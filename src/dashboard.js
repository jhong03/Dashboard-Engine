'use strict';

// Dashboard renderer: turns a sanitized Persona Pack into CSS custom
// properties and widget DOM. Packs never inject CSS or markup — every token
// arrives pre-clamped from lib/packs.js, and everything rendered here is
// created with textContent, never innerHTML.

/* global aegis */

const $ = (id) => document.getElementById(id);

// Built-in font stacks — the only typography a pack can choose from.
const FONT_STACKS = {
  'rajdhani': "'Rajdhani', 'Segoe UI', sans-serif",
  'system-sans': "'Segoe UI', system-ui, sans-serif",
  'system-serif': "Georgia, 'Times New Roman', serif",
  'mono': "'Share Tech Mono', Consolas, monospace",
};

const state = {
  packId: null,
  timers: [],       // widget intervals, cleared on every re-render
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

// ── Skin application ────────────────────────────────────────────────────────

function applySkin(pack, wallpaper) {
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
  root.setProperty('--gap', `${pack.layout.gap}px`);
  root.setProperty('--ls', `${typography.letterSpacing}em`);
  root.setProperty('--font-display', FONT_STACKS[typography.display]);

  document.body.classList.toggle('uppercase', typography.uppercase);
  document.body.classList.toggle('notches', shape.cornerNotches);
  document.body.style.backgroundImage = wallpaper ? `url(${wallpaper})` : 'none';
}

// ── Widgets ─────────────────────────────────────────────────────────────────

function widgetShell(widget) {
  const el = document.createElement('section');
  el.className = `widget widget-${widget.type}`;
  const [col, row, spanC, spanR] = widget.area;
  el.style.gridColumn = `${col} / span ${spanC}`;
  el.style.gridRow = `${row} / span ${spanR}`;
  return el;
}

function buildClock(widget, el) {
  const label = document.createElement('span');
  label.className = 'widget-label';
  label.textContent = 'Local time';
  const time = document.createElement('div');
  time.className = 'clock-time';
  const date = document.createElement('div');
  date.className = 'clock-date display-case';
  el.append(label, time);
  if (widget.options.showDate) el.append(date);

  const tick = () => {
    const now = new Date();
    let hours = now.getHours();
    let suffix = '';
    if (widget.options.format === '12h') {
      suffix = hours >= 12 ? ' PM' : ' AM';
      hours = hours % 12 || 12;
    }
    const parts = [String(hours).padStart(2, '0'), String(now.getMinutes()).padStart(2, '0')];
    if (widget.options.seconds) parts.push(String(now.getSeconds()).padStart(2, '0'));
    time.textContent = parts.join(':') + suffix;
    if (widget.options.showDate) {
      date.textContent = now.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    }
  };
  tick();
  state.timers.push(setInterval(tick, 250));
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

function buildStats(widget, el) {
  const label = document.createElement('span');
  label.className = 'widget-label';
  label.textContent = 'System telemetry';
  el.appendChild(label);

  const cpu = widget.options.cpu ? statRow('CPU') : null;
  const mem = widget.options.mem ? statRow('MEM') : null;
  if (cpu) el.appendChild(cpu.row);
  if (mem) el.appendChild(mem.row);

  const gb = (bytes) => (bytes / 2 ** 30).toFixed(1);
  const update = async () => {
    const res = await aegis.stats();
    if (!res.ok) return;
    if (cpu) {
      cpu.fill.style.width = `${res.cpuPercent}%`;
      cpu.fill.classList.toggle('hot', res.cpuPercent >= 85);
      cpu.value.textContent = `${res.cpuPercent} %`;
    }
    if (mem) {
      const pct = Math.round((res.memUsedBytes / res.memTotalBytes) * 100);
      mem.fill.style.width = `${pct}%`;
      mem.fill.classList.toggle('hot', pct >= 90);
      mem.value.textContent = `${gb(res.memUsedBytes)} / ${gb(res.memTotalBytes)} GB`;
    }
  };
  update();
  state.timers.push(setInterval(update, 2000));
}

function buildStatus(pack, el) {
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

function renderWidgets(pack) {
  for (const timer of state.timers) clearInterval(timer);
  state.timers = [];

  const grid = $('grid');
  grid.textContent = '';
  for (const widget of pack.layout.widgets) {
    const el = widgetShell(widget);
    if (widget.type === 'clock') buildClock(widget, el);
    else if (widget.type === 'stats') buildStats(widget, el);
    else if (widget.type === 'status') buildStatus(pack, el);
    grid.appendChild(el);
  }
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
  applySkin(res.pack, res.wallpaper);
  renderWidgets(res.pack);

  $('persona-name').textContent = res.pack.persona.name;
  $('persona-tagline').textContent = res.pack.persona.tagline;
  document.title = `${res.pack.persona.name} — ${res.pack.name}`;
  $('pack-select').value = res.pack.id;

  const foot = $('foot');
  if (res.warnings.length > 0) {
    foot.textContent = `PACK WARNINGS: ${res.warnings.join(' · ')}`;
    foot.className = 'mono foot warn';
  } else {
    foot.textContent = `PACK ${res.pack.id} · ${res.pack.layout.widgets.length} WIDGETS · EDIT packs/${res.pack.id}/pack.json TO RESKIN LIVE`;
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
