'use strict';

// Dashboard renderer: turns a sanitized Persona Pack into CSS custom
// properties and component DOM on a free-form percent canvas. Packs never
// inject CSS or markup — every token arrives pre-clamped from lib/packs.js,
// everything here is created with textContent (never innerHTML), and image
// sources are data URIs prepared by the main process.

/* global aegis */

const $ = (id) => document.getElementById(id);

// Built-in font stacks — the only typography a pack can choose from.
const FONT_STACKS = {
  'rajdhani': "'Rajdhani', 'Segoe UI', sans-serif",
  'system-sans': "'Segoe UI', system-ui, sans-serif",
  'system-serif': "Georgia, 'Times New Roman', serif",
  'mono': "'Share Tech Mono', Consolas, monospace",
};

// Telemetry history depth for sparklines: 90 samples at 2 s = 3 minutes.
const HISTORY_LENGTH = 90;
const TELEMETRY_INTERVAL_MS = 2000;

const state = {
  packId: null,
  pack: null,
  timers: [],
  observers: [],
  telemetry: {
    subscribers: [],                 // update callbacks fed by one shared loop
    history: { cpu: [], mem: [] },   // rolling 0–100 series
  },
  unsubscribe: null,
};

// ── Colour helpers (tokens are validated hex; alpha comes from knobs) ──────

function hexToRgbParts(hex) {
  let h = hex.slice(1);
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
}

function rgba(hex, alpha) {
  const [r, g, b] = hexToRgbParts(hex);
  return `rgba(${r}, ${g}, ${b}, ${Math.max(0, Math.min(1, alpha)).toFixed(3)})`;
}

// ── Skin application (global tokens) ────────────────────────────────────────

function applySkin(pack, assets) {
  const { palette, typography, texture, shape } = pack.skin;
  const root = document.documentElement.style;

  root.setProperty('--void', palette.void);
  root.setProperty('--accent', palette.accent);
  root.setProperty('--accent-bright', palette.accentBright);
  root.setProperty('--muted', palette.muted);
  root.setProperty('--warn', palette.warn);
  root.setProperty('--gold', palette.gold);

  root.setProperty('--panel-bg', rgba(palette.glass, shape.panelOpacity));
  root.setProperty('--hairline', rgba(palette.accent, shape.borderOpacity));
  root.setProperty('--hairline-dim', rgba(palette.accent, shape.borderOpacity * 0.5));
  root.setProperty('--glow', rgba(palette.accent, 0.45 * texture.glow));
  root.setProperty('--glow-wash', rgba(palette.accent, 0.14 * texture.glow));
  root.setProperty('--scan-ink', rgba('#000000', 0.5 * texture.scanlines));
  root.setProperty('--grid-ink', rgba(palette.accent, 0.12 * texture.grid));
  root.setProperty('--vignette-ink', rgba('#000000', 0.85 * texture.vignette));

  root.setProperty('--radius', `${shape.radius}px`);
  root.setProperty('--ls', `${typography.letterSpacing}em`);
  root.setProperty('--font-display', FONT_STACKS[typography.display]);

  document.body.classList.toggle('uppercase', typography.uppercase);
  document.body.classList.toggle('notches', shape.cornerNotches);
  document.body.style.backgroundImage =
    pack.skin.wallpaper && assets[pack.skin.wallpaper] ? `url(${assets[pack.skin.wallpaper]})` : 'none';
}

// Per-component overrides become element-scoped CSS custom properties, so
// the same stylesheet serves both the skin default and the local override.
function applyComponentStyle(el, style, pack) {
  const accent = style.accent || pack.skin.palette.accent;
  if (style.accent) {
    el.style.setProperty('--accent', style.accent);
    el.style.setProperty('--glow', rgba(style.accent, 0.45 * pack.skin.texture.glow));
    el.style.setProperty('--hairline', rgba(style.accent, pack.skin.shape.borderOpacity));
    el.style.setProperty('--hairline-dim', rgba(style.accent, pack.skin.shape.borderOpacity * 0.5));
  }
  if (style.glow !== null) {
    el.style.setProperty('--glow', rgba(accent, 0.45 * style.glow));
  }
  if (style.textColor) el.style.setProperty('--accent-bright', style.textColor);
  if (style.font) el.style.setProperty('--font-display', FONT_STACKS[style.font]);
  if (style.fontScale !== null) el.style.setProperty('--font-scale', String(style.fontScale));
  if (style.align) el.style.textAlign = style.align;
  if (style.opacity !== null) el.style.opacity = String(style.opacity);
  if (style.padding !== null) el.style.padding = `${style.padding}px`;
  if (style.rotate !== null) el.style.transform = `rotate(${style.rotate}deg)`;

  const panel = style.panel !== null ? style.panel : true;
  el.classList.toggle('panel', panel);
  const border = style.border !== null ? style.border : panel;
  el.classList.toggle('borderless', !border);
  if (style.notches !== null) el.classList.toggle('no-notches', !style.notches);
}

