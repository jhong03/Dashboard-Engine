'use strict';

// Electron main process. Wallpaper Engine model (M3): on launch the active
// persona pack renders straight onto the DESKTOP (a frameless window
// reparented under the shell's wallpaper layer on Windows), and the app
// window is the MANAGER — the library for browsing/installing/selecting
// content. The M1 voice tuning panel opens from the manager or `npm run
// panel`. All pipeline/pack work happens behind the validated IPC handlers
// in lib/ipc.js — renderers never touch Node.

const { app, BrowserWindow, screen, Tray, Menu, nativeImage, Notification, protocol, powerMonitor, session, crashReporter, net, desktopCapturer, shell } = require('electron');
const path = require('path');
const { pathToFileURL } = require('url');
const { spawn } = require('child_process');
const { createPresenceMonitor } = require('./lib/presence');
const { createMediaMonitor } = require('./lib/media');
const { createAudioMixer } = require('./lib/audiomixer');
const voicebank = require('./lib/voicebank');
const profiles = require('./lib/profiles');
const packs = require('./lib/packs');
const pomodoro = require('./lib/pomodoro');
const music = require('./lib/music');
const videostore = require('./lib/videostore');
const settings = require('./lib/settings');
const achievements = require('./lib/achievements');
const i18n = require('./lib/i18n');
const logger = require('./lib/logger');
const { registerIpcHandlers, prewarmAssistantVoice } = require('./lib/ipc');
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
// planner alerts never reach the Action Center. Kept as a constant so the
// now-playing watcher can exclude our OWN media session by the same id.
const APP_USER_MODEL_ID = 'com.dashboardengine.app';
app.setAppUserModelId(APP_USER_MODEL_ID);

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
// Background music streams the user's own local audio files to the wallpaper
// over demusic://<opaque-id>. A custom streaming scheme (not file://, which the
// page CSP forbids) lets main gate every request through the music library —
// only ids the user actually added resolve to a real path.
const MUSIC_SCHEME = 'demusic';
// Video wallpapers stream the same way as music — a gated streaming scheme so
// main resolves an OPAQUE id to a validated pack-video path (never a raw path
// to the renderer), and video is never base64'd into a pack's assets map.
const VIDEO_SCHEME = 'depack';
protocol.registerSchemesAsPrivileged([
  {
    scheme: MODULE_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: false, corsEnabled: false, stream: false },
  },
  {
    scheme: MUSIC_SCHEME,
    privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true },
  },
  {
    scheme: VIDEO_SCHEME,
    privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true },
  },
]);

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

// Wallpaper-Engine-style Steam integration (see lib/session-link.js). The packaged
// Steam launch runs as a thin SESSION whose lifetime = the Manager being open, so
// Steam shows "playing" only while the Manager is up; the persistent ENGINE (tray +
// wallpaper) runs detached and keeps going when the session ends. Everything else —
// `npm start` (unpackaged dev), the login autostart, `--panel`, and the engine
// spawn itself (`--engine`) — takes the ENGINE path unchanged, so the split's blast
// radius is only the Steam launch.
const ENGINE_FLAG = '--engine';
const IS_SESSION = app.isPackaged && !WANT_PANEL && !LAUNCHED_AT_LOGIN && !process.argv.includes(ENGINE_FLAG);

let panelWindow = null;
let managerWindow = null;
let dashboardWindow = null;
let editorWindow = null;
let sessionLink = null; // the engine's session-link server (accepts Steam-session commands)
let tray = null;
let desktopPaused = false;
let alertScheduler = null;
let pomodoroTimer = null;

// Performance citizenship: pause/throttle the animated wallpaper when a
// full-screen app is up or the machine is on battery (both user-configurable).
let presenceMonitor = null;
let mediaMonitor = null;
let isFullscreen = false;
let onBattery = false;
// Per-app volume mixer (Windows Core Audio). Created lazily the first time a pack
// with a `mixer` component is active; polls only while that component is visible.
let audioMixer = null;
let lastAudioState = { ok: false, master: null, sessions: [] };
let activePackMixer = false;        // does the ACTIVE pack contain a mixer component?
const audioIconCache = new Map();   // exe path → icon data URI | null

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

// Open the Manager directly, no Steam relaunch — so opening it from the tray for
// everyday use (switch packs, edit, voice, settings) never triggers Steam's
// "launching a game" dialog. Steam only needs to be involved when the user actually
// opens the WORKSHOP, which is bounced on demand (launchWorkshopSession → the Browse/
// Published tabs). Already open → just focus it.
function openManagerFromTray() {
  if (managerWindow && !managerWindow.isDestroyed()) { bringToFront(managerWindow); return; }
  createManagerWindow();
}

// The Workshop needs a Steam-tracked session (which owns the Steam client). Relaunch
// through Steam so one spawns; the session connects to this engine and the Manager
// picks up Workshop access. Packaged only — unpackaged dev uses its own client.
function launchWorkshopSession() {
  if (!app.isPackaged) return false; // dev: Workshop runs locally, no session needed
  if (sessionLink && sessionLink.hasSession()) return true; // already have one
  try { shell.openExternal(`steam://rungameid/${require('./lib/workshop').STEAM_APP_ID}`); return true; }
  catch (e) { return false; }
}

// Whether the Workshop can run right now: unpackaged dev (own client) or a live
// Steam session. The Manager uses this to gate the Workshop tabs behind an
// "Open in Steam" prompt instead of a bare error.
function workshopAvailable() {
  return !app.isPackaged || !!(sessionLink && sessionLink.hasSession());
}

function createManagerWindow() {
  if (managerWindow) {
    // Already up → bring it forward. Still initializing behind the splash (hidden)
    // → leave it; the pending reveal will show it once it's loaded + warmed, so a
    // second open can't yank a half-warmed window into view.
    if (managerWindow.isVisible()) bringToFront(managerWindow);
    return;
  }
  const splash = createSplashWindow(); // branded loading dialog, shown immediately
  managerWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 940,
    minHeight: 600,
    backgroundColor: '#04080F',
    // Stay hidden until the page has rendered AND the thumbnail cache is warm, so a
    // first eager drag can never land during the offscreen GPU render swarm (which
    // could hang/crash the app). The splash covers the wait; revealManagerWhenReady
    // shows this window once it's ready.
    show: false,
    webPreferences: {
      ...COMMON_WEB_PREFERENCES,
      preload: path.join(__dirname, 'preload-manager.js'),
    },
  });
  managerWindow.loadFile(path.join(__dirname, 'src', 'manager.html'), {
    query: { view: envFlag('VIEW') || '' },
  });
  // Keep the thumbnail queue paused while the window is settling or being moved/
  // resized, so offscreen GPU renders never fight the OS window-drag modal loop.
  // Every move/resize event pushes the idle moment forward; the queue resumes
  // shortly after the drag stops.
  markManagerBusy(700);
  const bumpBusy = () => markManagerBusy(500);
  managerWindow.on('will-move', bumpBusy);
  managerWindow.on('will-resize', bumpBusy);
  managerWindow.on('move', bumpBusy);
  managerWindow.on('resize', bumpBusy);
  managerWindow.on('closed', () => {
    managerWindow = null;
    // The Manager is the Steam "session": closing it ends the session so Steam stops
    // showing "playing" — the wallpaper (this engine) keeps running. No-op when the
    // Manager was opened outside a session (tray / first run) → no socket to signal.
    if (sessionLink) sessionLink.endSession();
  });
  revealManagerWhenReady(managerWindow, splash);
}

// A small branded loading dialog shown while the Manager loads and warms its
// thumbnail cache off-screen. Frameless, centred, always-on-top; the logo is
// injected as a data: URI (no file-path/CSP surprises) and the window is shown
// only once the logo is in place, so it never flashes a bare frame. Fail-soft:
// if it can't be created the Manager still opens (just without the splash).
function createSplashWindow() {
  let splash;
  try {
    splash = new BrowserWindow({
      width: 470, height: 290, resizable: false, movable: false,
      minimizable: false, maximizable: false, fullscreenable: false,
      frame: false, transparent: true, backgroundColor: '#00000000', hasShadow: false,
      skipTaskbar: true, alwaysOnTop: true, center: true, show: false, focusable: false,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
  } catch (e) { return null; }
  splash.loadFile(path.join(__dirname, 'src', 'splash.html'));
  splash.webContents.once('did-finish-load', () => {
    if (!splash || splash.isDestroyed()) return;
    try {
      const b64 = require('fs').readFileSync(path.join(__dirname, 'brand', 'DEHori1.png')).toString('base64');
      splash.webContents.executeJavaScript(`window.__splashLogo && window.__splashLogo('data:image/png;base64,${b64}')`).catch(() => {});
    } catch (e) { /* no logo — status + bar still identify the app */ }
    if (!splash.isDestroyed()) splash.show();
  });
  return splash;
}

// Push a status line to the splash (no-op once it's gone).
function splashStatus(splash, text) {
  if (!splash || splash.isDestroyed()) return;
  splash.webContents.executeJavaScript(`window.__splashStatus && window.__splashStatus(${JSON.stringify(text)})`).catch(() => {});
}

// Pre-generate the (GPU-heavy) library thumbnails while the Manager is still
// hidden, so the offscreen render swarm can never collide with an eager first
// drag. A fast no-op when the cache is already warm; bounded so a slow render
// never holds the window back too long (any leftovers render lazily after reveal,
// idle-gated as before).
async function warmManagerThumbnails(maxMs, onProgress) {
  let ids = [];
  try { ids = (packs.listPacks(__dirname, USER_DIR).packs || []).map((p) => p.id).filter(Boolean); }
  catch (e) { return; }
  if (!ids.length) return;
  const deadline = Date.now() + maxMs;
  for (let i = 0; i < ids.length; i++) {
    if (Date.now() > deadline) break;
    if (onProgress) onProgress(i + 1, ids.length);
    try { await getPackThumbnail(ids[i]); } catch (e) { /* skip a bad pack */ }
  }
}

// Poll the Manager renderer's readiness flag (set after its first library render).
async function waitForManagerReady(win, maxMs) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    if (!win || win.isDestroyed()) return;
    const ready = await win.webContents.executeJavaScript('window.__managerReady === true').catch(() => false);
    if (ready) return;
    await new Promise((r) => setTimeout(r, 100));
  }
}

