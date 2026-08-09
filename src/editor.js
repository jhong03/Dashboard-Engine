'use strict';

// Pack editor: drag & drop components on a live canvas that renders through
// the SAME module as the desktop (components.js), inspect and restyle them,
// edit the skin and persona, save. Fork-on-save happens in the main process;
// the editor just keeps editing whatever id came back.

/* global aegis, AegisComponents */

const $ = (id) => document.getElementById(id);

// UI localization shortcut. i18n.js (loaded first) defines window.t; this alias
// is fail-soft so a missing runtime just yields the key's English fallback.
const t = (key, params) => (window.t ? window.t(key, params) : key);

const SNAP = 0.5;       // percent grid
const MIN_SIZE = 2;     // percent

const PALETTE = [
  { type: 'status', label: 'Persona status', hint: 'name · tagline · ticker' },
  { type: 'clock', label: 'Clock', hint: 'digital time + date' },
  { type: 'analog-clock', label: 'Analog clock', hint: 'drawn clock face' },
  { type: 'hud-clock', label: 'HUD clock', hint: 'rotating reactor rings (sci-fi)' },
  { type: 'ring-clock', label: 'Ring clock', hint: 'minimal or soft-halo centrepiece' },
  { type: 'stats', label: 'Stats', hint: 'labelled telemetry bars' },
  { type: 'cores', label: 'Core load', hint: 'per-core CPU bars' },
  { type: 'sysinfo', label: 'System info', hint: 'memory / disk / uptime rows' },
  { type: 'meter', label: 'Meter', hint: 'one value, ring or bar' },
  { type: 'sparkline', label: 'Sparkline', hint: '3-minute history graph' },
  { type: 'text', label: 'Text', hint: 'free text block' },
  { type: 'image', label: 'Image', hint: 'pack art (assets/)' },
  { type: 'gallery', label: 'Photo gallery', hint: 'looping photo slideshow' },
  { type: 'divider', label: 'Divider', hint: 'hairline rule' },
  { type: 'calendar', label: 'Calendar', hint: 'month grid, today marked' },
  { type: 'countdown', label: 'Countdown', hint: 'days/hours to a date' },
  { type: 'weather', label: 'Weather', hint: 'Open-Meteo, needs lat/lon' },
  { type: 'agenda', label: 'Agenda', hint: 'your upcoming reminders' },
  { type: 'notifications', label: 'Notifications', hint: 'live Windows notifications' },
  { type: 'launcher', label: 'Launcher', hint: 'your pinned & recent apps' },
  { type: 'nowplaying', label: 'Now playing', hint: 'Spotify / any media, with controls' },
  { type: 'visualizer', label: 'Audio visualizer', hint: 'reacts to any system audio' },
  { type: 'assistant', label: 'Assistant console', hint: 'opens the AI chat' },
  { type: 'module', label: 'Custom module', hint: 'your own sandboxed HTML/JS' },
];

// Starter fragment for a new module — demonstrates the two things every module
// needs: theme tokens (--de-* CSS vars + DE.onTheme) and live stats (DE.onData).
// Kept small and neutral so it clears the quality floor in any pack skin.
const MODULE_STARTER = [
  '<div class="wrap">',
  '  <div class="hi">hello, <span id="who">friend</span></div>',
  '  <div class="row"><span>CPU</span><b id="cpu">—</b></div>',
  '  <div class="bar"><i id="cpuBar"></i></div>',
  '  <div class="row"><span>MEM</span><b id="mem">—</b></div>',
  '  <div class="bar"><i id="memBar"></i></div>',
  '</div>',
  '<style>',
  '  .wrap{height:100%;padding:5cqw;display:flex;flex-direction:column;justify-content:center;gap:2cqw}',
  '  .hi{font-size:4cqw;color:var(--de-accent);letter-spacing:var(--de-ls)}',
  '  .row{display:flex;justify-content:space-between;font-size:2.6cqw;color:var(--de-muted)}',
  '  .row b{color:var(--de-accent-bright)}',
  '  .bar{height:1.4cqw;background:rgba(127,127,127,.18);border-radius:var(--de-radius)}',
  '  .bar i{display:block;height:100%;width:0;background:var(--de-accent);border-radius:inherit;transition:width .6s}',
  '</style>',
  '<script>',
  '  DE.onTheme(function(t){ document.getElementById("who").textContent = (t.persona && t.persona.name) || "friend"; });',
  '  DE.onData(function(d){',
  '    document.getElementById("cpu").textContent = d.cpu + "%";',
  '    document.getElementById("mem").textContent = d.mem + "%";',
  '    document.getElementById("cpuBar").style.width = d.cpu + "%";',
  '    document.getElementById("memBar").style.width = d.mem + "%";',
  '  });',
  '<\/script>',
].join('\n');

const DEFAULT_RECTS = {
  'status': [10, 10, 40, 18], 'clock': [10, 10, 26, 20], 'analog-clock': [10, 10, 18, 28],
  'stats': [10, 10, 34, 22], 'meter': [10, 10, 14, 22], 'sparkline': [10, 10, 26, 16],
  'text': [10, 10, 24, 10], 'image': [10, 10, 24, 30], 'gallery': [10, 10, 28, 34], 'divider': [10, 10, 30, 3],
  'calendar': [10, 10, 20, 30], 'countdown': [10, 10, 22, 16], 'weather': [10, 10, 20, 16],
  'agenda': [10, 10, 24, 32], 'launcher': [10, 10, 28, 30], 'notifications': [10, 10, 24, 32],
  'hud-clock': [10, 10, 24, 42], 'ring-clock': [10, 10, 22, 38], 'cores': [10, 10, 16, 10], 'sysinfo': [10, 10, 16, 14],
  'assistant': [10, 10, 60, 6], 'nowplaying': [10, 10, 30, 12], 'visualizer': [10, 10, 30, 16], 'module': [10, 10, 26, 26],
};

function defaultOptions(type, assets) {
  const in30days = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
  const firstAsset = Object.keys(assets)[0] || null;
  return {
    'status': {}, 'clock': { format: '24h', seconds: true, showDate: true },
    'analog-clock': { seconds: true, numerals: 'quarters', minuteTicks: true },
    'stats': { cpu: true, mem: true, disk: false, battery: false, history: true },
    'meter': { bind: 'cpu', variant: 'ring', label: null, ticks: true, readout: true },
    'sparkline': { bind: 'cpu', label: null, grid: true, readout: true },
    'text': { text: 'New text' },
    'image': { src: firstAsset, fit: 'contain' },
    'gallery': { images: [], interval: 6, fit: 'cover', transition: 'fade', shuffle: false },
    'divider': { orientation: 'h' },
    'calendar': { weekStart: 'mon', showReminders: true },
    'countdown': { target: in30days, label: 'Countdown' },
    'weather': { lat: 0, lon: 0, place: null, details: true, compact: false },
    'agenda': { days: 7, limit: 6, label: null },
    'notifications': { limit: 6, label: null, showApp: true },
    'launcher': { pinned: true, recent: true, running: false, labels: true, iconSize: 'm', label: null },
    'hud-clock': { format: '24h', seconds: true, showDate: true },
    'ring-clock': { style: 'minimal', format: '24h', seconds: true, showDate: true },
    'cores': { label: null },
    'sysinfo': { memory: true, disk: true, uptime: true, host: false, statusText: null, health: true },
    'assistant': { label: null, button: null },
    'nowplaying': { showArt: true, showControls: true, label: null },
    'visualizer': { style: 'bars' },
    'module': { html: MODULE_STARTER, scroll: false, telemetry: true },
  }[type];
}

const DEFAULT_STYLE = {
  accent: null, textColor: null, font: null, fontScale: null, align: null, place: null,
  panel: null, border: null, notches: null, opacity: null, glow: null, padding: null, rotate: null,
};

const state = {
  baseId: null,
  pack: null,
  assets: {},
  selected: null,   // component index
  tab: 'component',
  renderedEls: [],
};

const renderer = AegisComponents.createRenderer({
  stats: () => aegis.stats(),
  weather: (opts) => aegis.weather(opts),
  reminders: (window) => aegis.remindersList(window),
  // Preview only — no launch() means tiles render inert on the stage.
  launcher: { state: (opts) => aegis.launcherState(opts) },
  // Sample toasts, never the user's real notifications — the editor stage is a
  // design surface people screenshot/stream, so it must not leak private data.
  notifications: () => Promise.resolve({ ok: true, granted: true, notifications: AegisComponents.demoNotifications() }),
});

function setStatus(text, warn) {
  const el = $('ed-status');
  el.textContent = text || '';
  el.className = `status-line-app ed-status${warn ? ' warn' : ''}`;
}

function typeLabel(type) {
  const entry = PALETTE.find((p) => p.type === type);
  return entry ? t(`editor.palette.${type}.label`) : type;
}

function snap(v) {
  return Math.round(v / SNAP) * SNAP;
}

function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

// Trim floating-point noise so snapped rects stay clean in the saved JSON
// (e.g. 10.000000000000002 → 10).
function tidy(v) {
  return Math.round(v * 1e4) / 1e4;
}

// ── Smart alignment guides (PowerPoint-style) ──────────────────────────────
// While dragging/resizing, snap the moving edges & centres to the canvas
// edges/centre and to every OTHER component's left/centre/right and
// top/middle/bottom, and draw a guide line where they meet. Hold Alt to
// move freely (guides + snapping off).

const SNAP_PX = 6;   // catch distance in screen pixels
const GUIDE_EPS = 0.06; // % tolerance for "this anchor is on the line now"

