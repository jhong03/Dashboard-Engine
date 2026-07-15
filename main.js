'use strict';

// Electron main process. Wallpaper Engine model (M3): on launch the active
// persona pack renders straight onto the DESKTOP (a frameless window
// reparented under the shell's wallpaper layer on Windows), and the app
// window is the MANAGER — the library for browsing/installing/selecting
// content. The M1 voice tuning panel opens from the manager or `npm run
// panel`. All pipeline/pack work happens behind the validated IPC handlers
// in lib/ipc.js — renderers never touch Node.

const { app, BrowserWindow, screen, Tray, Menu, nativeImage, Notification } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const voicebank = require('./lib/voicebank');
const packs = require('./lib/packs');
const settings = require('./lib/settings');
const { registerIpcHandlers } = require('./lib/ipc');
const { createAlertScheduler } = require('./lib/alerts');
const { userDataDir } = require('./lib/paths');

const USER_DIR = userDataDir();

// Windows routes toast notifications by AppUserModelID; without one set,
// planner alerts never reach the Action Center.
app.setAppUserModelId('com.dashboardengine.app');

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
let assistantWindow = null;
let tray = null;
let desktopPaused = false;
let alertScheduler = null;

const COMMON_WEB_PREFERENCES = {
  // Non-negotiable (CLAUDE.md): the renderer never touches Node.
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
};

// On Windows, focus() is a no-op for minimized OR hidden windows (a process
// launched with a hide-window startup hint hides its first window) — always
// restore + show first, or the tray click "does nothing".
function bringToFront(win) {
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createPanelWindow() {
  if (panelWindow) {
    bringToFront(panelWindow);
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
    bringToFront(managerWindow);
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
    bringToFront(editorWindow);
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
    query: { pack: packId || 'jarvis' },
  });
  editorWindow.on('closed', () => { editorWindow = null; });
}

// The assistant console: a persistent, always-visible docked bar along the
// bottom of the primary display (like the original JARVIS console) — NOT a
// popup. The desktop surface is focusable:false and can't take keyboard
// input, so the console is its own real window. It starts as a slim bar and
// expands upward to show the conversation; it never auto-hides.
const CONSOLE_COLLAPSED_H = 58;
const CONSOLE_EXPANDED_H = 440;

// The console window is positioned OVER the active pack's `assistant`
// component (its screen rect), so the one interactive bar sits exactly where
// the pack draws its console — matching what the editor shows, no phantom
// second bar. Null when the pack has no assistant component (→ no console).
let consoleHome = null; // { x, y, w, h } in screen px, or null

function computeConsoleHome(pack) {
  const comp = pack.components.find((c) => c.type === 'assistant');
  if (!comp) return null;
  const disp = screen.getPrimaryDisplay();
  const b = disp.bounds, wa = disp.workArea;
  const pad = (pack.canvas && pack.canvas.padding) || 0;
  const inner = (100 - 2 * pad) / 100; // components are % within the padded canvas
  const [rx, ry, rw, rh] = comp.rect;
  const x = Math.round(b.x + (pad + rx * inner) / 100 * b.width);
  const w = Math.round(rw * inner / 100 * b.width);
  let h = Math.max(CONSOLE_COLLAPSED_H, Math.round(rh * inner / 100 * b.height));
  let y = Math.round(b.y + (pad + ry * inner) / 100 * b.height);
  const waBottom = wa.y + wa.height; // keep the bar above the taskbar
  if (y + h > waBottom) y = waBottom - h;
  return { x, y, w, h };
}

// Collapsed = the component's own rect; expanded grows upward from its bottom.
function consoleBounds(expanded) {
  if (consoleHome) {
    const h = expanded ? Math.max(consoleHome.h, CONSOLE_EXPANDED_H) : consoleHome.h;
    let y = consoleHome.y + consoleHome.h - h;
    const wa = screen.getPrimaryDisplay().workArea;
    if (y < wa.y) y = wa.y;
    return { x: consoleHome.x, y, width: consoleHome.w, height: h };
  }
  const area = screen.getPrimaryDisplay().workArea; // fallback: full-width bottom
  const h = expanded ? CONSOLE_EXPANDED_H : CONSOLE_COLLAPSED_H;
  return { x: area.x, y: area.y + area.height - h, width: area.width, height: h };
}

