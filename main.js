'use strict';

// Electron main process. Wallpaper Engine model (M3): on launch the active
// persona pack renders straight onto the DESKTOP (a frameless window
// reparented under the shell's wallpaper layer on Windows), and the app
// window is the MANAGER — the library for browsing/installing/selecting
// content. The M1 voice tuning panel opens from the manager or `npm run
// panel`. All pipeline/pack work happens behind the validated IPC handlers
// in lib/ipc.js — renderers never touch Node.

const { app, BrowserWindow, screen, Tray, Menu, nativeImage, Notification, protocol, powerMonitor, session, crashReporter } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const { createPresenceMonitor } = require('./lib/presence');
const voicebank = require('./lib/voicebank');
const packs = require('./lib/packs');
const settings = require('./lib/settings');
const logger = require('./lib/logger');
const { registerIpcHandlers } = require('./lib/ipc');
const { createAlertScheduler } = require('./lib/alerts');
const { userDataDir } = require('./lib/paths');

const USER_DIR = userDataDir();

// Crash reporting, privacy-first: collect NATIVE crash minidumps locally and
// NEVER upload them (there is no server, and nothing about this app should phone
// home). Combined with lib/logger, a user who hits a crash has a local trail to
// share if they choose to. Must start before the app is ready.
try {
  crashReporter.start({ uploadToServer: false });
} catch (err) {
  // Non-fatal — the JS-level logging below still works without native dumps.
  console.error(`[engine] crashReporter unavailable: ${err.message}`);
}
function logEngine(level, message) {
  logger.write(USER_DIR, level, message);
}

// Windows routes toast notifications by AppUserModelID; without one set,
// planner alerts never reach the Action Center.
app.setAppUserModelId('com.dashboardengine.app');

// Sandboxed module components render from `demodule://` (registered below).
// A custom scheme is NOT a "local scheme" (unlike data:/srcdoc), so its
// document does NOT inherit the strict CSP of the page that embeds it —
// letting a module run its own inline code under its OWN permissive-but-
// network-less policy, while the trusted desktop/editor pages keep their
// locked-down `script-src 'self'`. Must be declared before app is ready.
const MODULE_SCHEME = 'demodule';
// The policy served with every module document: inline script/style for the
// designer's own code, images/fonts/media only as data: URIs, and — critically —
// NO network of any kind (no default-src, so no connect/fetch/websocket).
const MODULE_DOC_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data:",
  "font-src data:",
  "media-src data:",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');
protocol.registerSchemesAsPrivileged([{
  scheme: MODULE_SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: false, corsEnabled: false, stream: false },
}]);

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

// The OS login item launches us with this marker (see loginItemOptions) so the
// engine can start QUIETLY to the tray at sign-in — no manager window popping
// up on every boot. A manual launch (or a tray "Open Manager") has no marker.
const AUTOSTART_FLAG = '--autostart';
const LAUNCHED_AT_LOGIN = process.argv.includes(AUTOSTART_FLAG);

let panelWindow = null;
let managerWindow = null;
let dashboardWindow = null;
let editorWindow = null;
let tray = null;
let desktopPaused = false;
let alertScheduler = null;

// Performance citizenship: pause/throttle the animated wallpaper when a
// full-screen app is up or the machine is on battery (both user-configurable).
let presenceMonitor = null;
let isFullscreen = false;
let onBattery = false;

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

// The assistant console is an in-pack COMPONENT now, not a separate window:
// each pack's `assistant` component IS the real, typeable console (see
// buildAssistant in components.js). The desktop window is made focusable so
// its input can take keyboard focus directly on the wallpaper — no docked
// bar, no overlap, one dialog per dashboard.

// Displays ranked by position (left-to-right, then top-to-bottom). This is the
// SAME ordering desktop-attach.ps1 uses on the Win32 monitor list, so a rank
// here maps to the same physical monitor there.
function rankedDisplays() {
  return screen.getAllDisplays().slice().sort((a, b) =>
    (a.bounds.x - b.bounds.x) || (a.bounds.y - b.bounds.y));
}

// The monitor the wallpaper should render on: the user's pinned display if it
// still exists, else the primary. Returns { display, explicit } — explicit is
// false when we fell back to primary (auto), which the attach path leaves
// unchanged from the long-proven single-monitor behaviour.
function chosenDisplay() {
  const id = settings.getDisplayId(USER_DIR);
  const pinned = id != null && screen.getAllDisplays().find((d) => d.id === id);
  return { display: pinned || screen.getPrimaryDisplay(), explicit: Boolean(pinned) };
}