// ── Shared telemetry loop ───────────────────────────────────────────────────

function startTelemetry() {
  if (state.telemetry.subscribers.length === 0) return;
  const tick = async () => {
    const res = await aegis.stats();
    if (!res.ok) return;
    const values = {
      cpu: res.cpuPercent,
      mem: Math.round((res.memUsedBytes / res.memTotalBytes) * 100),
      memText: `${(res.memUsedBytes / 2 ** 30).toFixed(1)} / ${(res.memTotalBytes / 2 ** 30).toFixed(1)} GB`,
    };
    for (const key of ['cpu', 'mem']) {
      const series = state.telemetry.history[key];
      series.push(values[key]);
      if (series.length > HISTORY_LENGTH) series.shift();
    }
    for (const update of state.telemetry.subscribers) update(values);
  };
  tick();
  state.timers.push(setInterval(tick, TELEMETRY_INTERVAL_MS));
}

// Canvas-backed components redraw on resize; one observer per canvas.
function observeCanvas(canvas, draw) {
  const observer = new ResizeObserver(() => {
    canvas.width = Math.max(1, canvas.clientWidth * devicePixelRatio);
    canvas.height = Math.max(1, canvas.clientHeight * devicePixelRatio);
    draw();
  });
  observer.observe(canvas);
  state.observers.push(observer);
}

function cssVar(el, name) {
  return getComputedStyle(el).getPropertyValue(name).trim();
}

// ── Component builders ──────────────────────────────────────────────────────

function buildStatus(component, el, pack) {
  const name = document.createElement('div');
  name.className = 'status-name';
  name.textContent = pack.persona.name;
  const tagline = document.createElement('div');
  tagline.className = 'status-tagline display-case';
  tagline.textContent = pack.persona.tagline;
  const line = document.createElement('div');
  line.className = 'status-line';
  el.append(name, tagline, line);

  const lines = pack.persona.lines;
  if (lines.length === 0) return;
  let index = 0;
  line.textContent = lines[0];
  if (lines.length > 1) {
    state.timers.push(setInterval(() => {
      index = (index + 1) % lines.length;
      line.textContent = lines[index];
    }, 4000));
  }
}

function buildClock(component, el) {
  const time = document.createElement('div');
  time.className = 'clock-time';
  const date = document.createElement('div');
  date.className = 'clock-date display-case';
  el.append(time);
  if (component.options.showDate) el.append(date);

  const tick = () => {
    const now = new Date();
    let hours = now.getHours();
    let suffix = '';
    if (component.options.format === '12h') {
      suffix = hours >= 12 ? ' PM' : ' AM';
      hours = hours % 12 || 12;
    }
    const parts = [String(hours).padStart(2, '0'), String(now.getMinutes()).padStart(2, '0')];
    if (component.options.seconds) parts.push(String(now.getSeconds()).padStart(2, '0'));
    time.textContent = parts.join(':') + suffix;
    if (component.options.showDate) {
      date.textContent = now.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    }
  };
  tick();
  state.timers.push(setInterval(tick, 250));
}

