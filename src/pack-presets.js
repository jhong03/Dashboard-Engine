'use strict';

// Shared authoring presets for Phase G — the time-of-day PALETTE presets and the
// timeline MOTION presets. Loaded by BOTH the editor (Skin-tab preset chips) and
// the Manager's from-scratch builder, so there is ONE source of truth. Pure data
// + builders, no DOM. Exposes window.AegisPresets.

(() => {

// ── HSL helpers (derive slot colours from a pack's own base palette) ──────────
function clamp01(x) { return Math.max(0, Math.min(1, x)); }
function hexToHsl(hex) {
  const h = String(hex).replace('#', '');
  const r = parseInt(h.slice(0, 2), 16) / 255, g = parseInt(h.slice(2, 4), 16) / 255, b = parseInt(h.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let hue = 0;
  if (d) {
    if (max === r) hue = ((g - b) / d) % 6;
    else if (max === g) hue = (b - r) / d + 2;
    else hue = (r - g) / d + 4;
    hue *= 60; if (hue < 0) hue += 360;
  }
  const l = (max + min) / 2;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  return { h: hue, s, l };
}
function hslToHex(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 60) [r, g, b] = [c, x, 0]; else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x]; else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c]; else [r, g, b] = [c, 0, x];
  const to2 = (v) => Math.round((v + m) * 255).toString(16).padStart(2, '0');
  return `#${to2(r)}${to2(g)}${to2(b)}`;
}
function withL(hex, dl) { const c = hexToHsl(hex); return hslToHex(c.h, c.s, clamp01(c.l + dl)); }
function withSL(hex, ds, dl) { const c = hexToHsl(hex); return hslToHex(c.h, clamp01(c.s + ds), clamp01(c.l + dl)); }
// COMMIT a hue (warm ~30°, gold ~45°, cool ~220°), keeping the pack's saturation
// and lightness (with tweaks). A fractional nudge can't be used — warming a cyan
// accent lands it in GREEN, not orange — so the preset must reach the target hue.
function setHue(hex, hue, ds, dl) {
  const c = hexToHsl(hex);
  return hslToHex(((hue % 360) + 360) % 360, clamp01(c.s + (ds || 0)), clamp01(c.l + (dl || 0)));
}

// ── Time-of-day palette presets ───────────────────────────────────────────────
// Bold enough to read at a glance: each slot recolours void + accent +
// accentBright with a clear brightness arc across the day (dawn bright, night
// dim) on top of the hue shift. `label` is the English builder chip; the editor
// localizes by `id`. build(void, accent, accentBright) → per-slot partial
// palettes (day inherits the base = {}).
const SCHEDULE_PRESETS = [
  { id: 'dayNight', label: 'Day & night', build: (v, a, ab) => ({
    dawn: { void: withL(v, 0.06), accent: withL(a, 0.08), accentBright: withL(ab, 0.05) },
    day: {},
    dusk: { void: withL(v, -0.07), accent: withSL(a, 0, -0.10), accentBright: withSL(ab, 0, -0.09) },
    night: { void: withL(v, -0.16), accent: withSL(a, -0.18, -0.24), accentBright: withSL(ab, -0.15, -0.22) },
  }) },
  { id: 'warmCool', label: 'Warm ↔ cool', build: (v, a, ab) => ({
    dawn: { void: setHue(v, 28, 0.08, 0.06), accent: setHue(a, 32, 0.10, 0.12), accentBright: setHue(ab, 34, 0.06, 0.06) },
    day: {},
    dusk: { void: setHue(v, 16, 0.12, -0.03), accent: setHue(a, 14, 0.16, -0.10), accentBright: setHue(ab, 20, 0.10, -0.08) },
    night: { void: setHue(v, 222, 0.10, -0.04), accent: setHue(a, 218, 0.02, -0.20), accentBright: setHue(ab, 216, -0.05, -0.18) },
  }) },
  { id: 'golden', label: 'Golden hour', build: (v, a, ab) => ({
    dawn: { void: setHue(v, 34, 0.10, 0.06), accent: setHue(a, 44, 0.30, 0.10), accentBright: setHue(ab, 46, 0.20, 0.06) },
    day: {},
    dusk: { void: setHue(v, 24, 0.14, -0.03), accent: setHue(a, 30, 0.32, -0.06), accentBright: setHue(ab, 36, 0.22, -0.05) },
    night: { void: setHue(v, 236, 0.12, -0.05), accent: setHue(a, 228, 0.08, -0.22), accentBright: setHue(ab, 226, 0.02, -0.18) },
  }) },
];

