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
    foot.textContent = `PACK ${res.pack.id} · ${res.pack.components.length} COMPONENTS · EDIT packs/${res.pack.id}/pack.json TO RESKIN LIVE`;
    foot.className = 'mono foot';
  }
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

  // Hot reload: main watches the active pack dir and pings on changes.
  state.unsubscribe = aegis.onPackChanged((data) => {
    if (data.id === state.packId) loadPack(state.packId);
  });

  const requested = new URLSearchParams(location.search).get('pack');
  const first =
    listed.packs.find((p) => p.id === requested) ||
    listed.packs.find((p) => p.id === 'aegis-holo') ||
    listed.packs[0];
  if (!first) {
    $('foot').textContent = 'NO PACKS INSTALLED — add one under packs/<id>/pack.json';
    $('foot').className = 'mono foot warn';
    return;
  }
  await loadPack(first.id);
}

init().catch((err) => {
  $('foot').textContent = `DASHBOARD FAILED TO INITIALISE: ${err.message}`;
  $('foot').className = 'mono foot warn';
});
