/**
 * Photo Map — Electron Main Process
 *
 * Responsibilities:
 * - Create the browser window
 * - Register the custom cache:// protocol for serving cached images
 * - Handle IPC: directory picker, photo metadata, scan control
 * - Background scanner: reads EXIF GPS data, generates downscaled cache copies
 * - Supports photos (JPG, HEIC, PNG, TIFF, WebP) and videos (MP4, MOV, AVI, MKV, WebM)
 */

const { app, BrowserWindow, ipcMain, dialog, protocol, net, shell, Menu } = require('electron');
const path = require('path');
const fsp = require('fs/promises');
const crypto = require('crypto');
const { execFile } = require('child_process');
const os = require('os');

// Lazy-load heavy modules after app is ready to avoid slowing startup
let exifr = null;
let sharp = null;
let ffmpegPath = null;

// ─── Paths ───────────────────────────────────────────────────────────────────

let cacheDir, thumbDir, previewDir, metadataPath, configPath;

// ─── State ───────────────────────────────────────────────────────────────────

let mainWindow = null;
let metadata = [];        // In-memory array of photo/video objects
let isScanning = false;   // Guard against concurrent scans
let sourceDirs = [];      // Configured source folder paths

// ─── Protocol registration ────────────────────────────────────────────────────
// MUST happen synchronously before app.whenReady(), otherwise Electron ignores it.

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'cache',
    privileges: {
      secure: true,
      standard: true,
      supportFetchAPI: true,
      bypassCSP: true,
    },
  },
]);

// ─── Window ───────────────────────────────────────────────────────────────────

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    backgroundColor: '#0f0f0f',
    titleBarStyle: 'default',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ─── App lifecycle ────────────────────────────────────────────────────────────

