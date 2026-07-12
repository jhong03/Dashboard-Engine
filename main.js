'use strict';

// Electron main process. Wallpaper Engine model (M3): on launch the active
// persona pack renders straight onto the DESKTOP (a frameless window
// reparented under the shell's wallpaper layer on Windows), and the app
// window is the MANAGER — the library for browsing/installing/selecting
// content. The M1 voice tuning panel opens from the manager or `npm run
// panel`. All pipeline/pack work happens behind the validated IPC handlers
// in lib/ipc.js — renderers never touch Node.

const { app, BrowserWindow, screen, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const voicebank = require('./lib/voicebank');
const packs = require('./lib/packs');
const settings = require('./lib/settings');
const { registerIpcHandlers } = require('./lib/ipc');
const { userDataDir } = require('./lib/paths');

const USER_DIR = userDataDir();

// `npm run panel` / the selftest open only the tuning panel.
// DE_* env vars are canonical since the rebrand; legacy AEGIS_* still work.
const envFlag = (name) => process.env[`DE_${name}`] ?? process.env[`AEGIS_${name}`];
const WANT_PANEL = envFlag('SELFTEST') === '1' || process.argv.includes('--panel');
if (WANT_PANEL) {
  // Tool modes run alongside a live engine instance; give Chromium its own
  // profile dir so the two don't fight over cache/profile locks. (Pack and
  // settings storage is unaffected — that lives in lib/paths userDataDir.)
  app.setPath('userData', path.join(app.getPath('temp'), 'dashboard-engine-tool'));
}
// `--no-desktop` keeps the dashboard in a normal window (useful over RDP or
// for debugging the desktop layer itself).
const NO_DESKTOP = process.argv.includes('--no-desktop');

let panelWindow = null;
let managerWindow = null;
let dashboardWindow = null;
let editorWindow = null;
let tray = null;
let desktopPaused = false;

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
    query: { selftest: envFlag('SELFTEST') === '1' ? '1' : '0' },
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
    query: { view: envFlag('VIEW') || '' },
  });
  managerWindow.on('closed', () => { managerWindow = null; });
}