function buildAnalogClock(component, el) {
  const canvas = document.createElement('canvas');
  canvas.className = 'fill-canvas';
  el.appendChild(canvas);

  const draw = () => {
    const ctx = canvas.getContext('2d');
    const w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    const cx = w / 2, cy = h / 2;
    const radius = Math.min(w, h) / 2 - 6 * devicePixelRatio;
    if (radius <= 0) return;

    const accent = cssVar(el, '--accent');
    const bright = cssVar(el, '--accent-bright');
    const hairline = cssVar(el, '--hairline');
    const gold = cssVar(el, '--gold');

    ctx.lineWidth = 1 * devicePixelRatio;
    ctx.strokeStyle = hairline;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.stroke();

    // Hour ticks
    ctx.strokeStyle = accent;
    for (let i = 0; i < 12; i++) {
      const angle = (i / 12) * Math.PI * 2;
      const inner = i % 3 === 0 ? radius * 0.86 : radius * 0.92;
      ctx.beginPath();
      ctx.moveTo(cx + Math.sin(angle) * inner, cy - Math.cos(angle) * inner);
      ctx.lineTo(cx + Math.sin(angle) * radius * 0.97, cy - Math.cos(angle) * radius * 0.97);
      ctx.stroke();
    }

    const now = new Date();
    const seconds = now.getSeconds() + now.getMilliseconds() / 1000;
    const minutes = now.getMinutes() + seconds / 60;
    const hours = (now.getHours() % 12) + minutes / 60;

    const hand = (angle, length, width, colour) => {
      ctx.strokeStyle = colour;
      ctx.lineWidth = width * devicePixelRatio;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.sin(angle) * length, cy - Math.cos(angle) * length);
      ctx.stroke();
    };
    hand((hours / 12) * Math.PI * 2, radius * 0.5, 3, bright);
    hand((minutes / 60) * Math.PI * 2, radius * 0.72, 2, accent);
    if (component.options.seconds) hand((seconds / 60) * Math.PI * 2, radius * 0.8, 1, gold);

    ctx.fillStyle = accent;
    ctx.beginPath();
    ctx.arc(cx, cy, 3 * devicePixelRatio, 0, Math.PI * 2);
    ctx.fill();
  };

  observeCanvas(canvas, draw);
  state.timers.push(setInterval(draw, component.options.seconds ? 100 : 1000));
}

function statRow(name) {
  const row = document.createElement('div');
  row.className = 'stat-row';
  const label = document.createElement('span');
  label.className = 'stat-name';
  label.textContent = name;
  const bar = document.createElement('div');
  bar.className = 'stat-bar';
  const fill = document.createElement('span');
  bar.appendChild(fill);
  const value = document.createElement('span');
  value.className = 'stat-value';
  value.textContent = '—';
  row.append(label, bar, value);
  return { row, fill, value };
}

function buildStats(component, el) {
  const cpu = component.options.cpu ? statRow('CPU') : null;
  const mem = component.options.mem ? statRow('MEM') : null;
  if (cpu) el.appendChild(cpu.row);
  if (mem) el.appendChild(mem.row);

  state.telemetry.subscribers.push((values) => {
    if (cpu) {
      cpu.fill.style.width = `${values.cpu}%`;
      cpu.fill.classList.toggle('hot', values.cpu >= 85);
      cpu.value.textContent = `${values.cpu} %`;
    }
    if (mem) {
      mem.fill.style.width = `${values.mem}%`;
      mem.fill.classList.toggle('hot', values.mem >= 90);
      mem.value.textContent = values.memText;
    }
  });
}