function alignmentTargets(excludeIndex) {
  const xs = [0, 50, 100];
  const ys = [0, 50, 100];
  state.pack.components.forEach((c, i) => {
    if (i === excludeIndex) return;
    const [x, y, w, h] = c.rect;
    xs.push(x, x + w / 2, x + w);
    ys.push(y, y + h / 2, y + h);
  });
  return { xs, ys };
}

// Nearest target within threshold, or null.
function nearestTarget(value, targets, threshold) {
  let best = null;
  for (const t of targets) {
    const d = Math.abs(t - value);
    if (d <= threshold && (best === null || d < best.d)) best = { t, d };
  }
  return best ? best.t : null;
}

function clearGuides() {
  overlayEl().querySelectorAll('.guide').forEach((g) => g.remove());
}

function drawGuides(guidesX, guidesY) {
  clearGuides();
  const overlay = overlayEl();
  for (const gx of guidesX) {
    const line = document.createElement('div');
    line.className = 'guide guide-v';
    line.style.left = `${gx}%`;
    overlay.appendChild(line);
  }
  for (const gy of guidesY) {
    const line = document.createElement('div');
    line.className = 'guide guide-h';
    line.style.top = `${gy}%`;
    overlay.appendChild(line);
  }
}

// ── Rendering ───────────────────────────────────────────────────────────────

// True while a range slider is being dragged. Rebuilding the inspector then
// would replace the very <input> under the cursor and drop the drag (you'd have
// to click for each step), so we skip the inspector rebuild until release.
let sliderActive = false;

function renderAll() {
  AegisComponents.applySkin($('skin'), state.pack, state.assets);
  state.renderedEls = renderer.render($('canvas'), state.pack, state.assets);
  rebuildOverlay();
  if (!sliderActive) renderInspector();
}

// ── Overlay: hitboxes, selection box, handles, drag/resize ─────────────────

function overlayEl() {
  return $('overlay');
}

function rebuildOverlay() {
  const overlay = overlayEl();
  overlay.textContent = '';
  overlay.style.inset = `${state.pack.canvas.padding}%`;

  state.pack.components.forEach((component, index) => {
    const hit = document.createElement('div');
    hit.className = 'hitbox';
    positionByRect(hit, component.rect);
    hit.addEventListener('pointerdown', (e) => beginDrag(e, index, hit));
    overlay.appendChild(hit);
  });

  if (state.selected !== null && state.pack.components[state.selected]) {
    const sel = document.createElement('div');
    sel.className = 'sel-box';
    positionByRect(sel, state.pack.components[state.selected].rect);
    for (const dir of ['nw', 'ne', 'sw', 'se', 'n', 's', 'w', 'e']) {
      const handle = document.createElement('div');
      handle.className = `handle ${dir}`;
      handle.addEventListener('pointerdown', (e) => beginResize(e, state.selected, dir));
      sel.appendChild(handle);
    }
    overlay.appendChild(sel);
  }
}

function positionByRect(el, rect) {
  el.style.left = `${rect[0]}%`;
  el.style.top = `${rect[1]}%`;
  el.style.width = `${rect[2]}%`;
  el.style.height = `${rect[3]}%`;
}

function select(index) {
  state.selected = index;
  state.tab = 'component';
  syncTabs();
  rebuildOverlay();
  renderInspector();
}

function beginDrag(event, index, hit) {
  event.preventDefault();
  if (state.selected !== index) select(index);
  const overlay = overlayEl();
  const bounds = overlay.getBoundingClientRect();
  const component = state.pack.components[index];
  const orig = [...component.rect];
  const startX = event.clientX, startY = event.clientY;
  hit.setPointerCapture(event.pointerId);

  const w = orig[2], h = orig[3];
  const move = (e) => {
    const dx = ((e.clientX - startX) / bounds.width) * 100;
    const dy = ((e.clientY - startY) / bounds.height) * 100;
    let x = clamp(orig[0] + dx, 0, 100 - w);
    let y = clamp(orig[1] + dy, 0, 100 - h);

    if (e.altKey) {
      x = snap(x); y = snap(y);
      clearGuides();
    } else {
      const thX = (SNAP_PX / bounds.width) * 100;
      const thY = (SNAP_PX / bounds.height) * 100;
      const targets = alignmentTargets(index);
      // Best snap across left/centre/right (x) and top/middle/bottom (y).
      let bestX = null, bestY = null;
      for (const a of [x, x + w / 2, x + w]) {
        const t = nearestTarget(a, targets.xs, thX);
        if (t !== null && (bestX === null || Math.abs(t - a) < Math.abs(bestX))) bestX = t - a;
      }
      for (const a of [y, y + h / 2, y + h]) {
        const t = nearestTarget(a, targets.ys, thY);
        if (t !== null && (bestY === null || Math.abs(t - a) < Math.abs(bestY))) bestY = t - a;
      }
      x = bestX !== null ? clamp(x + bestX, 0, 100 - w) : snap(x);
      y = bestY !== null ? clamp(y + bestY, 0, 100 - h) : snap(y);
      // A guide for every edge/centre that now lands on a target.
      const gX = [], gY = [];
      for (const a of [x, x + w / 2, x + w]) { const t = nearestTarget(a, targets.xs, GUIDE_EPS); if (t !== null && !gX.includes(t)) gX.push(t); }
      for (const a of [y, y + h / 2, y + h]) { const t = nearestTarget(a, targets.ys, GUIDE_EPS); if (t !== null && !gY.includes(t)) gY.push(t); }
      drawGuides(gX, gY);
    }

    component.rect[0] = tidy(x);
    component.rect[1] = tidy(y);
    // Live-move the rendered element + overlay boxes without a full re-render.
    positionByRect(state.renderedEls[index], component.rect);
    positionByRect(hit, component.rect);
    const sel = overlay.querySelector('.sel-box');
    if (sel) positionByRect(sel, component.rect);
  };
  const up = () => {
    hit.removeEventListener('pointermove', move);
    hit.removeEventListener('pointerup', up);
    clearGuides();
    renderAll(); // commit (some components re-measure canvases on size)
  };
  hit.addEventListener('pointermove', move);
  hit.addEventListener('pointerup', up);
}

function beginResize(event, index, dir) {
  event.preventDefault();
  event.stopPropagation();
  const overlay = overlayEl();
  const bounds = overlay.getBoundingClientRect();
  const component = state.pack.components[index];
  const orig = [...component.rect];
  const startX = event.clientX, startY = event.clientY;
  const handle = event.target;
  handle.setPointerCapture(event.pointerId);

  const move = (e) => {
    const dx = ((e.clientX - startX) / bounds.width) * 100;
    const dy = ((e.clientY - startY) / bounds.height) * 100;
    let [x, y, w, h] = orig;
    if (dir.includes('e')) w = clamp(w + dx, MIN_SIZE, 100 - x);
    if (dir.includes('s')) h = clamp(h + dy, MIN_SIZE, 100 - y);
    if (dir.includes('w')) {
      const nx = clamp(x + dx, 0, x + w - MIN_SIZE);
      w = w + (x - nx);
      x = nx;
    }
    if (dir.includes('n')) {
      const ny = clamp(y + dy, 0, y + h - MIN_SIZE);
      h = h + (y - ny);
      y = ny;
    }

    // Snap the edge(s) being dragged to alignment targets; grid-snap the rest.
    let keepX = false, keepY = false, keepW = false, keepH = false;
    if (e.altKey) {
      clearGuides();
    } else {
      const thX = (SNAP_PX / bounds.width) * 100;
      const thY = (SNAP_PX / bounds.height) * 100;
      const targets = alignmentTargets(index);
      const gX = [], gY = [];
      if (dir.includes('e')) { const t = nearestTarget(x + w, targets.xs, thX); if (t !== null) { w = clamp(t - x, MIN_SIZE, 100 - x); keepW = true; gX.push(t); } }
      if (dir.includes('w')) { const t = nearestTarget(x, targets.xs, thX); if (t !== null) { const nx = clamp(t, 0, x + w - MIN_SIZE); w = w + (x - nx); x = nx; keepX = keepW = true; gX.push(t); } }
      if (dir.includes('s')) { const t = nearestTarget(y + h, targets.ys, thY); if (t !== null) { h = clamp(t - y, MIN_SIZE, 100 - y); keepH = true; gY.push(t); } }
      if (dir.includes('n')) { const t = nearestTarget(y, targets.ys, thY); if (t !== null) { const ny = clamp(t, 0, y + h - MIN_SIZE); h = h + (y - ny); y = ny; keepY = keepH = true; gY.push(t); } }
      drawGuides(gX, gY);
    }

    component.rect = [
      tidy(keepX ? x : snap(x)), tidy(keepY ? y : snap(y)),
      tidy(keepW ? w : snap(w)), tidy(keepH ? h : snap(h)),
    ];
    positionByRect(state.renderedEls[index], component.rect);
    const sel = overlay.querySelector('.sel-box');
    if (sel) positionByRect(sel, component.rect);
  };
  const up = () => {
    handle.removeEventListener('pointermove', move);
    handle.removeEventListener('pointerup', up);
    clearGuides();
    renderAll();
  };
  handle.addEventListener('pointermove', move);
  handle.addEventListener('pointerup', up);
}

// ── Add / remove / reorder ─────────────────────────────────────────────────

