'use strict';

// Editor preload: load packs (with assets), list a pack's full asset dir,
// save (fork-on-save happens in main), apply to desktop, and the live-data
// services so the canvas preview behaves exactly like the real desktop.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('aegis', {
  version: '0.4.0',
  packLoad: (id) => ipcRenderer.invoke('aegis:packs:load', String(id)),
  assetsAll: (id) => ipcRenderer.invoke('aegis:packs:assetsAll', String(id)),
  editorSave: (baseId, pack) => ipcRenderer.invoke('aegis:editor:save', { baseId: String(baseId), pack }),
  importImage: (existingNames) => ipcRenderer.invoke('aegis:editor:importImage', existingNames),
  activeSet: (id) => ipcRenderer.invoke('aegis:active:set', String(id)),
  stats: () => ipcRenderer.invoke('aegis:stats'),
  weather: (opts) => ipcRenderer.invoke('aegis:weather', { lat: Number(opts.lat), lon: Number(opts.lon) }),
  remindersList: () => ipcRenderer.invoke('aegis:reminders:list'),   // read-only here
});
