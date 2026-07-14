'use strict';

// Assistant chat preload: ask the configured model, speak replies through the
// tuned voice, read the non-secret config (hasKey/provider/speak). The API
// key never crosses this bridge — it stays encrypted in main.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('aegis', {
  version: '0.4.0',
  configGet: () => ipcRenderer.invoke('aegis:assistant:config:get'),
  ask: (prompt) => ipcRenderer.invoke('aegis:assistant:ask', String(prompt)),
  speak: (text) => ipcRenderer.invoke('aegis:assistant:speak', String(text)),
  reset: () => ipcRenderer.invoke('aegis:assistant:reset'),
  openManager: () => ipcRenderer.invoke('aegis:open-manager'),
  // Grow/shrink the docked console bar (main owns the actual window bounds).
  resize: (expanded) => ipcRenderer.invoke('aegis:console:resize', Boolean(expanded)),
  // Pack-console click asks us to expand + focus the input.
  onSummon: (callback) => ipcRenderer.on('aegis:console:summon', () => callback()),
});