function resizeConsole(expanded) {
  if (!assistantWindow || assistantWindow.isDestroyed()) return;
  assistantWindow.setBounds(consoleBounds(expanded));
}

function createAssistantWindow() {
  if (assistantWindow) return;
  assistantWindow = new BrowserWindow({
    ...consoleBounds(false),
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    focusable: true,
    show: false,
    backgroundColor: '#00000000',
    webPreferences: {
      ...COMMON_WEB_PREFERENCES,
      preload: path.join(__dirname, 'preload-assistant.js'),
    },
  });
  assistantWindow.loadFile(path.join(__dirname, 'src', 'assistant.html'));
  // Visible from the start, but don't steal focus — the user clicks to type.
  assistantWindow.once('ready-to-show', () => assistantWindow.showInactive());
  assistantWindow.on('closed', () => { assistantWindow = null; });
}

// Bring the console forward and focus its input (from a pack console click).
function focusAssistant() {
  createAssistantWindow();
  resizeConsole(true);
  assistantWindow.show();
  assistantWindow.focus();
  if (!assistantWindow.webContents.isLoading()) assistantWindow.webContents.send('aegis:console:summon');
  else assistantWindow.webContents.once('did-finish-load', () => assistantWindow.webContents.send('aegis:console:summon'));
}

// The console bar is OPT-IN per pack: it appears only when the active pack
// includes an `assistant` component (visible/placeable in the editor). Packs
// without one get no console. Called on startup and on every pack change.
function syncConsole(packId) {
  let pack = null;
  try { pack = packs.loadPack(__dirname, USER_DIR, packId).pack; } catch { /* no console */ }
  consoleHome = pack ? computeConsoleHome(pack) : null;
  if (!consoleHome) {
    if (assistantWindow && !assistantWindow.isDestroyed()) assistantWindow.hide();
    return;
  }
  createAssistantWindow();
  resizeConsole(false);              // move to the new pack's console position
  if (!assistantWindow.isVisible()) assistantWindow.showInactive();
  // Match the bar's placeholder, button, and accent to the pack so the one
  // console reads as part of the active dashboard (crimson on gothic, etc.).
  const comp = pack.components.find((c) => c.type === 'assistant');
  const cfg = {
    label: comp.options.label || '',
    button: comp.options.button || '',
    name: pack.persona.name || '',
    accent: pack.skin.palette.accent,
    bright: pack.skin.palette.accentBright,
  };
  const send = () => { if (assistantWindow && !assistantWindow.isDestroyed()) assistantWindow.webContents.send('aegis:console:config', cfg); };
  if (assistantWindow.webContents.isLoading()) assistantWindow.webContents.once('did-finish-load', send);
  else send();
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
  syncConsole(id); // show/hide the console bar to match the new pack
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
  const active = settings.getActivePack(USER_DIR) || 'jarvis';
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
    {
      label: assistantWindow && assistantWindow.isVisible() ? 'Hide Assistant Console' : 'Show Assistant Console',
      click: toggleConsole,
    },
    { type: 'separator' },
    { label: 'Quit Dashboard Engine', click: () => app.quit() },
  ]);
}

// Escape hatch: fully hide/show the always-on-top console bar.
function toggleConsole() {
  if (!assistantWindow || assistantWindow.isDestroyed()) { createAssistantWindow(); return; }
  if (assistantWindow.isVisible()) assistantWindow.hide();
  else assistantWindow.showInactive();
}