const SCHEDULE_SLOT_HOURS = { dawn: 6, day: 9, dusk: 17, night: 20 };

// The four {startHour, palette} slots for a preset, from a base palette. null on
// an unknown id.
function buildScheduleSlots(palette, presetId) {
  const preset = SCHEDULE_PRESETS.find((p) => p.id === presetId);
  if (!preset) return null;
  const built = preset.build(palette.void || '#04080F', palette.accent || '#3FD8FF', palette.accentBright || '#7FE9FF');
  const slots = {};
  for (const n of ['dawn', 'day', 'dusk', 'night']) slots[n] = { startHour: SCHEDULE_SLOT_HOURS[n], palette: built[n] || {} };
  return slots;
}

// ── Timeline motion presets ───────────────────────────────────────────────────
// Loop-safe (start === end) so they read cleanly in any playback mode. keys is a
// function of the loop length (seconds). `label` is the English builder chip; the
// editor localizes by `id`.
const TIMELINE_MOTIONS = [
  { id: 'float',   label: 'Float',       kind: 'component', prop: 'y',       keys: (D) => [{ t: 0, v: 0 }, { t: D / 2, v: -6 }, { t: D, v: 0 }] },
  { id: 'breathe', label: 'Breathe',     kind: 'component', prop: 'scale',   keys: (D) => [{ t: 0, v: 1 }, { t: D / 2, v: 1.08 }, { t: D, v: 1 }] },
  { id: 'pulse',   label: 'Pulse',       kind: 'component', prop: 'opacity', keys: (D) => [{ t: 0, v: 1 }, { t: D / 2, v: 0.4 }, { t: D, v: 1 }] },
  { id: 'sway',    label: 'Sway',        kind: 'component', prop: 'rotate',  keys: (D) => [{ t: 0, v: -4 }, { t: D / 2, v: 4 }, { t: D, v: -4 }] },
  { id: 'drift',   label: 'Drift',       kind: 'component', prop: 'x',       keys: (D) => [{ t: 0, v: 0 }, { t: D / 2, v: 14 }, { t: D, v: 0 }] },
  { id: 'fade',    label: 'Fade in/out', kind: 'component', prop: 'opacity', keys: (D) => [{ t: 0, v: 0 }, { t: D * 0.2, v: 1 }, { t: D * 0.8, v: 1 }, { t: D, v: 0 }] },
  { id: 'twinkle', label: 'Twinkle',     kind: 'ambience',  prop: 'opacity', keys: (D) => [{ t: 0, v: 1 }, { t: D / 2, v: 0.3 }, { t: D, v: 1 }] },
];

// A timeline track for a motion at the given loop length + component index. null
// on an unknown id. Times snap to the editor's 0.5 s step.
function buildMotionTrack(motionId, duration, componentIndex) {
  const m = TIMELINE_MOTIONS.find((x) => x.id === motionId);
  if (!m) return null;
  const snap = (x) => Math.max(0, Math.min(duration, Math.round(x * 2) / 2));
  const keys = m.keys(duration).map((k) => ({ t: snap(k.t), v: k.v, ease: 'inout' }));
  const target = m.kind === 'ambience'
    ? { kind: 'ambience', prop: 'opacity' }
    : { kind: 'component', index: componentIndex || 0, prop: m.prop };
  return { target, keys };
}

window.AegisPresets = { SCHEDULE_PRESETS, TIMELINE_MOTIONS, buildScheduleSlots, buildMotionTrack };

})();
