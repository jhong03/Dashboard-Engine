'use strict';

// Pomodoro / focus-timer state. MAIN-OWNED and wall-clock based — NOT a
// renderer timer. Why: the desktop renderer is DESTROYED on the performance
// freeze (a full-screen app covers the primary monitor, or on battery), which
// is exactly when someone is heads-down and most wants the phase-end ding. A
// renderer-only countdown would stop dead there and miss it. So the source of
// truth lives here (persisted `pomodoro.json`), main arms one timer against the
// phase's end moment and fires the notification itself, and every wallpaper
// `pomodoro` component just DISPLAYS this state and sends control actions.
//
// One timer per user (global), shown by any number of pomodoro components. A
// component's editor options (durations, cycle length, auto-start, alerts) ride
// along on every control call as `cfg`, so the last component the user touched
// is authoritative — packs almost always have a single timer.
//
// State is small and hand-editable JSON, so everything is validated on load.

const fs = require('fs');
const path = require('path');

const FILE = 'pomodoro.json';

const PHASES = ['focus', 'shortBreak', 'longBreak'];
const MIN_MINUTES = 1;
const MAX_MINUTES = 180;
const MIN_CYCLES = 1;
const MAX_CYCLES = 12;

// Classic Pomodoro defaults: 25 focus / 5 short / 15 long, long break every 4.
const DEFAULT_CFG = {
  focusMin: 25,
  shortBreakMin: 5,
  longBreakMin: 15,
  cyclesBeforeLong: 4,
  autoStart: false, // auto-advance into the next phase running, vs. landing paused
  notify: true,     // fire a desktop notification at each phase end (main)
  sound: true,      // play a short Web-Audio chime at each phase end (renderer, when active)
};

function pomodoroFile(userDir) {
  return path.join(userDir, FILE);
}

function clampMinutes(value, fallback) {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.min(MAX_MINUTES, Math.max(MIN_MINUTES, n)) : fallback;
}

/** A component's options, validated. Bad/missing fields fall back to defaults. */
function validCfg(raw) {
  const r = (typeof raw === 'object' && raw !== null) ? raw : {};
  const cycles = Math.round(Number(r.cyclesBeforeLong));
  return {
    focusMin: clampMinutes(r.focusMin, DEFAULT_CFG.focusMin),
    shortBreakMin: clampMinutes(r.shortBreakMin, DEFAULT_CFG.shortBreakMin),
    longBreakMin: clampMinutes(r.longBreakMin, DEFAULT_CFG.longBreakMin),
    cyclesBeforeLong: Number.isFinite(cycles) ? Math.min(MAX_CYCLES, Math.max(MIN_CYCLES, cycles)) : DEFAULT_CFG.cyclesBeforeLong,
    autoStart: typeof r.autoStart === 'boolean' ? r.autoStart : DEFAULT_CFG.autoStart,
    notify: typeof r.notify === 'boolean' ? r.notify : DEFAULT_CFG.notify,
    sound: typeof r.sound === 'boolean' ? r.sound : DEFAULT_CFG.sound,
  };
}

function phaseDurationMs(phase, cfg) {
  const min = phase === 'shortBreak' ? cfg.shortBreakMin
    : phase === 'longBreak' ? cfg.longBreakMin
      : cfg.focusMin;
  return min * 60 * 1000;
}

function defaultState() {
  const cfg = { ...DEFAULT_CFG };
  return {
    phase: 'focus',
    running: false,
    endsAt: null,           // ms epoch the running phase ends (only when running)
    remainingMs: phaseDurationMs('focus', cfg), // ms left while paused/idle
    completedFocus: 0,      // focus sessions finished since the last long break
    cfg,
    updatedAt: 0,
  };
}

function validState(raw) {
  if (typeof raw !== 'object' || raw === null) return defaultState();
  const cfg = validCfg(raw.cfg);
  const phase = PHASES.includes(raw.phase) ? raw.phase : 'focus';

  // A running timer needs a valid future/past endsAt; anything else is treated
  // as paused with a remaining time, so a corrupt file can't leave us "running"
  // with no end moment.
  let running = raw.running === true;
  let endsAt = null;
  let remainingMs = null;
  if (running && typeof raw.endsAt === 'number' && Number.isFinite(raw.endsAt)) {
    endsAt = raw.endsAt;
  } else {
    running = false;
    remainingMs = (typeof raw.remainingMs === 'number' && Number.isFinite(raw.remainingMs) && raw.remainingMs >= 0)
      ? Math.min(raw.remainingMs, MAX_MINUTES * 60000)
      : phaseDurationMs(phase, cfg);
  }

  const completedFocus = Math.min(cfg.cyclesBeforeLong, Math.max(0, Math.round(Number(raw.completedFocus) || 0)));
  return {
    phase, running, endsAt, remainingMs, completedFocus, cfg,
    updatedAt: typeof raw.updatedAt === 'number' && Number.isFinite(raw.updatedAt) ? raw.updatedAt : 0,
  };
}