app.whenReady().then(async () => {
  cacheDir = path.join(app.getPath('userData'), 'photo-map-cache');
  thumbDir = path.join(cacheDir, 'thumbnails');
  previewDir = path.join(cacheDir, 'previews');
  metadataPath = path.join(cacheDir, 'metadata.json');
  configPath = path.join(cacheDir, 'config.json');

  await fsp.mkdir(thumbDir, { recursive: true });
  await fsp.mkdir(previewDir, { recursive: true });

  await loadMetadata();
  await loadConfig();

  // Register cache:// protocol handler
  protocol.handle('cache', (request) => {
    const url = new URL(request.url);
    const subDir = url.hostname;
    const filename = url.pathname.replace(/^\//, '');
    const absolutePath = path.join(cacheDir, subDir, filename);
    return net.fetch('file://' + absolutePath.replace(/\\/g, '/'));
  });

  Menu.setApplicationMenu(null);
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ─── Metadata persistence ─────────────────────────────────────────────────────

async function loadMetadata() {
  try {
    const raw = await fsp.readFile(metadataPath, 'utf8');
    metadata = JSON.parse(raw);
    if (!Array.isArray(metadata)) metadata = [];
  } catch {
    metadata = [];
  }
}

async function saveMetadata() {
  await fsp.writeFile(metadataPath, JSON.stringify(metadata), 'utf8');
}

// ─── Config persistence (source folders) ─────────────────────────────────────

async function loadConfig() {
  try {
    const raw = await fsp.readFile(configPath, 'utf8');
    const config = JSON.parse(raw);
    if (Array.isArray(config.sourceDirs)) sourceDirs = config.sourceDirs;
  } catch {
    sourceDirs = [];
  }
  // Migrate from old single-dir setup: infer source dir from existing metadata
  if (sourceDirs.length === 0 && metadata.length > 0) {
    const dirs = new Set(metadata.map((m) => path.dirname(m.originalPath)));
    // Find shortest common prefix(es) — simple heuristic: use unique top-level dirs
    sourceDirs = [...dirs].reduce((acc, d) => {
      if (!acc.some((a) => d.startsWith(a + path.sep) || d === a)) {
        // Remove any existing entries that are children of d
        acc = acc.filter((a) => !a.startsWith(d + path.sep));
        acc.push(d);
      }
      return acc;
    }, []);
    await saveConfig();
  }
}

async function saveConfig() {
  await fsp.writeFile(configPath, JSON.stringify({ sourceDirs }), 'utf8');
}

function isUnderSourceDirs(filePath) {
  const normalized = filePath.replace(/\\/g, '/').toLowerCase();
  return sourceDirs.some((d) => {
    const nd = d.replace(/\\/g, '/').toLowerCase();
    return normalized.startsWith(nd + '/') || normalized === nd;
  });
}

// ─── IPC handlers ─────────────────────────────────────────────────────────────

ipcMain.handle('dialog:openDirectory', async () => {
  if (!mainWindow) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: 'Select Photo Folder',
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('photos:getAll', () => metadata);

ipcMain.handle('photos:getPreviewPath', (_event, id) => {
  const entry = metadata.find((m) => m.id === id);
  if (entry?.type === 'video') {
    return 'file://' + entry.originalPath.replace(/\\/g, '/');
  }
  return `cache://previews/${id}_preview.jpg`;
});

// ─── Shell IPC ───────────────────────────────────────────────────────────────

ipcMain.handle('shell:openExternal', (_event, url) => shell.openExternal(url));
ipcMain.handle('shell:showItemInFolder', (_event, filePath) => {
  shell.showItemInFolder(filePath);
});

// ─── Directory management IPC ────────────────────────────────────────────────

ipcMain.handle('dirs:getAll', () => sourceDirs);

ipcMain.handle('dirs:add', async (_event, dirPath) => {
  if (!sourceDirs.includes(dirPath)) {
    sourceDirs.push(dirPath);
    await saveConfig();
  }
  return sourceDirs;
});

ipcMain.handle('dirs:remove', async (_event, dirPath) => {
  sourceDirs = sourceDirs.filter((d) => d !== dirPath);
  await saveConfig();

  // Remove metadata entries under the removed directory
  const normalizedDir = dirPath.replace(/\\/g, '/').toLowerCase();
  const toRemove = metadata.filter((m) => {
    const np = m.originalPath.replace(/\\/g, '/').toLowerCase();
    return np.startsWith(normalizedDir + '/') || np === normalizedDir;
  });

  if (toRemove.length > 0) {
    const removeIds = new Set(toRemove.map((e) => e.id));
    metadata = metadata.filter((e) => !removeIds.has(e.id));
    for (const entry of toRemove) {
      try { await fsp.unlink(path.join(thumbDir, `${entry.id}_thumb.jpg`)); } catch {}
      try { await fsp.unlink(path.join(previewDir, `${entry.id}_preview.jpg`)); } catch {}
    }
    await saveMetadata();
    console.log(`Removed ${toRemove.length} cached entries for ${dirPath}`);
  }

  return sourceDirs;
});

// ─── Scan IPC ────────────────────────────────────────────────────────────────

ipcMain.on('scan:start', (_event) => {
  if (isScanning) {
    mainWindow?.webContents.send('scan:error', 'A scan is already running.');
    return;
  }
  if (sourceDirs.length === 0) {
    mainWindow?.webContents.send('scan:error', 'No folders configured.');
    return;
  }
  startScan(sourceDirs).catch((err) => {
    console.error('Scan error:', err);
    isScanning = false;
    mainWindow?.webContents.send('scan:error', err.message);
  });
});

// ─── File walker ──────────────────────────────────────────────────────────────

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.heic', '.png', '.tiff', '.tif', '.webp']);
const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.avi', '.mkv', '.webm', '.m4v']);
const ALL_EXTENSIONS = new Set([...IMAGE_EXTENSIONS, ...VIDEO_EXTENSIONS]);

/**
 * Walk a directory tree collecting media files.
 * Uses parallel readdir on subdirectories for speed.
 */
async function walkDirParallel(dir) {
  const results = [];
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return results;
  }

  const subdirPromises = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      subdirPromises.push(walkDirParallel(fullPath));
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (ALL_EXTENSIONS.has(ext)) {
        results.push(fullPath);
      }
    }
  }

  if (subdirPromises.length > 0) {
    const subResults = await Promise.all(subdirPromises);
    for (const sub of subResults) {
      for (const f of sub) results.push(f);
    }
  }

  return results;
}

// ─── Worker pool ─────────────────────────────────────────────────────────────

/**
 * Run async tasks with bounded concurrency. Unlike fixed batches, new work
 * starts immediately when a slot frees up — no waiting for the slowest item.
 */
function runPool(items, concurrency, fn) {
  let idx = 0;
  const workers = [];
  for (let w = 0; w < concurrency; w++) {
    workers.push((async () => {
      while (idx < items.length) {
        const i = idx++;
        await fn(items[i], i);
      }
    })());
  }
  return Promise.all(workers);
}

// ─── Video thumbnail via ffmpeg ───────────────────────────────────────────────

function ensureFfmpeg() {
  if (ffmpegPath) return true;
  try {
    ffmpegPath = require('ffmpeg-static');
    return true;
  } catch {
    console.warn('ffmpeg-static not available, video thumbnails will be skipped.');
    return false;
  }
}

function ffmpegExtractFrame(videoPath, outputPath, timeOffset = '00:00:01') {
  return new Promise((resolve, reject) => {
    if (!ffmpegPath) return reject(new Error('No ffmpeg'));
    execFile(
      ffmpegPath,
      [
        '-y',                     // Overwrite
        '-ss', timeOffset,        // Seek to 1 second in
        '-i', videoPath,
        '-vframes', '1',          // Extract 1 frame
        '-q:v', '3',              // JPEG quality
        outputPath,
      ],
      { timeout: 15000 },
      (err) => (err ? reject(err) : resolve())
    );
  });
}

// ─── Scanner ──────────────────────────────────────────────────────────────────

async function startScan(dirs) {
  isScanning = true;

  // Lazy-load heavy modules
  if (!exifr) exifr = await import('exifr');
  if (!sharp) sharp = require('sharp');
  ensureFfmpeg();

  // Concurrency: I/O tasks (stat, access, exifr) can go wide;
  // CPU tasks (sharp) are limited by cores. Use a blend.
  const cpuCount = os.cpus().length;
  const IO_CONCURRENCY = Math.max(cpuCount * 4, 32);
  const PROCESS_CONCURRENCY = Math.max(cpuCount * 2, 16);

  // ── Phase 0: Remove deleted files and entries outside configured dirs ──
  mainWindow?.webContents.send('scan:progress', {
    phase: 'cleanup',
    total: 0, processed: 0, withGPS: 0,
    currentFile: 'Checking for removed files…',
  });

  // Parallel existence checks
  const removeFlags = await Promise.all(
    metadata.map(async (entry) => {
      if (!isUnderSourceDirs(entry.originalPath)) return true;
      try { await fsp.access(entry.originalPath); return false; }
      catch { return true; }
    })
  );
  const toRemove = metadata.filter((_, i) => removeFlags[i]);

  if (toRemove.length > 0) {
    const removeIds = new Set(toRemove.map((e) => e.id));
    metadata = metadata.filter((e) => !removeIds.has(e.id));

    // Parallel cache file deletion
    await Promise.all(toRemove.flatMap((entry) => [
      fsp.unlink(path.join(thumbDir, `${entry.id}_thumb.jpg`)).catch(() => {}),
      fsp.unlink(path.join(previewDir, `${entry.id}_preview.jpg`)).catch(() => {}),
    ]));

    console.log(`Removed ${toRemove.length} deleted/orphaned file(s) from cache.`);
    await saveMetadata();
  }

  // ── Phase 1: Index files from all source directories in parallel ──
  mainWindow?.webContents.send('scan:progress', {
    phase: 'indexing',
    total: 0, processed: 0, withGPS: 0,
    currentFile: 'Indexing files…',
  });

  const walkResults = await Promise.all(dirs.map(walkDirParallel));
  const allFiles = [];
  for (const list of walkResults) {
    for (const f of list) allFiles.push(f);
  }

  // Pre-compute IDs for all files (used in change detection AND processing)
  const allIds = allFiles.map((fp) =>
    crypto.createHash('md5').update(fp).digest('hex')
  );

  // Build lookup of existing entries by id for change detection
  const existingById = new Map(metadata.map((m) => [m.id, m]));

  let processed = 0;
  let withGPS = metadata.filter((m) => m.lat !== null).length;

  // ── Phase 1b: Parallel change detection via stat ──
  // Stat all files that have an existing entry, in parallel
  const fileItems = allFiles.map((fp, i) => ({ fp, id: allIds[i], idx: i }));
  const needsStat = fileItems.filter((item) => existingById.has(item.id));
  const noEntry = fileItems.filter((item) => !existingById.has(item.id));

  // Stat existing files in parallel to detect changes
  const statResults = new Array(needsStat.length);
  await runPool(needsStat, IO_CONCURRENCY, async (item, i) => {
    const existing = existingById.get(item.id);
    try {
      const stat = await fsp.stat(item.fp);
      if (existing.fileSize === stat.size && existing.fileMtime === stat.mtimeMs) {
        statResults[i] = 'skip';
      } else {
        statResults[i] = 'changed';
      }
    } catch {
      statResults[i] = 'skip';
    }
  });

  // Collect files to process: new files + changed files
  const toProcess = [];
  for (const item of noEntry) {
    toProcess.push({ filePath: item.fp, id: item.id });
  }

  // Handle changed files: clean old cache entries
  const changedCleanup = [];
  for (let i = 0; i < needsStat.length; i++) {
    if (statResults[i] === 'changed') {
      const item = needsStat[i];
      const existing = existingById.get(item.id);
      metadata = metadata.filter((m) => m.id !== item.id);
      existingById.delete(item.id);
      if (existing.lat !== null) withGPS--;
      changedCleanup.push(
        fsp.unlink(path.join(thumbDir, `${item.id}_thumb.jpg`)).catch(() => {}),
        fsp.unlink(path.join(previewDir, `${item.id}_preview.jpg`)).catch(() => {})
      );
      toProcess.push({ filePath: item.fp, id: item.id });
    } else {
      processed++;
    }
  }
  if (changedCleanup.length > 0) await Promise.all(changedCleanup);

  // ── Phase 2: Process new/changed files with worker pool ──
  // Metadata save is debounced to avoid blocking workers
  let savePending = false;
  let lastSaveTime = Date.now();
  function scheduleSave() {
    if (savePending) return;
    const elapsed = Date.now() - lastSaveTime;
    if (elapsed >= 3000) {
      savePending = true;
      saveMetadata().then(() => { savePending = false; lastSaveTime = Date.now(); });
    }
  }

  await runPool(toProcess, PROCESS_CONCURRENCY, async (item) => {
    const entry = await processOneFile(item.filePath, item.id);
    processed++;

    if (entry) {
      metadata.push(entry);
      existingById.set(entry.id, entry);

      if (entry.lat !== null && entry.lng !== null) {
        withGPS++;
        if (entry.hasThumbnail) {
          mainWindow?.webContents.send('scan:newItem', entry);
        }
      }
    }

    // Throttled progress updates (every 5 items to avoid flooding IPC)
    if (processed % 5 === 0 || processed === allFiles.length) {
      mainWindow?.webContents.send('scan:progress', {
        phase: 'scanning',
        total: allFiles.length,
        processed,
        withGPS,
        currentFile: path.basename(item.filePath),
      });
      scheduleSave();
    }
  });

  await saveMetadata();
  isScanning = false;

  mainWindow?.webContents.send('scan:complete', {
    total: allFiles.length,
    withGPS,
  });
}

async function processOneFile(filePath, id) {
  const filename = path.basename(filePath);
  const ext = path.extname(filename).toLowerCase();
  const isVideo = VIDEO_EXTENSIONS.has(ext);

  let fileSize = 0, fileMtime = 0;
  try {
    const stat = await fsp.stat(filePath);
    fileSize = stat.size;
    fileMtime = stat.mtimeMs;
  } catch { return null; }

  let lat = null, lng = null, date = null;

  // Single exifr.parse call to extract GPS + date in one file read
  try {
    const parsed = await exifr.default.parse(filePath, {
      gps: true,
      pick: ['DateTimeOriginal', 'DateTime', 'CreationDate',
             'GPSLatitude', 'GPSLatitudeRef', 'GPSLongitude', 'GPSLongitudeRef'],
    });
    if (parsed) {
      if (typeof parsed.latitude === 'number' && typeof parsed.longitude === 'number') {
        lat = parsed.latitude;
        lng = parsed.longitude;
      }
      const rawDate = parsed.DateTimeOriginal ?? parsed.DateTime ?? parsed.CreationDate;
      if (rawDate instanceof Date) date = rawDate.toISOString();
    }
  } catch {}

  let hasThumbnail = false, hasPreview = false;

  if (lat !== null && lng !== null) {
    if (isVideo) {
      if (ffmpegPath) {
        try {
          const framePath = path.join(cacheDir, `${id}_frame.jpg`);
          await ffmpegExtractFrame(filePath, framePath);

          // Read frame once, generate both thumb and preview in parallel
          const frameBuffer = await fsp.readFile(framePath);
          const [thumbResult, previewResult] = await Promise.allSettled([
            sharp(frameBuffer)
              .resize(80, 80, { fit: 'cover', position: 'centre' })
              .jpeg({ quality: 70 })
              .toFile(path.join(thumbDir, `${id}_thumb.jpg`)),
            sharp(frameBuffer)
              .resize(1200, null, { fit: 'inside', withoutEnlargement: true })
              .jpeg({ quality: 82 })
              .toFile(path.join(previewDir, `${id}_preview.jpg`)),
          ]);
          if (thumbResult.status === 'fulfilled') hasThumbnail = true;
          if (previewResult.status === 'fulfilled') hasPreview = true;
          fsp.unlink(framePath).catch(() => {});
        } catch (err) {
          console.warn(`Video thumb failed for ${filename}:`, err.message);
        }
      }
    } else {
      // Read image buffer once, generate both thumb and preview in parallel
      try {
        const imgBuffer = await fsp.readFile(filePath);
        const [thumbResult, previewResult] = await Promise.allSettled([
          sharp(imgBuffer).rotate()
            .resize(80, 80, { fit: 'cover', position: 'centre' })
            .jpeg({ quality: 70 })
            .toFile(path.join(thumbDir, `${id}_thumb.jpg`)),
          sharp(imgBuffer).rotate()
            .resize(1200, null, { fit: 'inside', withoutEnlargement: true })
            .jpeg({ quality: 82 })
            .toFile(path.join(previewDir, `${id}_preview.jpg`)),
        ]);
        if (thumbResult.status === 'fulfilled') hasThumbnail = true;
        if (previewResult.status === 'fulfilled') hasPreview = true;
      } catch {}
    }
  }

  return {
    id, originalPath: filePath, filename, lat, lng, date,
    fileSize, fileMtime, type: isVideo ? 'video' : 'photo', hasThumbnail, hasPreview,
  };
}
