'use strict';

// Preload: the ONLY bridge between renderer and main. An explicit allowlist —
// each entry wraps exactly one IPC channel with coerced arguments. No generic
// ipcRenderer passthrough, no channel names taken from the renderer, and
// event subscriptions hand the renderer plain data, never Electron objects.

const { contextBridge, ipcRenderer } = require('electron');

// UI language dictionary, fetched SYNCHRONOUSLY so the page has it before it
// renders (no flash of untranslated text). Exposed read-only to the page world;
// src/i18n.js reads window.__i18n. Fail-soft: if unavailable, pages fall back to
// English keys.
try {
  contextBridge.exposeInMainWorld('__i18n', ipcRenderer.sendSync('aegis:i18n:get'));
} catch (e) { /* i18n unavailable — English fallback */ }

contextBridge.exposeInMainWorld('aegis', {
  version: '0.4.0',

  // UI language (i18n): list available locales, and set the active one (the
  // renderer reloads to apply the new dictionary).
  i18nList: () => ipcRenderer.invoke('aegis:i18n:list'),
  i18nSet: (code) => ipcRenderer.invoke('aegis:i18n:set', code),

  ranges: () => ipcRenderer.invoke('aegis:ranges'),
  env: () => ipcRenderer.invoke('aegis:env'),

  bankList: () => ipcRenderer.invoke('aegis:bank:list'),
  bankDownload: (voiceId) => ipcRenderer.invoke('aegis:bank:download', String(voiceId)),
  // Downloads run in main and survive this window closing; this restores the
  // in-progress bars when the window reopens mid-download.
  bankInflight: () => ipcRenderer.invoke('aegis:bank:inflight'),
  onBankProgress: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('aegis:bank:progress', handler);
    return () => ipcRenderer.removeListener('aegis:bank:progress', handler);
  },

  presetsList: () => ipcRenderer.invoke('aegis:presets:list'),

  profilesList: () => ipcRenderer.invoke('aegis:profiles:list'),
  profileLoad: (file) => ipcRenderer.invoke('aegis:profiles:load', String(file)),
  profileSave: (profile) => ipcRenderer.invoke('aegis:profiles:save', profile),

  synthesize: (profile, text) => ipcRenderer.invoke('aegis:test:synthesize', { profile, text: String(text) }),
  speakFallback: (text, voiceHint) => ipcRenderer.invoke('aegis:test:fallback', { text: String(text), voiceHint: String(voiceHint || '') }),
  // Warm the neural HD engine in the background so the first Synthesize isn't a cold start.
  voicePrewarm: (voiceId) => ipcRenderer.invoke('aegis:voice:prewarm', String(voiceId)),

  // Publish the SAVED voice profile to the Steam Workshop (auditory profile only —
  // parameters, never audio). workshopStatus gates the button; voicePublishable
  // refuses factory presets / imported voices.
  workshopStatus: () => ipcRenderer.invoke('aegis:workshop:status'),
  voicePublishable: (file) => ipcRenderer.invoke('aegis:voice:publishable', String(file)),
  voicePublish: (req) => ipcRenderer.invoke('aegis:voice:publish', {
    profileFile: String(req.profileFile),
    title: String(req.title || ''),
    description: String(req.description || ''),
    tags: Array.isArray(req.tags) ? req.tags.map(String) : [],
    visibility: String(req.visibility || 'unlisted'),
  }),
});