function addComponent(type, atX, atY) {
  if (state.pack.components.length >= 24) {
    setStatus(t('editor.capReached'), true);
    return;
  }
  const options = defaultOptions(type, state.assets);
  if (type === 'image' && !options.src) {
    setStatus(t('editor.noImages'), true);
    return;
  }
  const rect = [...DEFAULT_RECTS[type]];
  if (atX !== undefined) {
    rect[0] = snap(clamp(atX - rect[2] / 2, 0, 100 - rect[2]));
    rect[1] = snap(clamp(atY - rect[3] / 2, 0, 100 - rect[3]));
  }
  state.pack.components.push({ type, rect, z: 2, style: { ...DEFAULT_STYLE }, options });
  state.selected = state.pack.components.length - 1;
  renderAll();
  setStatus(t('editor.added', { name: typeLabel(type) }));
}

function removeSelected() {
  if (state.selected === null) return;
  state.pack.components.splice(state.selected, 1);
  state.selected = null;
  renderAll();
}

// ── Image import (dialog + staging live in main; we just get a rel + uri) ──

async function importImage() {
  const res = await aegis.importImage(Object.keys(state.assets));
  if (!res.ok) {
    if (res.error) setStatus(res.error, true);
    return null; // cancelled or refused
  }
  state.assets[res.rel] = res.uri;
  setStatus(t('editor.imported', { rel: res.rel }));
  return res.rel;
}

// Video wallpaper import: staged in main, returned as a depack:// url the stage
// plays live (30 MB never rides base64). Same shape as importImage.
async function importVideo() {
  const res = await aegis.importVideo(Object.keys(state.assets));
  if (!res.ok) {
    if (res.error) setStatus(res.error, true);
    return null; // cancelled or refused
  }
  state.assets[res.rel] = res.uri;
  setStatus(t('editor.imported', { rel: res.rel }));
  return res.rel;
}

// Classify a wallpaper ref so the skin tab shows the right controls.
function isVideoRel(rel) {
  return typeof rel === 'string' && /\.(mp4|webm)$/i.test(rel);
}

async function importImageAsComponent() {
  const rel = await importImage();
  if (!rel) return;
  state.pack.components.push({
    type: 'image',
    rect: [...DEFAULT_RECTS.image],
    z: 1,
    // Imported art is usually decoration — start chromeless.
    style: { ...DEFAULT_STYLE, panel: false },
    options: { src: rel, fit: 'contain' },
  });
  state.selected = state.pack.components.length - 1;
  renderAll();
}

// ── Inspector ───────────────────────────────────────────────────────────────

function field(labelText, control, onClear, hint) {
  const wrap = document.createElement('div');
  wrap.className = 'field';
  const label = document.createElement('label');
  const span = document.createElement('span');
  span.textContent = labelText;
  label.appendChild(span);
  if (onClear) {
    const clear = document.createElement('button');
    clear.className = 'clear';
    clear.type = 'button';
    clear.textContent = t('editor.insp.clearBtn');
    clear.addEventListener('click', onClear);
    label.appendChild(clear);
  }
  wrap.appendChild(label);
  // Optional plain-language explanation of what this control affects.
  if (hint) {
    const small = document.createElement('small');
    small.className = 'field-hint';
    small.textContent = hint;
    wrap.appendChild(small);
  }
  wrap.appendChild(control);
  return wrap;
}

function selectControl(value, choices, onChange) {
  const select = document.createElement('select');
  for (const [val, text] of choices) {
    const option = document.createElement('option');
    option.value = val;
    option.textContent = text;
    select.appendChild(option);
  }
  select.value = value;
  select.addEventListener('change', () => onChange(select.value));
  return select;
}

function checkControl(labelText, value, onChange) {
  const wrap = document.createElement('label');
  wrap.className = 'check';
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.checked = Boolean(value);
  box.addEventListener('change', () => onChange(box.checked));
  wrap.append(box, document.createTextNode(labelText));
  return wrap;
}

function textControl(value, onChange, placeholder) {
  const input = document.createElement('input');
  input.type = 'text';
  input.value = value ?? '';
  if (placeholder) input.placeholder = placeholder;
  input.addEventListener('change', () => onChange(input.value));
  return input;
}

function numberControl(value, min, max, step, onChange) {
  const input = document.createElement('input');
  input.type = 'number';
  input.min = min; input.max = max; input.step = step;
  input.value = value ?? '';
  input.addEventListener('change', () => onChange(Number(input.value)));
  return input;
}

function rangeControl(value, min, max, step, onChange) {
  const input = document.createElement('input');
  input.type = 'range';
  input.min = min; input.max = max; input.step = step;
  input.value = value;
  // input = live while dragging (inspector rebuild suppressed); change = on
  // release (full render re-syncs the panel).
  input.addEventListener('input', () => { sliderActive = true; onChange(Number(input.value)); });
  input.addEventListener('change', () => { sliderActive = false; onChange(Number(input.value)); });
  return input;
}

function sectionLabel(text) {
  const el = document.createElement('div');
  el.className = 'section';
  el.textContent = text;
  return el;
}

// Telemetry binds + font stacks: the value ids are frozen (they map to pack
// fields), only the display text is localized. Helpers rebuild the pairs at
// render time so the labels follow the active language.
const BIND_KEYS = ['cpu', 'mem', 'disk', 'battery'];
function bindChoices() {
  return BIND_KEYS.map((k) => [k, t(`editor.insp.bind.${k}`)]);
}
function fontChoices() {
  // Rajdhani is a proper font name — never translated; the rest are descriptive.
  return [['rajdhani', 'Rajdhani'], ['system-sans', t('editor.insp.font.systemSans')], ['system-serif', t('editor.insp.font.serif')], ['mono', t('editor.insp.font.mono')]];
}

// Standard skin field names → localized labels. Custom pack keys fall back to
// prettyKey (author-defined, so left as written).
const SKIN_PALETTE_KEYS = new Set(['void', 'glass', 'accent', 'accentBright', 'muted', 'warn', 'gold', 'steel', 'amber', 'bright', 'ink']);
const SKIN_TEXTURE_KEYS = new Set(['scanlines', 'grid', 'glow', 'vignette', 'noise']);
function paletteLabel(key) {
  return SKIN_PALETTE_KEYS.has(key) ? t(`editor.insp.pal.${key}`) : prettyKey(key);
}
function textureLabel(key) {
  return SKIN_TEXTURE_KEYS.has(key) ? t(`editor.insp.tex.${key}`) : prettyKey(key);
}
// Plain-language hints so a new user knows what each colour paints / how a
// texture slider changes the look. Empty for custom (author-defined) keys.
function paletteHint(key) {
  return SKIN_PALETTE_KEYS.has(key) ? t(`editor.insp.palHint.${key}`) : '';
}
function textureHint(key) {
  return SKIN_TEXTURE_KEYS.has(key) ? t(`editor.insp.texHint.${key}`) : '';
}

