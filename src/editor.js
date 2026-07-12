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
  { type: 'stats', label: 'Stats', hint: 'labelled telemetry bars' },
  { type: 'meter', label: 'Meter', hint: 'one value, ring or bar' },
  { type: 'sparkline', label: 'Sparkline', hint: '3-minute history graph' },
  { type: 'text', label: 'Text', hint: 'free text block' },
  { type: 'image', label: 'Image', hint: 'pack art (assets/)' },
  { type: 'divider', label: 'Divider', hint: 'hairline rule' },
  { type: 'calendar', label: 'Calendar', hint: 'month grid, today marked' },
  { type: 'countdown', label: 'Countdown', hint: 'days/hours to a date' },
  { type: 'weather', label: 'Weather', hint: 'Open-Meteo, needs lat/lon' },
];

const DEFAULT_RECTS = {
  'status': [10, 10, 40, 18], 'clock': [10, 10, 26, 20], 'analog-clock': [10, 10, 18, 28],
  'stats': [10, 10, 34, 22], 'meter': [10, 10, 14, 22], 'sparkline': [10, 10, 26, 16],
  'text': [10, 10, 24, 10], 'image': [10, 10, 24, 30], 'divider': [10, 10, 30, 3],
  'calendar': [10, 10, 20, 30], 'countdown': [10, 10, 22, 16], 'weather': [10, 10, 20, 16],
};

function defaultOptions(type, assets) {
  const in30days = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
  const firstAsset = Object.keys(assets)[0] || null;
  return {
    'status': {}, 'clock': { format: '24h', seconds: true, showDate: true },
    'analog-clock': { seconds: true },
    'stats': { cpu: true, mem: true, disk: false, battery: false },
    'meter': { bind: 'cpu', variant: 'ring', label: null },
    'sparkline': { bind: 'cpu', label: null },
    'text': { text: 'New text' },
    'image': { src: firstAsset, fit: 'contain' },
    'divider': { orientation: 'h' },
    'calendar': { weekStart: 'mon' },
    'countdown': { target: in30days, label: 'Countdown' },
    'weather': { lat: 0, lon: 0, place: null },
  }[type];
}