function buildMeter(component, el) {
  const bind = component.options.bind;
  const label = document.createElement('span');
  label.className = 'comp-label';
  label.textContent = component.options.label || bind.toUpperCase();

  if (component.options.variant === 'bar') {
    const { row, fill, value } = statRow(component.options.label || bind.toUpperCase());
    row.querySelector('.stat-name').remove();
    row.style.gridTemplateColumns = '1fr 76px';
    el.append(label, row);
    state.telemetry.subscribers.push((values) => {
      fill.style.width = `${values[bind]}%`;
      fill.classList.toggle('hot', values[bind] >= 85);
      value.textContent = bind === 'mem' ? values.memText : `${values[bind]} %`;
    });
    return;
  }

  // Ring: canvas arc + centred value.
  const wrap = document.createElement('div');
  wrap.className = 'ring-wrap';
  const canvas = document.createElement('canvas');
  canvas.className = 'fill-canvas';
  const value = document.createElement('span');
  value.className = 'ring-value';
  value.textContent = '—';
  wrap.append(canvas, value);
  el.append(label, wrap);

  let current = 0;
  const draw = () => {
    const ctx = canvas.getContext('2d');
    const w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    const cx = w / 2, cy = h / 2;
    const radius = Math.min(w, h) / 2 - 8 * devicePixelRatio;
    if (radius <= 0) return;
    const start = -Math.PI / 2;

    ctx.lineWidth = 5 * devicePixelRatio;
    ctx.lineCap = 'round';
    ctx.strokeStyle = cssVar(el, '--hairline-dim');
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.stroke();

    ctx.strokeStyle = current >= 85 ? cssVar(el, '--warn') : cssVar(el, '--accent');
    ctx.beginPath();
    ctx.arc(cx, cy, radius, start, start + (current / 100) * Math.PI * 2);
    ctx.stroke();
  };

  observeCanvas(canvas, draw);
  state.telemetry.subscribers.push((values) => {
    current = values[bind];
    value.textContent = `${current}%`;
    draw();
  });
}

function buildSparkline(component, el) {
  const bind = component.options.bind;
  const label = document.createElement('span');
  label.className = 'comp-label';
  label.textContent = component.options.label || `${bind.toUpperCase()} HISTORY`;
  const canvas = document.createElement('canvas');
  canvas.className = 'fill-canvas spark';
  el.append(label, canvas);

  const draw = () => {
    const ctx = canvas.getContext('2d');
    const w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    const series = state.telemetry.history[bind];
    if (series.length < 2) return;
    const accent = cssVar(el, '--accent');
    const step = w / (HISTORY_LENGTH - 1);
    const yFor = (v) => h - (v / 100) * (h - 4 * devicePixelRatio) - 2 * devicePixelRatio;

    // Filled area, then the line on top.
    const startX = w - (series.length - 1) * step;
    ctx.beginPath();
    ctx.moveTo(startX, h);
    series.forEach((v, i) => ctx.lineTo(startX + i * step, yFor(v)));
    ctx.lineTo(w, h);
    ctx.closePath();
    ctx.fillStyle = cssVar(el, '--glow-wash');
    ctx.fill();

    ctx.beginPath();
    series.forEach((v, i) => {
      const x = startX + i * step;
      if (i === 0) ctx.moveTo(x, yFor(v));
      else ctx.lineTo(x, yFor(v));
    });
    ctx.strokeStyle = accent;
    ctx.lineWidth = 1.5 * devicePixelRatio;
    ctx.stroke();
  };

  observeCanvas(canvas, draw);
  state.telemetry.subscribers.push(() => draw());
}

function buildText(component, el) {
  const text = document.createElement('div');
  text.className = 'text-body display-case';
  text.textContent = component.options.text;
  el.appendChild(text);
}

function buildImage(component, el, assets) {
  const uri = assets[component.options.src];
  if (!uri) return; // asset missing — warning already surfaced by main
  const img = document.createElement('img');
  img.className = `image-body fit-${component.options.fit}`;
  img.alt = '';
  img.src = uri;
  el.appendChild(img);
}

function buildDivider(component, el) {
  // The line is a real child, not a pseudo-element — the corner-notch
  // decorations own ::before/::after on components.
  el.classList.add(`divider-${component.options.orientation}`);
  const line = document.createElement('span');
  line.className = 'divider-line';
  el.appendChild(line);
}

const BUILDERS = {
  status: buildStatus,
  clock: buildClock,
  'analog-clock': buildAnalogClock,
  stats: buildStats,
  meter: buildMeter,
  sparkline: buildSparkline,
  text: buildText,
  divider: buildDivider,
};

// ── Canvas render ───────────────────────────────────────────────────────────