function optionFields(component, panel) {
  const o = component.options;
  const set = (key) => (v) => { o[key] = v; renderAll(); };
  const type = component.type;

  if (type === 'clock' || type === 'hud-clock' || type === 'ring-clock') {
    if (type === 'ring-clock') {
      panel.append(field(t('editor.insp.field.style'), selectControl(o.style, [['minimal', t('editor.insp.opt.ringMinimal')], ['halo', t('editor.insp.opt.ringHalo')]], set('style'))));
    }
    panel.append(
      field(t('editor.insp.field.format'), selectControl(o.format, [['24h', t('editor.insp.opt.fmt24')], ['12h', t('editor.insp.opt.fmt12')]], set('format'))),
      checkControl(t('editor.insp.check.showSeconds'), o.seconds, set('seconds')),
      checkControl(t('editor.insp.check.showDate'), o.showDate, set('showDate')),
    );
  } else if (type === 'cores') {
    panel.append(field(t('editor.insp.field.label'), textControl(o.label, (v) => { o.label = v || null; renderAll(); }, t('editor.insp.ph.coreLoad'))));
  } else if (type === 'sysinfo') {
    panel.append(
      checkControl(t('editor.insp.check.memory'), o.memory !== false, set('memory')),
      checkControl(t('editor.insp.check.diskFree'), o.disk !== false, set('disk')),
      checkControl(t('editor.insp.check.uptime'), o.uptime !== false, set('uptime')),
      checkControl(t('editor.insp.check.hostName'), o.host === true, set('host')),
      checkControl(t('editor.insp.check.liveHealth'), o.health === true, set('health')),
      field(t('editor.insp.field.statusLine'), textControl(o.statusText, (v) => { o.statusText = v || null; renderAll(); }, t('editor.insp.ph.allNominal'))),
    );
    const note = document.createElement('p');
    note.className = 'ed-empty';
    note.textContent = t('editor.insp.note.health');
    panel.appendChild(note);
  } else if (type === 'analog-clock') {
    panel.append(
      field(t('editor.insp.field.numerals'), selectControl(o.numerals ?? 'quarters', [['quarters', t('editor.insp.opt.numQuarters')], ['all', t('editor.insp.opt.numAll')], ['none', t('editor.insp.opt.none')]], set('numerals'))),
      checkControl(t('editor.insp.check.minuteTicks'), o.minuteTicks !== false, set('minuteTicks')),
      checkControl(t('editor.insp.check.secondHand'), o.seconds, set('seconds')),
    );
  } else if (type === 'stats') {
    for (const [bind, label] of bindChoices()) panel.append(checkControl(label, o[bind], set(bind)));
    panel.append(checkControl(t('editor.insp.check.historyBars'), o.history !== false, set('history')));
  } else if (type === 'meter' || type === 'sparkline') {
    panel.append(field(t('editor.insp.field.source'), selectControl(o.bind, bindChoices(), set('bind'))));
    if (type === 'meter') {
      panel.append(
        field(t('editor.insp.field.shape'), selectControl(o.variant, [['ring', t('editor.insp.opt.shapeRing')], ['bar', t('editor.insp.opt.shapeBar')]], set('variant'))),
        checkControl(t('editor.insp.check.bigReadout'), o.readout !== false, set('readout')),
        checkControl(t('editor.insp.check.scaleTicks'), o.ticks !== false, set('ticks')),
      );
    } else {
      panel.append(
        checkControl(t('editor.insp.check.gridLines'), o.grid !== false, set('grid')),
        checkControl(t('editor.insp.check.liveReadout'), o.readout !== false, set('readout')),
      );
    }
    panel.append(field(t('editor.insp.field.label'), textControl(o.label, (v) => { o.label = v || null; renderAll(); }, t('editor.insp.ph.auto'))));
  } else if (type === 'text') {
    const area = document.createElement('textarea');
    area.rows = 4;
    area.maxLength = 200;
    area.value = o.text;
    area.addEventListener('change', () => { o.text = area.value; renderAll(); });
    panel.append(field(t('editor.insp.field.text'), area));
  } else if (type === 'image') {
    const choices = Object.keys(state.assets).map((rel) => [rel, rel.replace('assets/', '')]);
    if (choices.length > 0) {
      panel.append(
        field(t('editor.insp.field.image'), selectControl(o.src, choices, set('src'))),
        field(t('editor.insp.field.fit'), selectControl(o.fit, [['contain', t('editor.insp.opt.fitContain')], ['cover', t('editor.insp.opt.fitCover')]], set('fit'))),
      );
    }
    const importBtn = document.createElement('button');
    importBtn.className = 'btn tiny';
    importBtn.textContent = t('editor.insp.btn.importNewImage');
    importBtn.addEventListener('click', async () => {
      const rel = await importImage();
      if (rel) { o.src = rel; renderAll(); }
    });
    panel.append(importBtn);
  } else if (type === 'gallery') {
    if (!Array.isArray(o.images)) o.images = [];
    // Current photos, in order, each removable.
    const list = document.createElement('div');
    list.className = 'gallery-editlist';
    if (o.images.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'hint';
      empty.textContent = t('editor.insp.note.galleryEmpty');
      list.appendChild(empty);
    }
    o.images.forEach((rel, i) => {
      const row = document.createElement('div');
      row.className = 'gallery-editrow';
      const name = document.createElement('span');
      name.className = 'gallery-editname';
      name.textContent = `${i + 1}. ${rel.replace('assets/', '')}`;
      const up = document.createElement('button');
      up.className = 'btn tiny'; up.textContent = '↑'; up.disabled = i === 0;
      up.addEventListener('click', () => { [o.images[i - 1], o.images[i]] = [o.images[i], o.images[i - 1]]; renderAll(); });
      const rm = document.createElement('button');
      rm.className = 'btn tiny danger'; rm.textContent = t('editor.insp.btn.remove');
      rm.addEventListener('click', () => { o.images.splice(i, 1); renderAll(); });
      row.append(name, up, rm);
      list.appendChild(row);
    });
    panel.append(field(t('editor.insp.field.photos'), list));

    const existing = Object.keys(state.assets).filter((r) => !o.images.includes(r));
    if (existing.length) {
      panel.append(field(t('editor.insp.field.addExisting'), selectControl('', [['', t('editor.insp.opt.chooseImage')], ...existing.map((r) => [r, r.replace('assets/', '')])], (v) => { if (v) { o.images.push(v); renderAll(); } })));
    }
    const importBtn = document.createElement('button');
    importBtn.className = 'btn tiny';
    importBtn.textContent = t('editor.insp.btn.importPhoto');
    importBtn.addEventListener('click', async () => { const rel = await importImage(); if (rel) { o.images.push(rel); renderAll(); } });
    panel.append(importBtn);

    panel.append(
      field(t('editor.insp.field.secondsPerPhoto'), rangeControl(o.interval, 2, 60, 1, set('interval'))),
      field(t('editor.insp.field.fit'), selectControl(o.fit, [['cover', t('editor.insp.opt.fitCover')], ['contain', t('editor.insp.opt.fitContain')]], set('fit'))),
      field(t('editor.insp.field.transition'), selectControl(o.transition, [['fade', t('editor.insp.opt.transFade')], ['none', t('editor.insp.opt.none')]], set('transition'))),
      checkControl(t('editor.insp.check.shuffleOrder'), o.shuffle, set('shuffle')),
    );
  } else if (type === 'divider') {
    panel.append(field(t('editor.insp.field.direction'), selectControl(o.orientation, [['h', t('editor.insp.opt.orientH')], ['v', t('editor.insp.opt.orientV')]], set('orientation'))));
  } else if (type === 'calendar') {
    panel.append(
      field(t('editor.insp.field.weekStart'), selectControl(o.weekStart, [['mon', t('editor.insp.opt.dayMon')], ['sun', t('editor.insp.opt.daySun')]], set('weekStart'))),
      checkControl(t('editor.insp.check.markReminders'), o.showReminders, set('showReminders')),
    );
  } else if (type === 'agenda') {
    panel.append(
      field(t('editor.insp.field.daysAhead'), numberControl(o.days, 1, 14, 1, set('days'))),
      field(t('editor.insp.field.maxItems'), numberControl(o.limit, 1, 12, 1, set('limit'))),
      field(t('editor.insp.field.label'), textControl(o.label, (v) => { o.label = v || null; renderAll(); }, t('editor.insp.ph.planner'))),
    );
  } else if (type === 'notifications') {
    panel.append(
      field(t('editor.insp.field.maxItems'), numberControl(o.limit, 1, 12, 1, set('limit'))),
      checkControl(t('editor.insp.check.showApp'), o.showApp !== false, set('showApp')),
      field(t('editor.insp.field.label'), textControl(o.label, (v) => { o.label = v || null; renderAll(); }, t('editor.insp.ph.notifications'))),
    );
    const note = document.createElement('p');
    note.className = 'ed-empty';
    note.textContent = t('editor.insp.note.notifications');
    panel.appendChild(note);
  } else if (type === 'assistant') {
    panel.append(
      field(t('editor.insp.field.promptText'), textControl(o.label, (v) => { o.label = v || null; renderAll(); }, t('editor.insp.ph.askAnything'))),
      field(t('editor.insp.field.buttonText'), textControl(o.button, (v) => { o.button = v || null; renderAll(); }, t('editor.insp.ph.execute'))),
    );
    const note = document.createElement('p');
    note.className = 'ed-empty';
    note.textContent = t('editor.insp.note.assistant');
    panel.appendChild(note);
  } else if (type === 'countdown') {
    const date = document.createElement('input');
    date.type = 'date';
    date.value = o.target ? o.target.slice(0, 10) : '';
    date.addEventListener('change', () => { o.target = date.value || null; renderAll(); });
    panel.append(field(t('editor.insp.field.targetDate'), date), field(t('editor.insp.field.label'), textControl(o.label, (v) => { o.label = v || null; renderAll(); }, t('editor.insp.ph.countdown'))));
  } else if (type === 'weather') {
    // Location by CITY NAME (geocoded to lat/lon) — friendlier than raw coords,
    // and it fills the display name so the widget shows the city, not "Weather".
    // Empty = follow the user's Settings weather location.
    const cityInput = document.createElement('input');
    cityInput.type = 'text';
    cityInput.placeholder = t('editor.insp.ph.weatherCity');
    cityInput.value = o.place || '';
    cityInput.style.flex = '1';
    cityInput.style.minWidth = '0';
    const lookupBtn = document.createElement('button');
    lookupBtn.type = 'button';
    lookupBtn.className = 'btn tiny';
    lookupBtn.textContent = t('editor.insp.btn.set');
    const row = document.createElement('div');
    row.style.display = 'flex';
    row.style.gap = '6px';
    row.append(cityInput, lookupBtn);

    const status = document.createElement('p');
    status.className = 'ed-empty';
    const showStatus = () => {
      const hasCoords = Number.isFinite(Number(o.lat)) && Number.isFinite(Number(o.lon)) && !(Number(o.lat) === 0 && Number(o.lon) === 0);
      status.textContent = hasCoords
        ? t('editor.insp.weather.showing', { place: o.place || t('editor.insp.weather.thisLocation'), lat: Number(o.lat).toFixed(2), lon: Number(o.lon).toFixed(2) })
        : t('editor.insp.weather.noLocation');
    };
    showStatus();

    const doLookup = async () => {
      const q = cityInput.value.trim();
      if (!q) { o.lat = 0; o.lon = 0; o.place = null; renderAll(); showStatus(); return; } // cleared → Settings location
      lookupBtn.disabled = true;
      status.textContent = t('editor.insp.weather.lookingUp');
      const res = await aegis.weatherGeocode(q);
      lookupBtn.disabled = false;
      if (!res.ok) { status.textContent = res.error || t('editor.insp.weather.notFound'); return; }
      o.lat = res.lat; o.lon = res.lon; o.place = res.place;
      cityInput.value = res.place;
      renderAll();
      showStatus();
    };
    lookupBtn.addEventListener('click', doLookup);
    cityInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doLookup(); } });

    panel.append(
      field(t('editor.insp.field.locationCity'), row),
      status,
      checkControl(t('editor.insp.check.hiLoWind'), o.details !== false, set('details')),
      checkControl(t('editor.insp.check.compactStrip'), o.compact === true, set('compact')),
    );

    // Advanced: exact coordinates + manual display-name override, tucked away so
    // the common path is just "type a city".
    const adv = document.createElement('details');
    adv.style.marginTop = '8px';
    const sum = document.createElement('summary');
    sum.textContent = t('editor.insp.field.coordsAdvanced');
    sum.style.cursor = 'pointer';
    adv.appendChild(sum);
    adv.append(
      field(t('editor.insp.field.latitude'), numberControl(o.lat, -90, 90, 0.0001, (v) => { o.lat = v; renderAll(); showStatus(); })),
      field(t('editor.insp.field.longitude'), numberControl(o.lon, -180, 180, 0.0001, (v) => { o.lon = v; renderAll(); showStatus(); })),
      field(t('editor.insp.field.displayName'), textControl(o.place, (v) => { o.place = v || null; cityInput.value = v || ''; renderAll(); showStatus(); }, t('editor.insp.ph.autoFromLookup'))),
    );
    panel.appendChild(adv);
  } else if (type === 'launcher') {
    panel.append(
      checkControl(t('editor.insp.check.pinnedApps'), o.pinned !== false, set('pinned')),
      checkControl(t('editor.insp.check.recentlyUsed'), o.recent !== false, set('recent')),
      checkControl(t('editor.insp.check.openWindows'), o.running === true, set('running')),
      checkControl(t('editor.insp.check.showNames'), o.labels !== false, set('labels')),
      field(t('editor.insp.field.iconSize'), selectControl(o.iconSize || 'm', [['s', t('editor.insp.opt.sizeS')], ['m', t('editor.insp.opt.sizeM')], ['l', t('editor.insp.opt.sizeL')]], set('iconSize'))),
      field(t('editor.insp.field.label'), textControl(o.label, (v) => { o.label = v || null; renderAll(); }, t('editor.insp.ph.launcher'))),
    );
    const note = document.createElement('p');
    note.className = 'ed-empty';
    note.textContent = t('editor.insp.note.launcher');
    panel.appendChild(note);
  } else if (type === 'nowplaying') {
    panel.append(
      checkControl(t('editor.insp.check.albumArt'), o.showArt !== false, set('showArt')),
      checkControl(t('editor.insp.check.playbackControls'), o.showControls !== false, set('showControls')),
      field(t('editor.insp.field.labelIdle'), textControl(o.label, (v) => { o.label = v || null; renderAll(); }, t('editor.insp.ph.nowPlaying'))),
    );
    const note = document.createElement('p');
    note.className = 'ed-empty';
    note.textContent = t('editor.insp.note.nowplaying');
    panel.appendChild(note);
  } else if (type === 'visualizer') {
    panel.append(field(t('editor.insp.field.style'), selectControl(o.style, [
      ['bars', t('editor.insp.opt.visBars')], ['waveform', t('editor.insp.opt.visWaveform')], ['radial', t('editor.insp.opt.visRadial')], ['bloom', t('editor.insp.opt.visBloom')],
    ], set('style'))));
    const note = document.createElement('p');
    note.className = 'ed-empty';
    note.textContent = t('editor.insp.note.visualizer');
    panel.appendChild(note);
  } else if (type === 'module') {
    const area = document.createElement('textarea');
    area.className = 'ed-code';
    area.rows = 16;
    area.spellcheck = false;
    area.maxLength = 24 * 1024;
    area.placeholder = '<div>…</div>\n<style>…</style>\n<script>DE.onData(d => …)<\/script>';
    area.value = o.html || '';
    area.addEventListener('change', () => { o.html = area.value; renderAll(); });
    panel.append(
      field(t('editor.insp.field.componentCode'), area),
      checkControl(t('editor.insp.check.scrollOverflow'), o.scroll === true, set('scroll')),
      checkControl(t('editor.insp.check.feedStats'), o.telemetry !== false, set('telemetry')),
    );
    const note = document.createElement('p');
    note.className = 'ed-empty';
    note.textContent = t('editor.insp.note.module');
    panel.appendChild(note);
  }
}

