'use strict';

// Pack editor: drag & drop components on a live canvas that renders through
// the SAME module as the desktop (components.js), inspect and restyle them,
// edit the skin and persona, save. Fork-on-save happens in the main process;
// the editor just keeps editing whatever id came back.

/* global aegis, AegisComponents */

const $ = (id) => document.getElementById(id);

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
  notifications: () => aegis.notifications(),
});

function setStatus(text, warn) {
  const el = $('ed-status');
  el.textContent = text || '';
  el.className = `status-line-app ed-status${warn ? ' warn' : ''}`;
}

function typeLabel(type) {
  const entry = PALETTE.find((p) => p.type === type);
  return entry ? entry.label : type;
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
    setStatus('This pack already has 24 components (the cap).', true);
    return;
  }
  const options = defaultOptions(type, state.assets);
  if (type === 'image' && !options.src) {
    setStatus('This pack has no images in assets/ — add files to the pack folder first.', true);
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
  setStatus(`Added ${typeLabel(type).toLowerCase()}.`);
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
  setStatus(`Imported ${res.rel} — it becomes part of the pack when you save.`);
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
  setStatus(`Imported ${res.rel} — it becomes part of the pack when you save.`);
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

function field(labelText, control, onClear) {
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
    clear.textContent = '[inherit]';
    clear.addEventListener('click', onClear);
    label.appendChild(clear);
  }
  wrap.append(label, control);
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

const BIND_CHOICES = [['cpu', 'CPU'], ['mem', 'Memory'], ['disk', 'Disk'], ['battery', 'Battery']];
const FONT_CHOICES = [['rajdhani', 'Rajdhani'], ['system-sans', 'System sans'], ['system-serif', 'Serif'], ['mono', 'Mono']];

function optionFields(component, panel) {
  const o = component.options;
  const set = (key) => (v) => { o[key] = v; renderAll(); };
  const type = component.type;

  if (type === 'clock' || type === 'hud-clock' || type === 'ring-clock') {
    if (type === 'ring-clock') {
      panel.append(field('Style', selectControl(o.style, [['minimal', 'Minimal (thin ring)'], ['halo', 'Halo (soft fill)']], set('style'))));
    }
    panel.append(
      field('Format', selectControl(o.format, [['24h', '24-hour'], ['12h', '12-hour']], set('format'))),
      checkControl('Show seconds', o.seconds, set('seconds')),
      checkControl('Show date', o.showDate, set('showDate')),
    );
  } else if (type === 'cores') {
    panel.append(field('Label', textControl(o.label, (v) => { o.label = v || null; renderAll(); }, 'Core load')));
  } else if (type === 'sysinfo') {
    panel.append(
      checkControl('Memory', o.memory !== false, set('memory')),
      checkControl('Disk free', o.disk !== false, set('disk')),
      checkControl('Uptime', o.uptime !== false, set('uptime')),
      checkControl('Host name', o.host === true, set('host')),
      checkControl('Live health alerts', o.health === true, set('health')),
      field('Status line', textControl(o.statusText, (v) => { o.statusText = v || null; renderAll(); }, 'ALL SYSTEMS NOMINAL')),
    );
    const note = document.createElement('p');
    note.className = 'ed-empty';
    note.textContent = 'With Live health alerts on, the status line shows your text when all is well and switches to the worst reading (e.g. “CPU 96%”) under high CPU/memory/disk or low battery — amber past 85%, red when critical.';
    panel.appendChild(note);
  } else if (type === 'analog-clock') {
    panel.append(
      field('Numerals', selectControl(o.numerals ?? 'quarters', [['quarters', '12 · 3 · 6 · 9'], ['all', 'All twelve'], ['none', 'None']], set('numerals'))),
      checkControl('Minute ticks', o.minuteTicks !== false, set('minuteTicks')),
      checkControl('Second hand', o.seconds, set('seconds')),
    );
  } else if (type === 'stats') {
    for (const [bind, label] of BIND_CHOICES) panel.append(checkControl(label, o[bind], set(bind)));
    panel.append(checkControl('History behind bars', o.history !== false, set('history')));
  } else if (type === 'meter' || type === 'sparkline') {
    panel.append(field('Source', selectControl(o.bind, BIND_CHOICES, set('bind'))));
    if (type === 'meter') {
      panel.append(
        field('Shape', selectControl(o.variant, [['ring', 'Ring'], ['bar', 'Bar']], set('variant'))),
        checkControl('Big readout', o.readout !== false, set('readout')),
        checkControl('Scale ticks', o.ticks !== false, set('ticks')),
      );
    } else {
      panel.append(
        checkControl('Grid lines', o.grid !== false, set('grid')),
        checkControl('Live readout', o.readout !== false, set('readout')),
      );
    }
    panel.append(field('Label', textControl(o.label, (v) => { o.label = v || null; renderAll(); }, 'auto')));
  } else if (type === 'text') {
    const area = document.createElement('textarea');
    area.rows = 4;
    area.maxLength = 200;
    area.value = o.text;
    area.addEventListener('change', () => { o.text = area.value; renderAll(); });
    panel.append(field('Text', area));
  } else if (type === 'image') {
    const choices = Object.keys(state.assets).map((rel) => [rel, rel.replace('assets/', '')]);
    if (choices.length > 0) {
      panel.append(
        field('Image', selectControl(o.src, choices, set('src'))),
        field('Fit', selectControl(o.fit, [['contain', 'Contain'], ['cover', 'Cover']], set('fit'))),
      );
    }
    const importBtn = document.createElement('button');
    importBtn.className = 'btn tiny';
    importBtn.textContent = 'Import new image…';
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
      empty.textContent = 'No photos yet — add or import below.';
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
      rm.className = 'btn tiny danger'; rm.textContent = 'Remove';
      rm.addEventListener('click', () => { o.images.splice(i, 1); renderAll(); });
      row.append(name, up, rm);
      list.appendChild(row);
    });
    panel.append(field('Photos', list));

    const existing = Object.keys(state.assets).filter((r) => !o.images.includes(r));
    if (existing.length) {
      panel.append(field('Add existing', selectControl('', [['', 'Choose an image…'], ...existing.map((r) => [r, r.replace('assets/', '')])], (v) => { if (v) { o.images.push(v); renderAll(); } })));
    }
    const importBtn = document.createElement('button');
    importBtn.className = 'btn tiny';
    importBtn.textContent = 'Import photo…';
    importBtn.addEventListener('click', async () => { const rel = await importImage(); if (rel) { o.images.push(rel); renderAll(); } });
    panel.append(importBtn);

    panel.append(
      field('Seconds per photo', rangeControl(o.interval, 2, 60, 1, set('interval'))),
      field('Fit', selectControl(o.fit, [['cover', 'Cover'], ['contain', 'Contain']], set('fit'))),
      field('Transition', selectControl(o.transition, [['fade', 'Crossfade'], ['none', 'None']], set('transition'))),
      checkControl('Shuffle order', o.shuffle, set('shuffle')),
    );
  } else if (type === 'divider') {
    panel.append(field('Direction', selectControl(o.orientation, [['h', 'Horizontal'], ['v', 'Vertical']], set('orientation'))));
  } else if (type === 'calendar') {
    panel.append(
      field('Week starts on', selectControl(o.weekStart, [['mon', 'Monday'], ['sun', 'Sunday']], set('weekStart'))),
      checkControl('Mark days with reminders', o.showReminders, set('showReminders')),
    );
  } else if (type === 'agenda') {
    panel.append(
      field('Days ahead', numberControl(o.days, 1, 14, 1, set('days'))),
      field('Max items', numberControl(o.limit, 1, 12, 1, set('limit'))),
      field('Label', textControl(o.label, (v) => { o.label = v || null; renderAll(); }, 'Planner')),
    );
  } else if (type === 'notifications') {
    panel.append(
      field('Max items', numberControl(o.limit, 1, 12, 1, set('limit'))),
      checkControl('Show app name', o.showApp !== false, set('showApp')),
      field('Label', textControl(o.label, (v) => { o.label = v || null; renderAll(); }, 'Notifications')),
    );
    const note = document.createElement('p');
    note.className = 'ed-empty';
    note.textContent = 'Shows the user’s own live Windows notifications — never saved into the pack. Needs notification access (Windows Settings › Privacy › Notifications).';
    panel.appendChild(note);
  } else if (type === 'assistant') {
    panel.append(
      field('Prompt text', textControl(o.label, (v) => { o.label = v || null; renderAll(); }, 'Ask anything…')),
      field('Button text', textControl(o.button, (v) => { o.button = v || null; renderAll(); }, 'Execute')),
    );
    const note = document.createElement('p');
    note.className = 'ed-empty';
    note.textContent = 'Clicking this on the desktop opens the AI chat. It runs on a free model by default — pick a different one in the manager under Assistant.';
    panel.appendChild(note);
  } else if (type === 'countdown') {
    const date = document.createElement('input');
    date.type = 'date';
    date.value = o.target ? o.target.slice(0, 10) : '';
    date.addEventListener('change', () => { o.target = date.value || null; renderAll(); });
    panel.append(field('Target date', date), field('Label', textControl(o.label, (v) => { o.label = v || null; renderAll(); }, 'Countdown')));
  } else if (type === 'weather') {
    // Location by CITY NAME (geocoded to lat/lon) — friendlier than raw coords,
    // and it fills the display name so the widget shows the city, not "Weather".
    // Empty = follow the user's Settings weather location.
    const cityInput = document.createElement('input');
    cityInput.type = 'text';
    cityInput.placeholder = 'e.g. Penang — empty = user’s Settings location';
    cityInput.value = o.place || '';
    cityInput.style.flex = '1';
    cityInput.style.minWidth = '0';
    const lookupBtn = document.createElement('button');
    lookupBtn.type = 'button';
    lookupBtn.className = 'btn tiny';
    lookupBtn.textContent = 'Set';
    const row = document.createElement('div');
    row.style.display = 'flex';
    row.style.gap = '6px';
    row.append(cityInput, lookupBtn);

    const status = document.createElement('p');
    status.className = 'ed-empty';
    const showStatus = () => {
      const hasCoords = Number.isFinite(Number(o.lat)) && Number.isFinite(Number(o.lon)) && !(Number(o.lat) === 0 && Number(o.lon) === 0);
      status.textContent = hasCoords
        ? `Showing ${o.place || 'this location'} (${Number(o.lat).toFixed(2)}, ${Number(o.lon).toFixed(2)}).`
        : 'No location set — follows the user’s Settings weather location.';
    };
    showStatus();

    const doLookup = async () => {
      const q = cityInput.value.trim();
      if (!q) { o.lat = 0; o.lon = 0; o.place = null; renderAll(); showStatus(); return; } // cleared → Settings location
      lookupBtn.disabled = true;
      status.textContent = 'Looking up…';
      const res = await aegis.weatherGeocode(q);
      lookupBtn.disabled = false;
      if (!res.ok) { status.textContent = res.error || 'Location not found.'; return; }
      o.lat = res.lat; o.lon = res.lon; o.place = res.place;
      cityInput.value = res.place;
      renderAll();
      showStatus();
    };
    lookupBtn.addEventListener('click', doLookup);
    cityInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doLookup(); } });

    panel.append(
      field('Location (city)', row),
      status,
      checkControl('Hi/lo + wind line', o.details !== false, set('details')),
      checkControl('Compact strip (one line)', o.compact === true, set('compact')),
    );

    // Advanced: exact coordinates + manual display-name override, tucked away so
    // the common path is just "type a city".
    const adv = document.createElement('details');
    adv.style.marginTop = '8px';
    const sum = document.createElement('summary');
    sum.textContent = 'Coordinates (advanced)';
    sum.style.cursor = 'pointer';
    adv.appendChild(sum);
    adv.append(
      field('Latitude', numberControl(o.lat, -90, 90, 0.0001, (v) => { o.lat = v; renderAll(); showStatus(); })),
      field('Longitude', numberControl(o.lon, -180, 180, 0.0001, (v) => { o.lon = v; renderAll(); showStatus(); })),
      field('Display name', textControl(o.place, (v) => { o.place = v || null; cityInput.value = v || ''; renderAll(); showStatus(); }, 'auto from lookup')),
    );
    panel.appendChild(adv);
  } else if (type === 'launcher') {
    panel.append(
      checkControl('Pinned apps', o.pinned !== false, set('pinned')),
      checkControl('Recently used', o.recent !== false, set('recent')),
      checkControl('Open windows', o.running === true, set('running')),
      checkControl('Show names', o.labels !== false, set('labels')),
      field('Icon size', selectControl(o.iconSize || 'm', [['s', 'Small'], ['m', 'Medium'], ['l', 'Large']], set('iconSize'))),
      field('Label', textControl(o.label, (v) => { o.label = v || null; renderAll(); }, 'Launcher')),
    );
    const note = document.createElement('p');
    note.className = 'ed-empty';
    note.textContent = 'Tiles show the user’s own pins and recents (managed in the manager) — they are never saved into the pack.';
    panel.appendChild(note);
  } else if (type === 'nowplaying') {
    panel.append(
      checkControl('Album art', o.showArt !== false, set('showArt')),
      checkControl('Playback controls', o.showControls !== false, set('showControls')),
      field('Label (when idle)', textControl(o.label, (v) => { o.label = v || null; renderAll(); }, 'Now Playing')),
    );
    const note = document.createElement('p');
    note.className = 'ed-empty';
    note.textContent = 'Shows whatever the user is playing — Spotify, a browser, any player — via the Windows media session, with play/pause/next/prev. Personal data; never saved into the pack. Live only on the desktop.';
    panel.appendChild(note);
  } else if (type === 'visualizer') {
    panel.append(field('Style', selectControl(o.style, [
      ['bars', 'Bars (spectrum)'], ['waveform', 'Waveform'], ['radial', 'Radial'], ['bloom', 'Bloom (ambient glow)'],
    ], set('style'))));
    const note = document.createElement('p');
    note.className = 'ed-empty';
    note.textContent = 'Reacts to the system audio on the desktop (any player — Spotify, a browser, a game) via loopback capture. Tip: place a Bloom one full-screen behind your other components for a reactive background ambience. Static preview here; live only on the desktop.';
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
      field('Component code (HTML · CSS · JS)', area),
      checkControl('Scroll if content overflows', o.scroll === true, set('scroll')),
      checkControl('Feed live system stats (DE.onData)', o.telemetry !== false, set('telemetry')),
    );
    const note = document.createElement('p');
    note.className = 'ed-empty';
    note.textContent = 'Runs in a locked-down sandbox — no network, no file access, no control over the engine. It receives the pack theme (--de-* CSS variables + DE.onTheme) and, if enabled, live stats via DE.onData. Full reference in PACKS.md → Module SDK.';
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
    input.addEventListener('input', () => { s[key] = input.value; renderAll(); });
    return field(label, input, clear(key));
  };

  panel.append(
    sectionLabel('Style'),
    colorField('Accent', 'accent'),
    colorField('Text colour', 'textColor'),
    field('Font', selectControl(s.font || '', [['', 'inherit'], ...FONT_CHOICES], (v) => { s.font = v || null; renderAll(); })),
    field(`Scale (${s.fontScale ?? 'inherit'})`, rangeControl(s.fontScale ?? 1, 0.5, 3, 0.05, set('fontScale')), clear('fontScale')),
    field('Align', selectControl(s.align || '', [['', 'inherit'], ['left', 'Left'], ['center', 'Center'], ['right', 'Right']], (v) => { s.align = v || null; renderAll(); })),
    field('Placement', selectControl(s.place || '', [['', 'inherit'], ['top', 'Top'], ['center', 'Middle'], ['bottom', 'Bottom'], ['spread', 'Spread out']], (v) => { s.place = v || null; renderAll(); })),
    field('Glass panel', selectControl(s.panel === null ? '' : String(s.panel), [['', 'inherit'], ['true', 'On'], ['false', 'Off']], (v) => { s.panel = v === '' ? null : v === 'true'; renderAll(); })),
    field('Border', selectControl(s.border === null ? '' : String(s.border), [['', 'inherit'], ['true', 'On'], ['false', 'Off']], (v) => { s.border = v === '' ? null : v === 'true'; renderAll(); })),
    field(`Padding (${s.padding ?? 'inherit'})`, rangeControl(s.padding ?? 18, 0, 48, 1, set('padding')), clear('padding')),
    field(`Opacity (${s.opacity ?? 'inherit'})`, rangeControl(s.opacity ?? 1, 0.05, 1, 0.05, set('opacity')), clear('opacity')),
    field(`Glow (${s.glow ?? 'inherit'})`, rangeControl(s.glow ?? 0.5, 0, 1, 0.05, set('glow')), clear('glow')),
    field(`Rotate (${s.rotate ?? 0}°)`, rangeControl(s.rotate ?? 0, -20, 20, 0.5, set('rotate')), clear('rotate')),
  );
}

