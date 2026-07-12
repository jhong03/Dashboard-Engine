'use strict';

// Electron main process. Stages 1–2: a window shell plus the voice-bank
// licence check — the synthesis pipeline lives in lib/ and is exercised by
// `npm run smoke`; the bank by `npm run voices`. IPC handlers that bridge
// the renderer to the pipeline arrive with the UI (Stage 4); per CLAUDE.md
// every one of them must validate its input.

const { app, BrowserWindow } = require('electron');
const path = require('path');
const voicebank = require('./lib/voicebank');

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 1100, // design floor — layout must never break under 1100px
    backgroundColor: '#04080F',
    webPreferences: {
      // Non-negotiable (CLAUDE.md): the renderer never touches Node.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  win.loadFile(path.join(__dirname, 'src', 'index.html'));
}

// Licence rule (voices.json): a voice without a verified licence is never
// silently shipped. Until the Stage 4 UI can surface this, log it loudly.
// loadManifest never throws, so this cannot take the window down.
function warnAboutUnauditedVoices() {
  const manifest = voicebank.loadManifest(__dirname);
  for (const w of [...manifest.warnings, ...voicebank.auditWarnings(manifest)]) {
    console.warn(`[voicebank] ${w}`);
  }
}

app.whenReady().then(() => {
  warnAboutUnauditedVoices();
  createWindow();
  app.on('activate', () => {
    // macOS convention: re-create the window on dock click.
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  // macOS convention: app stays alive without windows.
  if (process.platform !== 'darwin') app.quit();
});
