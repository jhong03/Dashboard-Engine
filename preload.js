'use strict';

// Preload: the ONLY bridge between renderer and main. An explicit allowlist —
// each entry wraps exactly one IPC channel with coerced arguments. No generic
// ipcRenderer passthrough, no channel names taken from the renderer, and
// event subscriptions hand the renderer plain data, never Electron objects.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('aegis', {
  version: '0.4.0',

  ranges: () => ipcRenderer.invoke('aegis:ranges'),
  env: () => ipcRenderer.invoke('aegis:env'),

  bankList: () => ipcRenderer.invoke('aegis:bank:list'),
  bankDownload: (voiceId) => ipcRenderer.invoke('aegis:bank:download', String(voiceId)),
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
});
