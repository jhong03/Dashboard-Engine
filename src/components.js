'use strict';

// Shared component renderer — loaded as a plain script by BOTH the desktop
// surface (dashboard.html) and the pack editor (editor.html), so a pack
// looks pixel-identical in the editor and on the desktop. No build step:
// this file defines window.AegisComponents and nothing else.
//
// Pages provide `services` so this module stays page-agnostic:
//   services.stats()        → { ok, cpuPercent, memUsedBytes, memTotalBytes,
//                               diskUsedBytes, diskTotalBytes }
//   services.weather(opts)  → { ok, tempC, description, windKmh } (cached in main)

(() => {

const FONT_STACKS = {
  'rajdhani': "'Rajdhani', 'Segoe UI', sans-serif",
  'system-sans': "'Segoe UI', system-ui, sans-serif",
  'system-serif': "Georgia, 'Times New Roman', serif",
  'mono': "'Share Tech Mono', Consolas, monospace",
};

const HISTORY_LENGTH = 90;         // sparkline: 90 samples at 2 s = 3 minutes
const TELEMETRY_INTERVAL_MS = 2000;
const WEATHER_REFRESH_MS = 10 * 60 * 1000;

// ── Colour helpers ──────────────────────────────────────────────────────────

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
// `root` is the element acting as the skin surface (the desktop's <body>, or
// the editor's canvas div). Vars cascade from it; textures/wallpaper attach
// to it via the .skin-root CSS hooks.

function applySkin(root, pack, assets) {
  const { palette, typography, texture, shape } = pack.skin;
  const s = root.style;

  s.setProperty('--void', palette.void);
  s.setProperty('--accent', palette.accent);
  s.setProperty('--accent-bright', palette.accentBright);
  s.setProperty('--muted', palette.muted);
  s.setProperty('--warn', palette.warn);
  s.setProperty('--gold', palette.gold);

  s.setProperty('--panel-bg', rgba(palette.glass, shape.panelOpacity));
  s.setProperty('--hairline', rgba(palette.accent, shape.borderOpacity));
  s.setProperty('--hairline-dim', rgba(palette.accent, shape.borderOpacity * 0.5));
  s.setProperty('--glow', rgba(palette.accent, 0.45 * texture.glow));
  s.setProperty('--glow-wash', rgba(palette.accent, 0.14 * texture.glow));
  s.setProperty('--scan-ink', rgba('#000000', 0.5 * texture.scanlines));
  s.setProperty('--grid-ink', rgba(palette.accent, 0.12 * texture.grid));
  s.setProperty('--vignette-ink', rgba('#000000', 0.85 * texture.vignette));

  s.setProperty('--radius', `${shape.radius}px`);
  s.setProperty('--ls', `${typography.letterSpacing}em`);
  s.setProperty('--font-display', FONT_STACKS[typography.display]);

  root.classList.add('skin-root');
  root.classList.toggle('uppercase', typography.uppercase);
  root.classList.toggle('notches', shape.cornerNotches);
  s.backgroundColor = palette.void;
  s.backgroundImage = pack.skin.wallpaper && assets[pack.skin.wallpaper] ? `url(${assets[pack.skin.wallpaper]})` : 'none';
}

function applyComponentStyle(el, style, pack) {
  const accent = style.accent || pack.skin.palette.accent;
  if (style.accent) {
    el.style.setProperty('--accent', style.accent);
    el.style.setProperty('--glow', rgba(style.accent, 0.45 * pack.skin.texture.glow));
    el.style.setProperty('--hairline', rgba(style.accent, pack.skin.shape.borderOpacity));
    el.style.setProperty('--hairline-dim', rgba(style.accent, pack.skin.shape.borderOpacity * 0.5));
  }
  if (style.glow !== null) el.style.setProperty('--glow', rgba(accent, 0.45 * style.glow));
  if (style.textColor) el.style.setProperty('--accent-bright', style.textColor);
  if (style.font) el.style.setProperty('--font-display', FONT_STACKS[style.font]);
  if (style.fontScale !== null) el.style.setProperty('--font-scale', String(style.fontScale));
  if (style.align) el.style.textAlign = style.align;
  if (style.opacity !== null) el.style.opacity = String(style.opacity);
  if (style.padding !== null) el.style.padding = `${style.padding}px`;
  if (style.rotate !== null) el.style.transform = `rotate(${style.rotate}deg)`;

  const panel = style.panel !== null ? style.panel : true;
  el.classList.toggle('panel', panel);
  el.classList.toggle('borderless', !(style.border !== null ? style.border : panel));
  if (style.notches !== null) el.classList.toggle('no-notches', !style.notches);
}

// ── Renderer instance ───────────────────────────────────────────────────────
// createRenderer(services) → { render(canvasEl, pack, assets), destroy() }.
// Every render() cleans up the previous one's timers/observers.

function createRenderer(services) {
  const live = {
    timers: [],
    observers: [],
    telemetry: { subscribers: [], history: { cpu: [], mem: [], disk: [], battery: [] } },
  };

  function cssVar(el, name) {
    return getComputedStyle(el).getPropertyValue(name).trim();
  }

  function observeCanvas(canvas, draw) {
    const observer = new ResizeObserver(() => {
      canvas.width = Math.max(1, canvas.clientWidth * devicePixelRatio);
      canvas.height = Math.max(1, canvas.clientHeight * devicePixelRatio);
      draw();
    });
    observer.observe(canvas);
    live.observers.push(observer);
  }

  async function batteryPercent() {
    try {
      if (!navigator.getBattery) return null;
      const battery = await navigator.getBattery();
      return Math.round(battery.level * 100);
    } catch {
      return null;
    }
  }

  function startTelemetry() {
    if (live.telemetry.subscribers.length === 0) return;
    const tick = async () => {
      const res = await services.stats();
      if (!res.ok) return;
      const gb = (bytes) => (bytes / 2 ** 30).toFixed(1);
      const values = {
        cpu: res.cpuPercent,
        mem: Math.round((res.memUsedBytes / res.memTotalBytes) * 100),
        memText: `${gb(res.memUsedBytes)} / ${gb(res.memTotalBytes)} GB`,
        disk: res.diskTotalBytes > 0 ? Math.round((res.diskUsedBytes / res.diskTotalBytes) * 100) : 0,
        diskText: res.diskTotalBytes > 0 ? `${gb(res.diskUsedBytes)} / ${gb(res.diskTotalBytes)} GB` : '—',
        battery: await batteryPercent(),
        batteryText: null,
      };
      if (values.battery === null) values.battery = 0;
      values.batteryText = navigator.getBattery ? `${values.battery} %` : 'no battery';
      for (const key of ['cpu', 'mem', 'disk', 'battery']) {
        const series = live.telemetry.history[key];
        series.push(values[key]);
        if (series.length > HISTORY_LENGTH) series.shift();
      }
      for (const update of live.telemetry.subscribers) update(values);
    };
    tick();
    live.timers.push(setInterval(tick, TELEMETRY_INTERVAL_MS));
  }

  function bindText(values, bind) {
    if (bind === 'mem') return values.memText;
    if (bind === 'disk') return values.diskText;
    if (bind === 'battery') return values.batteryText;
    return `${values[bind]} %`;
  }

  // ── Builders ──────────────────────────────────────────────────────────────

  function buildStatus(component, el, ctx) {
    const name = document.createElement('div');
    name.className = 'status-name';
    name.textContent = ctx.pack.persona.name;
    const tagline = document.createElement('div');
    tagline.className = 'status-tagline display-case';
    tagline.textContent = ctx.pack.persona.tagline;
    const line = document.createElement('div');
    line.className = 'status-line';
    el.append(name, tagline, line);

    const lines = ctx.pack.persona.lines;
    if (lines.length === 0) return;
    let index = 0;
    line.textContent = lines[0];
    if (lines.length > 1) {
      live.timers.push(setInterval(() => {
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
    live.timers.push(setInterval(tick, 250));
  }

  function buildAnalogClock(component, el) {
    const canvas = document.createElement('canvas');
    canvas.className = 'fill-canvas';
    el.appendChild(canvas);

    const draw = () => {
      const ctx2 = canvas.getContext('2d');
      const w = canvas.width, h = canvas.height;
      ctx2.clearRect(0, 0, w, h);
      const cx = w / 2, cy = h / 2;
      const radius = Math.min(w, h) / 2 - 6 * devicePixelRatio;
      if (radius <= 0) return;

      const accent = cssVar(el, '--accent');
      const bright = cssVar(el, '--accent-bright');
      const hairline = cssVar(el, '--hairline');
      const gold = cssVar(el, '--gold');

      ctx2.lineWidth = 1 * devicePixelRatio;
      ctx2.strokeStyle = hairline;
      ctx2.beginPath();
      ctx2.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx2.stroke();

      ctx2.strokeStyle = accent;
      for (let i = 0; i < 12; i++) {
        const angle = (i / 12) * Math.PI * 2;
        const inner = i % 3 === 0 ? radius * 0.86 : radius * 0.92;
        ctx2.beginPath();
        ctx2.moveTo(cx + Math.sin(angle) * inner, cy - Math.cos(angle) * inner);
        ctx2.lineTo(cx + Math.sin(angle) * radius * 0.97, cy - Math.cos(angle) * radius * 0.97);
        ctx2.stroke();
      }

      const now = new Date();
      const seconds = now.getSeconds() + now.getMilliseconds() / 1000;
      const minutes = now.getMinutes() + seconds / 60;
      const hours = (now.getHours() % 12) + minutes / 60;

      const hand = (angle, length, width, colour) => {
        ctx2.strokeStyle = colour;
        ctx2.lineWidth = width * devicePixelRatio;
        ctx2.lineCap = 'round';
        ctx2.beginPath();
        ctx2.moveTo(cx, cy);
        ctx2.lineTo(cx + Math.sin(angle) * length, cy - Math.cos(angle) * length);
        ctx2.stroke();
      };
      hand((hours / 12) * Math.PI * 2, radius * 0.5, 3, bright);
      hand((minutes / 60) * Math.PI * 2, radius * 0.72, 2, accent);
      if (component.options.seconds) hand((seconds / 60) * Math.PI * 2, radius * 0.8, 1, gold);

      ctx2.fillStyle = accent;
      ctx2.beginPath();
      ctx2.arc(cx, cy, 3 * devicePixelRatio, 0, Math.PI * 2);
      ctx2.fill();
    };

    observeCanvas(canvas, draw);
    live.timers.push(setInterval(draw, component.options.seconds ? 100 : 1000));
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
    const label = document.createElement('span');
    label.className = 'comp-label';
    label.textContent = 'System telemetry';
    el.appendChild(label);
    const rows = [];
    for (const bind of ['cpu', 'mem', 'disk', 'battery']) {
      if (!component.options[bind]) continue;
      const r = statRow(bind.toUpperCase());
      rows.push({ bind, ...r });
      el.appendChild(r.row);
    }
    live.telemetry.subscribers.push((values) => {
      for (const r of rows) {
        r.fill.style.width = `${values[r.bind]}%`;
        r.fill.classList.toggle('hot', values[r.bind] >= (r.bind === 'battery' ? 101 : 85));
        r.value.textContent = bindText(values, r.bind);
      }
    });
  }

  function buildMeter(component, el) {
    const bind = component.options.bind;
    const label = document.createElement('span');
    label.className = 'comp-label';
    label.textContent = component.options.label || bind.toUpperCase();

    if (component.options.variant === 'bar') {
      const { row, fill, value } = statRow('');
      row.querySelector('.stat-name').remove();
      row.style.gridTemplateColumns = '1fr 76px';
      el.append(label, row);
      live.telemetry.subscribers.push((values) => {
        fill.style.width = `${values[bind]}%`;
        fill.classList.toggle('hot', values[bind] >= 85);
        value.textContent = bindText(values, bind);
      });
      return;
    }

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
      const ctx2 = canvas.getContext('2d');
      const w = canvas.width, h = canvas.height;
      ctx2.clearRect(0, 0, w, h);
      const cx = w / 2, cy = h / 2;
      const radius = Math.min(w, h) / 2 - 8 * devicePixelRatio;
      if (radius <= 0) return;
      const start = -Math.PI / 2;

      ctx2.lineWidth = 5 * devicePixelRatio;
      ctx2.lineCap = 'round';
      ctx2.strokeStyle = cssVar(el, '--hairline-dim');
      ctx2.beginPath();
      ctx2.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx2.stroke();

      ctx2.strokeStyle = current >= 85 ? cssVar(el, '--warn') : cssVar(el, '--accent');
      ctx2.beginPath();
      ctx2.arc(cx, cy, radius, start, start + (current / 100) * Math.PI * 2);
      ctx2.stroke();
    };

    observeCanvas(canvas, draw);
    live.telemetry.subscribers.push((values) => {
      current = values[bind];
      value.textContent = bind === 'battery' && !navigator.getBattery ? '—' : `${current}%`;
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
      const ctx2 = canvas.getContext('2d');
      const w = canvas.width, h = canvas.height;
      ctx2.clearRect(0, 0, w, h);
      const series = live.telemetry.history[bind];
      if (series.length < 2) return;
      const step = w / (HISTORY_LENGTH - 1);
      const yFor = (v) => h - (v / 100) * (h - 4 * devicePixelRatio) - 2 * devicePixelRatio;

      const startX = w - (series.length - 1) * step;
      ctx2.beginPath();
      ctx2.moveTo(startX, h);
      series.forEach((v, i) => ctx2.lineTo(startX + i * step, yFor(v)));
      ctx2.lineTo(w, h);
      ctx2.closePath();
      ctx2.fillStyle = cssVar(el, '--glow-wash');
      ctx2.fill();

      ctx2.beginPath();
      series.forEach((v, i) => {
        const x = startX + i * step;
        if (i === 0) ctx2.moveTo(x, yFor(v));
        else ctx2.lineTo(x, yFor(v));
      });
      ctx2.strokeStyle = cssVar(el, '--accent');
      ctx2.lineWidth = 1.5 * devicePixelRatio;
      ctx2.stroke();
    };

    observeCanvas(canvas, draw);
    live.telemetry.subscribers.push(() => draw());
  }

  function buildText(component, el) {
    const text = document.createElement('div');
    text.className = 'text-body display-case';
    text.textContent = component.options.text;
    el.appendChild(text);
  }

  function buildImage(component, el, ctx) {
    const uri = ctx.assets[component.options.src];
    if (!uri) return;
    const img = document.createElement('img');
    img.className = `image-body fit-${component.options.fit}`;
    img.alt = '';
    img.src = uri;
    el.appendChild(img);
  }

  function buildDivider(component, el) {
    el.classList.add(`divider-${component.options.orientation}`);
    const line = document.createElement('span');
    line.className = 'divider-line';
    el.appendChild(line);
  }

  function buildCalendar(component, el) {
    const label = document.createElement('span');
    label.className = 'comp-label';
    const grid = document.createElement('div');
    grid.className = 'cal-grid';
    el.append(label, grid);

    const render = () => {
      const now = new Date();
      label.textContent = now.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
      grid.textContent = '';
      const mondayFirst = component.options.weekStart === 'mon';
      const dayNames = mondayFirst ? ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] : ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
      for (const d of dayNames) {
        const head = document.createElement('span');
        head.className = 'cal-head';
        head.textContent = d;
        grid.appendChild(head);
      }
      const first = new Date(now.getFullYear(), now.getMonth(), 1);
      const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
      let lead = first.getDay(); // 0 = Sunday
      if (mondayFirst) lead = (lead + 6) % 7;
      for (let i = 0; i < lead; i++) grid.appendChild(document.createElement('span'));
      for (let day = 1; day <= daysInMonth; day++) {
        const cell = document.createElement('span');
        cell.className = `cal-day${day === now.getDate() ? ' today' : ''}`;
        cell.textContent = String(day);
        grid.appendChild(cell);
      }
    };
    render();
    live.timers.push(setInterval(render, 60 * 1000));
  }

  function buildCountdown(component, el) {
    const label = document.createElement('span');
    label.className = 'comp-label';
    label.textContent = component.options.label || 'Countdown';
    const value = document.createElement('div');
    value.className = 'clock-time countdown-value';
    const sub = document.createElement('div');
    sub.className = 'clock-date';
    el.append(label, value, sub);

    const target = new Date(component.options.target).getTime();
    const tick = () => {
      const diff = target - Date.now();
      if (Number.isNaN(target)) {
        value.textContent = '—';
        return;
      }
      if (diff <= 0) {
        value.textContent = 'NOW';
        sub.textContent = '';
        return;
      }
      const days = Math.floor(diff / 86400000);
      const hours = Math.floor((diff % 86400000) / 3600000);
      const mins = Math.floor((diff % 3600000) / 60000);
      value.textContent = days > 0 ? `${days}d ${hours}h` : `${hours}h ${String(mins).padStart(2, '0')}m`;
      sub.textContent = new Date(target).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
    };
    tick();
    live.timers.push(setInterval(tick, 30 * 1000));
  }

  function buildWeather(component, el) {
    const label = document.createElement('span');
    label.className = 'comp-label';
    label.textContent = component.options.place || 'Weather';
    const temp = document.createElement('div');
    temp.className = 'clock-time weather-temp';
    temp.textContent = '—';
    const desc = document.createElement('div');
    desc.className = 'clock-date display-case';
    el.append(label, temp, desc);

    const refresh = async () => {
      if (!services.weather) return;
      const res = await services.weather({ lat: component.options.lat, lon: component.options.lon });
      if (!res.ok) {
        desc.textContent = 'weather unavailable';
        return;
      }
      temp.textContent = `${Math.round(res.tempC)}°`;
      desc.textContent = `${res.description} · wind ${Math.round(res.windKmh)} km/h`;
    };
    refresh();
    live.timers.push(setInterval(refresh, WEATHER_REFRESH_MS));
  }

  const BUILDERS = {
    status: buildStatus,
    clock: buildClock,
    'analog-clock': buildAnalogClock,
    stats: buildStats,
    meter: buildMeter,
    sparkline: buildSparkline,
    text: buildText,
    image: buildImage,
    divider: buildDivider,
    calendar: buildCalendar,
    countdown: buildCountdown,
    weather: buildWeather,
  };

  function cleanup() {
    for (const timer of live.timers) clearInterval(timer);
    for (const observer of live.observers) observer.disconnect();
    live.timers = [];
    live.observers = [];
    live.telemetry.subscribers = [];
  }

  /** Render a pack's components into canvasEl. Returns the component elements by index. */
  function render(canvasEl, pack, assets) {
    cleanup();
    canvasEl.textContent = '';
    canvasEl.style.inset = `${pack.canvas.padding}%`;
    const ctx = { pack, assets };
    const elements = [];

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
      const builder = BUILDERS[component.type];
      if (builder) builder(component, el, ctx);
      canvasEl.appendChild(el);
      elements.push(el);
    }
    startTelemetry();
    return elements;
  }

  return { render, destroy: cleanup };
}

window.AegisComponents = { FONT_STACKS, rgba, applySkin, createRenderer };

})();
