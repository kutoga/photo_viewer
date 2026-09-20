'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const { Workers } = require('./workers.cjs');
const { validImage } = require('./cache.cjs');
const {
  CACHE_VERSION,
  key,
  isWithin,
  uniqueRoots,
  fileId,
  hasGPS,
  atomicWrite,
  readJSON,
  walk,
} = require('./core.cjs');

class Library extends EventEmitter {
  constructor(cacheDir, options = {}) {
    super();
    this.cacheDir = cacheDir;
    this.entries = new Map();
    this.dirs = [];
    this.folderWarnings = new Map();
    this.scan = null;
    this.saveChain = Promise.resolve();
    this.workers =
      options.workers ||
      new Workers(
        Math.max(1, Math.min(2, Math.floor((os.availableParallelism?.() || os.cpus().length) / 2))),
      );
    this.previewWorkers = options.previewWorkers || new Workers(1);
    this.prefetchWorkers = options.previewWorkers || new Workers(1);
    this.previews = new Map();
    this.processing = new Map();
    this.repairs = new Map();
  }
  async init() {
    await Promise.all(
      ['thumbnails', 'previews'].map((d) =>
        fs.mkdir(path.join(this.cacheDir, d), { recursive: true }),
      ),
    );
    const data = await readJSON(path.join(this.cacheDir, 'metadata.json'), []);
    if (!Array.isArray(data)) throw new Error('The photo library is not a valid list.');
    for (const item of data)
      if (item && /^[a-f0-9]{32}$/.test(item.id) && typeof item.originalPath === 'string')
        this.entries.set(item.id, item);
    const config = await readJSON(path.join(this.cacheDir, 'config.json'), {});
    this.dirs = Array.isArray(config.sourceDirs)
      ? config.sourceDirs.filter((d) => typeof d === 'string')
      : [];
  }
  summary() {
    let photos = 0,
      videos = 0,
      located = 0,
      unavailable = 0;
    for (const e of this.entries.values()) {
      if (e.type === 'video') videos++;
      else photos++;
      if (hasGPS(e)) located++;
      if (e.error) unavailable++;
    }
    return {
      total: this.entries.size,
      located,
      photos,
      videos,
      withoutGPS: this.entries.size - located,
      unavailable,
    };
  }
  snapshot() {
    const folders = this.dirs.map((dir) => ({
      path: dir,
      name: path.basename(dir) || dir,
      count: [...this.entries.values()].filter((e) => isWithin(e.originalPath, dir)).length,
      warning: this.folderWarnings.get(dir) || null,
    }));
    return {
      items: [...this.entries.values()].filter(hasGPS),
      folders,
      summary: this.summary(),
      scan: this.scan?.progress || null,
      needsRescan:
        this.dirs.length > 0 &&
        [...this.entries.values()].some((entry) => entry.cacheVersion !== CACHE_VERSION),
    };
  }
  persist() {
    // Serial writes + rename ensure checkpoints never overwrite a newer final save.
    const data = [...this.entries.values()];
    this.saveChain = this.saveChain
      .catch(() => {})
      .then(() => atomicWrite(path.join(this.cacheDir, 'metadata.json'), data));
    return this.saveChain;
  }
  async saveConfig() {
    await atomicWrite(path.join(this.cacheDir, 'config.json'), { sourceDirs: this.dirs });
  }
  async addFolders(dirs) {
    if (this.scan) throw new Error('Wait for the scan to finish before changing folders.');
    for (const dir of dirs) {
      const resolved = await fs.realpath(dir);
      if (!(await fs.stat(resolved)).isDirectory()) continue;
      if (!this.dirs.some((d) => key(d) === key(resolved))) this.dirs.push(resolved);
    }
    await this.saveConfig();
    return this.snapshot();
  }
  async removeFolder(dir) {
    if (this.scan) throw new Error('Wait for the scan to finish before changing folders.');
    // Windows temp paths can use 8.3 names; selected folders may also be junctions.
    const canonical = await fs.realpath(dir).catch(() => dir);
    this.dirs = this.dirs.filter((d) => key(d) !== key(dir) && key(d) !== key(canonical));
    await this.saveConfig();
    const removed = [];
    for (const [id, entry] of this.entries)
      if (!this.dirs.some((d) => isWithin(entry.originalPath, d))) {
        this.entries.delete(id);
        removed.push(id);
      }
    await this.persist();
    await this.deleteCaches(removed);
    return this.snapshot();
  }
  async deleteCaches(ids) {
    // Bounded filesystem work even when a large folder is removed.
    for (let i = 0; i < ids.length; i += 64)
      await Promise.all(
        ids
          .slice(i, i + 64)
          .flatMap((id) => [
            fs.rm(path.join(this.cacheDir, 'thumbnails', `${id}_thumb.jpg`), { force: true }),
            fs.rm(path.join(this.cacheDir, 'previews', `${id}_preview.jpg`), { force: true }),
            fs.rm(path.join(this.cacheDir, 'previews', `${id}_full.jpg`), { force: true }),
          ])
          .map((p) => p.catch(() => {})),
      );
  }
  cancel() {
    this.scan?.controller.abort();
  }
  async startScan() {
    if (this.scan) throw new Error('A scan is already running.');
    if (!this.dirs.length) throw new Error('Add a folder to get started.');
    const controller = new AbortController();
    const progress = {
      phase: 'scanning',
      discovered: 0,
      processed: 0,
      added: 0,
      updated: 0,
      skipped: 0,
      errors: 0,
      currentFile: '',
    };
    this.scan = { controller, progress };
    this.folderWarnings.clear();
    const seen = new Set(),
      unavailable = [],
      pending = new Set();
    let updates = [],
      lastFlush = 0,
      lastSave = Date.now();
    const flush = (force = false) => {
      if (!force && Date.now() - lastFlush < 250) return;
      if (updates.length) this.emit('changes', { upsert: updates.splice(0), remove: [] });
      this.emit('progress', { ...progress });
      lastFlush = Date.now();
    };
    const reportUnavailable = (dir, err) => {
      unavailable.push(dir);
      progress.errors++;
      for (const root of this.dirs)
        if (isWithin(dir, root))
          this.folderWarnings.set(
            root,
            'Some files could not be read. Check the drive or folder permissions.',
          );
    };
    const processFile = async (file) => {
      const id = fileId(file);
      seen.add(id);
      let stat;
      try {
        stat = await fs.stat(file);
      } catch (err) {
        unavailable.push(file);
        progress.errors++;
        return;
      }
      const old = this.entries.get(id);
      // Validate cached thumbnails too, so missing/corrupt files cannot be skipped forever.
      if (
        old &&
        old.fileSize === stat.size &&
        old.fileMtime === stat.mtimeMs &&
        old.cacheVersion === CACHE_VERSION &&
        !old.error &&
        (!hasGPS(old) ||
          (old.hasThumbnail &&
            (await validImage(path.join(this.cacheDir, 'thumbnails', `${id}_thumb.jpg`)))))
      ) {
        progress.skipped++;
        progress.processed++;
        flush();
        return;
      }
      try {
        const entry = await this.processEntry(file, id, stat);
        // Retire previews only when the original or processing format changed.
        if (
          old &&
          (old.fileMtime !== stat.mtimeMs ||
            old.fileSize !== stat.size ||
            old.cacheVersion !== CACHE_VERSION)
        )
          await Promise.all(
            ['preview', 'full'].map((suffix) =>
              fs.rm(path.join(this.cacheDir, 'previews', `${id}_${suffix}.jpg`), { force: true }),
            ),
          );
        this.entries.set(id, entry);
        updates.push(entry);
        old ? progress.updated++ : progress.added++;
        if (entry.error) progress.errors++;
      } catch (err) {
        progress.errors++;
      }
      progress.processed++;
      progress.currentFile = path.basename(file);
      flush();
    };
    try {
      flush(true);
      for (const root of uniqueRoots(this.dirs)) {
        for await (const file of walk(root, reportUnavailable, controller.signal)) {
          if (controller.signal.aborted) break;
          progress.discovered++;
          const task = processFile(file).finally(() => pending.delete(task));
          pending.add(task);
          if (pending.size >= 12) await Promise.race(pending);
          if (Date.now() - lastSave > 10000) {
            await this.persist();
            lastSave = Date.now();
          }
        }
        if (controller.signal.aborted) break;
      }
      await Promise.all(pending);
      const removed = [];
      if (!controller.signal.aborted) {
        for (const [id, entry] of this.entries) {
          if (!seen.has(id) && !unavailable.some((dir) => isWithin(entry.originalPath, dir))) {
            this.entries.delete(id);
            removed.push(id);
          }
        }
      }
      if (removed.length) {
        this.emit('changes', { upsert: [], remove: removed });
        await this.deleteCaches(removed);
      }
      await this.persist();
      progress.phase = controller.signal.aborted ? 'cancelled' : 'complete';
      flush(true);
      this.scan = null;
      this.emit('complete', {
        ...progress,
        summary: this.summary(),
        folders: this.snapshot().folders,
      });
      return progress;
    } catch (err) {
      await Promise.allSettled(pending);
      this.scan = null;
      flush(true);
      throw err;
    }
  }
  processEntry(file, id, stat) {
    if (!this.processing.has(id)) {
      const task = this.workers
        .run('scan', {
          file,
          id,
          stat: { size: stat.size, mtimeMs: stat.mtimeMs },
          cacheDir: this.cacheDir,
        })
        .finally(() => this.processing.delete(id));
      this.processing.set(id, task);
    }
    return this.processing.get(id);
  }
  async thumbnail(id) {
    const entry = this.entries.get(id);
    if (!entry) throw new Error('This photo is no longer in your library.');
    const file = path.join(this.cacheDir, 'thumbnails', `${id}_thumb.jpg`);
    if (await validImage(file)) return file;
    if (!this.repairs.has(id)) {
      const task = (async () => {
        const stat = await fs.stat(entry.originalPath);
        const repaired = await this.processEntry(entry.originalPath, id, stat);
        if (!repaired.hasThumbnail) throw new Error('Thumbnail could not be regenerated.');
        if (!this.entries.has(id)) throw new Error('This photo was removed.');
        this.entries.set(id, repaired);
        this.emit('changes', { upsert: [repaired], remove: [] });
        await this.persist();
        return file;
      })().finally(() => this.repairs.delete(id));
      this.repairs.set(id, task);
    }
    return this.repairs.get(id);
  }
  async preview(id, { full = false, prefetch = false } = {}) {
    const entry = this.entries.get(id);
    if (!entry) throw new Error('This photo is no longer in your library.');
    full = full === true && entry.type !== 'video';
    const key = `${id}:${full}`;
    if (!this.previews.has(key)) {
      const task = (prefetch ? this.prefetchWorkers : this.previewWorkers)
        .run('preview', { entry, cacheDir: this.cacheDir, full })
        .finally(() => this.previews.delete(key));
      this.previews.set(key, task);
    }
    await this.previews.get(key);
    return {
      image: `media://${full ? 'full' : 'previews'}/${id}?v=${entry.fileMtime || 0}&cache=${entry.cacheVersion || 0}`,
      video: entry.type === 'video' ? `media://original/${id}` : null,
    };
  }
  async close() {
    this.cancel();
    await Promise.all([
      this.workers.close(),
      this.previewWorkers.close(),
      this.prefetchWorkers.close(),
    ]);
    await this.saveChain.catch(() => {});
  }
}
module.exports = { Library };