// Reveal the Manager only once it has finished its first render AND its thumbnail
// cache is warm — walking the splash through the stages, then swapping the splash
// out for the real window. A failsafe guarantees the window always appears even if
// a step stalls; a minimum splash time keeps it from flashing on a warm reopen.
const SPLASH_MIN_MS = 750;
function revealManagerWhenReady(win, splash) {
  const shownAt = Date.now();
  let shown = false, scheduled = false;
  const failsafe = setTimeout(() => revealNow(), 9000);
  function revealNow() {
    if (shown) return;
    shown = true;
    clearTimeout(failsafe);
    if (win && !win.isDestroyed()) { markManagerBusy(500); win.show(); win.focus(); }
    // Let the Manager paint a frame before dropping the splash (no desktop flash).
    setTimeout(() => { if (splash && !splash.isDestroyed()) { try { splash.close(); } catch (e) { /* gone */ } } }, 90);
  }
  function reveal() {
    if (shown || scheduled) return;
    scheduled = true;
    setTimeout(revealNow, Math.max(0, SPLASH_MIN_MS - (Date.now() - shownAt)));
  }
  (async () => {
    try {
      splashStatus(splash, 'Initializing…');
      await waitForManagerReady(win, 6000);
      splashStatus(splash, 'Warming up…');
      await warmManagerThumbnails(4000, (n, total) => splashStatus(splash, `Warming up… ${n}/${total}`));
      splashStatus(splash, 'Almost ready…');
    } catch (e) { /* reveal regardless */ }
    reveal();
  })();
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

// The wallpaper's monitor as a (Left,Top) rank — the SAME index desktop-attach.ps1
// and the full-screen watcher use, so all three agree on which screen it's on.
// The full-screen pause keys off THIS monitor (not the primary), so a full-screen
// app on another screen doesn't freeze the wallpaper.
function dashboardMonitorIndex() {
  try {
    const id = chosenDisplay().display.id;
    return rankedDisplays().findIndex((d) => d.id === id);
  } catch (err) {
    return -1; // fail-soft → the watcher falls back to the primary monitor
  }
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

// Warm the assistant voice engine at most once per app session (the desktop can
// reload / re-attach, and we don't want the warm-up to stack).
let warmedVoiceOnce = false;

async function createDashboardWindow() {
  if (dashboardWindow) return;
  const { display } = chosenDisplay();
  // The wallpaper always renders on a DEFINITE monitor. When no display is pinned,
  // chosenDisplay() already defaults to the primary; either way, hand the attach
  // that monitor's INDEX so it positions the window with DPI-safe PHYSICAL pixel
  // rects. The old path passed -1 when unpinned ("leave Electron's DIP bounds"),
  // which could land the wallpaper not-quite-fullscreen on a high-DPI monitor.
  // (We deliberately do NOT persist a pin here — a null displayId is the valid
  // "Auto / follow primary" choice, and pinning would fight it.)
  const monitorIndex = rankedDisplays().findIndex((d) => d.id === display.id);
  // Point the full-screen watcher at THIS monitor so it pauses the wallpaper only
  // when something covers the screen the wallpaper is actually on. Covers first
  // launch, a display re-pick, and a monitor plug/unplug (all route through here).
  if (presenceMonitor) presenceMonitor.setMonitor(monitorIndex);

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
      // Background music is enabled by the user in Settings, not on this window,
      // so its gesture doesn't count here — let the desktop start audio on its
      // own. (The assistant's Web-Audio playback benefits too.)
      autoplayPolicy: 'no-user-gesture-required',
    },
  });
  dashboardWindow.loadFile(path.join(__dirname, 'src', 'dashboard.html'), {
    query: { pack: envFlag('PACK') || '', nogl: envFlag('NO_GL') ? '1' : '' },
  });
  dashboardWindow.on('closed', () => { dashboardWindow = null; });
  // Push the current power state on first load and every reload/hot-reload, so
  // the renderer starts at the right fps / frozen if a game is already up.
  dashboardWindow.webContents.on('did-finish-load', () => { sendDesktopPower(); sendBackgroundMotion(); });

  // Warm the assistant's voice engine in the background a few seconds after the
  // desktop is up (idle time), so the FIRST spoken reply / health alert isn't a
  // cold-start wait — the expensive one-time engine load + OS first-access scan
  // happens invisibly here instead of on the user. Fail-soft + gated (only if a
  // voice is configured) inside the helper. Guarded so retries don't stack warms.
  if (!warmedVoiceOnce) {
    warmedVoiceOnce = true;
    setTimeout(() => { try { prewarmAssistantVoice(__dirname, USER_DIR); } catch (e) { /* best effort */ } }, 6000);
  }

  await new Promise((resolve) => dashboardWindow.once('ready-to-show', resolve));
  dashboardWindow.showInactive(); // visible, but don't grab focus on launch

  if (!NO_DESKTOP) {
    // The shell's wallpaper WorkerW may not exist the instant we launch (common
    // on quiet-launch-at-login, before explorer has finished spawning it), so a
    // single attach can miss and drop us to a taskbar window. Retry a few times
    // with a short delay before giving up.
    let attached = false;
    for (let attempt = 0; attempt < 5 && !attached; attempt++) {
      attached = await attachToDesktop(dashboardWindow, monitorIndex);
      if (!attached && attempt < 4) await new Promise((resolve) => setTimeout(resolve, 600));
    }
    if (attached) return;
    console.warn('[desktop] could not attach to the wallpaper layer after retries; falling back to a normal window.');
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
  recomputeActivePackMixer(); // the new pack may add/drop the mixer component
}

function setActivePackFromTray(id) {
  settings.setActivePack(USER_DIR, id);
  achievements.unlock('ACH_FIRST_LIGHT');
  notifyActivePack(id);
}

function toggleDesktop() {
  if (!dashboardWindow || dashboardWindow.isDestroyed()) return;
  desktopPaused = !desktopPaused;
  if (desktopPaused) dashboardWindow.hide();
  else dashboardWindow.show();
  sendDesktopPower(); // reflect the manual pause in the power state (music + render)
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
  // The manual tray pause counts too, so hiding the desktop also silences the
  // background music and stops the render loop (a hidden window keeps running).
  const shouldPause = desktopPaused || (perf.pauseOnFullscreen && isFullscreen) || (perf.pauseOnBattery && onBattery);
  dashboardWindow.webContents.send('aegis:desktop:power', { active: !shouldPause, maxFps: perf.maxFps });
  refreshAudioMixer(); // pause/resume the volume-mixer poll with the wallpaper
}

// ── Per-app volume mixer (Windows Core Audio) ────────────────────────────────
// The wallpaper's `mixer` component adjusts each app's volume live. The heavy
// COM enumeration runs in a background daemon (lib/audiomixer.js) that only polls
// while a mixer component is actually visible (an active-pack mixer + the desktop
// not frozen), so it costs nothing on packs that don't use it or during a game.

// Is the wallpaper currently rendering (not frozen / hidden)? Same rule as
// sendDesktopPower — kept module-level so the mixer lifecycle can share it.
function desktopActive() {
  if (!dashboardWindow || dashboardWindow.isDestroyed()) return false;
  const perf = settings.getPerformance(USER_DIR);
  return !(desktopPaused || (perf.pauseOnFullscreen && isFullscreen) || (perf.pauseOnBattery && onBattery));
}

// A process's icon as a data URI, cached by exe path (same source as launcher
// tiles). Master + system-sounds rows have no path and fall back to a glyph.
async function audioIcon(exePath) {
  if (!exePath) return null;
  if (audioIconCache.has(exePath)) return audioIconCache.get(exePath);
  let uri = null;
  try {
    const icon = await app.getFileIcon(exePath, { size: 'normal' });
    if (icon && !icon.isEmpty()) uri = icon.toDataURL();
  } catch (err) { /* protected process / gone — no icon */ }
  audioIconCache.set(exePath, uri);
  return uri;
}

async function attachAudioIcons(raw) {
  if (!raw || raw.ok !== true) return raw;
  const sessions = [];
  for (const s of raw.sessions) sessions.push({ ...s, icon: await audioIcon(s.path) });
  return { ...raw, sessions };
}

// A fresh snapshot from the daemon: attach icons, cache it, and push to the
// desktop so the mixer repaints (apps come/go, external volume changes).
function onAudioState(raw) {
  attachAudioIcons(raw).then((state) => {
    lastAudioState = state;
    if (dashboardWindow && !dashboardWindow.isDestroyed()) {
      dashboardWindow.webContents.send('aegis:audio:changed', state);
    }
  });
}

function ensureAudioMixer() {
  if (!audioMixer) audioMixer = createAudioMixer(__dirname, onAudioState);
  return audioMixer;
}

// Recompute whether the active pack has a mixer component (cheap — only on a
// pack change), then reconcile the daemon's polling.
function recomputeActivePackMixer() {
  try {
    const id = settings.getActivePack(USER_DIR) || 'jarvis';
    const loaded = packs.loadPack(__dirname, USER_DIR, id);
    const comps = (loaded && loaded.pack && loaded.pack.components) || [];
    activePackMixer = comps.some((c) => c && c.type === 'mixer');
  } catch (err) {
    activePackMixer = false;
  }
  refreshAudioMixer();
}

// Poll only when a mixer component is on the active pack AND the wallpaper is
// visible; otherwise pause the daemon (near-zero cost). Started lazily.
function refreshAudioMixer() {
  if (activePackMixer) ensureAudioMixer();
  if (audioMixer) audioMixer.setActive(activePackMixer && desktopActive());
}

// Push the global background-motion multiplier to the desktop (on load + change),
// so parallax/drift scale by the user's preference without a pack edit.
function sendBackgroundMotion() {
  if (!dashboardWindow || dashboardWindow.isDestroyed()) return;
  dashboardWindow.webContents.send('aegis:desktop:backgroundMotion', settings.getBackgroundMotion(USER_DIR));
}

// Start the full-screen watcher + battery listeners once, on ready.
function startPresenceMonitoring() {
  try { onBattery = powerMonitor.isOnBatteryPower(); } catch (err) { onBattery = false; }
  powerMonitor.on('on-battery', () => { onBattery = true; sendDesktopPower(); });
  powerMonitor.on('on-ac', () => { onBattery = false; sendDesktopPower(); });
  presenceMonitor = createPresenceMonitor(__dirname, (fullscreen) => {
    isFullscreen = fullscreen;
    sendDesktopPower();
  }, dashboardMonitorIndex());
  // "Now playing" from the Windows media session — pushed to the desktop for the
  // `nowplaying` component (personal data; never enters a pack).
  // Exclude our OWN media session (the background-music <audio> registers with
  // Windows) so the widget shows the user's real player (Spotify, etc.).
  mediaMonitor = createMediaMonitor(__dirname, (state) => {
    if (dashboardWindow && !dashboardWindow.isDestroyed()) {
      dashboardWindow.webContents.send('aegis:media:changed', state);
    }
  }, APP_USER_MODEL_ID);
}

