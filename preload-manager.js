'use strict';

// Manager preload: the engine app's bridge — library, registries, and
// active-pack selection. It cannot render packs or reach the voice pipeline
// (the panel and desktop windows have their own narrower bridges).

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('aegis', {
  version: '0.4.0',

  libraryState: () => ipcRenderer.invoke('aegis:library:state'),
  installFile: () => ipcRenderer.invoke('aegis:packs:installFile'),
  exportPack: (id) => ipcRenderer.invoke('aegis:packs:export', String(id)),
  uninstallPack: (id) => ipcRenderer.invoke('aegis:packs:uninstall', String(id)),

  registryAdd: (url) => ipcRenderer.invoke('aegis:registry:add', String(url)),
  registryRemove: (url) => ipcRenderer.invoke('aegis:registry:remove', String(url)),
  registryBrowse: (url) => ipcRenderer.invoke('aegis:registry:browse', String(url)),
  registryPreview: (url) => ipcRenderer.invoke('aegis:registry:preview', String(url)),
  registryInstall: (url, id) => ipcRenderer.invoke('aegis:registry:install', { url: String(url), id: String(id) }),

  activeGet: () => ipcRenderer.invoke('aegis:active:get'),
  activeSet: (id) => ipcRenderer.invoke('aegis:active:set', String(id)),
  onActiveChanged: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('aegis:active:changed', handler);
    return () => ipcRenderer.removeListener('aegis:active:changed', handler);
  },

  openPanel: () => ipcRenderer.invoke('aegis:open-panel'),
});