function renderComponents(pack, assets) {
  for (const timer of state.timers) clearInterval(timer);
  for (const observer of state.observers) observer.disconnect();
  state.timers = [];
  state.observers = [];
  state.telemetry.subscribers = [];

  const canvas = $('canvas');
  canvas.textContent = '';
  canvas.style.inset = `${pack.canvas.padding}%`;

  for (const component of pack.components) {
    const el = document.createElement('section');
    el.className = `comp comp-${component.type}`;
    const [x, y, w, h] = component.rect;
    el.style.left = `${x}%`;
    el.style.top = `${y}%`;
    el.style.width = `${w}%`;
    el.style.height = `${h}%`;
    el.style.zIndex = String(component.z);
    applyComponentStyle(el, component.style, pack);

    if (component.type === 'image') buildImage(component, el, assets);
    else BUILDERS[component.type](component, el, pack);
    canvas.appendChild(el);
  }
  startTelemetry();
}

// ── Pack loading ────────────────────────────────────────────────────────────

async function loadPack(id) {
  const res = await aegis.packLoad(id);
  if (!res.ok) {
    $('foot').textContent = res.error;
    $('foot').className = 'mono foot warn';
    return;
  }
  state.packId = res.pack.id;
  state.pack = res.pack;
  applySkin(res.pack, res.assets);
  renderComponents(res.pack, res.assets);

  $('persona-name').textContent = res.pack.persona.name;
  $('persona-tagline').textContent = res.pack.persona.tagline;
  document.title = `${res.pack.persona.name} — ${res.pack.name}`;
  $('pack-select').value = res.pack.id;

  const foot = $('foot');
  if (res.warnings.length > 0) {
    foot.textContent = `PACK WARNINGS: ${res.warnings.join(' · ')}`;
    foot.className = 'mono foot warn';
  } else {
    const hint = res.origin === 'builtin'
      ? `EDIT packs/${res.pack.id}/pack.json TO RESKIN LIVE`
      : 'INSTALLED PACK · MANAGED IN THE LIBRARY · HOT-RELOADS IF EDITED';
    foot.textContent = `PACK ${res.pack.id} · ${res.pack.components.length} COMPONENTS · ${hint}`;
    foot.className = 'mono foot';
  }
}

// ── Pack library: gallery + detail sidebar (Wallpaper Engine-style) ─────────

const library = {
  tab: 'installed',
  search: '',
  localPacks: [],
  registries: [],
  indexes: new Map(),   // registry url → fetched index (or {ok:false})
  selected: null,       // { kind: 'local', item } | { kind: 'remote', url, entry }
};

function libStatus(text, warn) {
  const el = $('library-status');
  el.textContent = text || '';
  el.className = `mono library-status${warn ? ' warn' : ''}`;
}

function libButton(label, onClick, kind) {
  const btn = document.createElement('button');
  btn.className = `btn${kind ? ` ${kind}` : ''}`;
  btn.textContent = label;
  btn.addEventListener('click', onClick);
  return btn;
}

async function refreshPackSelect() {
  const listed = await aegis.packsList();
  const select = $('pack-select');
  select.textContent = '';
  for (const pack of listed.packs) {
    const option = document.createElement('option');
    option.value = pack.id;
    option.textContent = pack.name;
    select.appendChild(option);
  }
  if (state.packId) select.value = state.packId;
}

// Blueprint thumbnail: the pack's palette + component rects drawn as glass
// boxes. Cheap, needs no assets, and honestly previews the layout.
function blueprintInto(container, pack) {
  const palette = pack.skin.palette;
  container.style.background =
    `radial-gradient(120% 90% at 50% 0%, ${rgba(palette.accent, 0.12)}, transparent 60%), ${palette.void}`;
  for (const component of pack.components) {
    const box = document.createElement('div');
    box.className = 'bp-comp';
    const [x, y, w, h] = component.rect;
    box.style.left = `${x}%`;
    box.style.top = `${y}%`;
    box.style.width = `${w}%`;
    box.style.height = `${h}%`;
    const accent = component.style.accent || palette.accent;
    const panel = component.style.panel !== null ? component.style.panel : true;
    box.style.borderColor = rgba(accent, 0.55);
    box.style.background = panel ? rgba(palette.glass, 0.45) : 'transparent';
    container.appendChild(box);
  }
}

function monogramInto(container, name) {
  container.style.background = 'radial-gradient(120% 90% at 50% 0%, rgba(255,255,255,0.05), transparent 60%), rgba(0,0,0,0.5)';
  const letter = document.createElement('div');
  letter.style.cssText = 'position:absolute;inset:0;display:grid;place-items:center;font-size:2.2rem;font-weight:700;opacity:0.35;';
  letter.textContent = (name || '?').slice(0, 1).toUpperCase();
  container.appendChild(letter);
}