// ── Tray: the engine's home. Menu is rebuilt on every right-click so the
// pack list and the active radio are always current — Wallpaper Engine
// habits, Dashboard Engine contents.
function buildTrayMenu() {
  const listed = packs.listPacks(__dirname, USER_DIR);
  const active = settings.getActivePack(USER_DIR) || 'jarvis';
  // Localized tray labels, fail-soft: a missing key falls back to the English literal.
  const dict = i18n.getActive(USER_DIR, settings.getLocale(USER_DIR), app.getLocale()).dict;
  const tr = (key, english) => { const s = i18n.translate(dict, key); return s === key ? english : s; };
  return Menu.buildFromTemplate([
    { label: tr('tray.openManager', 'Open Manager'), click: openManagerFromTray },
    { label: tr('tray.voiceTuning', 'Voice Tuning'), click: createPanelWindow },
    { type: 'separator' },
    {
      label: tr('tray.switchPack', 'Switch Pack'),
      submenu: listed.packs.map((p) => ({
        label: p.name,
        type: 'radio',
        checked: p.id === active,
        click: () => setActivePackFromTray(p.id),
      })),
    },
    { label: desktopPaused ? tr('tray.resumeDesktop', 'Resume Desktop') : tr('tray.pauseDesktop', 'Pause Desktop'), click: toggleDesktop },
    { label: tr('tray.performance', 'Performance'), submenu: buildPerformanceMenu() },
    { type: 'separator' },
    { label: tr('tray.quit', 'Quit Dashboard Engine'), click: () => app.quit() },
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
  tray.on('click', openManagerFromTray);
  tray.on('double-click', openManagerFromTray);
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
        // DE_SHOT_SIZE=WxH: force a consistent capture size (e.g. 1920x1080 for
        // marketing/store shots), letting the responsive UI reflow before capture.
        const shotSize = envFlag('SHOT_SIZE');
        let resized = false;
        if (shotSize) {
          const [w, h] = shotSize.split('x').map((n) => parseInt(n, 10));
          // setBounds (not setContentSize) so the window fills the whole display,
          // dodging the work-area/taskbar clamp that would truncate the capture.
          if (w > 0 && h > 0) { try { win.setBounds({ x: 0, y: 0, width: w, height: h }); resized = true; } catch (e) { /* not resizable */ } }
        }
        win.showInactive();
        win.moveTop();
        await new Promise((resolve) => setTimeout(resolve, resized ? 800 : 500));
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
function renderPackPreview(packId, sizeOpts) {
  const width = sizeOpts && sizeOpts.width ? sizeOpts.width : 1280;
  const height = sizeOpts && sizeOpts.height ? sizeOpts.height : 720;
  const forcePng = !!(sizeOpts && sizeOpts.png); // store shots want crisp PNG
  return new Promise((resolve) => {
    const fs = require('fs');
    const os = require('os');
    let win = new BrowserWindow({
      width, height, useContentSize: true, // width/height = the captured CONTENT area (exact)
      enableLargerThanScreen: true,        // don't clamp to the display work area (taskbar)
      show: false, frame: false, skipTaskbar: true,
      backgroundColor: '#04080F',
      webPreferences: {
        ...COMMON_WEB_PREFERENCES,
        preload: path.join(__dirname, 'preload-dashboard.js'),
        offscreen: true,            // renders to a bitmap, never shown on screen
        backgroundThrottling: false,
      },
    });
    // Windows clamps a normal window to the display WORK AREA (screen minus the
    // taskbar), which truncates a 1080-tall offscreen capture to ~1032. Forcing
    // the bounds to cover the full display (taskbar included) restores the exact
    // requested height for store/marketing shots. Best-effort — a clamp just
    // yields a slightly shorter image, never a failure.
    if (forcePng) { try { win.setBounds({ x: 0, y: 0, width, height }); } catch (e) { /* clamped */ } }
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (win && !win.isDestroyed()) win.destroy();
      win = null;
      resolve(result);
    };
    const guard = setTimeout(() => finish(null), 13000); // never hang a publish
    win.webContents.on('did-finish-load', async () => {
      try {
        // Wait for the render to signal it has settled (fonts + a few frames,
        // and a video wallpaper's first decoded frame — up to shot.js's 5 s cap).
        const start = Date.now();
        while (Date.now() - start < 8000) {
          const ready = await win.webContents.executeJavaScript('window.__shotReady === true').catch(() => false);
          if (ready) break;
          await new Promise((r) => setTimeout(r, 150));
        }
        await new Promise((r) => setTimeout(r, 300));
        const image = await win.webContents.capturePage();
        const png = image.toPNG();
        const useJpeg = !forcePng && png.length > 1024 * 1024;
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

// Encode a numbered PNG frame sequence → an optimized, looping animated GIF via
// ffmpeg (two-pass palette for quality). Resolves true on success. FAIL-SOFT:
// any error — including ffmpeg not being installed on this machine — resolves
// false so the publish falls back to the static preview image.
function encodeGif(frameGlob, palettePath, outPath, fps, opts) {
  const { spawn } = require('child_process');
  const ffmpeg = require('./lib/dsp').findFfmpeg();
  const width = opts.width, colors = opts.colors, dither = opts.dither;
  const run = (args) => new Promise((resolve) => {
    let child;
    try { child = spawn(ffmpeg, args, { windowsHide: true }); }
    catch (e) { return resolve(false); }
    child.on('error', () => resolve(false));           // ffmpeg missing / unspawnable
    if (child.stderr) child.stderr.on('data', () => {}); // drain so the pipe never blocks
    child.on('close', (code) => resolve(code === 0));
  });
  const scale = `scale=${width}:-1:flags=lanczos`;
  // Pass 1: build an optimal palette from the frames (capped colours = smaller
  // file). Pass 2: apply it with the requested dither. Two passes = far better
  // quality-per-byte than a single-pass GIF.
  return run(['-y', '-framerate', String(fps), '-i', frameGlob, '-vf', `${scale},palettegen=max_colors=${colors}:stats_mode=diff`, palettePath])
    .then((ok) => ok && run(['-y', '-framerate', String(fps), '-i', frameGlob, '-i', palettePath,
      '-lavfi', `${scale} [x]; [x][1:v] paletteuse=dither=${dither}`, '-loop', '0', outPath]));
}

// Render a short, LOOPING animated GIF preview of a pack (demo data only, no
// personal info) for the Steam Workshop — so packs whose look depends on motion
// (video/parallax backgrounds, ambience particles, animated fills, WebGL
// effects) show that motion in the Workshop grid, the way Wallpaper Engine does.
// Small + short so the GIF stays under Steam's ~1 MB preview cap. Uses the same
// deterministic capture clock as the trailer tool (?capture=1) for a smooth loop.
// Returns a temp .gif path, or null on ANY failure (ffmpeg missing, over the
// cap, render error) → the caller falls back to the static image. Fail-soft.
// Keep the animated preview SMALL. Steam throttles Workshop uploads by size, not
// just frequency (confirmed: an ~8 MB GIF hit "limit exceeded" while a ~270 KB
// static went through at the same moment) — a heavy preview is exactly what makes
// publishing fail. So the GIF is capped low; a calm pack still renders full-width
// at 960, and a busy one steps down through the tiers until it fits.
const GIF_PREVIEW_MAX_BYTES = 2 * 1024 * 1024;
function renderPackPreviewGif(packId) {
  const fs = require('fs');
  const os = require('os');
  // Capture at 16:9; a short loop keeps the file small. Encode tiers step down in
  // size/colours until the GIF fits GIF_PREVIEW_MAX_BYTES (so busy packs stay
  // light enough to upload rather than tripping Steam's throttle).
  const W = 960, H = 540, FPS = 10, SECONDS = 4;
  const GIF_TIERS = [
    { width: 960, colors: 160, dither: 'bayer:bayer_scale=5' },
    { width: 768, colors: 128, dither: 'bayer:bayer_scale=5' },
    { width: 640, colors: 112, dither: 'none' },
    { width: 512, colors: 96, dither: 'none' },
  ];
  const total = Math.max(1, Math.round(SECONDS * FPS));
  const workDir = path.join(os.tmpdir(), `de-gif-${Date.now()}`);
  return new Promise((resolve) => {
    let win = new BrowserWindow({
      width: W, height: H, useContentSize: true, enableLargerThanScreen: true,
      show: false, frame: false, skipTaskbar: true, backgroundColor: '#04080F',
      webPreferences: {
        ...COMMON_WEB_PREFERENCES,
        preload: path.join(__dirname, 'preload-dashboard.js'),
        offscreen: true, backgroundThrottling: false,
      },
    });
    try { win.setBounds({ x: 0, y: 0, width: W, height: H }); } catch (e) { /* clamped */ }
    let settled = false;
    const cleanup = () => { try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (e) { /* best-effort */ } };
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (win && !win.isDestroyed()) win.destroy();
      win = null;
      if (!result) cleanup();
      resolve(result || null);
    };
    const guard = setTimeout(() => finish(null), 90000); // never hang a publish
    win.webContents.on('render-process-gone', () => { clearTimeout(guard); finish(null); });
    win.webContents.on('did-finish-load', async () => {
      try {
        fs.mkdirSync(workDir, { recursive: true });
        const start = Date.now();
        while (Date.now() - start < 8000) {
          const ready = await win.webContents.executeJavaScript('window.__shotReady === true').catch(() => false);
          if (ready) break;
          await new Promise((r) => setTimeout(r, 150));
        }
        await new Promise((r) => setTimeout(r, 300)); // one more beat so data has painted
        // Capture in REAL time (not the deterministic capture clock, which would
        // gate the rAF-driven data render and leave meters/clocks blank). Ambience,
        // video, animated fills and effects all move on their own; a synthetic
        // pointer sweep each frame drives parallax + cursor-ripple too.
        const frameMs = Math.round(1000 / FPS);
        for (let i = 0; i < total; i++) {
          const tt = i / total;
          const px = Math.round(W / 2 + W * 0.4 * Math.sin(tt * 6.283));
          const py = Math.round(H / 2 + H * 0.3 * Math.sin(tt * 12.566 + 1));
          await win.webContents.executeJavaScript(
            `(function(x,y){var t=['pointermove','mousemove'];for(var i=0;i<t.length;i++){var e;try{e=new MouseEvent(t[i],{clientX:x,clientY:y,bubbles:true,view:window});}catch(_){continue;}window.dispatchEvent(e);document.dispatchEvent(e);if(document.body)document.body.dispatchEvent(e);}})(${px},${py})`
          ).catch(() => {});
          await new Promise((r) => setTimeout(r, frameMs)); // let it animate a frame
          const img = await win.webContents.capturePage();
          fs.writeFileSync(path.join(workDir, `f${String(i + 1).padStart(4, '0')}.png`), img.toPNG());
        }
        // Encode at successively smaller/cheaper tiers until one fits the cap.
        const frameGlob = path.join(workDir, 'f%04d.png');
        const palettePath = path.join(workDir, 'palette.png');
        let gifPath = null;
        for (const tier of GIF_TIERS) {
          const out = path.join(os.tmpdir(), `de-preview-${Date.now()}-${tier.width}.gif`);
          const ok = await encodeGif(frameGlob, palettePath, out, FPS, tier);
          if (ok && fs.existsSync(out)) {
            if (fs.statSync(out).size <= GIF_PREVIEW_MAX_BYTES) { gifPath = out; break; }
            try { fs.rmSync(out, { force: true }); } catch (e) { /* try the next tier */ }
          } else if (!ok) {
            break; // ffmpeg unavailable — no tier will work; fall back to static
          }
        }
        cleanup();
        clearTimeout(guard);
        finish(gifPath); // null → caller falls back to the static image
      } catch (err) {
        cleanup();
        clearTimeout(guard);
        finish(null);
      }
    });
    win.loadFile(path.join(__dirname, 'src', 'shot.html'), { query: { pack: String(packId) } });
  });
}

// Render a Workshop preview CARD for a voice profile, off-screen. The card shows
// ONLY the voice's name, its base voice (language · sex · accent), and a few
// tuning bars — never any personal data (a voice profile has no telemetry, apps,
// or messages). Returns a temp png/jpg path, or null on any failure (publish
// then uploads with no image). Fail-soft, like renderPackPreview.
function renderVoicePreview(profileFile) {
  return new Promise((resolve) => {
    const fs = require('fs');
    const os = require('os');
    let cardHtml;
    let htmlFile;
    try {
      if (!profiles.PROFILE_FILE_PATTERN.test(String(profileFile))) return resolve(null);
      const full = path.join(profiles.profilesDir(__dirname), profileFile);
      if (!fs.existsSync(full)) return resolve(null);
      const { profile } = profiles.loadProfile(full);
      const voice = voicebank.voiceById(voicebank.loadManifest(__dirname), profile.base.voice);
      cardHtml = buildVoiceCardHtml(profile, voice);
      htmlFile = path.join(os.tmpdir(), `de-voicecard-${Date.now()}.html`);
      fs.writeFileSync(htmlFile, cardHtml, 'utf8');
    } catch (err) {
      return resolve(null);
    }

    let win = new BrowserWindow({
      width: 640, height: 360, show: false, frame: false, skipTaskbar: true,
      backgroundColor: '#04080F',
      webPreferences: { offscreen: true, backgroundThrottling: false, sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (win && !win.isDestroyed()) win.destroy();
      win = null;
      try { if (htmlFile) fs.rmSync(htmlFile, { force: true }); } catch (e) { /* temp cleanup */ }
      resolve(result);
    };
    const guard = setTimeout(() => finish(null), 8000);
    win.webContents.on('did-finish-load', async () => {
      try {
        await new Promise((r) => setTimeout(r, 350)); // let fonts/layout settle
        const image = await win.webContents.capturePage();
        const png = image.toPNG();
        const useJpeg = png.length > 1024 * 1024;
        const buffer = useJpeg ? image.toJPEG(88) : png;
        const file = path.join(os.tmpdir(), `de-voicepreview-${Date.now()}.${useJpeg ? 'jpg' : 'png'}`);
        fs.writeFileSync(file, buffer);
        clearTimeout(guard);
        finish(file);
      } catch (err) {
        clearTimeout(guard);
        finish(null);
      }
    });
    win.webContents.on('render-process-gone', () => { clearTimeout(guard); finish(null); });
    win.loadFile(htmlFile);
  });
}

// Build the self-contained HTML for a voice preview card. Everything is inline
// (no external fonts/scripts) so it renders identically off-screen with no
// network. Uses the pack-content holographic register — this is a showcase image.
function buildVoiceCardHtml(profile, voice) {
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const name = esc(profile.name || 'Voice');
  const baseBits = voice
    ? [voice.language, voice.sex, voice.accent].filter(Boolean).map(esc)
    : [esc(profile.base.voice)];
  const hd = voice && voice.hd;
  // A handful of the most audible tunings, each normalized 0..1 for a bar.
  const norm = (dotted) => {
    const range = profiles.PARAM_RANGES[dotted];
    if (!range) return 0.5;
    const v = profiles.getByPath(profile, dotted);
    const n = typeof v === 'number' ? v : range.default;
    return Math.max(0, Math.min(1, (n - range.min) / (range.max - range.min)));
  };
  const bars = [
    ['Pitch', norm('prosody.pitchShift')],
    ['Speed', norm('prosody.rate')],
    ['Warmth', norm('timbre.warmth')],
    ['Brightness', norm('timbre.brightness')],
    ['Reverb', norm('character.reverb.mix')],
  ];
  const barRows = bars.map(([label, v]) => `
    <div class="bar-row">
      <span class="bar-label">${label}</span>
      <span class="bar-track"><span class="bar-fill" style="width:${Math.round(v * 100)}%"></span></span>
    </div>`).join('');
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    :root { --cyan:#3FD8FF; --bright:#7FE9FF; --steel:#5A7E93; }
    * { margin:0; box-sizing:border-box; }
    html,body { width:640px; height:360px; }
    body { background:radial-gradient(120% 120% at 20% 0%, #0a1622 0%, #04080F 70%); color:#dbeaf2;
      font-family: 'Segoe UI', system-ui, sans-serif; padding:38px 44px; position:relative; overflow:hidden; }
    .glow { position:absolute; inset:0; background:radial-gradient(60% 60% at 85% 90%, rgba(63,216,255,.10), transparent 70%); }
    .kicker { text-transform:uppercase; letter-spacing:.28em; font-size:13px; color:var(--steel); }
    h1 { font-size:44px; font-weight:600; line-height:1.05; margin:10px 0 6px; color:#fff;
      text-shadow:0 0 24px rgba(63,216,255,.25); }
    .base { font-size:16px; color:var(--bright); letter-spacing:.02em; }
    .base .hd { display:inline-block; margin-left:10px; padding:1px 8px; border:1px solid var(--cyan);
      border-radius:4px; font-size:11px; letter-spacing:.15em; color:var(--cyan); vertical-align:2px; }
    .bars { position:absolute; left:44px; right:44px; bottom:64px; }
    .bar-row { display:flex; align-items:center; gap:14px; margin:9px 0; }
    .bar-label { width:92px; font-size:13px; color:var(--steel); text-transform:uppercase; letter-spacing:.12em; }
    .bar-track { flex:1; height:6px; background:rgba(90,126,147,.22); border-radius:3px; overflow:hidden; }
    .bar-fill { display:block; height:100%; background:linear-gradient(90deg, var(--cyan), var(--bright)); }
    .foot { position:absolute; left:44px; bottom:30px; font-size:12px; letter-spacing:.22em;
      text-transform:uppercase; color:var(--steel); }
    .foot b { color:var(--cyan); font-weight:600; }
  </style></head><body>
    <div class="glow"></div>
    <div class="kicker">Voice profile</div>
    <h1>${name}</h1>
    <div class="base">${baseBits.join(' · ')}${hd ? '<span class="hd">HD</span>' : ''}</div>
    <div class="bars">${barRows}</div>
    <div class="foot">◗ <b>Dashboard&nbsp;Engine</b> voice</div>
  </body></html>`;
}

// Capture an ANIMATED clip of a pack's shot render (demo data) as a PNG frame
// sequence for a store trailer — offscreen, no personal data. Drives a synthetic
// cursor so parallax + cursor-ripple react, and bakes an on-brand caption. The
// frames are encoded to MP4 externally with ffmpeg. Dev/marketing utility.
// Render trailer lower-third caption banners (src/lowerthird.html) to transparent
// 1920x240 PNGs — one per caption — matching the store trailer's style, so the
// editor segment carries the same banners. Offscreen + transparent; captured PNGs
// keep their alpha for compositing in ffmpeg. Marketing tooling (DE_LOWERTHIRDS).
function captureLowerThirds(outDir, captions) {
  const fs = require('fs');
  return new Promise(async (resolve) => {
    try { fs.mkdirSync(outDir, { recursive: true }); } catch (e) { /* exists */ }
    const files = [];
    for (let i = 0; i < captions.length; i++) {
      const file = path.join(outDir, `lt-${String(i).padStart(2, '0')}.png`);
      await new Promise((res) => {
        let win = new BrowserWindow({
          width: 1920, height: 240, useContentSize: true, enableLargerThanScreen: true,
          show: false, frame: false, skipTaskbar: true, transparent: true, backgroundColor: '#00000000',
          webPreferences: { offscreen: true, backgroundThrottling: false, contextIsolation: true, nodeIntegration: false, sandbox: true },
        });
        try { win.setBounds({ x: 0, y: 0, width: 1920, height: 240 }); } catch (e) { /* clamp */ }
        let settled = false;
        const done = () => { if (settled) return; settled = true; if (win && !win.isDestroyed()) win.destroy(); win = null; res(); };
        const guard = setTimeout(done, 15000);
        win.webContents.on('did-finish-load', async () => {
          try {
            const start = Date.now();
            while (Date.now() - start < 8000) {
              const r = await win.webContents.executeJavaScript('window.__ltReady === true').catch(() => false);
              if (r) break;
              await new Promise((r) => setTimeout(r, 100));
            }
            await new Promise((r) => setTimeout(r, 150));
            const img = await win.webContents.capturePage();
            fs.writeFileSync(file, img.toPNG());
            files.push(file);
            clearTimeout(guard); done();
          } catch (e) { clearTimeout(guard); done(); }
        });
        win.loadFile(path.join(__dirname, 'src', 'lowerthird.html'), { query: { text: captions[i] } });
      });
    }
    resolve(files);
  });
}

// The "editor in action" trailer choreography (injected into the offscreen editor
// under ?demo=1). It shows the DESIGN PROCESS: from a clean stage, add four
// components and drag each into a logical grid slot so the REAL smart-alignment
// guides catch, then size the hero clock up. The finished dashboard — over a
// looping video, and as a photo gallery — is shown full-frame in the two PAYOFF
// beats (captureTrailerDash), not here, so this stays a tight editing showcase.
function buildEditorTimeline() {
  return `window.__demo.setTimeline([
  { at: 200,   type: 'clear' },
  { at: 600,   type: 'add',  comp: 'ring-clock', x: 42, y: 42 },
  { at: 900,   type: 'drag', index: 'last', dur: 1000, to: function (b) { return { x: b.left + b.width * 0.22, y: b.top + b.height * 0.27 }; } },
  { at: 2100,  type: 'add',  comp: 'weather', x: 56, y: 56 },
  { at: 2400,  type: 'drag', index: 'last', dur: 1000, to: function (b) { return { x: b.left + b.width * 0.78, y: b.top + b.height * 0.27 }; } },
  { at: 3600,  type: 'add',  comp: 'stats', x: 44, y: 46 },
  { at: 3900,  type: 'drag', index: 'last', dur: 950,  to: function (b) { return { x: b.left + b.width * 0.22, y: b.top + b.height * 0.64 }; } },
  { at: 5050,  type: 'add',  comp: 'sparkline', x: 60, y: 58 },
  { at: 5350,  type: 'drag', index: 'last', dur: 950,  to: function (b) { return { x: b.left + b.width * 0.78, y: b.top + b.height * 0.64 }; } },
  { at: 6500,  type: 'resize', index: 0, dir: 'se', dur: 950, to: function (b) { return { x: b.left + b.width * 0.4, y: b.top + b.height * 0.5 }; } },
  { at: 7700,  type: 'select', index: -1 },
  { at: 8000,  type: 'cursor', to: function (b) { return { x: b.left + b.width * 0.5, y: b.top + b.height * 0.85 }; } }
]);`;
}

// Capture the editor-choreography as a PNG frame sequence (fNNNN.png) for the
// editor trailer segment. Offscreen + deterministic (?capture=1&demo=1), so it's a
// perfect 30fps of the REAL editor UI (palette + stage + inspector) being driven.
function captureEditorTrailer(outDir, opts) {
  const fs = require('fs');
  const fps = (opts && opts.fps) || 30;
  const W = (opts && opts.width) || 1600;
  const H = (opts && opts.height) || 900;
  const pack = (opts && opts.pack) || 'neon-cyberpunk';
  return new Promise((resolve) => {
    try { fs.mkdirSync(outDir, { recursive: true }); } catch (e) { /* exists */ }
    let win = new BrowserWindow({
      width: W, height: H, useContentSize: true, enableLargerThanScreen: true,
      show: false, frame: false, skipTaskbar: true, backgroundColor: '#1b1d21',
      webPreferences: {
        ...COMMON_WEB_PREFERENCES,
        preload: path.join(__dirname, 'preload-editor.js'),
        offscreen: true, backgroundThrottling: false,
        autoplayPolicy: 'no-user-gesture-required', // so a video-wallpaper beat actually plays
      },
    });
    try { win.setBounds({ x: 0, y: 0, width: W, height: H }); } catch (e) { /* clamp */ }
    let settled = false, frame = 0;
    const finish = (n) => { if (settled) return; settled = true; if (win && !win.isDestroyed()) win.destroy(); win = null; resolve(n); };
    const guard = setTimeout(() => finish(frame), 180000);
    win.webContents.on('render-process-gone', () => { clearTimeout(guard); finish(frame); });
    win.webContents.on('did-finish-load', async () => {
      try {
        const start = Date.now();
        while (Date.now() - start < 25000) {
          const ready = await win.webContents.executeJavaScript('window.__demoReady === true && !!window.__editorDemoApi').catch(() => false);
          if (ready) break;
          await new Promise((r) => setTimeout(r, 150));
        }
        await win.webContents.executeJavaScript(buildEditorTimeline()).catch(() => {});
        const durMs = await win.webContents.executeJavaScript('window.__demo.duration()').catch(() => 5000);
        const total = Math.max(1, Math.round(((durMs + 900) / 1000) * fps)); // +0.9s tail so the last action settles
        for (let i = 0; i < total; i++) {
          const vt = (i * 1000) / fps;
          await win.webContents.executeJavaScript(`window.__demo.step(${vt}); window.__cap && window.__cap.step(${vt});`).catch(() => {});
          // A background VIDEO was just mounted — give it a real-time beat to load + play.
          const vw = await win.webContents.executeJavaScript('var w=window.__demoVideoWait; window.__demoVideoWait=false; !!w').catch(() => false);
          if (vw) await new Promise((r) => setTimeout(r, 1600));
          await new Promise((r) => setTimeout(r, 16)); // let the compositor paint the stepped frame
          const img = await win.webContents.capturePage();
          fs.writeFileSync(path.join(outDir, `f${String(i).padStart(4, '0')}.png`), img.toPNG());
          frame = i + 1;
        }
        clearTimeout(guard);
        finish(frame);
      } catch (err) { clearTimeout(guard); finish(frame); }
    });
    win.loadFile(path.join(__dirname, 'src', 'editor.html'), { query: { capture: '1', demo: '1', pack } });
  });
}

// ── Editor-trailer PAYOFF beats (marketing tooling) ──────────────────────────
// A full style block matching a sanitized pack's shape, so the ad-hoc trailer
// packs below render exactly like a real one (component builders read every key).
function trailerStyle(over) {
  return Object.assign({
    accent: null, textColor: null, font: null, fontScale: null, align: null,
    place: null, panel: null, border: null, notches: null, opacity: null,
    glow: null, padding: 0, rotate: null,
  }, over || {});
}

// The finished "sci-fi HUD" dashboard shown OVER the looping video (rendered on
// transparency; ffmpeg lays the video behind it). Scanlines/grid off so the video
// reads clean; glass panels + a hero ring-clock sit on top.
function trailerHudPack() {
  return {
    schema: 2, id: '_trailer-hud', name: 'Dashboard Engine',
    persona: { name: 'Dashboard', tagline: 'LIVE HUD', lines: ['All systems online.'] },
    skin: {
      palette: { void: '#050C16', glass: '#0D1E32', accent: '#4DDDFF', accentBright: '#A5F2FF', muted: '#8FB6CC', warn: '#FFB23E', gold: '#E8C56A' },
      typography: { display: 'rajdhani', uppercase: true, letterSpacing: 0.22 },
      texture: { scanlines: 0, grid: 0, glow: 0.6, vignette: 0.4 },
      shape: { cornerNotches: true, borderOpacity: 0.3, panelOpacity: 0.62, radius: 8 },
      ambience: { effect: 'none', density: 0.5 }, wallpaper: null,
    },
    canvas: { padding: 0 }, props: [],
    components: [
      { type: 'sysinfo', rect: [4, 10, 26, 20], z: 2, style: trailerStyle({ panel: true, padding: 10, fontScale: 0.95 }), options: { memory: true, disk: true, uptime: true, host: false, statusText: 'ALL SYSTEMS NOMINAL' } },
      { type: 'weather', rect: [70, 10, 26, 9], z: 2, style: trailerStyle({ panel: true, padding: 16 }), options: { lat: 0, lon: 0, place: null, details: true, compact: true } },
      { type: 'ring-clock', rect: [37, 22, 26, 45], z: 2, style: trailerStyle({}), options: { style: 'halo', showDate: true } },
      { type: 'cores', rect: [31, 80, 38, 13], z: 2, style: trailerStyle({ panel: true, padding: 10 }), options: { label: 'CORE LOAD' } },
    ],
  };
}

// The finished "personal gallery" dashboard — a photo gallery hero cycling the
// user's shots, with a clock, weather and system readouts. Rendered opaque over a
// warm gradient base fill.
function trailerGalleryPack(imageRels) {
  return {
    schema: 2, id: '_trailer-gallery', name: 'My Gallery',
    persona: { name: 'Gallery', tagline: 'PERSONAL', lines: ['Welcome home.'] },
    skin: {
      palette: { void: '#0B0D12', glass: '#171B24', accent: '#E6B980', accentBright: '#F6ECD8', muted: '#9AA1AA', warn: '#E0A446', gold: '#E8C56A' },
      typography: { display: 'rajdhani', uppercase: true, letterSpacing: 0.16 },
      texture: { scanlines: 0, grid: 0.06, glow: 0.3, vignette: 0.5 },
      shape: { cornerNotches: false, borderOpacity: 0.22, panelOpacity: 0.85, radius: 14 },
      ambience: { effect: 'none', density: 0.4 }, wallpaper: null,
      background: { fill: { type: 'radial', posX: 50, posY: 30, angle: 0, stops: [{ color: '#1B2130', at: 0 }, { color: '#0B0D12', at: 100 }], animate: false, grain: false } },
    },
    canvas: { padding: 0 }, props: [],
    components: [
      { type: 'text', rect: [31, 1.6, 64, 4.5], z: 3, style: trailerStyle({ align: 'left', fontScale: 1.0, textColor: '#F6ECD8', glow: 0.4 }), options: { text: 'MY GALLERY' } },
      { type: 'gallery', rect: [31, 7, 65, 74], z: 2, style: trailerStyle({ panel: true, notches: false, padding: 8, glow: 0.3 }), options: { images: imageRels, interval: 2, transition: 'fade', fit: 'cover' } },
      { type: 'ring-clock', rect: [4, 9, 23, 26], z: 2, style: trailerStyle({}), options: { style: 'halo', showDate: true } },
      { type: 'weather', rect: [4, 38, 23, 9], z: 2, style: trailerStyle({ panel: true, padding: 16 }), options: { lat: 0, lon: 0, place: null, details: true, compact: true } },
      { type: 'sysinfo', rect: [4, 49, 23, 22], z: 2, style: trailerStyle({ panel: true, padding: 10 }), options: { memory: true, disk: true, uptime: true, host: false, statusText: null } },
    ],
  };
}

// Render a rich, seamless looping video (scratch/loopgen.html) to a PNG frame
// sequence — the "any looping video" a user might set as their wallpaper. Every
// motion term is periodic, so capturing exactly one PERIOD loops perfectly.
function captureLoopFrames(outDir, opts) {
  const fs = require('fs');
  const fps = (opts && opts.fps) || 30;
  const W = 1920, H = 1080;
  return new Promise((resolve) => {
    try { fs.mkdirSync(outDir, { recursive: true }); } catch (e) { /* exists */ }
    let win = new BrowserWindow({
      width: W, height: H, useContentSize: true, enableLargerThanScreen: true,
      show: false, frame: false, skipTaskbar: true, backgroundColor: '#01020a',
      webPreferences: { offscreen: true, backgroundThrottling: false, contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    try { win.setBounds({ x: 0, y: 0, width: W, height: H }); } catch (e) { /* clamp */ }
    let settled = false, frame = 0;
    const finish = (n) => { if (settled) return; settled = true; if (win && !win.isDestroyed()) win.destroy(); win = null; resolve(n); };
    const guard = setTimeout(() => finish(frame), 180000);
    win.webContents.on('render-process-gone', () => { clearTimeout(guard); finish(frame); });
    win.webContents.on('did-finish-load', async () => {
      try {
        const start = Date.now();
        while (Date.now() - start < 12000) {
          if (await win.webContents.executeJavaScript('window.__loopReady === true').catch(() => false)) break;
          await new Promise((r) => setTimeout(r, 100));
        }
        const period = await win.webContents.executeJavaScript('window.__loopPeriod || 6').catch(() => 6);
        const total = Math.max(1, Math.round(period * fps));
        for (let i = 0; i < total; i++) {
          await win.webContents.executeJavaScript(`window.__drawFrame(${(i / fps).toFixed(4)})`).catch(() => {});
          await new Promise((r) => setTimeout(r, 24)); // let the compositor paint
          const img = await win.webContents.capturePage();
          fs.writeFileSync(path.join(outDir, `f${String(i).padStart(4, '0')}.png`), img.toPNG());
          frame = i + 1;
        }
        clearTimeout(guard); finish(frame);
      } catch (e) { clearTimeout(guard); finish(frame); }
    });
    win.loadFile(path.join(__dirname, 'src', 'loopgen.html'));
  });
}

// Render an ad-hoc trailer pack full-frame to a PNG sequence. REAL-TIME capture
// (no virtual clock) so the gallery's setInterval cycling and the clock animate
// naturally. opts.transparent → a transparent window whose PNGs keep alpha, for
// compositing a looping video behind the dashboard.
function captureTrailerDash(spec, outDir, opts) {
  const fs = require('fs');
  const fps = (opts && opts.fps) || 30;
  const seconds = (opts && opts.seconds) || 4;
  const transparent = !!(opts && opts.transparent);
  const W = 1920, H = 1080;
  return new Promise((resolve) => {
    try { fs.mkdirSync(outDir, { recursive: true }); } catch (e) { /* exists */ }
    let win = new BrowserWindow({
      width: W, height: H, useContentSize: true, enableLargerThanScreen: true,
      show: false, frame: false, skipTaskbar: true,
      transparent, backgroundColor: transparent ? '#00000000' : '#04080F',
      webPreferences: {
        ...COMMON_WEB_PREFERENCES,
        preload: path.join(__dirname, 'preload-dashboard.js'),
        offscreen: true, backgroundThrottling: false,
      },
    });
    try { win.setBounds({ x: 0, y: 0, width: W, height: H }); } catch (e) { /* clamp */ }
    let settled = false, frame = 0;
    const finish = (n) => { if (settled) return; settled = true; if (win && !win.isDestroyed()) win.destroy(); win = null; resolve(n); };
    const guard = setTimeout(() => finish(frame), 120000);
    win.webContents.on('render-process-gone', () => { clearTimeout(guard); finish(frame); });
    win.webContents.on('did-finish-load', async () => {
      try {
        await win.webContents.executeJavaScript(`window.__trailerSpec = ${JSON.stringify(spec)}; true;`).catch(() => {});
        const start = Date.now();
        while (Date.now() - start < 15000) {
          if (await win.webContents.executeJavaScript('window.__shotReady === true').catch(() => false)) break;
          await new Promise((r) => setTimeout(r, 120));
        }
        const total = Math.max(1, Math.round(seconds * fps));
        for (let i = 0; i < total; i++) {
          await new Promise((r) => setTimeout(r, Math.round(1000 / fps))); // real-time cadence
          const img = await win.webContents.capturePage();
          fs.writeFileSync(path.join(outDir, `f${String(i).padStart(4, '0')}.png`), img.toPNG());
          frame = i + 1;
        }
        clearTimeout(guard); finish(frame);
      } catch (e) { clearTimeout(guard); finish(frame); }
    });
    win.loadFile(path.join(__dirname, 'src', 'trailer-dash.html'));
  });
}

function captureTrailerClip(packId, outDir, opts) {
  const fs = require('fs');
  const seconds = (opts && opts.seconds) || 6;
  const fps = (opts && opts.fps) || 30;
  // Capture a touch under 1080p so the per-frame JPEG encode is cheap; ffmpeg
  // upscales the ~1.2x back to 1080 with negligible softening.
  const W = (opts && opts.width) || 1600;
  const H = (opts && opts.height) || 900;
  return new Promise((resolve) => {
    try { fs.mkdirSync(outDir, { recursive: true }); } catch (e) { /* exists */ }
    let win = new BrowserWindow({
      width: W, height: H, useContentSize: true, enableLargerThanScreen: true,
      show: false, frame: false, skipTaskbar: true, backgroundColor: '#04080F',
      webPreferences: {
        ...COMMON_WEB_PREFERENCES,
        preload: path.join(__dirname, 'preload-dashboard.js'),
        offscreen: true, backgroundThrottling: false,
      },
    });
    try { win.setBounds({ x: 0, y: 0, width: W, height: H }); } catch (e) { /* clamp */ }
    let settled = false;
    let frame = 0;
    const finish = (n) => {
      if (settled) return;
      settled = true;
      if (win && !win.isDestroyed()) win.destroy();
      win = null;
      resolve(n);
    };
    const total = Math.max(1, Math.round(seconds * fps));
    const guard = setTimeout(() => finish(frame), (total * 0.4 + 40) * 1000);
    win.webContents.on('render-process-gone', () => { clearTimeout(guard); finish(frame); });
    win.webContents.on('did-finish-load', async () => {
      try {
        const start = Date.now();
        while (Date.now() - start < 12000) {
          const ready = await win.webContents.executeJavaScript('window.__shotReady === true').catch(() => false);
          if (ready) break;
          await new Promise((r) => setTimeout(r, 150));
        }
        // DETERMINISTIC capture: advance the virtual clock (capture-clock.js) a
        // fixed 1/fps per frame and grab it — so the output is a perfect `fps`
        // regardless of how slowly the off-screen compositor paints. Captions are
        // NOT baked here; they're composited later in ffmpeg (banner lower-third).
        const buffers = [];
        for (let i = 0; i < total; i++) {
          const vt = (i * 1000) / fps;
          const t = i / total;
          const px = Math.round(W / 2 + W * 0.41 * Math.sin(t * 6.283));
          const py = Math.round(H / 2 + H * 0.36 * Math.sin(t * 12.566 + 1));
          await win.webContents.executeJavaScript('window.__cap && window.__cap.step(' + vt + ',' + px + ',' + py + ')').catch(() => {});
          await new Promise((r) => setTimeout(r, 16)); // let the compositor paint the stepped frame
          const img = await win.webContents.capturePage();
          buffers.push(img.toJPEG(90));
        }
        clearTimeout(guard);
        for (let j = 0; j < buffers.length; j++) {
          try { fs.writeFileSync(path.join(outDir, 'f' + String(j + 1).padStart(4, '0') + '.jpg'), buffers[j]); } catch (e) { /* skip */ }
        }
        frame = buffers.length;
        finish(frame);
      } catch (e) {
        clearTimeout(guard);
        finish(frame);
      }
    });
    win.loadFile(path.join(__dirname, 'src', 'shot.html'), { query: { pack: String(packId), capture: '1' } });
  });
}

// ── Library card thumbnails ──────────────────────────────────────────────────
// A cached STATIC snapshot per pack (rendered offscreen with DEMO data — no
// personal info) used as the library card image, so cards never live-render.
// Freshness is by pack.json mtime; a save (which rewrites pack.json) auto-
// invalidates. Renders are serialized so opening a big library doesn't spawn a
// swarm of offscreen windows.
const THUMB_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,47}$/;
const thumbInFlight = new Map();
let thumbQueue = Promise.resolve();

// Card thumbnails are rendered in OFFSCREEN BrowserWindows (GPU-backed). Creating/
// destroying those while the OS is in a window MOVE/RESIZE modal loop — the user
// grabbed the manager's title bar — contends with the GPU/compositor and can hang
// or hard-crash the app with NO catchable JS error (nothing reaches the crash
// log). So the thumbnail queue waits until the manager window is idle: not
// just-opened (still settling), and not being dragged or resized. `markManagerBusy`
// pushes the idle moment forward; a fresh build makes every thumbnail stale, so the
// first open is exactly when the render swarm would collide with an eager drag.
let managerBusyUntil = 0;
function markManagerBusy(ms) { managerBusyUntil = Math.max(managerBusyUntil, Date.now() + ms); }
function whenManagerIdle() {
  return new Promise((resolve) => {
    const tick = () => {
      const wait = managerBusyUntil - Date.now();
      if (wait <= 0) resolve();
      else setTimeout(tick, Math.min(wait, 150));
    };
    tick();
  });
}

function thumbDir() { return path.join(USER_DIR, 'thumbnails'); }

function packManifestMtime(id) {
  try {
    const resolved = packs.resolvePackDir(__dirname, USER_DIR, id);
    if (resolved.origin === 'missing') return -1;
    return require('fs').statSync(path.join(resolved.dir, 'pack.json')).mtimeMs;
  } catch { return -1; }
}

// A fresh cached thumbnail (newer than the pack manifest) as a data URI, or null.
function cachedThumbUri(id) {
  const fs = require('fs');
  const mtime = packManifestMtime(id);
  if (mtime < 0) return null;
  for (const ext of ['png', 'jpg']) {
    const file = path.join(thumbDir(), `${id}.${ext}`);
    try {
      const st = fs.statSync(file);
      if (st.mtimeMs >= mtime) return `data:${ext === 'png' ? 'image/png' : 'image/jpeg'};base64,${fs.readFileSync(file).toString('base64')}`;
    } catch { /* not cached in this ext */ }
  }
  return null;
}

function queuedThumbRender(id) {
  const next = thumbQueue.then(async () => {
    // Hold off while the manager window is settling after open or being dragged/
    // resized, so offscreen GPU renders never churn during an OS modal move loop.
    await whenManagerIdle();
    return renderPackPreview(id, { width: 854, height: 480 }).catch(() => null);
  });
  thumbQueue = next.catch(() => {});
  return next;
}

// Return the pack's card thumbnail as a data URI (cached, or rendered + cached
// on first request). null on any failure — the card then shows its blueprint.
async function getPackThumbnail(id) {
  if (!THUMB_ID_PATTERN.test(String(id))) return null;
  const hit = cachedThumbUri(id);
  if (hit) return hit;
  if (thumbInFlight.has(id)) return thumbInFlight.get(id);
  const job = (async () => {
    const file = await queuedThumbRender(id);
    if (!file) return null;
    const fs = require('fs');
    try {
      const ext = path.extname(file).slice(1).toLowerCase() === 'png' ? 'png' : 'jpg';
      fs.mkdirSync(thumbDir(), { recursive: true });
      for (const e of ['png', 'jpg']) { try { fs.rmSync(path.join(thumbDir(), `${id}.${e}`)); } catch { /* none */ } }
      const dest = path.join(thumbDir(), `${id}.${ext}`);
      fs.copyFileSync(file, dest);
      try { fs.rmSync(file); } catch { /* tmp cleanup best-effort */ }
      return `data:${ext === 'png' ? 'image/png' : 'image/jpeg'};base64,${fs.readFileSync(dest).toString('base64')}`;
    } catch { return null; }
  })();
  thumbInFlight.set(id, job);
  job.finally(() => thumbInFlight.delete(id));
  return job;
}

// SESSION role (the packaged Steam launch): do NOT run the engine here. Ask the
// running engine — starting one detached if none is up — to open the Manager, then
// stay alive only until it closes, so Steam's "playing" indicator tracks the Manager
// rather than the always-on wallpaper. A session owns no windows; the pipe socket
// keeps the process alive. FAIL-SOFT: if no engine can be reached or started, spawn
// one detached so the wallpaper still appears, then exit.
// The Steam operations the engine may forward to the session. Whitelisted so a
// forwarded call can only reach a known Workshop op, never e.g. setForwarder.
const SESSION_STEAM_OPS = new Set([
  'status', 'publish', 'browse', 'listSubscribed', 'importSubscribed', 'subscribe',
  'listMine', 'getEditableCopy', 'getItemVisibility',
  'publishVoice', 'browseVoices', 'listMineVoices', 'getEditableVoice', 'importVoice',
]);

function runSession() {
  const link = require('./lib/session-link');
  const workshop = require('./lib/workshop');
  const achievements = require('./lib/achievements');
  const editAt = process.argv.indexOf('--edit');
  const intent = editAt !== -1 ? { cmd: 'edit', id: process.argv[editAt + 1] || 'jarvis' } : { cmd: 'open-manager' };
  app.on('window-all-closed', () => { /* a session has no windows — stay alive on the socket */ });
  app.whenReady().then(() => {
    link.connect(process.execPath, intent, {
      onEnd: () => app.quit(), // Manager closed (or engine gone) → session ends → Steam not playing
      onFail: () => {
        try { require('child_process').spawn(process.execPath, [ENGINE_FLAG], { detached: true, stdio: 'ignore', windowsHide: true }).unref(); }
        catch { /* nothing more we can do */ }
        app.quit();
      },
      // The SESSION owns the Steam client — run the Workshop / achievement ops the
      // engine forwards. (No forwarder is set in this process, so these run locally.)
      onRpc: (method, args) => {
        if (method === 'unlock') return Promise.resolve(achievements.unlock(String((args && args[0]) || '')));
        if (SESSION_STEAM_OPS.has(method) && typeof workshop[method] === 'function') return Promise.resolve(workshop[method](...(args || [])));
        return Promise.reject(new Error(`Unsupported Steam op: ${method}`));
      },
    });
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
if (IS_SESSION) {
  // The Steam-launched session: talk to the engine, don't become it.
  runSession();
} else if (!WANT_PANEL && !app.requestSingleInstanceLock()) {
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

  // ── Pomodoro / focus timer (main-backed, wall-clock) ───────────────────────
  // The timer's source of truth is lib/pomodoro.js (persisted). We keep ONE
  // timer armed against the running phase's end moment; when it fires — or the
  // app reopens across an end — we advance the phase, fire the notification, and
  // tell every window so the wallpaper repaints. Running the countdown HERE, not
  // in the renderer, is what lets the phase-end ding survive the desktop freeze
  // (the renderer is destroyed while a full-screen app owns the screen).
  const POMODORO_CATCHUP_MS = 90 * 1000;              // ding for an end missed this recently; older → silent transition
  const POMODORO_MAX_SLEEP_MS = 24 * 60 * 60 * 1000;  // re-arm at least daily (a paused timer parks until a control action)

  // The desktop is "active" (rendering, so a chime will play) when a desktop
  // window exists and nothing is pausing it — same rule as sendDesktopPower().
  function desktopIsActive() {
    if (!dashboardWindow || dashboardWindow.isDestroyed()) return false;
    const perf = settings.getPerformance(USER_DIR);
    return !(desktopPaused || (perf.pauseOnFullscreen && isFullscreen) || (perf.pauseOnBattery && onBattery));
  }

  function broadcastPomodoro(event) {
    const payload = { event: event || 'control', state: pomodoro.get(USER_DIR) };
    for (const win of BrowserWindow.getAllWindows()) {
      if (win && !win.isDestroyed()) {
        try { win.webContents.send('aegis:pomodoro:changed', payload); } catch { /* window gone */ }
      }
    }
  }

  function firePomodoroEnd(result) {
    const cfg = result.state.cfg || {};
    // Broadcast first: an active desktop repaints to the new phase and (if the
    // chime is on) plays its sound in the component.
    broadcastPomodoro('phase-end');
    if (!cfg.notify || !Notification.isSupported()) return;
    // When the desktop is active AND the chime is on, the chime is the sound, so
    // fire the toast SILENT to avoid a double-ding. When frozen/closed (you're
    // heads-down in a full-screen app) there's no chime — the OS sound is the alert.
    const chimeCovers = cfg.sound && desktopIsActive();
    const dict = i18n.getActive(USER_DIR, settings.getLocale(USER_DIR), app.getLocale()).dict;
    const tr = (key, english) => { const s = i18n.translate(dict, key); return s === key ? english : s; };
    const endedFocus = result.endedPhase === 'focus';
    const title = endedFocus ? tr('pomodoro.notify.focusDone.title', 'Focus complete') : tr('pomodoro.notify.breakDone.title', 'Break over');
    const body = endedFocus ? tr('pomodoro.notify.focusDone.body', 'Time for a break.') : tr('pomodoro.notify.breakDone.body', 'Back to focus.');
    const n = new Notification({ title, body, silent: chimeCovers });
    n.on('click', () => { if (dashboardWindow && !dashboardWindow.isDestroyed()) dashboardWindow.focus(); });
    n.show();
  }

  function armNextPomodoro(state) {
    if (!state.running || !state.endsAt) return; // paused/idle — a control action re-arms
    const sleep = Math.min(Math.max(state.endsAt - Date.now(), 250), POMODORO_MAX_SLEEP_MS);
    pomodoroTimer = setTimeout(rearmPomodoro, sleep);
    if (typeof pomodoroTimer.unref === 'function') pomodoroTimer.unref(); // never hold the process open
  }

  // Fire any phase(s) that ended while we weren't watching, then arm the next
  // timer. Bounded loop so auto-start across a long absence can't spin forever.
  function rearmPomodoro() {
    if (pomodoroTimer) { clearTimeout(pomodoroTimer); pomodoroTimer = null; }
    for (let i = 0; i < 500; i++) {
      const result = pomodoro.tick(USER_DIR);
      if (!result.ended) { armNextPomodoro(result.state); return; }
      // Only ding for a genuinely recent end — a live timer firing, or the app
      // reopening moments after. Older ends (the app was closed a while) advance
      // silently so you don't get a stale ding for a break long gone.
      if (Date.now() - (result.endedAt || 0) <= POMODORO_CATCHUP_MS) firePomodoroEnd(result);
      if (!result.autoStarted) { armNextPomodoro(result.state); return; }
      // autoStarted → the next phase is already running; loop in case it, too, is overdue.
    }
    armNextPomodoro(pomodoro.get(USER_DIR));
  }

  app.whenReady().then(() => {
    logEngine('INFO', `engine start — v${app.getVersion()} · electron ${process.versions.electron} · ${process.platform} · ${LAUNCHED_AT_LOGIN ? 'login' : 'manual'}`);
    // Voice models now live in user data (survive updates); bring any the owner
    // downloaded into the old in-app voices/ dir across so they aren't refetched.
    voicebank.migrateModelsFromAppRoot(__dirname);
    warnAboutUnauditedVoices();

    // SECURITY: Electron GRANTS permission requests by default when no handler
    // is set — which would let an untrusted pack `module` frame ask for camera,
    // microphone, geolocation, etc. The engine needs none of these EXCEPT one:
    // the audio visualizer captures system-audio loopback via getDisplayMedia,
    // which needs 'display-capture'. Grant that ONLY to the trusted desktop
    // window's TOP frame (never a module iframe, never another window); deny
    // everything else, everywhere.
    // The audio visualizer captures system-audio loopback via getDisplayMedia,
    // which needs 'display-capture' AND — for the audio track — a 'media' check.
    // Grant BOTH only to the DESKTOP window; the display-media handler below
    // further restricts the actual stream to that window's TOP frame, and a pack
    // `module` iframe is blocked by Permissions Policy (allow="") + the SDK shim
    // regardless. Every OTHER permission (camera, mic, geolocation, …) and every
    // other window/frame stays denied.
    const isDesktopWc = (wc) => !!wc && dashboardWindow && !dashboardWindow.isDestroyed() && wc === dashboardWindow.webContents;
    const isCapturePerm = (p) => p === 'display-capture' || p === 'media';
    session.defaultSession.setPermissionRequestHandler((wc, permission, callback) => {
      callback(isCapturePerm(permission) && isDesktopWc(wc));
    });
    session.defaultSession.setPermissionCheckHandler((_wc, permission) => isCapturePerm(permission));
    // Chromium REQUIRES a video source for getDisplayMedia to resolve even when
    // we only want audio, so we pair a screen source with loopback audio and the
    // renderer stops that video track immediately (keeping only the audio).
    session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
      let frameOk = false;
      try {
        const frame = request.frame;
        const url = frame ? String(frame.url || '') : '';
        frameOk = !!frame && frame.top === frame && url.includes('/dashboard.html');
      } catch (err) { frameOk = false; }
      if (!frameOk) { callback({}); return; }
      desktopCapturer.getSources({ types: ['screen'], fetchWindowIcons: false }).then((sources) => {
        callback(sources && sources.length ? { video: sources[0], audio: 'loopback' } : { audio: 'loopback' });
      }).catch(() => callback({}));
    });

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

    // Stream a background-music track. The URL host is the OPAQUE track id;
    // main resolves it to a real path ONLY if the user added that track, then
    // streams the file (forwarding Range so the audio element can seek).
    protocol.handle(MUSIC_SCHEME, (request) => {
      try {
        const id = new URL(request.url).hostname;
        const file = music.pathForId(USER_DIR, id);
        if (!file) return new Response('', { status: 404 });
        // Forward ONLY Range (for seeking) — never the whole request's headers —
        // to a file:// fetch main built from a vetted, id-resolved path.
        const range = request.headers.get('range');
        return net.fetch(pathToFileURL(file).toString(), range ? { headers: { Range: range } } : undefined);
      } catch (err) {
        return new Response('', { status: 400 });
      }
    });

    // Stream a pack VIDEO wallpaper. Identical gating to music: the URL host is
    // an OPAQUE id that resolves (via lib/videostore) to a real path ONLY if a
    // currently-loaded pack registered that video; unknown id → 404. Range is
    // forwarded so the <video> element can seek/loop efficiently.
    protocol.handle(VIDEO_SCHEME, (request) => {
      try {
        const id = new URL(request.url).hostname;
        const file = videostore.pathForId(id);
        if (!file) return new Response('', { status: 404 });
        const range = request.headers.get('range');
        return net.fetch(pathToFileURL(file).toString(), range ? { headers: { Range: range } } : undefined);
      } catch (err) {
        return new Response('', { status: 400 });
      }
    });
    if (!WANT_PANEL) {
      alertScheduler = createAlertScheduler({ userDir: USER_DIR, notify: notifyReminder });
      alertScheduler.rearm();
      // Focus timer: reconcile any phase that ended while the app was closed and
      // arm the next one (a paused/idle timer just parks until a control action).
      rearmPomodoro();
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
      onPomodoroChanged: (info) => {
        // A control action changed the focus timer: sync every window at once so
        // all pomodoro components agree, then re-arm main's phase-end timer.
        broadcastPomodoro((info && info.event) || 'control');
        rearmPomodoro();
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
        recomputeActivePackMixer(); // an edit may have added/removed the mixer
      },
      // Workshop publish asks for a rendered preview image of the pack.
      // Steam gets a small STATIC preview (a big animated GIF trips Steam's upload
      // throttle). The live moving preview is shown in-app on the Browse detail.
      renderPreview: (id) => renderPackPreview(id),
      // Publishing a VOICE renders a small preview card (name + base voice +
      // tuning bars; no personal data).
      renderVoicePreview: (file) => renderVoicePreview(file),
      renderThumbnail: (id) => getPackThumbnail(id),
      // Send an event to every live window — used for voice-bank download
      // progress so a download (which runs in main) still updates a window that
      // was closed and reopened mid-download.
      broadcast: (channel, payload) => {
        for (const win of BrowserWindow.getAllWindows()) {
          if (win && !win.isDestroyed()) {
            try { win.webContents.send(channel, payload); } catch { /* window gone */ }
          }
        }
      },
      // Workshop needs a Steam-tracked session; the Manager gates the Workshop tabs
      // on this and bounces through Steam only when the user opens one.
      workshopAvailable: () => workshopAvailable(),
      launchWorkshopSession: () => launchWorkshopSession(),
      // Settings screen: performance changes must reach the live desktop, and
      // the OS login item is owned by main.
      onPerformanceChanged: () => sendDesktopPower(),
      onBackgroundMotionChanged: () => sendBackgroundMotion(),
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
      // Background music changed in Settings — tell the OTHER windows (the
      // desktop updates playback; a second window stays in sync). Skip the
      // sender: it already reflects its own change, and re-rendering it would
      // drop keyboard focus mid-list.
      onMusicChanged: (sender) => {
        for (const win of [dashboardWindow, managerWindow]) {
          if (win && !win.isDestroyed() && win.webContents !== sender) {
            win.webContents.send('aegis:music:changed');
          }
        }
      },
      // Now-playing: the `nowplaying` component reads current state on load and
      // drives transport controls (play/pause/next/prev) via the media session.
      getMediaState: () => (mediaMonitor ? mediaMonitor.current() : { has: false }),
      mediaControl: (action) => (mediaMonitor
        ? mediaMonitor.control(action)
        : Promise.resolve({ ok: false, error: 'Media control is unavailable.' })),
      // Per-app volume mixer: the `mixer` component reads current sessions on
      // mount (which starts/activates the daemon) and sets per-app volume/mute.
      getAudioState: () => { ensureAudioMixer(); refreshAudioMixer(); return lastAudioState; },
      audioSet: (id, patch) => {
        if (!audioMixer) return;
        if (patch && patch.volume !== undefined) audioMixer.setVolume(id, patch.volume);
        if (patch && patch.muted !== undefined) audioMixer.setMute(id, patch.muted);
      },
    });
    // DE_EDITOR_TRAILER=<dir>: capture the deterministic "editor in action" clip and
    // quit. Capture-only — IPC + protocols are up (the editor page needs them), but
    // we skip the tray/desktop so it never touches the live wallpaper.
    if (envFlag('EDITOR_TRAILER')) {
      captureEditorTrailer(envFlag('EDITOR_TRAILER'), { pack: envFlag('EDITOR_TRAILER_PACK') || 'neon-cyberpunk' })
        .then((n) => { console.log(`[editor-trailer] ${n} frames -> ${envFlag('EDITOR_TRAILER')}`); app.quit(); })
        .catch((e) => { console.log(`[editor-trailer] failed: ${e && e.message}`); app.quit(); });
      return;
    }
    // DE_LOWERTHIRDS=<dir> + DE_LT_CAPTIONS="a|b|c": render the caption banners.
    if (envFlag('LOWERTHIRDS')) {
      const caps = (envFlag('LT_CAPTIONS') || '').split('|').map((s) => s.trim()).filter(Boolean);
      captureLowerThirds(envFlag('LOWERTHIRDS'), caps)
        .then((f) => { console.log(`[lowerthirds] ${f.length} banners -> ${envFlag('LOWERTHIRDS')}`); app.quit(); })
        .catch((e) => { console.log(`[lowerthirds] failed: ${e && e.message}`); app.quit(); });
      return;
    }
    // DE_LOOPFRAMES=<dir>: render the seamless aurora loop to a PNG frame sequence.
    if (envFlag('LOOPFRAMES')) {
      captureLoopFrames(envFlag('LOOPFRAMES'), {})
        .then((n) => { console.log(`[loopframes] ${n} frames -> ${envFlag('LOOPFRAMES')}`); app.quit(); })
        .catch((e) => { console.log(`[loopframes] failed: ${e && e.message}`); app.quit(); });
      return;
    }
    // DE_TRAILER_DASH=<dir> + DE_TDASH_KIND=video|gallery: render a full-frame
    // finished dashboard for a payoff beat (transparent HUD for the video beat,
    // opaque photo-gallery dashboard for the gallery beat).
    if (envFlag('TRAILER_DASH')) {
      const outDir = envFlag('TRAILER_DASH');
      const kind = envFlag('TDASH_KIND') || 'video';
      let spec, opts;
      if (kind === 'gallery') {
        const fs = require('fs');
        const gdir = path.join(__dirname, 'store-assets', 'trailer', 'editor-assets', 'gallery');
        // Four varied, scene-like "photos": the two seed wallpapers that read as
        // real scenes (a sunset, a city skyline) plus two rich stills from the
        // aurora loop — so the gallery sells "your photos" instead of flat gradients.
        const photoSrcs = [
          { p: path.join(__dirname, 'packs', 'vaporwave', 'assets', 'bg.png'), m: 'image/png' },
          { p: path.join(__dirname, 'packs', 'neon-cyberpunk', 'assets', 'bg.png'), m: 'image/png' },
          { p: path.join(gdir, 'space1.jpg'), m: 'image/jpeg' },
          { p: path.join(gdir, 'space2.jpg'), m: 'image/jpeg' },
        ];
        const assets = {}; const imgs = [];
        photoSrcs.forEach((s, i) => {
          const rel = `assets/photo${i + 1}.jpg`;
          try { assets[rel] = `data:${s.m};base64,${fs.readFileSync(s.p).toString('base64')}`; imgs.push(rel); } catch (e) { /* skip */ }
        });
        spec = { pack: trailerGalleryPack(imgs), assets, transparent: false };
        opts = { transparent: false, seconds: 6, fps: 30 };
      } else {
        spec = { pack: trailerHudPack(), assets: {}, transparent: true };
        opts = { transparent: true, seconds: 4, fps: 30 };
      }
      captureTrailerDash(spec, outDir, opts)
        .then((n) => { console.log(`[trailer-dash:${kind}] ${n} frames -> ${outDir}`); app.quit(); })
        .catch((e) => { console.log(`[trailer-dash:${kind}] failed: ${e && e.message}`); app.quit(); });
      return;
    }
    if (!WANT_PANEL) createTray();
    if (!WANT_PANEL) startPresenceMonitoring();
    // Start the volume-mixer daemon now only if the active pack already uses it
    // (else it stays dormant until a mixer pack is loaded).
    if (!WANT_PANEL) recomputeActivePackMixer();
    // Accept commands from Steam-launched SESSION processes (open the Manager; and
    // when a session ends — Manager closed or Steam "Stop" — close the Manager but
    // keep the wallpaper). Fail-soft: if the pipe can't bind, the engine still runs
    // exactly as before, just without the "playing tracks the Manager" behaviour.
    if (!WANT_PANEL) {
      try {
        const workshop = require('./lib/workshop');
        // Achievements fired while no session is connected wait here, then flush to
        // the session on the next connect (Steam's activate is idempotent).
        const pendingAchievements = new Set();
        sessionLink = require('./lib/session-link').serve({
          onOpen: () => {
            createManagerWindow();
            // A session just connected — a Manager already open on a Workshop tab
            // can now load it (it bounced through Steam to get here).
            if (managerWindow && !managerWindow.isDestroyed()) {
              try { managerWindow.webContents.send('aegis:workshop:session', { connected: true }); } catch (e) { /* window gone */ }
            }
            if (pendingAchievements.size && sessionLink && sessionLink.hasSession()) {
              for (const name of Array.from(pendingAchievements)) sessionLink.call('unlock', [name]).catch(() => {});
              pendingAchievements.clear();
            }
          },
          onEdit: (id) => createEditorWindow(id),
          onSessionGone: () => { if (managerWindow && !managerWindow.isDestroyed()) managerWindow.close(); },
          onError: (err) => logEngine('WARN', `session-link server: ${err && err.message}`),
        });
        // The persistent engine must NEVER open its own Steam connection (Steam would
        // then track IT as "playing"). Forward every Steam op to the session, which
        // Steam launched and tracks. Packaged only — unpackaged dev has no session and
        // keeps using its own client, so Workshop still works while developing.
        if (app.isPackaged) {
          workshop.setForwarder((method, args) =>
            (sessionLink && sessionLink.hasSession())
              ? sessionLink.call(method, args)
              : Promise.resolve({ ok: false, error: 'Open the Manager from Steam to use the Workshop.' }));
          achievements.setForwarder((method, args) => {
            const name = String((args && args[0]) || '');
            if (sessionLink && sessionLink.hasSession()) return sessionLink.call(method, args).catch(() => {});
            if (name) pendingAchievements.add(name); // flush on next session connect
            return Promise.resolve();
          });
        }
      } catch (err) { logEngine('WARN', `session-link unavailable: ${err && err.message}`); }
    }
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
    // DE_GIFPREVIEW=<dir>: dev utility — render DE_PACK's ANIMATED (GIF) Workshop
    // preview to <dir>/preview.gif and quit, to eyeball the motion + file size.
    if (envFlag('GIFPREVIEW')) {
      renderPackPreviewGif(envFlag('PACK') || 'jarvis').then((file) => {
        const fs = require('fs');
        try {
          fs.mkdirSync(envFlag('GIFPREVIEW'), { recursive: true });
          if (file) { fs.copyFileSync(file, path.join(envFlag('GIFPREVIEW'), 'preview.gif')); console.log(`[gifpreview] ok ${file} (${fs.statSync(file).size} bytes)`); }
          else console.log('[gifpreview] render failed (ffmpeg missing or over size cap)');
        } catch (err) { console.warn(`[gifpreview] ${err.message}`); }
        app.quit();
      });
    }
    // DE_STORESHOTS=<dir>: dev/marketing utility — render each pack in DE_PACKS
    // (comma-separated; default jarvis,sakura,neon-cyberpunk) at DE_STORESIZE
    // (WxH, default 1920x1080) with DEMO data only (no personal info), writing
    // <dir>/<id>.png, then quit. Reuses the Workshop preview renderer.
    if (envFlag('STORESHOTS')) {
      const fs = require('fs');
      const dir = envFlag('STORESHOTS');
      const ids = (envFlag('PACKS') || 'jarvis,sakura,neon-cyberpunk').split(',').map((s) => s.trim()).filter(Boolean);
      const [sw, sh] = (envFlag('STORESIZE') || '1920x1080').split('x').map((n) => parseInt(n, 10));
      (async () => {
        try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { /* best-effort */ }
        for (const id of ids) {
          try {
            const file = await renderPackPreview(id, { width: sw || 1920, height: sh || 1080, png: true });
            if (file) { fs.copyFileSync(file, path.join(dir, `${id}.png`)); try { fs.rmSync(file); } catch (e) { /* tmp */ } console.log(`[storeshot] ${id} -> ${id}.png`); }
            else console.warn(`[storeshot] ${id}: render failed`);
          } catch (err) { console.warn(`[storeshot] ${id}: ${err.message}`); }
        }
        app.quit();
      })();
    }
    // DE_TRAILER=<dir>: capture animated PNG frame sequences (demo data) for a
    // store trailer. DE_PACKS=a,b,c · DE_TRAILER_SECS=<n> · DE_CAPTIONS="a|b|c"
    // (per-pack, baked on-brand). Frames land in <dir>/<id>/fNNNN.png; encode to
    // MP4 externally with ffmpeg.
    if (envFlag('TRAILER')) {
      const dir = envFlag('TRAILER');
      const ids = (envFlag('PACKS') || 'jarvis').split(',').map((s) => s.trim()).filter(Boolean);
      const secs = Number(envFlag('TRAILER_SECS')) || 6;
      const caps = (envFlag('CAPTIONS') || '').split('|');
      (async () => {
        for (let k = 0; k < ids.length; k++) {
          const n = await captureTrailerClip(ids[k], path.join(dir, ids[k]), { seconds: secs, caption: (caps[k] || '').trim() });
          console.log(`[trailer] ${ids[k]}: ${n} frames`);
        }
        app.quit();
      })();
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
  app.on('before-quit', () => {
    if (presenceMonitor) presenceMonitor.stop();
    if (mediaMonitor) mediaMonitor.stop();
    if (audioMixer) audioMixer.stop();
  });
}