function styleFields(component, panel) {
  const s = component.style;
  const set = (key) => (v) => { s[key] = v; renderAll(); };
  const clear = (key) => () => { s[key] = null; renderAll(); };

  const colorField = (label, key) => {
    const input = document.createElement('input');
    input.type = 'color';
    input.value = s[key] || state.pack.skin.palette.accent;
    // Same as the palette pickers: keep the inspector (and thus the open native
    // colour picker) alive while adjusting; full re-sync on close.
    input.addEventListener('input', () => { sliderActive = true; s[key] = input.value; renderAll(); });
    input.addEventListener('change', () => { sliderActive = false; s[key] = input.value; renderAll(); });
    return field(label, input, clear(key));
  };

  const inh = t('editor.insp.inherit');
  const onOff = [['', inh], ['true', t('editor.insp.opt.on')], ['false', t('editor.insp.opt.off')]];
  panel.append(
    sectionLabel(t('editor.insp.section.style')),
    colorField(t('editor.insp.field.accent'), 'accent'),
    colorField(t('editor.insp.field.textColour'), 'textColor'),
    field(t('editor.insp.field.font'), selectControl(s.font || '', [['', inh], ...fontChoices()], (v) => { s.font = v || null; renderAll(); })),
    field(t('editor.insp.dyn.scale', { value: s.fontScale ?? inh }), rangeControl(s.fontScale ?? 1, 0.5, 3, 0.05, set('fontScale')), clear('fontScale')),
    field(t('editor.insp.field.align'), selectControl(s.align || '', [['', inh], ['left', t('editor.insp.opt.alignLeft')], ['center', t('editor.insp.opt.alignCenter')], ['right', t('editor.insp.opt.alignRight')]], (v) => { s.align = v || null; renderAll(); })),
    field(t('editor.insp.field.placement'), selectControl(s.place || '', [['', inh], ['top', t('editor.insp.opt.placeTop')], ['center', t('editor.insp.opt.placeMiddle')], ['bottom', t('editor.insp.opt.placeBottom')], ['spread', t('editor.insp.opt.placeSpread')]], (v) => { s.place = v || null; renderAll(); })),
    field(t('editor.insp.field.glassPanel'), selectControl(s.panel === null ? '' : String(s.panel), onOff, (v) => { s.panel = v === '' ? null : v === 'true'; renderAll(); })),
    field(t('editor.insp.field.border'), selectControl(s.border === null ? '' : String(s.border), onOff, (v) => { s.border = v === '' ? null : v === 'true'; renderAll(); })),
    field(t('editor.insp.dyn.padding', { value: s.padding ?? inh }), rangeControl(s.padding ?? 18, 0, 48, 1, set('padding')), clear('padding')),
    field(t('editor.insp.dyn.opacity', { value: s.opacity ?? inh }), rangeControl(s.opacity ?? 1, 0.05, 1, 0.05, set('opacity')), clear('opacity')),
    field(t('editor.insp.dyn.glow', { value: s.glow ?? inh }), rangeControl(s.glow ?? 0.5, 0, 1, 0.05, set('glow')), clear('glow')),
    field(t('editor.insp.dyn.rotate', { value: s.rotate ?? 0 }), rangeControl(s.rotate ?? 0, -20, 20, 0.5, set('rotate')), clear('rotate')),
  );
}

function renderComponentTab(panel) {
  if (state.selected === null || !state.pack.components[state.selected]) {
    const empty = document.createElement('p');
    empty.className = 'ed-empty';
    empty.textContent = t('editor.insp.nothingSelected');
    empty.style.whiteSpace = 'pre-wrap';
    panel.appendChild(empty);
    return;
  }
  const component = state.pack.components[state.selected];

  const title = sectionLabel(typeLabel(component.type));
  panel.appendChild(title);

  const actions = document.createElement('div');
  actions.className = 'row-actions';
  const mkBtn = (label, fn, kind) => {
    const b = document.createElement('button');
    b.className = `btn tiny${kind ? ` ${kind}` : ''}`;
    b.textContent = label;
    b.addEventListener('click', fn);
    return b;
  };
  actions.append(
    mkBtn(t('editor.insp.act.forward'), () => { component.z = Math.min(20, component.z + 1); renderAll(); }),
    mkBtn(t('editor.insp.act.back'), () => { component.z = Math.max(0, component.z - 1); renderAll(); }),
    mkBtn(t('editor.insp.act.duplicate'), () => {
      const copy = JSON.parse(JSON.stringify(component));
      copy.rect[0] = clamp(copy.rect[0] + 3, 0, 100 - copy.rect[2]);
      copy.rect[1] = clamp(copy.rect[1] + 3, 0, 100 - copy.rect[3]);
      state.pack.components.push(copy);
      state.selected = state.pack.components.length - 1;
      renderAll();
    }),
    mkBtn(t('editor.insp.act.delete'), removeSelected, 'danger'),
  );
  panel.appendChild(actions);

  optionFields(component, panel);
  styleFields(component, panel);
}

