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
});
