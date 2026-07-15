'use strict';

// Manager preload: the engine app's bridge — library, registries, and
// active-pack selection. It cannot render packs or reach the voice pipeline
// (the panel and desktop windows have their own narrower bridges).

const { contextBridge, ipcRenderer } = require('electron');

// SECURITY: preloads run in every frame, including the sandboxed <iframe> a
// module component renders inside the manager's live pack preview. This bridge
// is the most powerful in the app (installs, registries, reminder CRUD,
// assistant config) — expose it to the top frame ONLY, never to a pack's
// untrusted module code. See preload-dashboard.js for the full rationale.
const bridge = {
  version: '0.4.0',

  libraryState: () => ipcRenderer.invoke('aegis:library:state'),
  // Live previews render packs through the shared renderer, so the manager
  // needs the same read-only data services the desktop surface has.
  packLoad: (id) => ipcRenderer.invoke('aegis:packs:load', String(id)),
  stats: () => ipcRenderer.invoke('aegis:stats'),
  weather: (opts) => ipcRenderer.invoke('aegis:weather', { lat: Number(opts.lat), lon: Number(opts.lon) }),
  notifications: () => ipcRenderer.invoke('aegis:notifications'),
  display: () => ipcRenderer.invoke('aegis:display'),
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

  // Launcher pins — managed here, displayed by the wallpaper component.
  launcherState: (opts) => ipcRenderer.invoke('aegis:launcher:state', { running: Boolean(opts && opts.running) }),
  launcherApps: () => ipcRenderer.invoke('aegis:launcher:apps'),
  launcherPinApp: (id) => ipcRenderer.invoke('aegis:launcher:pinApp', String(id)),
  launcherPinPath: (kind) => ipcRenderer.invoke('aegis:launcher:pinPath', { kind: String(kind) }),
  launcherUnpin: (id) => ipcRenderer.invoke('aegis:launcher:unpin', String(id)),
  launcherPinMove: (id, delta) => ipcRenderer.invoke('aegis:launcher:pinMove', { id: String(id), delta: Number(delta) }),
  onLauncherChanged: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('aegis:launcher:changed', handler);
    return () => ipcRenderer.removeListener('aegis:launcher:changed', handler);
  },

  // AI assistant settings — the API key is set here but never read back
  // (config get returns hasKey only; the key stays encrypted in main).
  assistantConfigGet: () => ipcRenderer.invoke('aegis:assistant:config:get'),
  assistantConfigSet: (patch) => ipcRenderer.invoke('aegis:assistant:config:set', patch),
  assistantModels: () => ipcRenderer.invoke('aegis:assistant:models'),
  assistantAsk: (prompt) => ipcRenderer.invoke('aegis:assistant:ask', String(prompt)),
  assistantReset: () => ipcRenderer.invoke('aegis:assistant:reset'),
  voiceProfilesList: () => ipcRenderer.invoke('aegis:profiles:list'),
};

if (window.top === window) contextBridge.exposeInMainWorld('aegis', bridge);
