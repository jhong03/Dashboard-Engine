'use strict';

// Pomodoro / focus-timer state. MAIN-OWNED and wall-clock based — NOT a
// renderer timer. Why: the desktop renderer is DESTROYED on the performance
// freeze (a full-screen app covers the primary monitor, or on battery), which
// is exactly when someone is heads-down and most wants the phase-end ding. A
// renderer-only countdown would stop dead there and miss it. So the source of
// truth lives here (persisted `pomodoro.json`), main arms one timer against the
// phase's end moment and fires the notification itself, and every wallpaper
// `pomodoro` component just DISPLAYS this state and drives it.
//
// Interaction model (owner's design): Start · Stop · Break · Reset.
//   Start  — start/resume the countdown.
//   Stop   — pause it (keeps the remaining time; Start resumes).
//   Break  — choose a short or long break: while a focus session is RUNNING it's
//            QUEUED and auto-starts the moment focus ends; otherwise it starts
//            right away. A queued break can be cleared (break with min < 1).
//   Reset  — start over: a fresh, idle focus at full time (clears any break).
//
// One timer per user (global), shown by any number of pomodoro components. A
// component's editor options (durations, cadence, alerts) ride along on every
// control call as `cfg`, so the last component the user touched is authoritative
// — packs almost always have a single timer.
//
// State is small and hand-editable JSON, so everything is validated on load.

const fs = require('fs');
const path = require('path');

const FILE = 'pomodoro.json';

const PHASES = ['focus', 'break'];
const MIN_MINUTES = 1;
const MAX_MINUTES = 180;
const MIN_CYCLES = 1;
const MAX_CYCLES = 12;

// Classic Pomodoro defaults: 25 min focus; the Break button offers 5 and 15.
const DEFAULT_CFG = {
  focusMin: 25,
  shortBreakMin: 5,
  longBreakMin: 15,
  cyclesBeforeLong: 4, // how many focus-session pips to show before the tally wraps
  notify: true,        // fire a desktop notification at each phase end (main)
  sound: true,         // play a short Web-Audio chime at each phase end (renderer, when active)
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
    notify: typeof r.notify === 'boolean' ? r.notify : DEFAULT_CFG.notify,
    sound: typeof r.sound === 'boolean' ? r.sound : DEFAULT_CFG.sound,
  };
}

// Full length of the phase the timer is currently on: a focus phase is always
// cfg.focusMin; a break is whatever length was chosen for it (breakMin).
function currentFullMs(state) {
  if (state.phase === 'break') return (state.breakMin || state.cfg.shortBreakMin) * 60 * 1000;
  return state.cfg.focusMin * 60 * 1000;
}

function defaultState() {
  const cfg = { ...DEFAULT_CFG };
  return {
    phase: 'focus',
    running: false,
    endsAt: null,           // ms epoch the running phase ends (only when running)
    remainingMs: cfg.focusMin * 60 * 1000, // ms left while paused/idle
    breakMin: null,         // length (min) of the CURRENT break (when phase === 'break')
    queuedBreakMin: null,   // a break queued to auto-start when the running focus ends
    completedFocus: 0,      // focus-session pip tally (wraps at cyclesBeforeLong)
    cfg,
    updatedAt: 0,
  };
}

function validMinuteOrNull(value) {
  const n = Math.round(Number(value));
  return Number.isFinite(n) && n >= MIN_MINUTES ? Math.min(MAX_MINUTES, n) : null;
}

