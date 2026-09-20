'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Library } = require('../lib/library.cjs');
const sharp = require('sharp');
const { CACHE_VERSION, fileId, atomicWrite } = require('../lib/core.cjs');
async function fixture(t, run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'photo-map-lib-'));
  const source = path.join(root, 'photos'),
    nested = path.join(source, 'trip');
  await fs.mkdir(nested, { recursive: true });
  const calls = [];
  const workers = {
    run: async (kind, payload) => {
      calls.push(payload.file);
      if (run) await run(payload);
      await sharp({ create: { width: 64, height: 48, channels: 3, background: '#789a87' } })
        .jpeg()
        .toFile(path.join(payload.cacheDir, 'thumbnails', `${payload.id}_thumb.jpg`));
      return {
        id: payload.id,
        originalPath: payload.file,
        filename: path.basename(payload.file),
        type: 'photo',
        lat: 0,
        lng: 0,
        hasThumbnail: true,
        cacheVersion: CACHE_VERSION,
        fileSize: payload.stat.size,
        fileMtime: payload.stat.mtimeMs,
      };
    },
    close: async () => {},
  };
  const lib = new Library(path.join(root, 'cache'), { workers, previewWorkers: workers });
  await lib.init();
  t.after(async () => {
    await lib.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, source, nested, calls, lib };
}
test('overlapping folders index once, unchanged rescans do no media work, deletion is reconciled', async (t) => {
  const { source, nested, lib, calls } = await fixture(t);
  const file = path.join(nested, 'a.jpg');
  await fs.writeFile(file, 'one');
  await lib.addFolders([source, nested]);
  let scan = await lib.startScan();
  assert.equal(scan.added, 1);
  assert.equal(calls.length, 1);
  assert.equal(lib.entries.size, 1);
  scan = await lib.startScan();
  assert.equal(scan.skipped, 1);
  assert.equal(calls.length, 1);
  await fs.writeFile(file, 'changed-size');
  scan = await lib.startScan();
  assert.equal(scan.updated, 1);
  assert.equal(calls.length, 2);
  await fs.rm(file);
  await lib.startScan();
  assert.equal(lib.entries.size, 0);
});
test('removing a parent folder preserves entries covered by a remaining nested source', async (t) => {
  const { source, nested, lib } = await fixture(t);
  await fs.writeFile(path.join(nested, 'keep.jpg'), 'keep');
  await fs.writeFile(path.join(source, 'remove.jpg'), 'remove');
  await lib.addFolders([source, nested]);
  await lib.startScan();
  await lib.removeFolder(source);
  assert.equal(lib.entries.size, 1);
  assert.equal([...lib.entries.values()][0].filename, 'keep.jpg');
  assert.equal(await fs.readFile(path.join(source, 'remove.jpg'), 'utf8'), 'remove');
});
test('disconnected folders retain cached entries and report a warning', async (t) => {
  const { root, source, lib } = await fixture(t);
  await fs.writeFile(path.join(source, 'a.jpg'), 'one');
  await lib.addFolders([source]);
  await lib.startScan();
  await fs.rename(source, path.join(root, 'disconnected'));
  const scan = await lib.startScan();
  assert.equal(lib.entries.size, 1);
  assert.ok(scan.errors > 0);
  assert.ok(lib.snapshot().folders[0].warning);
});
test('cancelled scans never remove unvisited cached entries', async (t) => {
  const { source, lib } = await fixture(t, async () => {
    lib.cancel();
  });
  await fs.writeFile(path.join(source, 'a.jpg'), 'one');
  await lib.addFolders([source]);
  const missing = path.join(source, 'not-visited.jpg'),
    id = fileId(missing);
  lib.entries.set(id, { id, originalPath: missing, filename: 'not-visited.jpg', lat: 45, lng: 7 });
  const scan = await lib.startScan();
  assert.equal(scan.phase, 'cancelled');
  assert.ok(lib.entries.has(id));
});
test('version 1 metadata and folders are loaded without rescanning', async (t) => {
  const { root, source, lib } = await fixture(t);
  const file = path.join(source, 'legacy.jpg'),
    id = fileId(file);
  await atomicWrite(path.join(root, 'cache', 'metadata.json'), [
    { id, originalPath: file, filename: 'legacy.jpg', lat: 47, lng: 8, hasThumbnail: true },
  ]);
  await atomicWrite(path.join(root, 'cache', 'config.json'), { sourceDirs: [source] });
  await lib.init();
  assert.equal(lib.snapshot().items[0].id, id);
  assert.equal(lib.dirs[0], source);
});

