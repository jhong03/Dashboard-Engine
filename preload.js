'use strict';

// Preload: the ONLY bridge between renderer and main. Stage 1 exposes nothing
// but a version marker; the tuning API (synthesize, profiles, voice bank)
// lands here in Stage 4 as an explicit, validated allowlist — never a
// generic ipcRenderer passthrough.

const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('aegis', {
  version: '0.1.0',
});