// Reparent the dashboard under the shell's wallpaper layer, optionally moving it
// onto a specific monitor (rank in rankedDisplays; -1 = leave bounds as set).
// The hwnd is program-generated; the PowerShell argv is fixed (CLAUDE.md rule).
function attachToDesktop(win, monitorIndex = -1) {
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
      hwnd.toString(), String(monitorIndex),
    ], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });

    let out = '';
    child.stdout.on('data', (chunk) => { out += chunk.toString('utf8'); });
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0 && out.includes('attached:')));
  });
}

async function createDashboardWindow() {
  if (dashboardWindow) return;
  const { display, explicit } = chosenDisplay();
  // Only hand the attach script a monitor index when the user explicitly pinned
  // a display; the default/primary path stays byte-for-byte what shipped before.
  const monitorIndex = explicit ? rankedDisplays().findIndex((d) => d.id === display.id) : -1;

  dashboardWindow = new BrowserWindow({
    x: display.bounds.x,
    y: display.bounds.y,
    width: display.bounds.width,
    height: display.bounds.height,
    frame: false,
    resizable: false,
    movable: false,
    skipTaskbar: true,
    // Focusable so the pack's assistant console input can take keyboard focus
    // on the wallpaper. It's shown inactive and never called to focus itself,
    // so it doesn't steal focus from the user's apps.
    focusable: true,
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
  // Push the current power state on first load and every reload/hot-reload, so
  // the renderer starts at the right fps / frozen if a game is already up.
  dashboardWindow.webContents.on('did-finish-load', () => sendDesktopPower());

  await new Promise((resolve) => dashboardWindow.once('ready-to-show', resolve));
  dashboardWindow.showInactive(); // visible, but don't grab focus on launch

  if (!NO_DESKTOP) {
    const attached = await attachToDesktop(dashboardWindow, monitorIndex);
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
  else { dashboardWindow.show(); sendDesktopPower(); }
}

// Tear down and rebuild the desktop window so it re-attaches on the currently
// chosen monitor. Used when the user picks a different display, or when a
// monitor is plugged/unplugged. Cheap enough (the pack re-renders from cache)
// and far simpler than trying to re-parent a live window across monitors.
function relocateDesktop() {
  if (!dashboardWindow || dashboardWindow.isDestroyed()) return;
  const wasPaused = desktopPaused;
  dashboardWindow.destroy();
  dashboardWindow = null;
  desktopPaused = false;
  createDashboardWindow().then(() => {
    if (wasPaused && dashboardWindow && !dashboardWindow.isDestroyed()) {
      desktopPaused = true;
      dashboardWindow.hide();
    }
  });
}

// The display picker's data: every monitor ranked as the attach script sees
// them, flagged with which is primary and which the user pinned.
function listDisplays() {
  const primaryId = screen.getPrimaryDisplay().id;
  const selectedId = settings.getDisplayId(USER_DIR);
  const displays = rankedDisplays().map((d, index) => ({
    id: d.id,
    index,
    primary: d.id === primaryId,
    label: d.label && d.label.trim() ? d.label : `Display ${index + 1}`,
    width: d.bounds.width,
    height: d.bounds.height,
  }));
  return { displays, selectedId };
}

// A monitor was added/removed/reconfigured. If the user's pinned display is
// gone, drop the pin (fall back to primary). Then rebuild so the wallpaper
// lands on the right screen. managerWindow (if open) refreshes its picker.
// Debounced: metrics-changed can fire several times for one change, and each
// relocate rebuilds the window + respawns the attach script.
let displaysChangedTimer = null;
function onDisplaysChanged() {
  clearTimeout(displaysChangedTimer);
  displaysChangedTimer = setTimeout(() => {
    const pinned = settings.getDisplayId(USER_DIR);
    if (pinned != null && !screen.getAllDisplays().find((d) => d.id === pinned)) {
      settings.setDisplayId(USER_DIR, null);
    }
    relocateDesktop();
    if (managerWindow && !managerWindow.isDestroyed()) {
      managerWindow.webContents.send('aegis:displays:changed');
    }
  }, 600);
}

// Performance citizenship: fold the user's prefs together with the live
// full-screen / battery signals and tell the desktop renderer to run at the
// chosen fps or freeze entirely. Freezing stops the wallpaper's animation
// loops (near-zero CPU/GPU) while a game or video owns the screen. No-ops
// without a desktop window.
function sendDesktopPower() {
  if (!dashboardWindow || dashboardWindow.isDestroyed()) return;
  const perf = settings.getPerformance(USER_DIR);
  const shouldPause = (perf.pauseOnFullscreen && isFullscreen) || (perf.pauseOnBattery && onBattery);
  dashboardWindow.webContents.send('aegis:desktop:power', { active: !shouldPause, maxFps: perf.maxFps });
}

// Start the full-screen watcher + battery listeners once, on ready.
function startPresenceMonitoring() {
  try { onBattery = powerMonitor.isOnBatteryPower(); } catch (err) { onBattery = false; }
  powerMonitor.on('on-battery', () => { onBattery = true; sendDesktopPower(); });
  powerMonitor.on('on-ac', () => { onBattery = false; sendDesktopPower(); });
  presenceMonitor = createPresenceMonitor(__dirname, (fullscreen) => {
    isFullscreen = fullscreen;
    sendDesktopPower();
  });
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
    { label: 'Performance', submenu: buildPerformanceMenu() },
    { type: 'separator' },
    { label: 'Quit Dashboard Engine', click: () => app.quit() },
  ]);
}

// Wallpaper-Engine-style performance controls: pause on full-screen apps,
// reduce on battery, and a frame-rate cap. Persisted, applied live.
function buildPerformanceMenu() {
  const perf = settings.getPerformance(USER_DIR);
  const setPerf = (patch) => { settings.setPerformance(USER_DIR, patch); sendDesktopPower(); };
  return [
    { label: 'Pause on full-screen apps', type: 'checkbox', checked: perf.pauseOnFullscreen,
      click: (item) => setPerf({ pauseOnFullscreen: item.checked }) },
    { label: 'Pause on battery', type: 'checkbox', checked: perf.pauseOnBattery,
      click: (item) => setPerf({ pauseOnBattery: item.checked }) },
    { type: 'separator' },
    ...settings.FPS_CHOICES.map((fps) => ({
      label: `${fps} fps${fps === 30 ? ' (recommended)' : ''}`,
      type: 'radio',
      checked: perf.maxFps === fps,
      click: () => setPerf({ maxFps: fps }),
    })),
  ];
}

// Auto-start with the OS (Windows/macOS login item). The login-item / registry
// entry IS the persistence, so state is read straight back from Electron — we
// keep nothing in settings.json. In a dev run (electron .) process.execPath is
// electron.exe, which needs the project path to launch our app; a packaged
// build points at the real binary and needs no extra args. Fail-soft: any
// platform without login-item support just reports "off / unsupported".
//
// CRITICAL: getLoginItemSettings must be queried with the SAME path/args used
// to register, or on Windows it won't recognise its own entry and reports
// openAtLogin:false — the write succeeds but the checkbox reads back unticked.
function loginItemOptions() {
  // The marker rides in BOTH set and get so the Windows registry-entry match
  // stays consistent (getLoginItemSettings must be queried with the same args).
  if (app.isPackaged) return { args: [AUTOSTART_FLAG] };
  return { path: process.execPath, args: [path.resolve(__dirname), AUTOSTART_FLAG] };
}

function getAutoStart() {
  try { return app.getLoginItemSettings(loginItemOptions()).openAtLogin; } catch { return false; }
}

function setAutoStart(enabled) {
  try {
    app.setLoginItemSettings({ openAtLogin: !!enabled, ...loginItemOptions() });
  } catch (err) {
    console.error(`[main] auto-start: ${err.message}`);
  }
  return getAutoStart();
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

// Render a pack to a Workshop preview image, off-screen, using DEMO data only
// (src/shot.* never touches the user's real stats/apps/notifications). Returns
// a temp file path (png, or jpg if the png exceeds Steam's ~1 MB cap) or null
// on any failure — publish then falls back to the pack's wallpaper. Fail-soft.
function renderPackPreview(packId) {
  return new Promise((resolve) => {
    const fs = require('fs');
    const os = require('os');
    let win = new BrowserWindow({
      width: 1280, height: 720, show: false, frame: false, skipTaskbar: true,
      backgroundColor: '#04080F',
      webPreferences: {
        ...COMMON_WEB_PREFERENCES,
        preload: path.join(__dirname, 'preload-dashboard.js'),
        offscreen: true,            // renders to a bitmap, never shown on screen
        backgroundThrottling: false,
      },
    });
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (win && !win.isDestroyed()) win.destroy();
      win = null;
      resolve(result);
    };
    const guard = setTimeout(() => finish(null), 9000); // never hang a publish
    win.webContents.on('did-finish-load', async () => {
      try {
        // Wait for the render to signal it has settled (fonts + a few frames).
        const start = Date.now();
        while (Date.now() - start < 4000) {
          const ready = await win.webContents.executeJavaScript('window.__shotReady === true').catch(() => false);
          if (ready) break;
          await new Promise((r) => setTimeout(r, 150));
        }
        await new Promise((r) => setTimeout(r, 300));
        const image = await win.webContents.capturePage();
        const png = image.toPNG();
        const useJpeg = png.length > 1024 * 1024;
        const buffer = useJpeg ? image.toJPEG(85) : png;
        const file = path.join(os.tmpdir(), `de-preview-${Date.now()}.${useJpeg ? 'jpg' : 'png'}`);
        fs.writeFileSync(file, buffer);
        clearTimeout(guard);
        finish(file);
      } catch (err) {
        clearTimeout(guard);
        finish(null);
      }
    });
    win.webContents.on('render-process-gone', () => { clearTimeout(guard); finish(null); });
    win.loadFile(path.join(__dirname, 'src', 'shot.html'), { query: { pack: String(packId) } });
  });
}

function openFirstWindows() {
  if (WANT_PANEL) {
    createPanelWindow();
    return;
  }
  createDashboardWindow(); // the desktop persona, immediately
  // The engine is a background wallpaper service: launches go straight to the
  // tray + desktop, and the manager opens from the tray (or a deliberate
  // relaunch). ONE exception — the very first run greets the user with the
  // manager + welcome so a new install isn't just an unexplained new wallpaper.
  // After onboarding, every launch (manual or at login) is silent.
  const firstRun = !settings.getOnboarded(USER_DIR);
  if (!LAUNCHED_AT_LOGIN && firstRun) createManagerWindow();
  const editAt = process.argv.indexOf('--edit');
  if (editAt !== -1) createEditorWindow(process.argv[editAt + 1] || 'jarvis');
}

// Fail soft (CLAUDE.md): a stray error in main must never crash the engine
// with a raw stack dialog. Log it (console + engine.log); the desktop stays up.
process.on('uncaughtException', (err) => {
  const detail = err && err.stack ? err.stack : String(err);
  console.error(`[engine] uncaught exception (survived): ${detail}`);
  logEngine('CRASH', `uncaughtException: ${detail}`);
});

process.on('unhandledRejection', (reason) => {
  const detail = reason && reason.stack ? reason.stack : String(reason);
  console.error(`[engine] unhandled rejection (survived): ${detail}`);
  logEngine('CRASH', `unhandledRejection: ${detail}`);
});

// Renderer / GPU / utility process death — these don't crash main, but they
// blank a window or the wallpaper, so they're the crashes users actually feel.
// Recorded so a "it went black" report has something behind it.
app.on('render-process-gone', (_event, webContents, details) => {
  const url = (() => { try { return webContents.getURL(); } catch { return '?'; } })();
  logEngine('CRASH', `render-process-gone (${details.reason}, exit ${details.exitCode}) at ${url}`);
});
app.on('child-process-gone', (_event, details) => {
  logEngine('CRASH', `child-process-gone (${details.type}: ${details.reason}, exit ${details.exitCode})`);
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

  // SECURITY (defence in depth): our pages render untrusted pack content (and a
  // pack's `module` component runs untrusted designer code in a sandboxed
  // subframe). Deny every window/frame the ability to open new windows or
  // navigate away — the app only ever loads its own local pages, so any
  // navigation/window.open is either a bug or an attempted escape.
  app.on('web-contents-created', (_event, contents) => {
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('will-navigate', (event) => event.preventDefault());
    contents.on('will-redirect', (event) => event.preventDefault());
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
    logEngine('INFO', `engine start — v${app.getVersion()} · electron ${process.versions.electron} · ${process.platform} · ${LAUNCHED_AT_LOGIN ? 'login' : 'manual'}`);
    // Voice models now live in user data (survive updates); bring any the owner
    // downloaded into the old in-app voices/ dir across so they aren't refetched.
    voicebank.migrateModelsFromAppRoot(__dirname);
    warnAboutUnauditedVoices();

    // SECURITY: Electron GRANTS permission requests by default when no handler
    // is set — which would let an untrusted pack `module` frame ask for camera,
    // microphone, geolocation, etc. The engine needs none of these (planner
    // alerts + notification reads happen in MAIN, replies play via Web Audio
    // which needs no permission), so deny them all, everywhere.
    session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);

    // Serve sandboxed module documents. The renderer (components.js
    // buildModule) base64url-encodes the whole wrapped HTML into the request
    // path; we decode and hand it back under the network-less MODULE_DOC_CSP.
    // Main only echoes the bytes — it never parses or runs them.
    protocol.handle(MODULE_SCHEME, (request) => {
      try {
        let b64 = new URL(request.url).pathname.replace(/^\/+/, '').replace(/-/g, '+').replace(/_/g, '/');
        while (b64.length % 4) b64 += '=';
        const html = Buffer.from(b64, 'base64').toString('utf8');
        return new Response(html, {
          headers: {
            'content-type': 'text/html; charset=utf-8',
            'content-security-policy': MODULE_DOC_CSP,
            'x-content-type-options': 'nosniff',
          },
        });
      } catch (err) {
        return new Response('', { status: 400 });
      }
    });
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
      openManager: (view) => openManagerView(view || 'installed'),
      onPackSaved: (id) => {
        // Editor saved a pack — the desktop repaints if it's showing it, and
        // the manager refreshes its library so an edit (or a brand-new fork)
        // shows up without reopening the app. A fresh fork has no file watcher
        // on the manager yet, so this direct ping is the only signal it gets.
        for (const win of [dashboardWindow, managerWindow]) {
          if (win && !win.isDestroyed()) win.webContents.send('aegis:packs:changed', { id });
        }
      },
      // Workshop publish asks for a rendered preview image of the pack.
      renderPreview: (id) => renderPackPreview(id),
      // Settings screen: performance changes must reach the live desktop, and
      // the OS login item is owned by main.
      onPerformanceChanged: () => sendDesktopPower(),
      getAutoStart,
      setAutoStart,
      // Multi-monitor: the picker's data + rebuild-on-a-new-display.
      getDisplays: listDisplays,
      onDisplayChanged: relocateDesktop,
      // A user property changed — the live desktop reloads the pack (with the
      // new overlay). The manager refreshes its own preview client-side.
      onUserPropsChanged: (id) => {
        if (dashboardWindow && !dashboardWindow.isDestroyed()) {
          dashboardWindow.webContents.send('aegis:packs:changed', { id });
        }
      },
      // The default weather location changed — repaint so any unset-location
      // weather component picks it up immediately (else it waits for its timer).
      onWeatherLocationChanged: () => {
        const activeId = settings.getActivePack(USER_DIR) || 'jarvis';
        for (const win of [dashboardWindow, managerWindow]) {
          if (win && !win.isDestroyed()) win.webContents.send('aegis:packs:changed', { id: activeId });
        }
      },
    });
    if (!WANT_PANEL) createTray();
    if (!WANT_PANEL) startPresenceMonitoring();
    // Monitor hotplug / rearrange: re-place the wallpaper (and drop a pin whose
    // display vanished). Only meaningful with a live desktop window.
    if (!WANT_PANEL) {
      for (const ev of ['display-added', 'display-removed', 'display-metrics-changed']) {
        screen.on(ev, onDisplaysChanged);
      }
    }
    openFirstWindows();
    if (envFlag('SHOT')) scheduleDevShots(envFlag('SHOT'));
    // DE_SHOTPREVIEW=<dir>: dev utility — render DE_PACK's Workshop preview to
    // <dir>/preview.png and quit, to eyeball what publish will upload.
    if (envFlag('SHOTPREVIEW')) {
      renderPackPreview(envFlag('PACK') || 'jarvis').then((file) => {
        const fs = require('fs');
        try {
          fs.mkdirSync(envFlag('SHOTPREVIEW'), { recursive: true });
          if (file) fs.copyFileSync(file, path.join(envFlag('SHOTPREVIEW'), 'preview.png'));
          console.log(`[preview] ${file || 'render failed'}`);
        } catch (err) { console.warn(`[preview] ${err.message}`); }
        app.quit();
      });
    }
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

  // Don't leave the full-screen watcher process behind on quit.
  app.on('before-quit', () => { if (presenceMonitor) presenceMonitor.stop(); });
}
