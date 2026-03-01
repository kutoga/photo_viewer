/**
 * Photo Map — Preload Script
 *
 * Exposes a safe, scoped API to the renderer via contextBridge.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('photoMap', {
  openDirectory: () => ipcRenderer.invoke('dialog:openDirectory'),
  startScan: () => ipcRenderer.send('scan:start'),
  getAllPhotos: () => ipcRenderer.invoke('photos:getAll'),
  getPreviewPath: (id) => ipcRenderer.invoke('photos:getPreviewPath', id),

  // Directory management
  getDirs: () => ipcRenderer.invoke('dirs:getAll'),
  addDir: (dirPath) => ipcRenderer.invoke('dirs:add', dirPath),
  removeDir: (dirPath) => ipcRenderer.invoke('dirs:remove', dirPath),

  onScanProgress: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('scan:progress', handler);
    return () => ipcRenderer.removeListener('scan:progress', handler);
  },

  onScanComplete: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('scan:complete', handler);
    return () => ipcRenderer.removeListener('scan:complete', handler);
  },

  /** Fired when a new GPS-tagged photo/video is cached during scan. */
  onScanNewItem: (callback) => {
    const handler = (_event, entry) => callback(entry);
    ipcRenderer.on('scan:newItem', handler);
    return () => ipcRenderer.removeListener('scan:newItem', handler);
  },

  // Shell actions
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  showItemInFolder: (filePath) => ipcRenderer.invoke('shell:showItemInFolder', filePath),

  onScanError: (callback) => {
    const handler = (_event, msg) => callback(msg);
    ipcRenderer.on('scan:error', handler);
    return () => ipcRenderer.removeListener('scan:error', handler);
  },
});