test('folder removal accepts the same aliased path used when adding it', async (t) => {
  const { root, source, nested, lib } = await fixture(t);
  await fs.writeFile(path.join(source, 'remove.jpg'), 'remove');
  await fs.writeFile(path.join(nested, 'keep.jpg'), 'keep');
  const alias = path.join(root, 'photos-alias');
  await fs.symlink(source, alias, process.platform === 'win32' ? 'junction' : 'dir');
  await lib.addFolders([alias, nested]);
  await lib.startScan();
  await lib.removeFolder(alias);
  assert.equal(lib.entries.size, 1);
  assert.equal([...lib.entries.values()][0].filename, 'keep.jpg');
  assert.equal(lib.dirs.length, 1);
});

test('missing and older cache versions refresh after restart, then skip unchanged media', async (t) => {
  const { source, lib, calls } = await fixture(t);
  await fs.writeFile(path.join(source, 'unversioned.jpg'), 'one');
  await fs.writeFile(path.join(source, 'cropped.jpg'), 'two');
  await lib.addFolders([source]);
  await lib.startScan();
  const entries = [...lib.entries.values()];
  delete entries[0].cacheVersion;
  entries[1].cacheVersion = 2;
  await lib.persist();
  // Read the persisted catalog just as a fresh process does.
  lib.entries.clear();
  await lib.init();
  assert.equal(lib.snapshot().needsRescan, true);
  const scan = await lib.startScan();
  assert.equal(scan.updated, 2);
  assert.equal(calls.length, 4);
  assert.equal(lib.snapshot().needsRescan, false);
  await lib.init();
  assert.equal(lib.snapshot().needsRescan, false);
  assert.equal((await lib.startScan()).skipped, 2);
  assert.equal(calls.length, 4);
});

test('obsolete caches on a disconnected drive stay available and retry on a later startup', async (t) => {
  const { root, source, lib } = await fixture(t);
  await fs.writeFile(path.join(source, 'old.jpg'), 'one');
  await lib.addFolders([source]);
  await lib.startScan();
  delete [...lib.entries.values()][0].cacheVersion;
  await lib.persist();
  await fs.rename(source, path.join(root, 'unplugged'));
  await lib.startScan();
  assert.equal(lib.snapshot().items.length, 1);
  assert.equal(lib.snapshot().needsRescan, true);
  assert.equal(lib.snapshot().items[0].hasThumbnail, true);
});

test('unchanged sources regenerate missing and corrupt thumbnails, including on-demand repair', async (t) => {
  const { source, lib, calls } = await fixture(t);
  const file = path.join(source, 'repair.jpg');
  await fs.writeFile(file, 'original');
  await lib.addFolders([source]);
  await lib.startScan();
  const id = fileId(file),
    thumbnail = path.join(lib.cacheDir, 'thumbnails', `${id}_thumb.jpg`);
  await fs.rm(thumbnail);
  assert.equal((await lib.startScan()).updated, 1);
  assert.equal((await sharp(thumbnail).metadata()).width, 64);
  await fs.writeFile(thumbnail, 'not a JPEG');
  assert.equal((await lib.startScan()).updated, 1);
  await fs.writeFile(thumbnail, 'broken again');
  const before = calls.length;
  await Promise.all([lib.thumbnail(id), lib.thumbnail(id), lib.thumbnail(id)]);
  assert.equal(calls.length, before + 1, 'concurrent requests share one repair');
  assert.equal((await sharp(thumbnail).metadata()).width, 64);
  assert.equal(await fs.readFile(file, 'utf8'), 'original');
  assert.equal((await lib.startScan()).skipped, 1);
});
