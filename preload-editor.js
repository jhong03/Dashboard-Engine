'use strict';

// Editor preload: load packs (with assets), list a pack's full asset dir,
// save (fork-on-save happens in main), apply to desktop, and the live-data
// services so the canvas preview behaves exactly like the real desktop.

const { contextBridge, ipcRenderer } = require('electron');

// UI language dictionary, fetched SYNCHRONOUSLY so the page has it before it
// renders (no flash of untranslated text). Exposed read-only to the page world;
// src/i18n.js reads window.__i18n. Fail-soft: if unavailable, pages fall back to
// English keys.
try {
  contextBridge.exposeInMainWorld('__i18n', ipcRenderer.sendSync('aegis:i18n:get'));
} catch (e) { /* i18n unavailable — English fallback */ }

// SECURITY: preloads run in every frame, including a module component's
// sandboxed <iframe> shown in the stage preview. Only the top frame (the real
// editor UI) may reach this bridge — never a pack's untrusted module code, which
// otherwise could call editorSave/importImage/activeSet. See preload-dashboard.js.
const bridge = {
  version: '0.4.0',

  // UI language (i18n): list available locales, and set the active one (the
  // renderer reloads to apply the new dictionary).
  i18nList: () => ipcRenderer.invoke('aegis:i18n:list'),
  i18nSet: (code) => ipcRenderer.invoke('aegis:i18n:set', code),

  packLoad: (id) => ipcRenderer.invoke('aegis:packs:load', String(id)),
  assetsAll: (id) => ipcRenderer.invoke('aegis:packs:assetsAll', String(id)),
  editorSave: (baseId, pack) => ipcRenderer.invoke('aegis:editor:save', { baseId: String(baseId), pack }),
  importImage: (existingNames) => ipcRenderer.invoke('aegis:editor:importImage', existingNames),
  importVideo: (existingNames) => ipcRenderer.invoke('aegis:editor:importVideo', existingNames),
  activeSet: (id) => ipcRenderer.invoke('aegis:active:set', String(id)),
  stats: () => ipcRenderer.invoke('aegis:stats'),
  display: () => ipcRenderer.invoke('aegis:display'),
  weather: (opts) => ipcRenderer.invoke('aegis:weather', { lat: Number(opts.lat), lon: Number(opts.lon) }),
  weatherGeocode: (query) => ipcRenderer.invoke('aegis:weather:geocode', String(query)),
  remindersList: (window) => ipcRenderer.invoke('aegis:reminders:list',   // read-only here
    window && window.from && window.to ? { from: String(window.from), to: String(window.to) } : undefined),
  // Preview only: the editor renders launcher tiles but cannot launch.
  launcherState: (opts) => ipcRenderer.invoke('aegis:launcher:state', { running: Boolean(opts && opts.running) }),
  notifications: () => ipcRenderer.invoke('aegis:notifications'),
  onLauncherChanged: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('aegis:launcher:changed', handler);
    return () => ipcRenderer.removeListener('aegis:launcher:changed', handler);
  },
  // Open a module component's code in VS Code and sync saves back. The CODE goes
  // into a temp FILE (never onto a command line); main watches it and pushes
  // changes over onModuleExternalChange.
  moduleEditExternal: (html) => ipcRenderer.invoke('aegis:module:editExternal', String(html)),
  moduleEditStop: (token) => ipcRenderer.invoke('aegis:module:editStop', String(token)),
  onModuleExternalChange: (callback) => {
    const handler = (_e, msg) => callback(msg);
    ipcRenderer.on('aegis:module:external:changed', handler);
    return () => ipcRenderer.removeListener('aegis:module:external:changed', handler);
  },
};

if (window.top === window) contextBridge.exposeInMainWorld('aegis', bridge);