function makeCard({ name, badge, selected, buildThumb, onSelect }) {
  const card = document.createElement('button');
  card.type = 'button';
  card.className = 'card';
  card.setAttribute('aria-pressed', String(selected));
  const thumb = document.createElement('div');
  thumb.className = 'thumb';
  buildThumb(thumb);
  const label = document.createElement('span');
  label.className = 'card-name';
  label.textContent = name;
  card.append(thumb, label);
  if (badge) {
    const badgeEl = document.createElement('span');
    badgeEl.className = 'badge';
    badgeEl.textContent = badge;
    card.appendChild(badgeEl);
  }
  card.addEventListener('click', onSelect);
  return card;
}

function sectionLabel(text, buttons = []) {
  const el = document.createElement('div');
  el.className = 'section-label';
  const span = document.createElement('span');
  span.textContent = text;
  el.append(span, ...buttons);
  return el;
}

function matchesSearch(text) {
  return text.toLowerCase().includes(library.search.toLowerCase());
}

function isSelected(kind, key) {
  const s = library.selected;
  if (!s || s.kind !== kind) return false;
  return kind === 'local' ? s.item.id === key : `${s.url}|${s.entry.id}` === key;
}

function renderGallery() {
  const gallery = $('gallery');
  gallery.textContent = '';
  $('reg-add').classList.toggle('hidden', library.tab !== 'browse');
  $('tab-installed').setAttribute('aria-selected', String(library.tab === 'installed'));
  $('tab-browse').setAttribute('aria-selected', String(library.tab === 'browse'));

  if (library.tab === 'installed') {
    for (const origin of ['installed', 'builtin']) {
      const items = library.localPacks.filter((p) => p.origin === origin && matchesSearch(p.name + p.id + (p.author || '')));
      gallery.appendChild(sectionLabel(origin === 'installed' ? 'INSTALLED' : 'BUILT-IN REFERENCE'));
      if (items.length === 0 && origin === 'installed') {
        const empty = document.createElement('p');
        empty.className = 'lib-meta';
        empty.style.gridColumn = '1 / -1';
        empty.textContent = 'Nothing installed yet — BROWSE a registry or INSTALL FROM FILE.';
        gallery.appendChild(empty);
      }
      for (const item of items) {
        gallery.appendChild(makeCard({
          name: item.name,
          badge: item.id === state.packId ? 'ACTIVE' : (origin === 'builtin' ? 'BUILT-IN' : null),
          selected: isSelected('local', item.id),
          buildThumb: (thumb) => blueprintInto(thumb, item.pack),
          onSelect: () => { library.selected = { kind: 'local', item }; renderGallery(); renderDetail(); },
        }));
      }
    }
    return;
  }

  // Browse tab: one section per subscribed registry.
  if (library.registries.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'lib-meta';
    empty.style.gridColumn = '1 / -1';
    empty.textContent = 'No registries yet. Anyone can host one — a static index.json anywhere https (see PACKS.md).';
    gallery.appendChild(empty);
  }
  for (const url of library.registries) {
    const index = library.indexes.get(url);
    const refresh = libButton('REFRESH', () => browseRegistry(url));
    const remove = libButton('REMOVE', async () => {
      await aegis.registryRemove(url);
      await openLibrary();
    }, 'danger');
    gallery.appendChild(sectionLabel(index && index.ok ? `${index.name} — ${url}` : url, [refresh, remove]));

    if (!index) continue; // still fetching
    if (!index.ok) {
      const err = document.createElement('p');
      err.className = 'lib-meta';
      err.style.gridColumn = '1 / -1';
      err.textContent = index.error;
      gallery.appendChild(err);
      continue;
    }
    for (const entry of index.packs.filter((e) => matchesSearch(e.name + e.id + e.author + e.description))) {
      const update = index.updates.find((u) => u.id === entry.id);
      gallery.appendChild(makeCard({
        name: entry.name,
        badge: update ? 'UPDATE' : entry.installed ? 'INSTALLED' : null,
        selected: isSelected('remote', `${url}|${entry.id}`),
        buildThumb: (thumb) => monogramInto(thumb, entry.name),
        onSelect: () => { library.selected = { kind: 'remote', url, entry, update }; renderGallery(); renderDetail(); },
      }));
    }
  }
}

