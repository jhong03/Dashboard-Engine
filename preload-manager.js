'use strict';

// Manager preload: the engine app's bridge — library, registries, and
// active-pack selection. It cannot render packs or reach the voice pipeline
// (the panel and desktop windows have their own narrower bridges).

const { contextBridge, ipcRenderer } = require('electron');

// UI language dictionary, fetched SYNCHRONOUSLY so the page has it before it
// renders (no flash of untranslated text). Exposed read-only to the page world;
// src/i18n.js reads window.__i18n. Fail-soft: if unavailable, pages fall back to
// English keys.
try {
  contextBridge.exposeInMainWorld('__i18n', ipcRenderer.sendSync('aegis:i18n:get'));
} catch (e) { /* i18n unavailable — English fallback */ }

// SECURITY: preloads run in every frame, including the sandboxed <iframe> a
// module component renders inside the manager's live pack preview. This bridge
// is the most powerful in the app (installs, registries, reminder CRUD,
// assistant config) — expose it to the top frame ONLY, never to a pack's
// untrusted module code. See preload-dashboard.js for the full rationale.
const bridge = {
  version: '0.4.0',

  // UI language (i18n): list available locales, and set the active one (the
  // renderer reloads to apply the new dictionary).
  i18nList: () => ipcRenderer.invoke('aegis:i18n:list'),
  i18nSet: (code) => ipcRenderer.invoke('aegis:i18n:set', code),

  libraryState: () => ipcRenderer.invoke('aegis:library:state'),
  packThumbnail: (id) => ipcRenderer.invoke('aegis:pack:thumbnail', String(id)),
  // Live previews render packs through the shared renderer, so the manager
  // needs the same read-only data services the desktop surface has.
  // withProps: the manager's previews show the user's customized pack, matching
  // what's on the desktop.
  packLoad: (id) => ipcRenderer.invoke('aegis:packs:load', String(id), { withProps: true }),
  // Per-pack user properties (the "Customize" controls in pack detail).
  userPropsGet: (id) => ipcRenderer.invoke('aegis:userprops:get', String(id)),
  userPropsSet: (packId, key, value) => ipcRenderer.invoke('aegis:userprops:set', { packId: String(packId), key: String(key), value }),
  userPropsReset: (id) => ipcRenderer.invoke('aegis:userprops:reset', String(id)),
  stats: () => ipcRenderer.invoke('aegis:stats'),
  weather: (opts) => ipcRenderer.invoke('aegis:weather', { lat: Number(opts.lat), lon: Number(opts.lon) }),
  notifications: () => ipcRenderer.invoke('aegis:notifications'),
  display: () => ipcRenderer.invoke('aegis:display'),
  installFile: () => ipcRenderer.invoke('aegis:packs:installFile'),
  exportPack: (id) => ipcRenderer.invoke('aegis:packs:export', String(id)),
  uninstallPack: (id) => ipcRenderer.invoke('aegis:packs:uninstall', String(id)),

  // Steam Workshop (prototype). All fail-soft when Steam isn't available.
  workshopStatus: () => ipcRenderer.invoke('aegis:workshop:status'),
  workshopPublish: (req) => ipcRenderer.invoke('aegis:workshop:publish', {
    packId: String(req.packId),
    title: String(req.title || ''),
    description: String(req.description || ''),
    tags: Array.isArray(req.tags) ? req.tags.map(String) : [],
    visibility: String(req.visibility || 'unlisted'),
  }),
  workshopSubscribed: () => ipcRenderer.invoke('aegis:workshop:subscribed'),
  workshopImport: (itemId) => ipcRenderer.invoke('aegis:workshop:import', String(itemId)),
  workshopBrowse: (opts) => ipcRenderer.invoke('aegis:workshop:browse', opts || {}),
  workshopSubscribe: (itemId) => ipcRenderer.invoke('aegis:workshop:subscribe', String(itemId)),
  workshopPreview: (url) => ipcRenderer.invoke('aegis:workshop:preview', String(url)),
  workshopOpen: () => ipcRenderer.invoke('aegis:workshop:open'),
  // Creator management: your published items, and getting an editable copy back.
  workshopMine: () => ipcRenderer.invoke('aegis:workshop:mine'),
  workshopVisibility: (itemId) => ipcRenderer.invoke('aegis:workshop:visibility', String(itemId)),
  workshopGetEditable: (itemId) => ipcRenderer.invoke('aegis:workshop:getEditable', String(itemId)),
  workshopOpenItem: (url) => ipcRenderer.invoke('aegis:workshop:openItem', String(url)),

  // Voice profiles on the Workshop (a separate item type). Publish/manage happens
  // mainly in the tuning panel; the manager browses + consumes + manages them.
  voiceBrowse: (opts) => ipcRenderer.invoke('aegis:voice:browse', opts || {}),
  voiceMine: () => ipcRenderer.invoke('aegis:voice:mine'),
  voiceGetEditable: (itemId) => ipcRenderer.invoke('aegis:voice:getEditable', String(itemId)),
  voiceImport: (itemId) => ipcRenderer.invoke('aegis:voice:import', String(itemId)),
  voicePublish: (req) => ipcRenderer.invoke('aegis:voice:publish', {
    profileFile: String(req.profileFile),
    title: String(req.title || ''),
    description: String(req.description || ''),
    tags: Array.isArray(req.tags) ? req.tags.map(String) : [],
    visibility: String(req.visibility || 'unlisted'),
  }),
  // Download a base voice a subscribed voice depends on (reuses the voice bank).
  bankDownload: (voiceId) => ipcRenderer.invoke('aegis:bank:download', String(voiceId)),
  bankInflight: () => ipcRenderer.invoke('aegis:bank:inflight'),
  onBankProgress: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('aegis:bank:progress', handler);
    return () => ipcRenderer.removeListener('aegis:bank:progress', handler);
  },

  registryAdd: (url) => ipcRenderer.invoke('aegis:registry:add', String(url)),
  registryRemove: (url) => ipcRenderer.invoke('aegis:registry:remove', String(url)),
  registryBrowse: (url) => ipcRenderer.invoke('aegis:registry:browse', String(url)),
  registryPreview: (url) => ipcRenderer.invoke('aegis:registry:preview', String(url)),
  registryInstall: (url, id) => ipcRenderer.invoke('aegis:registry:install', { url: String(url), id: String(id) }),

  activeGet: () => ipcRenderer.invoke('aegis:active:get'),
  activeSet: (id) => ipcRenderer.invoke('aegis:active:set', String(id)),
  // A pack's files changed (editor save, fork, or a hot-reload watcher) — the
  // manager refreshes its library + previews so it never shows a stale pack.
  onPackChanged: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('aegis:packs:changed', handler);
    return () => ipcRenderer.removeListener('aegis:packs:changed', handler);
  },

  // Engine settings — performance (mirrors the tray) + start-with-Windows.
  performanceGet: () => ipcRenderer.invoke('aegis:settings:performance:get'),
  performanceSet: (patch) => ipcRenderer.invoke('aegis:settings:performance:set', patch),
  backgroundMotionGet: () => ipcRenderer.invoke('aegis:settings:backgroundMotion:get'),
  backgroundMotionSet: (patch) => ipcRenderer.invoke('aegis:settings:backgroundMotion:set', patch),
  autoStartGet: () => ipcRenderer.invoke('aegis:settings:autostart:get'),
  autoStartSet: (enabled) => ipcRenderer.invoke('aegis:settings:autostart:set', Boolean(enabled)),
  healthVoiceGet: () => ipcRenderer.invoke('aegis:settings:healthvoice:get'),
  healthVoiceSet: (enabled) => ipcRenderer.invoke('aegis:settings:healthvoice:set', Boolean(enabled)),
  displayGet: () => ipcRenderer.invoke('aegis:settings:display:get'),
  displaySet: (id) => ipcRenderer.invoke('aegis:settings:display:set', id === null ? null : Number(id)),
  onboardedGet: () => ipcRenderer.invoke('aegis:settings:onboarded:get'),
  onboardedSet: (value) => ipcRenderer.invoke('aegis:settings:onboarded:set', value === true),
  weatherLocationGet: () => ipcRenderer.invoke('aegis:settings:weather:get'),
  weatherLocationSet: (query) => ipcRenderer.invoke('aegis:settings:weather:set', query === null ? null : { query: String(query) }),
  openLogs: () => ipcRenderer.invoke('aegis:logs:open'),
  openGuide: () => ipcRenderer.invoke('aegis:guide:open'),
  // App version + bundled third-party license notices (Settings → About).
  licensesGet: () => ipcRenderer.invoke('aegis:licenses:get'),
  licensesOpen: () => ipcRenderer.invoke('aegis:licenses:open'),

  // Background music — the user's own local files, played on the desktop. Main
  // holds the real paths; here we only ever pass opaque track ids.
  musicList: () => ipcRenderer.invoke('aegis:music:list'),
  musicAdd: () => ipcRenderer.invoke('aegis:music:add'),
  musicRemove: (id) => ipcRenderer.invoke('aegis:music:remove', String(id)),
  musicEnabled: (on) => ipcRenderer.invoke('aegis:music:enabled', Boolean(on)),
  musicVolume: (v) => ipcRenderer.invoke('aegis:music:volume', Number(v)),

  // From-scratch pack builder: import a wallpaper (staged in main, returns a
  // preview data URI + rel), then create the assembled pack and open it.
  builderImportImage: (existingNames) => ipcRenderer.invoke('aegis:editor:importImage', existingNames || []),
  builderImportVideo: (existingNames) => ipcRenderer.invoke('aegis:editor:importVideo', existingNames || []),
  builderCreate: (pack, openInEditor = true) => ipcRenderer.invoke('aegis:builder:create', { pack, openInEditor }),
  onDisplaysChanged: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('aegis:displays:changed', handler);
    return () => ipcRenderer.removeListener('aegis:displays:changed', handler);
  },
  onActiveChanged: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('aegis:active:changed', handler);
    return () => ipcRenderer.removeListener('aegis:active:changed', handler);
  },
  onMusicChanged: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('aegis:music:changed', handler);
    return () => ipcRenderer.removeListener('aegis:music:changed', handler);
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
  assistantSpeak: (text) => ipcRenderer.invoke('aegis:assistant:speak', String(text)),
  assistantPresetAdd: (name, prompt) => ipcRenderer.invoke('aegis:assistant:preset:add', { name: String(name), prompt: String(prompt) }),
  assistantPresetRemove: (name) => ipcRenderer.invoke('aegis:assistant:preset:remove', String(name)),
  voiceProfilesList: () => ipcRenderer.invoke('aegis:profiles:list'),
  voicePresetsList: () => ipcRenderer.invoke('aegis:presets:list'),
  // Which voice packs are installed — the assistant voice/persona pickers gate
  // uninstalled languages by it.
  bankList: () => ipcRenderer.invoke('aegis:bank:list'),
  voicePrewarm: (voiceId) => ipcRenderer.invoke('aegis:voice:prewarm', String(voiceId)),
};

if (window.top === window) contextBridge.exposeInMainWorld('aegis', bridge);
