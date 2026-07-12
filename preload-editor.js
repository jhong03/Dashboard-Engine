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
  display: () => ipcRenderer.invoke('aegis:display'),
  weather: (opts) => ipcRenderer.invoke('aegis:weather', { lat: Number(opts.lat), lon: Number(opts.lon) }),
  remindersList: (window) => ipcRenderer.invoke('aegis:reminders:list',   // read-only here
    window && window.from && window.to ? { from: String(window.from), to: String(window.to) } : undefined),
  // Preview only: the editor renders launcher tiles but cannot launch.
  launcherState: (opts) => ipcRenderer.invoke('aegis:launcher:state', { running: Boolean(opts && opts.running) }),
  onLauncherChanged: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('aegis:launcher:changed', handler);
    return () => ipcRenderer.removeListener('aegis:launcher:changed', handler);
  },
});
