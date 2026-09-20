'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const invoke = async (channel, ...args) => {
  const result = await ipcRenderer.invoke(channel, ...args);
  if (!result.ok) throw new Error(result.error);
  return result.value;
};
const listen = (channel, fn) => {
  const handler = (_event, data) => fn(data);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};
contextBridge.exposeInMainWorld('photoMap', {
  getLibrary: () => invoke('library:get'),
  addFolders: () => invoke('folders:add'),
  removeFolder: (dir) => invoke('folders:remove', dir),
  startScan: () => invoke('scan:start'),
  cancelScan: () => invoke('scan:cancel'),
  getPreview: (id, options) => invoke('media:preview', id, options),
  reveal: (id) => invoke('media:reveal', id),
  openOriginal: (id) => invoke('media:open', id),
  openMaps: (id) => invoke('media:maps', id),
  onChanges: (fn) => listen('library:changes', fn),
  onProgress: (fn) => listen('scan:progress', fn),
  onComplete: (fn) => listen('scan:complete', fn),
  onError: (fn) => listen('scan:error', fn),
});
