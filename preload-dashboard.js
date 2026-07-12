'use strict';

// Dashboard preload: the explicit allowlist for the pack-rendering window.
// Deliberately narrower than the panel bridge — the dashboard can read packs
// and stats and ask for the tuning panel; it cannot touch voices, profiles,
// or synthesis. A pack that somehow drove this window still couldn't reach
// anything the skin engine doesn't need.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('aegis', {
  version: '0.4.0',

  packsList: () => ipcRenderer.invoke('aegis:packs:list'),
  packLoad: (id) => ipcRenderer.invoke('aegis:packs:load', String(id)),
  onPackChanged: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('aegis:packs:changed', handler);
    return () => ipcRenderer.removeListener('aegis:packs:changed', handler);
  },

  stats: () => ipcRenderer.invoke('aegis:stats'),
  openPanel: () => ipcRenderer.invoke('aegis:open-panel'),
});