// 'accentBright' → 'Accent bright' — palette keys as readable labels.
function prettyKey(key) {
  const spaced = key.replace(/([A-Z])/g, ' $1').toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function renderSkinTab(panel) {
  const skin = state.pack.skin;
  panel.appendChild(sectionLabel(t('editor.insp.section.palette')));
  for (const key of Object.keys(skin.palette)) {
    const input = document.createElement('input');
    input.type = 'color';
    // Colour inputs can't hold 8-digit hex; show the RGB part.
    input.value = skin.palette[key].slice(0, 7);
    // input = live while the native picker is open; skip the inspector rebuild
    // (sliderActive) so the very <input> the picker is anchored to isn't torn
    // out from under it — otherwise the picker closes on every adjustment.
    // change = on close, do a full re-sync.
    input.addEventListener('input', () => { sliderActive = true; skin.palette[key] = input.value; renderAll(); });
    input.addEventListener('change', () => { sliderActive = false; skin.palette[key] = input.value; renderAll(); });
    panel.appendChild(field(paletteLabel(key), input, null, paletteHint(key)));
  }

  panel.appendChild(sectionLabel(t('editor.insp.section.texture')));
  for (const key of Object.keys(skin.texture)) {
    panel.appendChild(field(textureLabel(key), rangeControl(skin.texture[key], 0, 1, 0.05, (v) => { skin.texture[key] = v; renderAll(); }), null, textureHint(key)));
  }

  panel.appendChild(sectionLabel(t('editor.insp.section.typography')));
  panel.append(
    field(t('editor.insp.field.displayFont'), selectControl(skin.typography.display, fontChoices(), (v) => { skin.typography.display = v; renderAll(); })),
    checkControl(t('editor.insp.check.uppercaseDisplay'), skin.typography.uppercase, (v) => { skin.typography.uppercase = v; renderAll(); }),
    field(t('editor.insp.field.letterSpacing'), rangeControl(skin.typography.letterSpacing, 0, 0.4, 0.01, (v) => { skin.typography.letterSpacing = v; renderAll(); })),
  );

  panel.appendChild(sectionLabel(t('editor.insp.section.shape')));
  panel.append(
    checkControl(t('editor.insp.check.cornerNotches'), skin.shape.cornerNotches, (v) => { skin.shape.cornerNotches = v; renderAll(); }),
    field(t('editor.insp.field.borderOpacity'), rangeControl(skin.shape.borderOpacity, 0.05, 1, 0.01, (v) => { skin.shape.borderOpacity = v; renderAll(); })),
    field(t('editor.insp.field.panelOpacity'), rangeControl(skin.shape.panelOpacity, 0, 1, 0.01, (v) => { skin.shape.panelOpacity = v; renderAll(); })),
    field(t('editor.insp.field.cornerRadius'), rangeControl(skin.shape.radius, 0, 16, 1, (v) => { skin.shape.radius = v; renderAll(); })),
    field(t('editor.insp.field.canvasPadding'), rangeControl(state.pack.canvas.padding, 0, 12, 0.5, (v) => { state.pack.canvas.padding = v; renderAll(); })),
  );

  panel.appendChild(sectionLabel(t('editor.insp.section.ambience')));
  if (!skin.ambience) skin.ambience = { effect: 'none', density: 0.5 };
  panel.append(
    field(t('editor.insp.field.effect'), selectControl(skin.ambience.effect, [['none', t('editor.insp.opt.effNone')], ['embers', t('editor.insp.opt.effEmbers')], ['dust', t('editor.insp.opt.effDust')], ['snow', t('editor.insp.opt.effSnow')], ['petals', t('editor.insp.opt.effPetals')], ['rain', t('editor.insp.opt.effRain')], ['sparkle', t('editor.insp.opt.effSparkle')]], (v) => { skin.ambience.effect = v; renderAll(); })),
    field(t('editor.insp.field.density'), rangeControl(skin.ambience.density, 0.05, 1, 0.05, (v) => { skin.ambience.density = v; renderAll(); })),
  );

  renderBackgroundSection(panel, skin);
}

// Background = a stack of image/video layers (back-to-front) with parallax
// depth + drift. A single layer is a plain wallpaper; add more for depth. The
// engine consumes skin.background.layers; the sanitizer keeps skin.wallpaper in
// sync on save for older engines.
function renderBackgroundSection(panel, skin) {
  if (!skin.background || !Array.isArray(skin.background.layers)) {
    skin.background = { layers: [], parallax: { strength: 1, axis: 'both' } };
  }
  const bg = skin.background;
  panel.appendChild(sectionLabel(t('editor.insp.section.bgLayers')));

  if (bg.layers.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'ed-empty';
    empty.textContent = t('editor.insp.note.bgEmpty');
    panel.appendChild(empty);
  }

  const FIT_CHOICES = [['cover', t('editor.insp.opt.bgFitCover')], ['contain', t('editor.insp.opt.bgFitContain')], ['stretch', t('editor.insp.opt.bgFitStretch')]];
  bg.layers.forEach((layer, i) => {
    const card = document.createElement('div');
    card.className = 'ed-bg-layer';

    const head = document.createElement('div');
    head.className = 'ed-bg-layer-head';
    const name = document.createElement('span');
    name.className = 'ed-bg-layer-name';
    name.textContent = `${i + 1}. ${String(layer.src).replace('assets/', '')}${isVideoRel(layer.src) ? ` (${t('editor.insp.videoTag')})` : ''}`;
    head.appendChild(name);
    const tools = document.createElement('span');
    tools.className = 'ed-bg-layer-tools';
    const mkTool = (glyph, title, enabled, onClick) => {
      const b = document.createElement('button');
      b.className = 'btn tiny'; b.textContent = glyph; b.title = title; b.disabled = !enabled;
      if (enabled) b.addEventListener('click', onClick);
      return b;
    };
    tools.appendChild(mkTool('↑', t('editor.insp.tool.moveBack'), i > 0, () => { [bg.layers[i - 1], bg.layers[i]] = [bg.layers[i], bg.layers[i - 1]]; renderAll(); }));
    tools.appendChild(mkTool('↓', t('editor.insp.tool.moveForward'), i < bg.layers.length - 1, () => { [bg.layers[i + 1], bg.layers[i]] = [bg.layers[i], bg.layers[i + 1]]; renderAll(); }));
    tools.appendChild(mkTool('×', t('editor.insp.tool.removeLayer'), true, () => { bg.layers.splice(i, 1); renderAll(); }));
    head.appendChild(tools);
    card.appendChild(head);

    if (typeof layer.fit !== 'string') layer.fit = 'cover';
    if (typeof layer.posX !== 'number') layer.posX = 50;
    if (typeof layer.posY !== 'number') layer.posY = 50;
    if (typeof layer.depth !== 'number') layer.depth = 0;
    if (typeof layer.opacity !== 'number') layer.opacity = 1;
    if (!layer.drift || typeof layer.drift !== 'object') layer.drift = { x: 0, y: 0 };

    card.appendChild(field(t('editor.insp.field.fit'), selectControl(layer.fit, FIT_CHOICES, (v) => { layer.fit = v; renderAll(); })));
    if (layer.fit !== 'stretch') {
      card.appendChild(field(t('editor.insp.field.positionX'), rangeControl(layer.posX, 0, 100, 1, (v) => { layer.posX = v; renderAll(); })));
      card.appendChild(field(t('editor.insp.field.positionY'), rangeControl(layer.posY, 0, 100, 1, (v) => { layer.posY = v; renderAll(); })));
    }
    // Depth = how much the layer moves with the cursor (0 fixed, 1 full). Opacity
    // lets a foreground layer blend over the ones behind it.
    card.appendChild(field(t('editor.insp.field.depth'), rangeControl(layer.depth, 0, 1, 0.05, (v) => { layer.depth = v; renderAll(); })));
    card.appendChild(field(t('editor.insp.field.opacity'), rangeControl(layer.opacity, 0.05, 1, 0.05, (v) => { layer.opacity = v; renderAll(); })));
    card.appendChild(field(t('editor.insp.field.driftX'), rangeControl(layer.drift.x, -20, 20, 1, (v) => { layer.drift.x = v; renderAll(); })));
    card.appendChild(field(t('editor.insp.field.driftY'), rangeControl(layer.drift.y, -20, 20, 1, (v) => { layer.drift.y = v; renderAll(); })));
    renderLayerEffects(card, layer);
    panel.appendChild(card);
  });

  const addLayer = (rel) => {
    if (!rel) return;
    bg.layers.push({ src: rel, depth: bg.layers.length === 0 ? 0 : 0.5, fit: 'cover', posX: 50, posY: 50, opacity: 1, drift: { x: 0, y: 0 } });
    renderAll();
  };
  if (bg.layers.length < 6) {
    const addImg = document.createElement('button');
    addImg.className = 'btn tiny';
    addImg.textContent = t('editor.insp.btn.addImageLayer');
    addImg.addEventListener('click', async () => addLayer(await importImage()));
    panel.appendChild(addImg);
    const addVid = document.createElement('button');
    addVid.className = 'btn tiny';
    addVid.textContent = t('editor.insp.btn.addVideoLayer');
    addVid.addEventListener('click', async () => addLayer(await importVideo()));
    panel.appendChild(addVid);
  }

  // Video speed is one global knob (schema); show it when any layer is a video.
  if (bg.layers.some((l) => isVideoRel(l.src))) {
    if (!skin.wallpaperVideo || typeof skin.wallpaperVideo.playbackRate !== 'number') skin.wallpaperVideo = { playbackRate: 1 };
    panel.appendChild(field(t('editor.insp.field.videoSpeed'), rangeControl(skin.wallpaperVideo.playbackRate, 0.25, 2, 0.05, (v) => { skin.wallpaperVideo.playbackRate = v; renderAll(); })));
  }

  // Parallax feel — only meaningful once a layer has depth or drift.
  if (bg.layers.length > 0) {
    if (!bg.parallax || typeof bg.parallax !== 'object') bg.parallax = { strength: 1, axis: 'both' };
    if (typeof bg.parallax.strength !== 'number') bg.parallax.strength = 1;
    panel.appendChild(sectionLabel(t('editor.insp.section.parallax')));
    panel.appendChild(field(t('editor.insp.field.strength'), rangeControl(bg.parallax.strength, 0, 2, 0.1, (v) => { bg.parallax.strength = v; renderAll(); })));
    panel.appendChild(field(t('editor.insp.field.axis'), selectControl(bg.parallax.axis || 'both', [['both', t('editor.insp.opt.axisBoth')], ['x', t('editor.insp.opt.axisX')], ['y', t('editor.insp.opt.axisY')]], (v) => { bg.parallax.axis = v; renderAll(); })));
  }
}

// Fresh effect with the sanitizer's defaults.
function defaultEffect(type) {
  if (type === 'ripple') return { type, speed: 1, scale: 3, strength: 0.5 };
  if (type === 'sway') return { type, speed: 0.5, strength: 0.5, direction: 0 };
  if (type === 'drift-warp') return { type, speed: 0.5, scale: 3 };
  if (type === 'pulse') return { type, speed: 1, amount: 0.3, paletteKey: null };
  return { type: 'cursor-ripple', strength: 0.5, speed: 1.4, decay: 1 };
}

// Effect type ids are frozen; only the display labels localize.
function effectAddChoices() {
  return [['', t('editor.insp.opt.fxAdd')], ['ripple', t('editor.insp.opt.fxRipple')], ['sway', t('editor.insp.opt.fxSway')], ['drift-warp', t('editor.insp.opt.fxDriftWarp')], ['pulse', t('editor.insp.opt.fxPulse')], ['cursor-ripple', t('editor.insp.opt.fxCursorRipple')]];
}
function paletteTintChoices() {
  return [['', t('editor.insp.opt.none')], ['accent', t('editor.insp.opt.tintAccent')], ['accentBright', t('editor.insp.opt.tintBright')], ['gold', t('editor.insp.opt.tintGold')], ['warn', t('editor.insp.opt.tintWarn')], ['muted', t('editor.insp.opt.tintMuted')]];
}

// Per-layer WebGL effects: a small card per effect with its params + optional
// region, an add-effect dropdown (max 3). Effects need WebGL; if this display
// lacks it, authoring still works but the stage can't preview.
function renderLayerEffects(card, layer) {
  if (!Array.isArray(layer.effects)) layer.effects = [];
  const head = document.createElement('div');
  head.className = 'ed-bg-fx-head';
  head.textContent = t('editor.insp.effectsWebgl');
  card.appendChild(head);
  if (!(window.AegisGL && window.AegisGL.supported())) {
    const note = document.createElement('p');
    note.className = 'ed-empty';
    note.textContent = t('editor.insp.note.fxUnavailable');
    card.appendChild(note);
  }

  const mkTool = (glyph, title, enabled, onClick) => {
    const b = document.createElement('button');
    b.className = 'btn tiny'; b.textContent = glyph; b.title = title; b.disabled = !enabled;
    if (enabled) b.addEventListener('click', onClick);
    return b;
  };

  layer.effects.forEach((fx, j) => {
    const box = document.createElement('div');
    box.className = 'ed-bg-fx';
    const fh = document.createElement('div');
    fh.className = 'ed-bg-layer-head';
    const name = document.createElement('span');
    name.className = 'ed-bg-layer-name';
    name.textContent = fx.type;
    fh.appendChild(name);
    const tools = document.createElement('span');
    tools.className = 'ed-bg-layer-tools';
    tools.appendChild(mkTool('↑', t('editor.insp.tool.earlier'), j > 0, () => { [layer.effects[j - 1], layer.effects[j]] = [layer.effects[j], layer.effects[j - 1]]; renderAll(); }));
    tools.appendChild(mkTool('↓', t('editor.insp.tool.later'), j < layer.effects.length - 1, () => { [layer.effects[j + 1], layer.effects[j]] = [layer.effects[j], layer.effects[j + 1]]; renderAll(); }));
    tools.appendChild(mkTool('×', t('editor.insp.btn.remove'), true, () => { layer.effects.splice(j, 1); renderAll(); }));
    fh.appendChild(tools);
    box.appendChild(fh);

    const rc = (label, key, min, max, step) => box.appendChild(field(label, rangeControl(fx[key], min, max, step, (v) => { fx[key] = v; renderAll(); })));
    if (fx.type === 'ripple') { rc(t('editor.insp.field.speed'), 'speed', 0, 3, 0.1); rc(t('editor.insp.field.scale'), 'scale', 0.5, 8, 0.5); rc(t('editor.insp.field.strength'), 'strength', 0, 1, 0.05); }
    else if (fx.type === 'sway') { rc(t('editor.insp.field.speed'), 'speed', 0, 3, 0.1); rc(t('editor.insp.field.strength'), 'strength', 0, 1, 0.05); rc(t('editor.insp.field.direction'), 'direction', 0, 360, 5); }
    else if (fx.type === 'drift-warp') { rc(t('editor.insp.field.speed'), 'speed', 0, 3, 0.1); rc(t('editor.insp.field.scale'), 'scale', 0.5, 8, 0.5); }
    else if (fx.type === 'pulse') { rc(t('editor.insp.field.speed'), 'speed', 0, 3, 0.1); rc(t('editor.insp.field.amount'), 'amount', 0, 1, 0.05); box.appendChild(field(t('editor.insp.field.tint'), selectControl(fx.paletteKey || '', paletteTintChoices(), (v) => { fx.paletteKey = v || null; renderAll(); }))); }
    else if (fx.type === 'cursor-ripple') { rc(t('editor.insp.field.strength'), 'strength', 0, 1, 0.05); rc(t('editor.insp.field.speed'), 'speed', 0.2, 3, 0.1); rc(t('editor.insp.field.decay'), 'decay', 0.2, 3, 0.1); }

    renderEffectRegion(box, fx);
    card.appendChild(box);
  });

  if (layer.effects.length < 3) {
    const add = selectControl('', effectAddChoices(), (v) => { if (!v) return; layer.effects.push(defaultEffect(v)); renderAll(); });
    card.appendChild(field('', add));
  }
}

// Optional per-effect region (confine the effect to a rect/ellipse). Numeric
// controls in v1 — a drag-on-stage overlay is a future nicety.
function renderEffectRegion(box, fx) {
  const toggle = document.createElement('button');
  toggle.className = 'btn tiny';
  toggle.textContent = fx.region ? t('editor.insp.btn.removeRegion') : t('editor.insp.btn.addRegion');
  toggle.addEventListener('click', () => {
    if (fx.region) delete fx.region; else fx.region = { shape: 'rect', x: 25, y: 25, w: 50, h: 50, feather: 10 };
    renderAll();
  });
  box.appendChild(toggle);
  if (!fx.region) return;
  const r = fx.region;
  box.appendChild(field(t('editor.insp.field.shape'), selectControl(r.shape, [['rect', t('editor.insp.opt.regRect')], ['ellipse', t('editor.insp.opt.regEllipse')]], (v) => { r.shape = v; renderAll(); })));
  const rc = (label, key, min, max) => box.appendChild(field(label, rangeControl(r[key], min, max, 1, (v) => { r[key] = v; renderAll(); })));
  rc(t('editor.insp.field.regionX'), 'x', 0, 100); rc(t('editor.insp.field.regionY'), 'y', 0, 100);
  rc(t('editor.insp.field.regionW'), 'w', 0, 100); rc(t('editor.insp.field.regionH'), 'h', 0, 100);
  rc(t('editor.insp.field.feather'), 'feather', 0, 50);
}

function renderPersonaTab(panel) {
  const persona = state.pack.persona;
  panel.append(
    sectionLabel(t('editor.insp.section.persona')),
    field(t('editor.insp.field.name'), textControl(persona.name, (v) => { persona.name = v.slice(0, 40) || 'Dashboard'; renderAll(); })),
    field(t('editor.insp.field.tagline'), textControl(persona.tagline, (v) => { persona.tagline = v.slice(0, 80); renderAll(); })),
  );
  const area = document.createElement('textarea');
  area.rows = 6;
  area.value = persona.lines.join('\n');
  area.addEventListener('change', () => {
    persona.lines = area.value.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 8);
    renderAll();
  });
  panel.appendChild(field(t('editor.insp.field.tickerLines'), area));
}