function validState(raw) {
  if (typeof raw !== 'object' || raw === null) return defaultState();
  const cfg = validCfg(raw.cfg);
  const phase = PHASES.includes(raw.phase) ? raw.phase : 'focus';
  const breakMin = validMinuteOrNull(raw.breakMin);
  const queuedBreakMin = validMinuteOrNull(raw.queuedBreakMin);

  // A running timer needs a valid endsAt; anything else is treated as paused
  // with a remaining time, so a corrupt file can't leave us "running" with no
  // end moment.
  let running = raw.running === true;
  let endsAt = null;
  let remainingMs = null;
  const state = { phase, cfg, breakMin };
  if (running && typeof raw.endsAt === 'number' && Number.isFinite(raw.endsAt)) {
    endsAt = raw.endsAt;
  } else {
    running = false;
    remainingMs = (typeof raw.remainingMs === 'number' && Number.isFinite(raw.remainingMs) && raw.remainingMs >= 0)
      ? Math.min(raw.remainingMs, MAX_MINUTES * 60000)
      : currentFullMs(state);
  }

  const completedFocus = Math.min(cfg.cyclesBeforeLong, Math.max(0, Math.round(Number(raw.completedFocus) || 0)));
  return {
    phase, running, endsAt, remainingMs, breakMin, queuedBreakMin, completedFocus, cfg,
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

function startTimer(state, now) {
  if (state.running) return;
  let ms = Number(state.remainingMs);
  if (!Number.isFinite(ms) || ms <= 0) ms = currentFullMs(state);
  state.running = true;
  state.endsAt = now + ms;
  state.remainingMs = null;
}

// Stop = pause: keep the remaining time so Start resumes exactly where it left off.
function pauseTimer(state, now) {
  if (!state.running) return;
  state.remainingMs = Math.max(0, Number(state.endsAt) - now);
  state.running = false;
  state.endsAt = null;
}

// Reset = start over: a fresh, idle focus at full time, clearing any break
// (current or queued) and the pip tally.
function resetTimer(state) {
  state.running = false;
  state.phase = 'focus';
  state.endsAt = null;
  state.breakMin = null;
  state.queuedBreakMin = null;
  state.completedFocus = 0;
  state.remainingMs = currentFullMs(state);
}

function startBreak(state, min, now) {
  state.phase = 'break';
  state.breakMin = min;
  state.queuedBreakMin = null;
  state.running = true;
  state.endsAt = now + min * 60 * 1000;
  state.remainingMs = null;
}

// The Break button. While a focus session is in progress (running, or paused
// part-way through), queue the break so it auto-starts when focus ends. Otherwise
// (idle, or already on a break) start the chosen break right now. min < 1 clears
// a queued break without starting anything.
function chooseBreak(state, min, now) {
  if (!(min >= MIN_MINUTES)) { state.queuedBreakMin = null; return; }
  const focusInProgress = state.phase === 'focus'
    && (state.running || Number(state.remainingMs) < currentFullMs(state) - 500);
  if (focusInProgress) state.queuedBreakMin = min;
  else startBreak(state, min, now);
}

/**
 * Apply a user action (start / pause / reset / break / sync). `opts.cfg` (the
 * calling component's editor options) is adopted first, so durations and
 * behaviour track whatever the user is looking at. `break` also takes
 * `opts.breakMin`. `sync` only adopts cfg and, while idle, snaps the shown
 * remaining time to the (possibly edited) duration.
 */
function control(userDir, action, opts, now = Date.now()) {
  const state = load(userDir);
  if (opts && opts.cfg) state.cfg = validCfg(opts.cfg);

  switch (action) {
    case 'start': startTimer(state, now); break;
    case 'pause': pauseTimer(state, now); break;
    case 'reset': resetTimer(state); break;
    case 'break': chooseBreak(state, Math.round(Number(opts && opts.breakMin)), now); break;
    case 'sync': if (!state.running) state.remainingMs = currentFullMs(state); break;
    default: return state; // unknown action — no change, don't churn the file
  }
  state.updatedAt = now;
  save(userDir, state);
  return state;
}

/**
 * Reconcile a phase that has run out (endsAt ≤ now). Returns what happened so the
 * caller (main) can notify + broadcast, then re-arm. Called on boot, on every
 * control change, and when the armed timer wakes. Focus ending auto-starts a
 * queued break (else lands on a fresh idle focus); a break ending lands on a
 * fresh idle focus. If nothing is due it's a cheap no-op.
 */
function tick(userDir, now = Date.now()) {
  const state = load(userDir);
  if (!state.running || !Number.isFinite(Number(state.endsAt)) || now < state.endsAt) {
    return { ended: false, state };
  }
  const endedPhase = state.phase;
  const endedAt = state.endsAt;

  if (endedPhase === 'focus') {
    state.completedFocus = ((Number(state.completedFocus) || 0) + 1) % Math.max(1, state.cfg.cyclesBeforeLong);
    if (state.queuedBreakMin >= MIN_MINUTES) {
      startBreak(state, state.queuedBreakMin, now); // the queued break begins immediately
    } else {
      state.running = false; state.endsAt = null; state.breakMin = null;
      state.remainingMs = currentFullMs(state); // idle focus, ready to Start again
    }
  } else {
    state.phase = 'focus'; state.breakMin = null; state.queuedBreakMin = null;
    state.running = false; state.endsAt = null;
    state.remainingMs = currentFullMs(state);
  }

  state.updatedAt = now;
  save(userDir, state);
  return { ended: true, endedPhase, endedAt, newPhase: state.phase, autoStarted: state.running, state };
}

module.exports = {
  PHASES, DEFAULT_CFG,
  load, save, get, control, tick,
  currentFullMs, validCfg,
};
