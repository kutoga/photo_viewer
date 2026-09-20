'use strict';
const { app, BrowserWindow, ipcMain, dialog, protocol, net, shell, Menu } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const fs = require('node:fs/promises');
const { Readable } = require('node:stream');
const { createReadStream } = require('node:fs');
const { Library } = require('./lib/library.cjs');
let window, library;
let quitting = false;
app.setName('photo-map'); // Keep v1's userData directory on Windows and Linux.
if (process.env.PHOTO_MAP_USER_DATA)
  app.setPath('userData', path.resolve(process.env.PHOTO_MAP_USER_DATA));
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'media',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
]);
const send = (channel, data) => {
  if (window && !window.isDestroyed()) window.webContents.send(channel, data);
};

function createWindow() {
  window = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 900,
    minHeight: 640,
    title: 'Photo Map',
    backgroundColor: '#f7f8fa',
    icon: path.join(__dirname, 'assets/icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  window.setMenuBarVisibility(false);
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.loadFile(path.join(__dirname, 'renderer/index.html'));
  window.on('closed', () => {
    window = null;
  });
}
function handle(channel, handler) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (event.sender !== window?.webContents || event.senderFrame !== window.webContents.mainFrame)
      throw new Error('Unknown caller');
    try {
      return { ok: true, value: await handler(...args) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
}
async function serveMedia(request) {
  const url = new URL(request.url);
  const id = url.pathname.slice(1);
  if (!/^[a-f0-9]{32}$/.test(id) || !library.entries.has(id))
    return new Response('Not found', { status: 404 });
  const entry = library.entries.get(id);
  if (url.hostname === 'thumbnails' || url.hostname === 'previews') {
    const folder = url.hostname;
    const suffix = folder === 'thumbnails' ? 'thumb' : 'preview';
    const filename = path.join(library.cacheDir, folder, `${id}_${suffix}.jpg`);
    try {
      return await net.fetch(pathToFileURL(filename).href);
    } catch {
      return new Response('Image unavailable', { status: 404 });
    }
  }
  if (url.hostname !== 'original' || entry.type !== 'video')
    return new Response('Not found', { status: 404 });
  // Explicit byte-range responses give reliable seeking on both Windows and Linux.
  try {
    const stat = await fs.stat(entry.originalPath);
    const mime =
      {
        '.mp4': 'video/mp4',
        '.m4v': 'video/mp4',
        '.mov': 'video/quicktime',
        '.webm': 'video/webm',
        '.mkv': 'video/x-matroska',
        '.avi': 'video/x-msvideo',
      }[path.extname(entry.originalPath).toLowerCase()] || 'application/octet-stream';
    const headers = { 'Content-Type': mime, 'Accept-Ranges': 'bytes' };
    const range = request.headers.get('range');
    let start = 0,
      end = stat.size - 1;
    if (range) {
      const match = range.match(/^bytes=(\d*)-(\d*)$/);
      if (!match || (!match[1] && !match[2]))
        return new Response(null, {
          status: 416,
          headers: { 'Content-Range': `bytes */${stat.size}` },
        });
      if (!match[1]) start = Math.max(0, stat.size - Number(match[2]));
      else {
        start = Number(match[1]);
        if (match[2]) end = Math.min(end, Number(match[2]));
      }
      if (start > end || start >= stat.size)
        return new Response(null, {
          status: 416,
          headers: { 'Content-Range': `bytes */${stat.size}` },
        });
      headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
    }
    headers['Content-Length'] = String(Math.max(0, end - start + 1));
    const stream =
      request.method === 'HEAD' || !stat.size
        ? null
        : Readable.toWeb(createReadStream(entry.originalPath, { start, end }));
    return new Response(stream, { status: range ? 206 : 200, headers });
  } catch {
    return new Response('Original file unavailable. Reconnect the source drive.', { status: 404 });
  }
}
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else
  app
    .whenReady()
    .then(async () => {
      Menu.setApplicationMenu(null);
      library = new Library(path.join(app.getPath('userData'), 'photo-map-cache'));
      await library.init();
      protocol.handle('media', serveMedia);
      library.on('changes', (data) => send('library:changes', data));
      library.on('progress', (data) => send('scan:progress', data));
      library.on('complete', (data) => send('scan:complete', data));
      handle('library:get', () => library.snapshot());
      handle('folders:add', async () => {
        if (library.scan) throw new Error('Wait for the current scan to finish.');
        const result = await dialog.showOpenDialog(window, {
          title: 'Add photo folders',
          properties: ['openDirectory', 'multiSelections'],
        });
        if (result.canceled) return null;
        return library.addFolders(result.filePaths);
      });
      handle('folders:remove', (dir) => {
        if (!library.dirs.includes(dir)) throw new Error('Unknown folder');
        return library.removeFolder(dir);
      });
      handle('scan:start', () => {
        if (library.scan) throw new Error('A scan is already running.');
        if (!library.dirs.length) throw new Error('Add a photo folder first.');
        library.startScan().catch((err) => send('scan:error', err.message));
        return true;
      });
      handle('scan:cancel', () => {
        library.cancel();
        return true;
      });
      handle('media:preview', (id) => library.preview(id));
      handle('media:reveal', (id) => {
        const entry = library.entries.get(id);
        if (!entry) throw new Error('File not found in library');
        shell.showItemInFolder(entry.originalPath);
      });
      handle('media:open', async (id) => {
        const entry = library.entries.get(id);
        if (!entry) throw new Error('File not found in library');
        const error = await shell.openPath(entry.originalPath);
        if (error) throw new Error(error);
      });
      handle('media:maps', (id) => {
        const entry = library.entries.get(id);
        if (!entry || !Number.isFinite(entry.lat) || !Number.isFinite(entry.lng))
          throw new Error('Location unavailable');
        return shell.openExternal(`https://www.google.com/maps?q=${entry.lat},${entry.lng}`);
      });
      createWindow();
      app.on('activate', () => {
        if (!BrowserWindow.getAllWindows().length) createWindow();
      });
    })
    .catch((err) => {
      dialog.showErrorBox('Photo Map could not start', err.message);
      app.quit();
    });
app.on('second-instance', () => {
  if (window) {
    if (window.isMinimized()) window.restore();
    window.focus();
  }
});
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
app.on('before-quit', (event) => {
  if (!library || quitting) return;
  event.preventDefault();
  quitting = true;
  library.cancel();
  // Let the bounded in-flight work finish and checkpoint before exiting.
  const wait = async () => {
    while (library.scan) await new Promise((resolve) => setTimeout(resolve, 100));
    await library.close();
    app.quit();
  };
  wait().catch(() => app.exit());
});
