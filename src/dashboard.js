'use strict';

// Desktop surface: renders the ACTIVE pack via the shared component
// renderer (components.js) — the same code the editor uses, so what you
// edit is exactly what your desktop shows. No chrome, no input; selection
// happens in the manager/tray and arrives over IPC.

/* global aegis, AegisComponents */

// Reminder edits made from the desktop calendar's own popover repaint in place;
// their reminders:changed echo must NOT force a full pack reload (that would
// destroy the open popover). We note the moment of a local edit and skip the
// reload for a short window afterwards. External changes (the manager planner)
// still reload normally.
let localReminderEditAt = 0;
function markLocalReminderEdit() { localReminderEditAt = Date.now(); }

const renderer = AegisComponents.createRenderer({
  stats: () => aegis.stats(),
  weather: (opts) => aegis.weather(opts),
  reminders: (window) => aegis.remindersList(window),
  // Present only on the desktop — the calendar component uses these to let a
  // user manage reminders in place. Editor/manager previews omit them, so the
  // calendar there stays a static read-only preview. Each write flags a local
  // edit so the reminders:changed echo doesn't trigger a full pack reload (which
  // would tear down the calendar's open editing popover — see onRemindersChanged).
  remindersAdd: (r) => { markLocalReminderEdit(); return aegis.remindersAdd(r); },
  remindersRemove: (id) => { markLocalReminderEdit(); return aegis.remindersRemove(id); },
  remindersToggle: (id) => { markLocalReminderEdit(); return aegis.remindersToggle(id); },
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
    history: () => aegis.assistantHistory(),
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
  // Planner changed — calendars and agendas repaint. Skip the reload when the
  // change came from the desktop calendar itself (it already repainted in place
  // and a reload would close its open editing popover).
  aegis.onRemindersChanged(() => {
    if (Date.now() - localReminderEditAt < 2000) return;
    loadPack(state.packId);
  });
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