// ── Customize knobs (pack.props) ─────────────────────────────────────────────
// The bindable knobs a pack may expose to subscribers. Mirrors the sanitizer's
// allowlist (lib/packs bindSpec) — anything outside it would be dropped on save.
const KNOB_CATALOG = [
  { key: 'accent', label: 'Accent colour', type: 'color', bind: { target: 'palette', key: 'accent' } },
  { key: 'accent-bright', label: 'Highlight colour', type: 'color', bind: { target: 'palette', key: 'accentBright' } },
  { key: 'muted', label: 'Muted colour', type: 'color', bind: { target: 'palette', key: 'muted' } },
  { key: 'gold', label: 'Gold colour', type: 'color', bind: { target: 'palette', key: 'gold' } },
  { key: 'particles', label: 'Particles', type: 'select', bind: { target: 'ambience', key: 'effect' },
    options: [['none', 'Off'], ['embers', 'Embers'], ['dust', 'Dust'], ['snow', 'Snow'], ['petals', 'Petals'], ['rain', 'Rain'], ['sparkle', 'Sparkle']] },
  { key: 'particle-density', label: 'Particle density', type: 'slider', min: 0.05, max: 1, step: 0.05, bind: { target: 'ambience', key: 'density' } },
  { key: 'glow', label: 'Glow', type: 'slider', min: 0, max: 1, step: 0.05, bind: { target: 'texture', key: 'glow' } },
  { key: 'scanlines', label: 'Scanlines', type: 'slider', min: 0, max: 1, step: 0.05, bind: { target: 'texture', key: 'scanlines' } },
  { key: 'grid', label: 'Grid', type: 'slider', min: 0, max: 1, step: 0.05, bind: { target: 'texture', key: 'grid' } },
  { key: 'vignette', label: 'Vignette', type: 'slider', min: 0, max: 1, step: 0.05, bind: { target: 'texture', key: 'vignette' } },
  { key: 'corner-notches', label: 'Corner notches', type: 'toggle', bind: { target: 'shape', key: 'cornerNotches' } },
];