const DEFAULT_STYLE = {
  accent: null, textColor: null, font: null, fontScale: null, align: null,
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

// ── Rendering ───────────────────────────────────────────────────────────────

function renderAll() {
  AegisComponents.applySkin($('skin'), state.pack, state.assets);
  state.renderedEls = renderer.render($('canvas'), state.pack, state.assets);
  rebuildOverlay();
  renderInspector();
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

  const move = (e) => {
    const dx = ((e.clientX - startX) / bounds.width) * 100;
    const dy = ((e.clientY - startY) / bounds.height) * 100;
    component.rect[0] = snap(clamp(orig[0] + dx, 0, 100 - orig[2]));
    component.rect[1] = snap(clamp(orig[1] + dy, 0, 100 - orig[3]));
    // Live-move the rendered element + overlay boxes without a full re-render.
    positionByRect(state.renderedEls[index], component.rect);
    positionByRect(hit, component.rect);
    const sel = overlay.querySelector('.sel-box');
    if (sel) positionByRect(sel, component.rect);
  };
  const up = () => {
    hit.removeEventListener('pointermove', move);
    hit.removeEventListener('pointerup', up);
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
    component.rect = [snap(x), snap(y), snap(w), snap(h)];
    positionByRect(state.renderedEls[index], component.rect);
    const sel = overlay.querySelector('.sel-box');
    if (sel) positionByRect(sel, component.rect);
  };
  const up = () => {
    handle.removeEventListener('pointermove', move);
    handle.removeEventListener('pointerup', up);
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
  input.addEventListener('input', () => onChange(Number(input.value)));
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

  if (type === 'clock') {
    panel.append(
      field('Format', selectControl(o.format, [['24h', '24-hour'], ['12h', '12-hour']], set('format'))),
      checkControl('Show seconds', o.seconds, set('seconds')),
      checkControl('Show date', o.showDate, set('showDate')),
    );
  } else if (type === 'analog-clock') {
    panel.append(checkControl('Second hand', o.seconds, set('seconds')));
  } else if (type === 'stats') {
    for (const [bind, label] of BIND_CHOICES) panel.append(checkControl(label, o[bind], set(bind)));
  } else if (type === 'meter' || type === 'sparkline') {
    panel.append(field('Source', selectControl(o.bind, BIND_CHOICES, set('bind'))));
    if (type === 'meter') panel.append(field('Shape', selectControl(o.variant, [['ring', 'Ring'], ['bar', 'Bar']], set('variant'))));
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
  } else if (type === 'divider') {
    panel.append(field('Direction', selectControl(o.orientation, [['h', 'Horizontal'], ['v', 'Vertical']], set('orientation'))));
  } else if (type === 'calendar') {
    panel.append(field('Week starts on', selectControl(o.weekStart, [['mon', 'Monday'], ['sun', 'Sunday']], set('weekStart'))));
  } else if (type === 'countdown') {
    const date = document.createElement('input');
    date.type = 'date';
    date.value = o.target ? o.target.slice(0, 10) : '';
    date.addEventListener('change', () => { o.target = date.value || null; renderAll(); });
    panel.append(field('Target date', date), field('Label', textControl(o.label, (v) => { o.label = v || null; renderAll(); }, 'Countdown')));
  } else if (type === 'weather') {
    panel.append(
      field('Latitude', numberControl(o.lat, -90, 90, 0.0001, set('lat'))),
      field('Longitude', numberControl(o.lon, -180, 180, 0.0001, set('lon'))),
      field('Place label', textControl(o.place, (v) => { o.place = v || null; renderAll(); }, 'Weather')),
    );
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
    field('Glass panel', selectControl(s.panel === null ? '' : String(s.panel), [['', 'inherit'], ['true', 'On'], ['false', 'Off']], (v) => { s.panel = v === '' ? null : v === 'true'; renderAll(); })),
    field('Border', selectControl(s.border === null ? '' : String(s.border), [['', 'inherit'], ['true', 'On'], ['false', 'Off']], (v) => { s.border = v === '' ? null : v === 'true'; renderAll(); })),
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

  panel.appendChild(sectionLabel('Wallpaper'));
  const choices = [['', 'None'], ...Object.keys(state.assets).map((rel) => [rel, rel.replace('assets/', '')])];
  panel.appendChild(field('Image', selectControl(skin.wallpaper || '', choices, (v) => { skin.wallpaper = v || null; renderAll(); })));
  const importBtn = document.createElement('button');
  importBtn.className = 'btn tiny';
  importBtn.textContent = 'Import wallpaper…';
  importBtn.addEventListener('click', async () => {
    const rel = await importImage();
    if (rel) { skin.wallpaper = rel; renderAll(); }
  });
  panel.appendChild(importBtn);
}

function renderPersonaTab(panel) {
  const persona = state.pack.persona;
  panel.append(
    sectionLabel('Persona'),
    field('Name', textControl(persona.name, (v) => { persona.name = v.slice(0, 40) || 'AEGIS'; renderAll(); })),
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

function renderInspector() {
  const panel = $('inspector');
  panel.textContent = '';
  if (state.tab === 'component') renderComponentTab(panel);
  else if (state.tab === 'skin') renderSkinTab(panel);
  else renderPersonaTab(panel);
}

function syncTabs() {
  for (const tab of ['component', 'skin', 'persona']) {
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
  const packId = new URLSearchParams(location.search).get('pack') || 'aegis-holo';
  const loaded = await aegis.packLoad(packId);
  if (!loaded.ok) return setStatus(loaded.error, true);
  const all = await aegis.assetsAll(packId);

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
  $('btn-save').addEventListener('click', () => save(false));
  $('btn-save-apply').addEventListener('click', () => save(true));
  $('btn-import-image').addEventListener('click', importImageAsComponent);

  renderAll();
  setStatus('Drag components from the palette. Click to select, arrow keys to nudge, Delete to remove.');
}

init().catch((err) => setStatus(`The editor failed to start: ${err.message}`, true));
