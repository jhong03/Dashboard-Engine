'use strict';

// Electron main process. M2: the dashboard (persona pack renderer) is the
// primary window; the M1 voice tuning panel opens on demand (its button in
// the dashboard, `npm run panel`, or the selftest). All pipeline and pack
// work happens behind the validated IPC handlers in lib/ipc.js — per
// CLAUDE.md the renderers never touch Node.

const { app, BrowserWindow } = require('electron');
const path = require('path');
const voicebank = require('./lib/voicebank');
const { registerIpcHandlers } = require('./lib/ipc');
const { userDataDir } = require('./lib/paths');

// `npm run panel` / the selftest open the tuning panel as the first window.
const WANT_PANEL = process.env.AEGIS_SELFTEST === '1' || process.argv.includes('--panel');

let panelWindow = null;
let dashboardWindow = null;

const COMMON_WEB_PREFERENCES = {
  // Non-negotiable (CLAUDE.md): the renderer never touches Node.
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
};

function createPanelWindow() {
  if (panelWindow) {
    panelWindow.focus();
    return;
  }
  panelWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 1100, // design floor — the panel layout must never break under 1100px
    backgroundColor: '#04080F',
    webPreferences: {
      ...COMMON_WEB_PREFERENCES,
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  // AEGIS_SELFTEST=1 makes the renderer run a scripted synth pass and quit —
  // the automated end-to-end check behind `npm run selftest`.
  panelWindow.loadFile(path.join(__dirname, 'src', 'index.html'), {
    query: { selftest: process.env.AEGIS_SELFTEST === '1' ? '1' : '0' },
  });
  panelWindow.on('closed', () => { panelWindow = null; });
}

function createDashboardWindow() {
  if (dashboardWindow) {
    dashboardWindow.focus();
    return;
  }
  dashboardWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 820,  // the pack grid scales; this floor just keeps widgets legible
    minHeight: 560,
    backgroundColor: '#04080F',
    webPreferences: {
      ...COMMON_WEB_PREFERENCES,
      preload: path.join(__dirname, 'preload-dashboard.js'),
    },
  });
  // AEGIS_PACK preselects a pack — the author preview loop
  // (AEGIS_PACK=my-pack npm start while editing packs/my-pack/pack.json).
  dashboardWindow.loadFile(path.join(__dirname, 'src', 'dashboard.html'), {
    query: { pack: process.env.AEGIS_PACK || '' },
  });
  dashboardWindow.on('closed', () => { dashboardWindow = null; });
}

// Licence rule (voices.json): a voice without a verified licence is never
// silently shipped. loadManifest never throws, so this cannot take the
// window down.
function warnAboutUnauditedVoices() {
  const manifest = voicebank.loadManifest(__dirname);
  for (const w of [...manifest.warnings, ...voicebank.auditWarnings(manifest)]) {
    console.warn(`[voicebank] ${w}`);
  }
}

function openFirstWindow() {
  if (WANT_PANEL) createPanelWindow();
  else createDashboardWindow();
}

app.whenReady().then(() => {
  warnAboutUnauditedVoices();
  // lib/paths mirrors Electron's default userData; using it everywhere keeps
  // the CLI tools and the app pointed at the same installed packs.
  registerIpcHandlers(__dirname, userDataDir(), { openPanel: createPanelWindow });
  openFirstWindow();
  app.on('activate', () => {
    // macOS convention: re-create the window on dock click.
    if (BrowserWindow.getAllWindows().length === 0) openFirstWindow();
  });
});

app.on('window-all-closed', () => {
  // macOS convention: app stays alive without windows.
  if (process.platform !== 'darwin') app.quit();
});
