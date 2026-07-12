'use strict';

// Renderer, Stage 1: nothing to do yet. The tuning panel (Stage 4) builds on
// the window.aegis bridge exposed by preload.js — never on Node APIs, which
// are unreachable here by design (contextIsolation, no nodeIntegration).

console.log(`AEGIS voice panel scaffold — bridge v${window.aegis?.version ?? 'missing'}`);
