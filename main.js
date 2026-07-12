'use strict';

// Electron main process. Wallpaper Engine model (M3): on launch the active
// persona pack renders straight onto the DESKTOP (a frameless window
// reparented under the shell's wallpaper layer on Windows), and the app
// window is the MANAGER — the library for browsing/installing/selecting
// content. The M1 voice tuning panel opens from the manager or `npm run
// panel`. All pipeline/pack work happens behind the validated IPC handlers
// in lib/ipc.js — renderers never touch Node.

const { app, BrowserWindow, screen } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const voicebank = require('./lib/voicebank');
const { registerIpcHandlers } = require('./lib/ipc');
const { userDataDir } = require('./lib/paths');

// `npm run panel` / the selftest open only the tuning panel.
const WANT_PANEL = process.env.AEGIS_SELFTEST === '1' || process.argv.includes('--panel');
if (WANT_PANEL) {
  // Tool modes run alongside a live engine instance; give Chromium its own
  // profile dir so the two don't fight over cache/profile locks. (Pack and
  // settings storage is unaffected — that lives in lib/paths userDataDir.)
  app.setPath('userData', path.join(app.getPath('temp'), 'aegis-voice-tool'));
}
// `--no-desktop` keeps the dashboard in a normal window (useful over RDP or
// for debugging the desktop layer itself).
const NO_DESKTOP = process.argv.includes('--no-desktop');

let panelWindow = null;
let managerWindow = null;
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
  panelWindow.loadFile(path.join(__dirname, 'src', 'index.html'), {
    query: { selftest: process.env.AEGIS_SELFTEST === '1' ? '1' : '0' },
  });
  panelWindow.on('closed', () => { panelWindow = null; });
}

function createManagerWindow() {
  if (managerWindow) {
    managerWindow.focus();
    return;
  }
  managerWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 940,
    minHeight: 600,
    backgroundColor: '#04080F',
    webPreferences: {
      ...COMMON_WEB_PREFERENCES,
      preload: path.join(__dirname, 'preload-manager.js'),
    },
  });
  managerWindow.loadFile(path.join(__dirname, 'src', 'manager.html'), {
    query: { view: process.env.AEGIS_VIEW || '' },
  });
  managerWindow.on('closed', () => { managerWindow = null; });
}

// Reparent the dashboard under the shell's wallpaper layer. The hwnd is
// program-generated; the PowerShell argv is fixed (CLAUDE.md shell rule).
function attachToDesktop(win) {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') {
      resolve(false);
      return;
    }
    const handle = win.getNativeWindowHandle();
    const hwnd = handle.length >= 8 ? handle.readBigUInt64LE(0) : BigInt(handle.readUInt32LE(0));
    const child = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', path.join(__dirname, 'scripts', 'desktop-attach.ps1'),
      hwnd.toString(),
    ], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });

    let out = '';
    child.stdout.on('data', (chunk) => { out += chunk.toString('utf8'); });
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0 && out.includes('attached:')));
  });
}

async function createDashboardWindow() {
  if (dashboardWindow) return;
  const display = screen.getPrimaryDisplay();

  dashboardWindow = new BrowserWindow({
    x: display.bounds.x,
    y: display.bounds.y,
    width: display.bounds.width,
    height: display.bounds.height,
    frame: false,
    resizable: false,
    movable: false,
    skipTaskbar: true,
    focusable: false,
    show: false,
    backgroundColor: '#04080F',
    webPreferences: {
      ...COMMON_WEB_PREFERENCES,
      preload: path.join(__dirname, 'preload-dashboard.js'),
    },
  });
  dashboardWindow.loadFile(path.join(__dirname, 'src', 'dashboard.html'), {
    query: { pack: process.env.AEGIS_PACK || '' },
  });
  dashboardWindow.on('closed', () => { dashboardWindow = null; });

  await new Promise((resolve) => dashboardWindow.once('ready-to-show', resolve));
  dashboardWindow.show();

  if (!NO_DESKTOP) {
    const attached = await attachToDesktop(dashboardWindow);
    if (attached) return;
    console.warn('[desktop] could not attach to the wallpaper layer; falling back to a normal window.');
  }
  // Fallback (non-Windows, RDP, or a shell change): a normal resizable
  // window instead of a hidden fullscreen one lurking behind everything.
  if (dashboardWindow) {
    dashboardWindow.setFocusable(true);
    dashboardWindow.setSkipTaskbar(false);
    dashboardWindow.setResizable(true);
    dashboardWindow.setBounds({ width: 1180, height: 760, x: display.bounds.x + 60, y: display.bounds.y + 60 });
  }
}

// Licence rule (voices.json): a voice without a verified licence is never
// silently shipped. loadManifest never throws.
function warnAboutUnauditedVoices() {
  const manifest = voicebank.loadManifest(__dirname);
  for (const w of [...manifest.warnings, ...voicebank.auditWarnings(manifest)]) {
    console.warn(`[voicebank] ${w}`);
  }
}

function openFirstWindows() {
  if (WANT_PANEL) {
    createPanelWindow();
    return;
  }
  createDashboardWindow(); // the desktop persona, immediately
  createManagerWindow();   // the engine app: content navigation + selection
}

// One engine instance owns the desktop; a second launch just re-opens the
// manager (so closing the manager doesn't strand the desktop persona).
// Panel/selftest launches are tools, not the engine — they skip the lock so
// they can run alongside a live desktop.
if (!WANT_PANEL && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!WANT_PANEL) createManagerWindow();
  });

  app.whenReady().then(() => {
    warnAboutUnauditedVoices();
    registerIpcHandlers(__dirname, userDataDir(), {
      openPanel: createPanelWindow,
      onActivePack: (id) => {
        if (dashboardWindow && !dashboardWindow.isDestroyed()) {
          dashboardWindow.webContents.send('aegis:active:changed', { id });
        }
      },
    });
    openFirstWindows();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) openFirstWindows();
    });
  });

  app.on('window-all-closed', () => {
    // macOS convention: app stays alive without windows.
    if (process.platform !== 'darwin') app.quit();
  });
}