function detailLine(text) {
  const el = document.createElement('p');
  el.className = 'detail-line';
  el.textContent = text;
  return el;
}

async function renderDetail() {
  const detail = $('lib-detail');
  detail.textContent = '';
  const s = library.selected;
  if (!s) {
    const empty = document.createElement('p');
    empty.className = 'lib-meta';
    empty.textContent = 'Select a pack to see its details.';
    detail.appendChild(empty);
    return;
  }

  const preview = document.createElement('div');
  preview.className = 'detail-preview';
  const name = document.createElement('h3');
  name.className = 'detail-name';

  if (s.kind === 'local') {
    const { item } = s;
    blueprintInto(preview, item.pack);
    name.textContent = item.name;
    detail.append(preview, name);
    const meta = item.meta || {};
    detail.appendChild(detailLine(`${item.id}${meta.version ? ' · v' + meta.version : ''} · ${item.origin === 'builtin' ? 'built-in reference' : meta.source === 'file' ? 'installed from file' : meta.source || 'installed'}`));
    detail.appendChild(detailLine(`${item.pack.components.length} components · ${item.pack.persona.name}`));

    const swatches = document.createElement('div');
    swatches.className = 'swatches';
    for (const key of ['void', 'glass', 'accent', 'accentBright', 'muted', 'gold']) {
      const sw = document.createElement('span');
      sw.className = 'swatch';
      sw.style.background = item.pack.skin.palette[key];
      sw.title = key;
      swatches.appendChild(sw);
    }
    detail.appendChild(swatches);

    detail.appendChild(libButton('USE THIS PACK', async () => {
      await loadPack(item.id);
      libStatus(`NOW SHOWING ${item.name.toUpperCase()}`);
      renderGallery();
    }, 'primary'));
    detail.appendChild(libButton('EXPORT .AEGISPACK', async () => {
      const out = await aegis.exportPack(item.id);
      libStatus(out.ok ? `EXPORTED -> ${out.file}` : out.error || '', !out.ok && out.error);
    }));
    if (item.origin === 'installed') {
      detail.appendChild(libButton('UNINSTALL', async () => {
        const out = await aegis.uninstallPack(item.id);
        libStatus(out.ok ? `UNINSTALLED ${item.id}` : out.error, !out.ok);
        library.selected = null;
        await openLibrary();
        await refreshPackSelect();
      }, 'danger'));
    }
    return;
  }

  // Remote entry
  const { url, entry, update } = s;
  monogramInto(preview, entry.name);
  name.textContent = entry.name;
  detail.append(preview, name);
  detail.appendChild(detailLine(`${entry.id} · v${entry.version} · by ${entry.author || 'unknown'}`));
  detail.appendChild(detailLine(`${(entry.sizeBytes / 1024).toFixed(0)} KB · ${url}`));
  if (entry.description) {
    const desc = document.createElement('p');
    desc.className = 'detail-desc';
    desc.textContent = entry.description;
    detail.appendChild(desc);
  }
  const label = update ? `UPDATE TO v${update.to}` : entry.installed ? 'REINSTALL' : 'INSTALL';
  detail.appendChild(libButton(label, async () => {
    libStatus(`INSTALLING ${entry.name}…`);
    const out = await aegis.registryInstall(url, entry.id);
    libStatus(out.ok ? `INSTALLED ${entry.name} v${entry.version} — CHECKSUM VERIFIED` : out.error, !out.ok);
    if (out.ok) {
      await openLibrary();
      await refreshPackSelect();
    }
  }, 'primary'));

  // Designer-hosted preview image, fetched through main (CSP: renderer never
  // touches remote hosts). Swaps in over the monogram when it arrives.
  if (entry.preview) {
    const res = await aegis.registryPreview(entry.preview);
    if (res.ok && library.selected === s) {
      preview.textContent = '';
      preview.style.background = 'none';
      const img = document.createElement('img');
      img.alt = '';
      img.src = res.uri;
      preview.appendChild(img);
    }
  }
}