function renderComponentTab(panel) {
  if (state.selected === null || !state.pack.components[state.selected]) {
    const empty = document.createElement('p');
    empty.className = 'ed-empty';
    empty.textContent = 'Nothing selected.\n\nClick a component on the canvas, drag one in from the palette, or double-click a palette entry.';
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
    mkBtn('Bring forward', () => { component.z = Math.min(20, component.z + 1); renderAll(); }),
    mkBtn('Send back', () => { component.z = Math.max(0, component.z - 1); renderAll(); }),
    mkBtn('Duplicate', () => {
      const copy = JSON.parse(JSON.stringify(component));
      copy.rect[0] = clamp(copy.rect[0] + 3, 0, 100 - copy.rect[2]);
      copy.rect[1] = clamp(copy.rect[1] + 3, 0, 100 - copy.rect[3]);
      state.pack.components.push(copy);
      state.selected = state.pack.components.length - 1;
      renderAll();
    }),
    mkBtn('Delete', removeSelected, 'danger'),
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
  panel.appendChild(sectionLabel('Palette'));
  for (const key of Object.keys(skin.palette)) {
    const input = document.createElement('input');
    input.type = 'color';
    // Colour inputs can't hold 8-digit hex; show the RGB part.
    input.value = skin.palette[key].slice(0, 7);
    input.addEventListener('input', () => { skin.palette[key] = input.value; renderAll(); });
    panel.appendChild(field(prettyKey(key), input));
  }

  panel.appendChild(sectionLabel('Texture'));
  for (const key of Object.keys(skin.texture)) {
    panel.appendChild(field(prettyKey(key), rangeControl(skin.texture[key], 0, 1, 0.05, (v) => { skin.texture[key] = v; renderAll(); })));
  }

  panel.appendChild(sectionLabel('Typography'));
  panel.append(
    field('Display font', selectControl(skin.typography.display, FONT_CHOICES, (v) => { skin.typography.display = v; renderAll(); })),
    checkControl('Uppercase display text', skin.typography.uppercase, (v) => { skin.typography.uppercase = v; renderAll(); }),
    field('Letter spacing', rangeControl(skin.typography.letterSpacing, 0, 0.4, 0.01, (v) => { skin.typography.letterSpacing = v; renderAll(); })),
  );

  panel.appendChild(sectionLabel('Shape'));
  panel.append(
    checkControl('Corner notches', skin.shape.cornerNotches, (v) => { skin.shape.cornerNotches = v; renderAll(); }),
    field('Border opacity', rangeControl(skin.shape.borderOpacity, 0.05, 1, 0.01, (v) => { skin.shape.borderOpacity = v; renderAll(); })),
    field('Panel opacity', rangeControl(skin.shape.panelOpacity, 0, 1, 0.01, (v) => { skin.shape.panelOpacity = v; renderAll(); })),
    field('Corner radius', rangeControl(skin.shape.radius, 0, 16, 1, (v) => { skin.shape.radius = v; renderAll(); })),
    field('Canvas padding', rangeControl(state.pack.canvas.padding, 0, 12, 0.5, (v) => { state.pack.canvas.padding = v; renderAll(); })),
  );

  panel.appendChild(sectionLabel('Ambience'));
  if (!skin.ambience) skin.ambience = { effect: 'none', density: 0.5 };
  panel.append(
    field('Effect', selectControl(skin.ambience.effect, [['none', 'None'], ['embers', 'Embers'], ['dust', 'Dust'], ['snow', 'Snow'], ['petals', 'Petals'], ['rain', 'Rain'], ['sparkle', 'Sparkle']], (v) => { skin.ambience.effect = v; renderAll(); })),
    field('Density', rangeControl(skin.ambience.density, 0.05, 1, 0.05, (v) => { skin.ambience.density = v; renderAll(); })),
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
  panel.appendChild(sectionLabel('Background layers'));

  if (bg.layers.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'ed-empty';
    empty.textContent = 'No background yet — add an image or video layer. Add several at different depths for a parallax effect.';
    panel.appendChild(empty);
  }

  const FIT_CHOICES = [['cover', 'Fill (crop)'], ['contain', 'Fit whole'], ['stretch', 'Stretch']];
  bg.layers.forEach((layer, i) => {
    const card = document.createElement('div');
    card.className = 'ed-bg-layer';

    const head = document.createElement('div');
    head.className = 'ed-bg-layer-head';
    const name = document.createElement('span');
    name.className = 'ed-bg-layer-name';
    name.textContent = `${i + 1}. ${String(layer.src).replace('assets/', '')}${isVideoRel(layer.src) ? ' (video)' : ''}`;
    head.appendChild(name);
    const tools = document.createElement('span');
    tools.className = 'ed-bg-layer-tools';
    const mkTool = (glyph, title, enabled, onClick) => {
      const b = document.createElement('button');
      b.className = 'btn tiny'; b.textContent = glyph; b.title = title; b.disabled = !enabled;
      if (enabled) b.addEventListener('click', onClick);
      return b;
    };
    tools.appendChild(mkTool('↑', 'Move back', i > 0, () => { [bg.layers[i - 1], bg.layers[i]] = [bg.layers[i], bg.layers[i - 1]]; renderAll(); }));
    tools.appendChild(mkTool('↓', 'Move forward', i < bg.layers.length - 1, () => { [bg.layers[i + 1], bg.layers[i]] = [bg.layers[i], bg.layers[i + 1]]; renderAll(); }));
    tools.appendChild(mkTool('×', 'Remove layer', true, () => { bg.layers.splice(i, 1); renderAll(); }));
    head.appendChild(tools);
    card.appendChild(head);

    if (typeof layer.fit !== 'string') layer.fit = 'cover';
    if (typeof layer.posX !== 'number') layer.posX = 50;
    if (typeof layer.posY !== 'number') layer.posY = 50;
    if (typeof layer.depth !== 'number') layer.depth = 0;
    if (typeof layer.opacity !== 'number') layer.opacity = 1;
    if (!layer.drift || typeof layer.drift !== 'object') layer.drift = { x: 0, y: 0 };

    card.appendChild(field('Fit', selectControl(layer.fit, FIT_CHOICES, (v) => { layer.fit = v; renderAll(); })));
    if (layer.fit !== 'stretch') {
      card.appendChild(field('Position X', rangeControl(layer.posX, 0, 100, 1, (v) => { layer.posX = v; renderAll(); })));
      card.appendChild(field('Position Y', rangeControl(layer.posY, 0, 100, 1, (v) => { layer.posY = v; renderAll(); })));
    }
    // Depth = how much the layer moves with the cursor (0 fixed, 1 full). Opacity
    // lets a foreground layer blend over the ones behind it.
    card.appendChild(field('Depth', rangeControl(layer.depth, 0, 1, 0.05, (v) => { layer.depth = v; renderAll(); })));
    card.appendChild(field('Opacity', rangeControl(layer.opacity, 0.05, 1, 0.05, (v) => { layer.opacity = v; renderAll(); })));
    card.appendChild(field('Drift X', rangeControl(layer.drift.x, -20, 20, 1, (v) => { layer.drift.x = v; renderAll(); })));
    card.appendChild(field('Drift Y', rangeControl(layer.drift.y, -20, 20, 1, (v) => { layer.drift.y = v; renderAll(); })));
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
    addImg.textContent = 'Add image layer…';
    addImg.addEventListener('click', async () => addLayer(await importImage()));
    panel.appendChild(addImg);
    const addVid = document.createElement('button');
    addVid.className = 'btn tiny';
    addVid.textContent = 'Add video layer…';
    addVid.addEventListener('click', async () => addLayer(await importVideo()));
    panel.appendChild(addVid);
  }

  // Video speed is one global knob (schema); show it when any layer is a video.
  if (bg.layers.some((l) => isVideoRel(l.src))) {
    if (!skin.wallpaperVideo || typeof skin.wallpaperVideo.playbackRate !== 'number') skin.wallpaperVideo = { playbackRate: 1 };
    panel.appendChild(field('Video speed', rangeControl(skin.wallpaperVideo.playbackRate, 0.25, 2, 0.05, (v) => { skin.wallpaperVideo.playbackRate = v; renderAll(); })));
  }

  // Parallax feel — only meaningful once a layer has depth or drift.
  if (bg.layers.length > 0) {
    if (!bg.parallax || typeof bg.parallax !== 'object') bg.parallax = { strength: 1, axis: 'both' };
    if (typeof bg.parallax.strength !== 'number') bg.parallax.strength = 1;
    panel.appendChild(sectionLabel('Parallax'));
    panel.appendChild(field('Strength', rangeControl(bg.parallax.strength, 0, 2, 0.1, (v) => { bg.parallax.strength = v; renderAll(); })));
    panel.appendChild(field('Axis', selectControl(bg.parallax.axis || 'both', [['both', 'Both'], ['x', 'Horizontal'], ['y', 'Vertical']], (v) => { bg.parallax.axis = v; renderAll(); })));
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

const EFFECT_ADD_CHOICES = [['', 'Add effect…'], ['ripple', 'Ripple'], ['sway', 'Sway'], ['drift-warp', 'Drift warp'], ['pulse', 'Pulse'], ['cursor-ripple', 'Cursor ripple']];
const PALETTE_TINT_CHOICES = [['', 'None'], ['accent', 'Accent'], ['accentBright', 'Bright'], ['gold', 'Gold'], ['warn', 'Warn'], ['muted', 'Muted']];

// Per-layer WebGL effects: a small card per effect with its params + optional
// region, an add-effect dropdown (max 3). Effects need WebGL; if this display
// lacks it, authoring still works but the stage can't preview.
function renderLayerEffects(card, layer) {
  if (!Array.isArray(layer.effects)) layer.effects = [];
  const head = document.createElement('div');
  head.className = 'ed-bg-fx-head';
  head.textContent = 'Effects (WebGL)';
  card.appendChild(head);
  if (!(window.AegisGL && window.AegisGL.supported())) {
    const note = document.createElement('p');
    note.className = 'ed-empty';
    note.textContent = 'Effects preview unavailable on this GPU — they’re still saved and run where WebGL is available.';
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
    tools.appendChild(mkTool('↑', 'Earlier', j > 0, () => { [layer.effects[j - 1], layer.effects[j]] = [layer.effects[j], layer.effects[j - 1]]; renderAll(); }));
    tools.appendChild(mkTool('↓', 'Later', j < layer.effects.length - 1, () => { [layer.effects[j + 1], layer.effects[j]] = [layer.effects[j], layer.effects[j + 1]]; renderAll(); }));
    tools.appendChild(mkTool('×', 'Remove', true, () => { layer.effects.splice(j, 1); renderAll(); }));
    fh.appendChild(tools);
    box.appendChild(fh);

    const rc = (label, key, min, max, step) => box.appendChild(field(label, rangeControl(fx[key], min, max, step, (v) => { fx[key] = v; renderAll(); })));
    if (fx.type === 'ripple') { rc('Speed', 'speed', 0, 3, 0.1); rc('Scale', 'scale', 0.5, 8, 0.5); rc('Strength', 'strength', 0, 1, 0.05); }
    else if (fx.type === 'sway') { rc('Speed', 'speed', 0, 3, 0.1); rc('Strength', 'strength', 0, 1, 0.05); rc('Direction', 'direction', 0, 360, 5); }
    else if (fx.type === 'drift-warp') { rc('Speed', 'speed', 0, 3, 0.1); rc('Scale', 'scale', 0.5, 8, 0.5); }
    else if (fx.type === 'pulse') { rc('Speed', 'speed', 0, 3, 0.1); rc('Amount', 'amount', 0, 1, 0.05); box.appendChild(field('Tint', selectControl(fx.paletteKey || '', PALETTE_TINT_CHOICES, (v) => { fx.paletteKey = v || null; renderAll(); }))); }
    else if (fx.type === 'cursor-ripple') { rc('Strength', 'strength', 0, 1, 0.05); rc('Speed', 'speed', 0.2, 3, 0.1); rc('Decay', 'decay', 0.2, 3, 0.1); }

    renderEffectRegion(box, fx);
    card.appendChild(box);
  });

  if (layer.effects.length < 3) {
    const add = selectControl('', EFFECT_ADD_CHOICES, (v) => { if (!v) return; layer.effects.push(defaultEffect(v)); renderAll(); });
    card.appendChild(field('', add));
  }
}

// Optional per-effect region (confine the effect to a rect/ellipse). Numeric
// controls in v1 — a drag-on-stage overlay is a future nicety.
function renderEffectRegion(box, fx) {
  const toggle = document.createElement('button');
  toggle.className = 'btn tiny';
  toggle.textContent = fx.region ? 'Remove region' : 'Add region';
  toggle.addEventListener('click', () => {
    if (fx.region) delete fx.region; else fx.region = { shape: 'rect', x: 25, y: 25, w: 50, h: 50, feather: 10 };
    renderAll();
  });
  box.appendChild(toggle);
  if (!fx.region) return;
  const r = fx.region;
  box.appendChild(field('Shape', selectControl(r.shape, [['rect', 'Rectangle'], ['ellipse', 'Ellipse']], (v) => { r.shape = v; renderAll(); })));
  const rc = (label, key, min, max) => box.appendChild(field(label, rangeControl(r[key], min, max, 1, (v) => { r[key] = v; renderAll(); })));
  rc('Region X', 'x', 0, 100); rc('Region Y', 'y', 0, 100);
  rc('Region W', 'w', 0, 100); rc('Region H', 'h', 0, 100);
  rc('Feather', 'feather', 0, 50);
}

function renderPersonaTab(panel) {
  const persona = state.pack.persona;
  panel.append(
    sectionLabel('Persona'),
    field('Name', textControl(persona.name, (v) => { persona.name = v.slice(0, 40) || 'Dashboard'; renderAll(); })),
    field('Tagline', textControl(persona.tagline, (v) => { persona.tagline = v.slice(0, 80); renderAll(); })),
  );
  const area = document.createElement('textarea');
  area.rows = 6;
  area.value = persona.lines.join('\n');
  area.addEventListener('change', () => {
    persona.lines = area.value.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 8);
    renderAll();
  });
  panel.appendChild(field('Ticker lines (one per line, up to 8)', area));
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

function renderPropsTab(panel) {
  if (!Array.isArray(state.pack.props)) state.pack.props = [];
  const props = state.pack.props;

  panel.appendChild(sectionLabel('Customize knobs'));
  const intro = document.createElement('p');
  intro.className = 'ed-empty';
  intro.textContent = 'Expose a few controls subscribers can tweak without editing the pack. Each knob’s starting value tracks the pack’s current look.';
  panel.appendChild(intro);

  if (props.length === 0) {
    const none = document.createElement('p');
    none.className = 'ed-empty';
    none.textContent = 'No knobs yet — add some below.';
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
    rm.textContent = 'Remove';
    rm.addEventListener('click', () => { props.splice(i, 1); renderInspector(); });
    row.append(label, type, rm);
    panel.appendChild(field(`${i + 1}.`, row));
  });

  // Add: knobs not already exposed.
  const available = KNOB_CATALOG.filter((k) => !props.some((p) => p.key === k.key));
  if (available.length) {
    const choices = [['', 'Add a knob…'], ...available.map((k) => [k.key, `${k.label} (${k.type})`])];
    panel.appendChild(field('Add', selectControl('', choices, (v) => {
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
  $('ed-base').textContent = `Editing ${res.id}${forked ? ' (your copy — the original is untouched)' : ''}`;
  setStatus(forked ? `Saved as a new pack: “${res.id}”.` : 'Saved.');
  if (applyAfter) {
    const applied = await aegis.activeSet(res.id);
    if (applied.ok) setStatus(`Saved — “${res.id}” is now on your desktop.`);
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
  $('ed-base').textContent = `Editing ${packId} (${loaded.origin === 'builtin' ? 'built-in — saving makes your own copy' : loaded.origin})`;
  document.title = `Editor — ${state.pack.name}`;

  // Palette
  const palette = $('palette');
  for (const item of PALETTE) {
    const li = document.createElement('li');
    li.className = 'pal-item';
    li.draggable = true;
    li.textContent = item.label;
    const hint = document.createElement('small');
    hint.textContent = item.hint;
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
  setStatus('Drag to move · guides snap to other components’ edges & centre · hold Alt to move freely · arrow keys nudge · Delete removes.');
}

init().catch((err) => setStatus(`The editor failed to start: ${err.message}`, true));
