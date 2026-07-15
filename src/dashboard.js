'use strict';

// Desktop surface: renders the ACTIVE pack via the shared component
// renderer (components.js) — the same code the editor uses, so what you
// edit is exactly what your desktop shows. No chrome, no input; selection
// happens in the manager/tray and arrives over IPC.

/* global aegis, AegisComponents */

const renderer = AegisComponents.createRenderer({
  stats: () => aegis.stats(),
  weather: (opts) => aegis.weather(opts),
  reminders: (window) => aegis.remindersList(window),
  launcher: {
    state: (opts) => aegis.launcherState(opts),
    launch: (id) => aegis.launcherLaunch(id),
    focus: (hwnd) => aegis.launcherFocus(hwnd),
  },
  notifications: () => aegis.notifications(),
  assistant: {
    ask: (prompt) => aegis.assistantAsk(prompt),
    speak: (text) => aegis.assistantSpeak(text),
    config: () => aegis.assistantConfig(),
    reset: () => aegis.assistantReset(),
  },
});

const state = { packId: null };

// Performance citizenship: main drives this over aegis:desktop:power. `active`
// false freezes the wallpaper (a full-screen app is up / on battery); `maxFps`
// caps the ambience frame rate. We cache the last pack so resuming re-renders
// without another IPC round-trip.
const power = { active: true, maxFps: 30 };
const applied = { active: true, maxFps: 30 };
let cache = { pack: null, assets: null };

// Render the active pack at the current frame cap, then freeze if we're paused.
function renderActive() {
  if (!cache.pack) return;
  AegisComponents.applySkin(document.body, cache.pack, cache.assets, { maxFps: power.maxFps });
  renderer.render(document.getElementById('canvas'), cache.pack, cache.assets);
  applied.active = true;
  applied.maxFps = power.maxFps;
  if (!power.active) freezeNow();
}

// Stop the animation loops and telemetry; the last frame stays on screen.
function freezeNow() {
  renderer.destroy();
  AegisComponents.freezeAmbience(document.body);
  applied.active = false;
}

function applyPower() {
  if (!cache.pack) return;
  if (power.active) {
    // Resume from a freeze, or re-render if the fps cap changed.
    if (!applied.active || applied.maxFps !== power.maxFps) renderActive();
  } else if (applied.active) {
    freezeNow();
  }
}

async function loadPack(id) {
  const res = await aegis.packLoad(id);
  if (!res.ok) {
    console.warn(`[dashboard] ${res.error}`);
    return;
  }
  state.packId = res.pack.id;
  cache = { pack: res.pack, assets: res.assets };
  renderActive();
  document.title = `${res.pack.persona.name} — ${res.pack.name}`;
  for (const w of res.warnings) console.warn(`[pack] ${w}`);
}

async function init() {
  // Precedence: dev override (AEGIS_PACK) → persisted active pack → default.
  const requested = new URLSearchParams(location.search).get('pack');
  const active = await aegis.activeGet();
  await loadPack(requested || active.id || 'jarvis');

  // Hot reload: the active pack's directory changed on disk (author editing,
  // or the editor saving).
  aegis.onPackChanged((data) => {
    if (data.id === state.packId) loadPack(state.packId);
  });
  // The manager or tray picked a different pack.
  aegis.onActiveChanged((data) => loadPack(data.id));
  // Planner changed — calendars and agendas repaint.
  aegis.onRemindersChanged(() => loadPack(state.packId));
  // Pins/recents changed — launcher tiles repaint.
  aegis.onLauncherChanged(() => loadPack(state.packId));
}

// Power signals stream from main. Register synchronously (before init()'s first
// await) so an early push — a game already running at launch — isn't missed.
// applyPower() no-ops until a pack is cached; the first render then honours it.
aegis.onPower((p) => {
  power.active = p.active !== false;
  power.maxFps = Number(p.maxFps) > 0 ? Number(p.maxFps) : 30;
  applyPower();
});

init().catch((err) => console.error(`[dashboard] failed to initialise: ${err.message}`));