function createTray() {
  tray = new Tray(nativeImage.createFromPath(path.join(__dirname, 'resources', 'tray-icon.png')));
  tray.setToolTip('Dashboard Engine');
  tray.on('click', () => createManagerWindow());
  tray.on('double-click', () => createManagerWindow());
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
    // Capture the expanded console: drive it through the renderer so the
    // layout (header + log + input) matches, not just the window size.
    if (envFlag('SHOTASSIST') === '1' && assistantWindow && !assistantWindow.isDestroyed()) {
      assistantWindow.webContents.send('aegis:console:summon');
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    const targets = [
      ['manager', managerWindow], ['editor', editorWindow],
      ['panel', panelWindow], ['dashboard', dashboardWindow],
      ['assistant', assistantWindow],
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
  // Console matches whatever the desktop renders (DE_PACK override or active).
  syncConsole(envFlag('PACK') || settings.getActivePack(USER_DIR) || 'jarvis');
  const editAt = process.argv.indexOf('--edit');
  if (editAt !== -1) createEditorWindow(process.argv[editAt + 1] || 'jarvis');
}

// Fail soft (CLAUDE.md): a stray error in main must never crash the engine
// with a raw stack dialog. Log it; the desktop persona stays up.
process.on('uncaughtException', (err) => {
  console.error(`[engine] uncaught exception (survived): ${err.stack || err.message}`);
});

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
    if (editAt !== -1) createEditorWindow(argv[editAt + 1] || 'jarvis');
    else createManagerWindow();
  });

  // Notification click lands the user on the planner.
  function openManagerView(view) {
    createManagerWindow();
    const send = () => {
      if (managerWindow && !managerWindow.isDestroyed()) {
        managerWindow.webContents.send('aegis:show-view', view);
        managerWindow.focus();
      }
    };
    if (managerWindow.webContents.isLoading()) managerWindow.webContents.once('did-finish-load', send);
    else send();
  }

  function notifyReminder(occurrence, minutesLate) {
    if (!Notification.isSupported()) {
      console.warn('[alerts] desktop notifications are not supported on this system');
      return;
    }
    const today = new Date();
    const todayIso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    const when = occurrence.date === todayIso ? `at ${occurrence.time}` : `${occurrence.date} at ${occurrence.time}`;
    const body = minutesLate > 0 ? `Was due ${when} (${minutesLate} min ago)` : `Due ${when}`;
    const notification = new Notification({ title: occurrence.text, body });
    notification.on('click', () => openManagerView('planner'));
    notification.show();
  }

  app.whenReady().then(() => {
    warnAboutUnauditedVoices();
    if (!WANT_PANEL) {
      alertScheduler = createAlertScheduler({ userDir: USER_DIR, notify: notifyReminder });
      alertScheduler.rearm();
    }
    registerIpcHandlers(__dirname, USER_DIR, {
      openPanel: createPanelWindow,
      openEditor: createEditorWindow,
      onActivePack: notifyActivePack,
      onRemindersChanged: () => {
        // Calendars/agendas repaint everywhere reminders show, and the alert
        // timer re-arms against the edited schedule.
        if (alertScheduler) alertScheduler.rearm();
        for (const win of [dashboardWindow, editorWindow, managerWindow]) {
          if (win && !win.isDestroyed()) win.webContents.send('aegis:reminders:changed');
        }
      },
      onLauncherChanged: () => {
        // Pins/recents changed — launcher tiles repaint everywhere they show.
        for (const win of [dashboardWindow, editorWindow, managerWindow]) {
          if (win && !win.isDestroyed()) win.webContents.send('aegis:launcher:changed');
        }
      },
      openAssistant: focusAssistant,
      onConsoleResize: (expanded) => resizeConsole(expanded),
      openManager: (view) => openManagerView(view || 'installed'),
      onPackSaved: (id) => {
        // Editor saved a pack — the desktop repaints if it's showing it.
        if (dashboardWindow && !dashboardWindow.isDestroyed()) {
          dashboardWindow.webContents.send('aegis:packs:changed', { id });
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