function createEditorWindow(packId) {
  if (editorWindow) {
    editorWindow.focus();
    return;
  }
  editorWindow = new BrowserWindow({
    width: 1380,
    height: 860,
    minWidth: 1200,
    minHeight: 720,
    backgroundColor: '#04080F',
    webPreferences: {
      ...COMMON_WEB_PREFERENCES,
      preload: path.join(__dirname, 'preload-editor.js'),
    },
  });
  editorWindow.loadFile(path.join(__dirname, 'src', 'editor.html'), {
    query: { pack: packId || 'aegis-holo' },
  });
  editorWindow.on('closed', () => { editorWindow = null; });
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
    query: { pack: envFlag('PACK') || '' },
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

// Broadcast an active-pack change to every window that cares — the desktop
// repaints, the manager updates its indicator and badges.
function notifyActivePack(id) {
  for (const win of [dashboardWindow, managerWindow]) {
    if (win && !win.isDestroyed()) win.webContents.send('aegis:active:changed', { id });
  }
}

function setActivePackFromTray(id) {
  settings.setActivePack(USER_DIR, id);
  notifyActivePack(id);
}

function toggleDesktop() {
  if (!dashboardWindow || dashboardWindow.isDestroyed()) return;
  desktopPaused = !desktopPaused;
  if (desktopPaused) dashboardWindow.hide();
  else dashboardWindow.show();
}

// ── Tray: the engine's home. Menu is rebuilt on every right-click so the
// pack list and the active radio are always current — Wallpaper Engine
// habits, Dashboard Engine contents.
function buildTrayMenu() {
  const listed = packs.listPacks(__dirname, USER_DIR);
  const active = settings.getActivePack(USER_DIR) || 'aegis-holo';
  return Menu.buildFromTemplate([
    { label: 'Open Manager', click: createManagerWindow },
    { label: 'Voice Tuning', click: createPanelWindow },
    { type: 'separator' },
    {
      label: 'Switch Pack',
      submenu: listed.packs.map((p) => ({
        label: p.name,
        type: 'radio',
        checked: p.id === active,
        click: () => setActivePackFromTray(p.id),
      })),
    },
    { label: desktopPaused ? 'Resume Desktop' : 'Pause Desktop', click: toggleDesktop },
    { type: 'separator' },
    { label: 'Quit Dashboard Engine', click: () => app.quit() },
  ]);
}

function createTray() {
  tray = new Tray(nativeImage.createFromPath(path.join(__dirname, 'resources', 'tray-icon.png')));
  tray.setToolTip('Dashboard Engine');
  tray.on('click', createManagerWindow);
  tray.on('right-click', () => tray.popUpContextMenu(buildTrayMenu()));
}

// Licence rule (voices.json): a voice without a verified licence is never
// silently shipped. loadManifest never throws.
function warnAboutUnauditedVoices() {
  const manifest = voicebank.loadManifest(__dirname);
  for (const w of [...manifest.warnings, ...voicebank.auditWarnings(manifest)]) {
    console.warn(`[voicebank] ${w}`);
  }
}

// DE_SHOT=<dir>: dev utility — after the windows settle, capture each
// window's page to <dir>/<name>.png via Electron's own compositor (works
// while occluded, steals no focus), then quit. Used by tooling/tests only.
function scheduleDevShots(dir) {
  setTimeout(async () => {
    const fs = require('fs');
    fs.mkdirSync(dir, { recursive: true });
    const targets = [
      ['manager', managerWindow], ['editor', editorWindow],
      ['panel', panelWindow], ['dashboard', dashboardWindow],
    ];
    for (const [name, win] of targets) {
      if (!win || win.isDestroyed()) continue;
      try {
        // Occluded windows are compositor-throttled and capture empty —
        // wake them without stealing the user's focus.
        win.webContents.setBackgroundThrottling(false);
        win.showInactive();
        win.moveTop();
        await new Promise((resolve) => setTimeout(resolve, 500));
        const image = await win.webContents.capturePage();
        fs.writeFileSync(path.join(dir, `${name}.png`), image.toPNG());
      } catch (err) {
        console.warn(`[devshot] ${name}: ${err.message}`);
      }
    }
    app.quit();
  }, 6000);
}

function openFirstWindows() {
  if (WANT_PANEL) {
    createPanelWindow();
    return;
  }
  createDashboardWindow(); // the desktop persona, immediately
  createManagerWindow();   // the engine app: content navigation + selection
  const editAt = process.argv.indexOf('--edit');
  if (editAt !== -1) createEditorWindow(process.argv[editAt + 1] || 'aegis-holo');
}

// One engine instance owns the desktop; a second launch just re-opens the
// manager (so closing the manager doesn't strand the desktop persona).
// Panel/selftest launches are tools, not the engine — they skip the lock so
// they can run alongside a live desktop.
if (!WANT_PANEL && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (event, argv) => {
    if (WANT_PANEL) return;
    // `dashboard-engine --edit <id>` from a second launch opens the editor here.
    const editAt = argv.indexOf('--edit');
    if (editAt !== -1) createEditorWindow(argv[editAt + 1] || 'aegis-holo');
    else createManagerWindow();
  });

  app.whenReady().then(() => {
    warnAboutUnauditedVoices();
    registerIpcHandlers(__dirname, USER_DIR, {
      openPanel: createPanelWindow,
      openEditor: createEditorWindow,
      onActivePack: notifyActivePack,
      onRemindersChanged: () => {
        // Calendars/agendas repaint everywhere reminders show.
        for (const win of [dashboardWindow, editorWindow, managerWindow]) {
          if (win && !win.isDestroyed()) win.webContents.send('aegis:reminders:changed');
        }
      },
    });
    if (!WANT_PANEL) createTray();
    openFirstWindows();
    if (envFlag('SHOT')) scheduleDevShots(envFlag('SHOT'));
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) openFirstWindows();
    });
  });

  app.on('window-all-closed', () => {
    // Engine mode lives in the tray — closing windows never kills the
    // desktop persona; Quit is in the tray menu. Tool mode (panel/selftest)
    // quits with its window, which the selftest relies on.
    if (WANT_PANEL && process.platform !== 'darwin') app.quit();
  });
}
