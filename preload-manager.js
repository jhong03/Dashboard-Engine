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
  openEditor: (id) => ipcRenderer.invoke('aegis:open-editor', String(id)),

  // Daily planner — the manager is where reminders are managed.
  remindersList: (window) => ipcRenderer.invoke('aegis:reminders:list',
    window && window.from && window.to ? { from: String(window.from), to: String(window.to) } : undefined),
  reminderAdd: (r) => ipcRenderer.invoke('aegis:reminders:add', {
    date: String(r.date),
    time: r.time ? String(r.time) : null,
    text: String(r.text),
    repeat: r.repeat ? String(r.repeat) : 'none',
    lead: Number(r.lead) || 0,
  }),
  reminderUpdate: (id, patch) => ipcRenderer.invoke('aegis:reminders:update', { id: String(id), patch }),
  reminderRemove: (id) => ipcRenderer.invoke('aegis:reminders:remove', String(id)),
  reminderToggle: (id) => ipcRenderer.invoke('aegis:reminders:toggle', String(id)),
  onRemindersChanged: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('aegis:reminders:changed', handler);
    return () => ipcRenderer.removeListener('aegis:reminders:changed', handler);
  },
  // Main asks the window to show a view (e.g. planner, from a notification click).
  onShowView: (callback) => {
    const handler = (_event, view) => callback(String(view));
    ipcRenderer.on('aegis:show-view', handler);
    return () => ipcRenderer.removeListener('aegis:show-view', handler);
  },
});
