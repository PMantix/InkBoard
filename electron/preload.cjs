// Narrow, typed bridge between the sandboxed renderer and main.mjs.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('inkboard', {
  open: () => ipcRenderer.invoke('board:open'),
  save: (text, saveAs = false) => ipcRenderer.invoke('board:save', { text, saveAs }),
  autosave: (text) => ipcRenderer.invoke('board:autosave', text),
  restore: () => ipcRenderer.invoke('board:restore'),
  importFiles: () => ipcRenderer.invoke('file:import'),
  exportFile: (bytes, defaultName, ext) => ipcRenderer.invoke('file:export', { bytes, defaultName, ext }),
  exportPdf: (svg, width, height) => ipcRenderer.invoke('file:exportPdf', { svg, width, height }),
  onMenu: (fn) => ipcRenderer.on('menu', (_e, cmd) => fn(cmd)),
  onLoaded: (fn) => ipcRenderer.on('board:loaded', (_e, doc) => fn(doc)),
});