// A knob's starting value = the pack's current value for its bound field.
function knobDefault(pack, knob) {
  const { target, key } = knob.bind;
  const src = { palette: pack.skin.palette, ambience: pack.skin.ambience, texture: pack.skin.texture, shape: pack.skin.shape }[target];
  return src ? src[key] : undefined;
}

function makeProp(knob, pack) {
  const prop = { key: knob.key, label: knob.label, type: knob.type, bind: { ...knob.bind }, default: knobDefault(pack, knob) };
  if (knob.type === 'slider') { prop.min = knob.min; prop.max = knob.max; prop.step = knob.step; }
  if (knob.type === 'select') prop.options = knob.options.map(([value, label]) => ({ value, label }));
  return prop;
}

// A knob catalog label localized for display only — the canonical English label
// is still what makeProp writes into the pack, so the manager's Customize panel
// can translate it back for subscribers.
function knobCatalogLabel(knob) {
  return t(`editor.insp.knob.${knob.key}`);
}

function renderPropsTab(panel) {
  if (!Array.isArray(state.pack.props)) state.pack.props = [];
  const props = state.pack.props;

  panel.appendChild(sectionLabel(t('editor.insp.section.customize')));
  const intro = document.createElement('p');
  intro.className = 'ed-empty';
  intro.textContent = t('editor.insp.note.knobsIntro');
  panel.appendChild(intro);

  if (props.length === 0) {
    const none = document.createElement('p');
    none.className = 'ed-empty';
    none.textContent = t('editor.insp.note.knobsEmpty');
    panel.appendChild(none);
  }

  props.forEach((prop, i) => {
    // Keep the default in sync with the current pack value so a knob always
    // starts at whatever the pack looks like now.
    const knob = KNOB_CATALOG.find((k) => k.key === prop.key);
    if (knob) prop.default = knobDefault(state.pack, knob);
    const row = document.createElement('div');
    row.className = 'prop-edit-row';
    const label = textControl(prop.label, (v) => { prop.label = v.slice(0, 40) || prop.key; });
    label.classList.add('prop-edit-label');
    const type = document.createElement('span');
    type.className = 'prop-edit-type';
    type.textContent = prop.type;
    const rm = document.createElement('button');
    rm.className = 'btn tiny danger';
    rm.textContent = t('editor.insp.btn.remove');
    rm.addEventListener('click', () => { props.splice(i, 1); renderInspector(); });
    row.append(label, type, rm);
    panel.appendChild(field(`${i + 1}.`, row));
  });

  // Add: knobs not already exposed.
  const available = KNOB_CATALOG.filter((k) => !props.some((p) => p.key === k.key));
  if (available.length) {
    const choices = [['', t('editor.insp.knob.add')], ...available.map((k) => [k.key, `${knobCatalogLabel(k)} (${k.type})`])];
    panel.appendChild(field(t('editor.insp.field.add'), selectControl('', choices, (v) => {
      const knob = KNOB_CATALOG.find((k) => k.key === v);
      if (knob) { props.push(makeProp(knob, state.pack)); renderInspector(); }
    })));
  }
}

function renderInspector() {
  const panel = $('inspector');
  panel.textContent = '';
  if (state.tab === 'component') renderComponentTab(panel);
  else if (state.tab === 'skin') renderSkinTab(panel);
  else if (state.tab === 'props') renderPropsTab(panel);
  else renderPersonaTab(panel);
}

function syncTabs() {
  for (const tab of ['component', 'skin', 'persona', 'props']) {
    $(`itab-${tab}`).setAttribute('aria-selected', String(state.tab === tab));
  }
}

// ── Save ────────────────────────────────────────────────────────────────────

async function save(applyAfter) {
  state.pack.name = $('ed-name').value.trim() || state.pack.name;
  const res = await aegis.editorSave(state.baseId, state.pack);
  if (!res.ok) return setStatus(res.error, true);
  const forked = res.forked;
  state.baseId = res.id;
  state.pack.id = res.id;
  $('ed-base').textContent = forked
    ? t('editor.editingForked', { id: res.id })
    : t('editor.editing', { id: res.id });
  setStatus(forked ? t('editor.savedAsNew', { id: res.id }) : t('common.saved'));
  if (applyAfter) {
    const applied = await aegis.activeSet(res.id);
    if (applied.ok) setStatus(t('editor.savedApplied', { id: res.id }));
  }
}

// ── Init ────────────────────────────────────────────────────────────────────

async function init() {
  const packId = new URLSearchParams(location.search).get('pack') || 'jarvis';
  const loaded = await aegis.packLoad(packId);
  if (!loaded.ok) return setStatus(loaded.error, true);
  const all = await aegis.assetsAll(packId);

  // WYSIWYG: the stage takes the primary display's real aspect ratio, so
  // what you arrange here is exactly what the desktop renders.
  const display = await aegis.display();
  if (display.ok) {
    const stage = $('stage');
    stage.style.aspectRatio = `${display.width} / ${display.height}`;
    stage.style.width = `min(100%, calc((100vh - 140px) * ${(display.width / display.height).toFixed(4)}))`;
  }

  state.baseId = packId;
  state.pack = loaded.pack;
  state.assets = { ...(all.ok ? all.assets : {}), ...loaded.assets };
  $('ed-name').value = state.pack.name;
  const originText = loaded.origin === 'builtin' ? t('editor.originBuiltin') : loaded.origin;
  $('ed-base').textContent = t('editor.editingOrigin', { id: packId, origin: originText });
  document.title = `Editor — ${state.pack.name}`;

  // Palette
  const palette = $('palette');
  for (const item of PALETTE) {
    const li = document.createElement('li');
    li.className = 'pal-item';
    li.draggable = true;
    // The English label/hint in PALETTE is the fallback; en.json carries the
    // canonical strings so translators localize the component list.
    li.textContent = t(`editor.palette.${item.type}.label`);
    const hint = document.createElement('small');
    hint.textContent = t(`editor.palette.${item.type}.hint`);
    li.appendChild(hint);
    li.addEventListener('dragstart', (e) => e.dataTransfer.setData('text/aegis-type', item.type));
    li.addEventListener('dblclick', () => addComponent(item.type, 50, 50));
    palette.appendChild(li);
  }

  const overlay = overlayEl();
  overlay.addEventListener('dragover', (e) => e.preventDefault());
  overlay.addEventListener('drop', (e) => {
    e.preventDefault();
    const type = e.dataTransfer.getData('text/aegis-type');
    if (!type) return;
    const bounds = overlay.getBoundingClientRect();
    addComponent(type, ((e.clientX - bounds.left) / bounds.width) * 100, ((e.clientY - bounds.top) / bounds.height) * 100);
  });
  overlay.addEventListener('pointerdown', (e) => {
    if (e.target === overlay) { state.selected = null; rebuildOverlay(); renderInspector(); }
  });

  // Keyboard: delete + nudge (ignored while typing in inputs)
  window.addEventListener('keydown', (e) => {
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) return;
    if (state.selected === null) return;
    const component = state.pack.components[state.selected];
    const step = e.shiftKey ? 2 : SNAP;
    if (e.key === 'Delete' || e.key === 'Backspace') { removeSelected(); e.preventDefault(); }
    else if (e.key === 'ArrowLeft') { component.rect[0] = clamp(component.rect[0] - step, 0, 100 - component.rect[2]); renderAll(); e.preventDefault(); }
    else if (e.key === 'ArrowRight') { component.rect[0] = clamp(component.rect[0] + step, 0, 100 - component.rect[2]); renderAll(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { component.rect[1] = clamp(component.rect[1] - step, 0, 100 - component.rect[3]); renderAll(); e.preventDefault(); }
    else if (e.key === 'ArrowDown') { component.rect[1] = clamp(component.rect[1] + step, 0, 100 - component.rect[3]); renderAll(); e.preventDefault(); }
  });

  $('itab-component').addEventListener('click', () => { state.tab = 'component'; syncTabs(); renderInspector(); });
  $('itab-skin').addEventListener('click', () => { state.tab = 'skin'; syncTabs(); renderInspector(); });
  $('itab-persona').addEventListener('click', () => { state.tab = 'persona'; syncTabs(); renderInspector(); });
  $('itab-props').addEventListener('click', () => { state.tab = 'props'; syncTabs(); renderInspector(); });
  $('btn-save').addEventListener('click', () => save(false));
  $('btn-save-apply').addEventListener('click', () => save(true));
  $('btn-import-image').addEventListener('click', importImageAsComponent);

  renderAll();
  setStatus(t('editor.dragHint'));
}

init().catch((err) => setStatus(t('editor.startFailed', { message: err.message }), true));