async function browseRegistry(url) {
  libStatus('FETCHING REGISTRY…');
  const index = await aegis.registryBrowse(url);
  library.indexes.set(url, index);
  if (index.ok) {
    libStatus(`${index.name} — ${index.packs.length} PACK(S)${index.updates.length ? ` · ${index.updates.length} UPDATE(S) AVAILABLE` : ''}`);
  } else {
    libStatus(index.error, true);
  }
  // The sidebar never sits empty: first browse result selects itself.
  if (index.ok && index.packs.length > 0 && library.tab === 'browse' && !library.selected) {
    const entry = index.packs[0];
    library.selected = { kind: 'remote', url, entry, update: index.updates.find((u) => u.id === entry.id) };
    renderDetail();
  }
  renderGallery();
}

async function openLibrary() {
  $('library').classList.remove('hidden');
  const res = await aegis.libraryState();
  if (!res.ok) return libStatus(res.error, true);
  library.localPacks = res.packs;
  library.registries = res.registries;
  // The sidebar never sits empty: default to the first installed (or any) pack.
  if (!library.selected && library.tab === 'installed' && library.localPacks.length > 0) {
    const first = library.localPacks.find((p) => p.origin === 'installed') || library.localPacks[0];
    library.selected = { kind: 'local', item: first };
  }
  renderGallery();
  renderDetail();
  for (const url of library.registries) {
    if (!library.indexes.has(url)) browseRegistry(url);
  }
}

function wireLibrary() {
  $('btn-library').addEventListener('click', () => { libStatus(''); openLibrary(); });
  $('btn-library-close').addEventListener('click', () => $('library').classList.add('hidden'));
  $('tab-installed').addEventListener('click', () => { library.tab = 'installed'; renderGallery(); });
  $('tab-browse').addEventListener('click', () => { library.tab = 'browse'; renderGallery(); });
  $('lib-search').addEventListener('input', (e) => { library.search = e.target.value; renderGallery(); });
  $('btn-install-file').addEventListener('click', async () => {
    const out = await aegis.installFile();
    if (out.error === null && !out.ok) return; // user cancelled the dialog
    libStatus(out.ok ? `INSTALLED "${out.id}"` : out.error, !out.ok);
    if (out.ok) {
      await openLibrary();
      await refreshPackSelect();
    }
  });
  $('btn-reg-add').addEventListener('click', async () => {
    const input = $('reg-url');
    const out = await aegis.registryAdd(input.value);
    libStatus(out.ok ? 'REGISTRY SUBSCRIBED' : out.error, !out.ok);
    if (out.ok) {
      input.value = '';
      await openLibrary();
    }
  });
}

async function init() {
  const listed = await aegis.packsList();
  const select = $('pack-select');
  for (const pack of listed.packs) {
    const option = document.createElement('option');
    option.value = pack.id;
    option.textContent = pack.name;
    select.appendChild(option);
  }
  select.addEventListener('change', () => loadPack(select.value));
  $('btn-panel').addEventListener('click', () => aegis.openPanel());
  wireLibrary();

  // Hot reload: main watches the active pack dir and pings on changes.
  state.unsubscribe = aegis.onPackChanged((data) => {
    if (data.id === state.packId) loadPack(state.packId);
  });

  const params = new URLSearchParams(location.search);
  const requested = params.get('pack');
  const first =
    listed.packs.find((p) => p.id === requested) ||
    listed.packs.find((p) => p.id === 'aegis-holo') ||
    listed.packs[0];
  if (!first) {
    $('foot').textContent = 'NO PACKS INSTALLED — open the LIBRARY to get some';
    $('foot').className = 'mono foot warn';
    return;
  }
  await loadPack(first.id);

  // Deep link (also the screenshot/test hook): AEGIS_VIEW=library|browse
  // opens the library (optionally straight onto the browse tab).
  const view = params.get('view');
  if (view === 'library' || view === 'browse') {
    if (view === 'browse') library.tab = 'browse';
    await openLibrary();
  }
}

init().catch((err) => {
  $('foot').textContent = `DASHBOARD FAILED TO INITIALISE: ${err.message}`;
  $('foot').className = 'mono foot warn';
});
