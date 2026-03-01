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

async function* walkDir(dir) {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkDir(fullPath);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (ALL_EXTENSIONS.has(ext)) {
        yield fullPath;
      }
    }
  }
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

  // ── Phase 0: Remove deleted files and entries outside configured dirs ──
  mainWindow?.webContents.send('scan:progress', {
    phase: 'cleanup',
    total: 0, processed: 0, withGPS: 0,
    currentFile: 'Checking for removed files…',
  });

  const toRemove = [];
  for (const entry of metadata) {
    if (!isUnderSourceDirs(entry.originalPath)) {
      toRemove.push(entry);
      continue;
    }
    try {
      await fsp.access(entry.originalPath);
    } catch {
      toRemove.push(entry);
    }
  }

  if (toRemove.length > 0) {
    const removeIds = new Set(toRemove.map((e) => e.id));
    metadata = metadata.filter((e) => !removeIds.has(e.id));

    for (const entry of toRemove) {
      try { await fsp.unlink(path.join(thumbDir, `${entry.id}_thumb.jpg`)); } catch {}
      try { await fsp.unlink(path.join(previewDir, `${entry.id}_preview.jpg`)); } catch {}
    }

    console.log(`Removed ${toRemove.length} deleted/orphaned file(s) from cache.`);
    await saveMetadata();
  }

  // ── Phase 1: Index files from all source directories ──
  mainWindow?.webContents.send('scan:progress', {
    phase: 'indexing',
    total: 0, processed: 0, withGPS: 0,
    currentFile: 'Indexing files…',
  });

  const allFiles = [];
  for (const dir of dirs) {
    for await (const filePath of walkDir(dir)) {
      allFiles.push(filePath);
    }
  }

  // Build lookup of existing entries by id for change detection
  const existingById = new Map(metadata.map((m) => [m.id, m]));

  let processed = 0;
  let withGPS = metadata.filter((m) => m.lat !== null).length;

  // Separate files into: skip (unchanged), and toProcess (new or changed)
  const toProcess = [];
  for (const filePath of allFiles) {
    const id = crypto.createHash('md5').update(filePath).digest('hex');
    const existing = existingById.get(id);
    if (existing) {
      try {
        const stat = await fsp.stat(filePath);
        if (existing.fileSize === stat.size && existing.fileMtime === stat.mtimeMs) {
          processed++;
          continue; // Unchanged
        }
        // Changed — remove old cache
        metadata = metadata.filter((m) => m.id !== id);
        existingById.delete(id);
        if (existing.lat !== null) withGPS--;
        try { await fsp.unlink(path.join(thumbDir, `${id}_thumb.jpg`)); } catch {}
        try { await fsp.unlink(path.join(previewDir, `${id}_preview.jpg`)); } catch {}
      } catch { processed++; continue; }
    }
    toProcess.push(filePath);
  }

  // ── Phase 2: Process new/changed files in parallel batches ──
  const CONCURRENCY = 12;

  async function processOneFile(filePath) {
    const filename = path.basename(filePath);
    const ext = path.extname(filename).toLowerCase();
    const isVideo = VIDEO_EXTENSIONS.has(ext);
    const id = crypto.createHash('md5').update(filePath).digest('hex');

    let fileSize = 0, fileMtime = 0;
    try {
      const stat = await fsp.stat(filePath);
      fileSize = stat.size;
      fileMtime = stat.mtimeMs;
    } catch { return; }

    let lat = null, lng = null, date = null;

    try {
      const gps = await exifr.default.gps(filePath);
      if (gps && typeof gps.latitude === 'number' && typeof gps.longitude === 'number') {
        lat = gps.latitude;
        lng = gps.longitude;
      }
    } catch {}

    try {
      const parsed = await exifr.default.parse(filePath, ['DateTimeOriginal', 'DateTime', 'CreationDate']);
      const rawDate = parsed?.DateTimeOriginal ?? parsed?.DateTime ?? parsed?.CreationDate;
      if (rawDate instanceof Date) date = rawDate.toISOString();
    } catch {}

    let hasThumbnail = false, hasPreview = false;

    if (lat !== null && lng !== null) {
      if (isVideo) {
        if (ffmpegPath) {
          try {
            const framePath = path.join(cacheDir, `${id}_frame.jpg`);
            await ffmpegExtractFrame(filePath, framePath);
            await sharp(framePath)
              .resize(80, 80, { fit: 'cover', position: 'centre' })
              .jpeg({ quality: 70 })
              .toFile(path.join(thumbDir, `${id}_thumb.jpg`));
            hasThumbnail = true;
            await sharp(framePath)
              .resize(1200, null, { fit: 'inside', withoutEnlargement: true })
              .jpeg({ quality: 82 })
              .toFile(path.join(previewDir, `${id}_preview.jpg`));
            hasPreview = true;
            await fsp.unlink(framePath).catch(() => {});
          } catch (err) {
            console.warn(`Video thumb failed for ${filename}:`, err.message);
          }
        }
      } else {
        try {
          await sharp(filePath).rotate()
            .resize(80, 80, { fit: 'cover', position: 'centre' })
            .jpeg({ quality: 70 })
            .toFile(path.join(thumbDir, `${id}_thumb.jpg`));
          hasThumbnail = true;
        } catch {}
        try {
          await sharp(filePath).rotate()
            .resize(1200, null, { fit: 'inside', withoutEnlargement: true })
            .jpeg({ quality: 82 })
            .toFile(path.join(previewDir, `${id}_preview.jpg`));
          hasPreview = true;
        } catch {}
      }
    }

    return {
      id, originalPath: filePath, filename, lat, lng, date,
      fileSize, fileMtime, type: isVideo ? 'video' : 'photo', hasThumbnail, hasPreview,
    };
  }

  // Process files in batches of CONCURRENCY
  for (let i = 0; i < toProcess.length; i += CONCURRENCY) {
    const batch = toProcess.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(batch.map(processOneFile));

    for (const result of results) {
      processed++;
      if (result.status !== 'fulfilled' || !result.value) continue;

      const entry = result.value;
      metadata.push(entry);
      existingById.set(entry.id, entry);

      if (entry.lat !== null && entry.lng !== null) {
        withGPS++;
        // Send new item to renderer for live map update
        if (entry.hasThumbnail) {
          mainWindow?.webContents.send('scan:newItem', entry);
        }
      }
    }

    // Persist periodically
    if (i % 50 === 0) {
      await saveMetadata();
    }

    mainWindow?.webContents.send('scan:progress', {
      phase: 'scanning',
      total: allFiles.length,
      processed,
      withGPS,
      currentFile: batch[batch.length - 1] ? path.basename(batch[batch.length - 1]) : '',
    });
  }

  await saveMetadata();
  isScanning = false;

  mainWindow?.webContents.send('scan:complete', {
    total: allFiles.length,
    withGPS,
  });
}
