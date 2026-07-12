'use strict';

// Desktop-surface preload: the NARROWEST bridge in the app. The desktop
// window only renders the active pack — it can read packs, stats, and the
// active-pack id, and hear about changes. No library, no installs, no
// registries, no voice pipeline.

const { contextBridge, ipcRenderer } = require('electron');

function subscription(channel) {
  return (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  };
}

contextBridge.exposeInMainWorld('aegis', {
  version: '0.4.0',
  packLoad: (id) => ipcRenderer.invoke('aegis:packs:load', String(id)),
  onPackChanged: subscription('aegis:packs:changed'),      // hot reload (file edits)
  activeGet: () => ipcRenderer.invoke('aegis:active:get'),
  onActiveChanged: subscription('aegis:active:changed'),   // manager picked a pack
  stats: () => ipcRenderer.invoke('aegis:stats'),
  weather: (opts) => ipcRenderer.invoke('aegis:weather', { lat: Number(opts.lat), lon: Number(opts.lon) }),
  remindersList: (window) => ipcRenderer.invoke('aegis:reminders:list',   // read-only here
    window && window.from && window.to ? { from: String(window.from), to: String(window.to) } : undefined),
  onRemindersChanged: subscription('aegis:reminders:changed'),
});