/** Load the timer state. Never throws — a missing/broken file → defaults. */
function load(userDir) {
  try {
    const text = fs.readFileSync(pomodoroFile(userDir), 'utf8');
    return validState(JSON.parse(text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text));
  } catch {
    return defaultState();
  }
}

function save(userDir, state) {
  fs.mkdirSync(userDir, { recursive: true });
  const tmp = `${pomodoroFile(userDir)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, pomodoroFile(userDir));
}

function get(userDir) {
  return load(userDir);
}

// ── Transitions ─────────────────────────────────────────────────────────────

// Move to the next phase in the focus→break→focus cycle. Pips (completedFocus)
// count focus sessions finished since the last long break: a focus ending bumps
// the count and picks a short or (every Nth) long break; a long break ending
// resets the count and a fresh set begins.
function advancePhase(state) {
  if (state.phase === 'focus') {
    state.completedFocus = Math.min(state.cfg.cyclesBeforeLong, (Number(state.completedFocus) || 0) + 1);
    state.phase = state.completedFocus >= state.cfg.cyclesBeforeLong ? 'longBreak' : 'shortBreak';
  } else {
    if (state.phase === 'longBreak') state.completedFocus = 0;
    state.phase = 'focus';
  }
}

function startTimer(state, now) {
  if (state.running) return;
  let ms = Number(state.remainingMs);
  if (!Number.isFinite(ms) || ms <= 0) ms = phaseDurationMs(state.phase, state.cfg);
  state.running = true;
  state.endsAt = now + ms;
  state.remainingMs = null;
}

function pauseTimer(state, now) {
  if (!state.running) return;
  state.remainingMs = Math.max(0, Number(state.endsAt) - now);
  state.running = false;
  state.endsAt = null;
}

function resetTimer(state) {
  state.running = false;
  state.endsAt = null;
  state.remainingMs = phaseDurationMs(state.phase, state.cfg);
}

function skipPhase(state) {
  advancePhase(state);
  state.running = false;
  state.endsAt = null;
  state.remainingMs = phaseDurationMs(state.phase, state.cfg);
}

/**
 * Apply a user action (start / pause / toggle / reset / skip / sync). `opts.cfg`
 * (the calling component's editor options) is adopted first, so durations and
 * behaviour track whatever the user is looking at. `sync` only adopts cfg and,
 * while idle, snaps the shown remaining time to the (possibly edited) duration;
 * a running timer is never disturbed by a cfg change.
 */
function control(userDir, action, opts, now = Date.now()) {
  const state = load(userDir);
  if (opts && opts.cfg) state.cfg = validCfg(opts.cfg);

  switch (action) {
    case 'start': startTimer(state, now); break;
    case 'pause': pauseTimer(state, now); break;
    case 'toggle': state.running ? pauseTimer(state, now) : startTimer(state, now); break;
    case 'reset': resetTimer(state); break;
    case 'skip': skipPhase(state); break;
    case 'sync': if (!state.running) state.remainingMs = phaseDurationMs(state.phase, state.cfg); break;
    default: return state; // unknown action — no change, don't churn the file
  }
  state.updatedAt = now;
  save(userDir, state);
  return state;
}

/**
 * Reconcile one phase that has run out (endsAt ≤ now). Returns what happened so
 * the caller (main) can notify + broadcast, then re-arm. Called on boot, on
 * every control change, and when the armed timer wakes. If nothing is due it's
 * a cheap no-op that just reports the current state.
 */
function tick(userDir, now = Date.now()) {
  const state = load(userDir);
  if (!state.running || !Number.isFinite(Number(state.endsAt)) || now < state.endsAt) {
    return { ended: false, state };
  }
  const endedPhase = state.phase;
  const endedAt = state.endsAt;
  advancePhase(state);
  const full = phaseDurationMs(state.phase, state.cfg);
  if (state.cfg.autoStart) {
    state.running = true;
    state.endsAt = now + full;
    state.remainingMs = null;
  } else {
    state.running = false;
    state.endsAt = null;
    state.remainingMs = full;
  }
  state.updatedAt = now;
  save(userDir, state);
  return { ended: true, endedPhase, endedAt, newPhase: state.phase, autoStarted: state.running, state };
}

module.exports = {
  PHASES, DEFAULT_CFG,
  load, save, get, control, tick,
  phaseDurationMs, validCfg,
};
