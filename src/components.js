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

// Weather condition glyphs — engine-drawn line icons (fixed strings, no pack
// data ever goes through innerHTML). Keyed by Open-Meteo weather-code group.
const GLYPH_ATTRS = 'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"';
const CLOUD_PATH = 'M7.5 15.5h9.3a3.6 3.6 0 0 0 .5-7.2 5.2 5.2 0 0 0-10-1.3 4 4 0 0 0 .2 8.5z';
const WEATHER_GLYPHS = {
  sun: `<svg ${GLYPH_ATTRS}><circle cx="12" cy="12" r="4.2"/><path d="M12 2.6v2.5M12 18.9v2.5M2.6 12h2.5M18.9 12h2.5M5.3 5.3l1.8 1.8M16.9 16.9l1.8 1.8M18.7 5.3l-1.8 1.8M7.1 16.9l-1.8 1.8"/></svg>`,
  partly: `<svg ${GLYPH_ATTRS}><circle cx="8.2" cy="7.6" r="3"/><path d="M8.2 2.7v1.4M3.3 7.6h1.4M4.7 4.1l1 1M11.7 4.1l-1 1"/><path d="M10.4 19.4h6.8a3.1 3.1 0 0 0 .4-6.2 4.4 4.4 0 0 0-8.4-1.1 3.4 3.4 0 0 0 1.2 7.3z"/></svg>`,
  cloud: `<svg ${GLYPH_ATTRS}><path d="${CLOUD_PATH}"/></svg>`,
  fog: `<svg ${GLYPH_ATTRS}><path d="M4.5 9.5h13.5M6.5 13h13M4.5 16.5h10.5"/></svg>`,
  rain: `<svg ${GLYPH_ATTRS}><path d="${CLOUD_PATH}"/><path d="M8.7 18l-1.1 2.8M12.7 18l-1.1 2.8M16.7 18l-1.1 2.8"/></svg>`,
  snow: `<svg ${GLYPH_ATTRS}><path d="${CLOUD_PATH}"/><circle cx="8.3" cy="19.2" r="0.4" fill="currentColor"/><circle cx="12.3" cy="19.2" r="0.4" fill="currentColor"/><circle cx="16.3" cy="19.2" r="0.4" fill="currentColor"/></svg>`,
  storm: `<svg ${GLYPH_ATTRS}><path d="${CLOUD_PATH}"/><path d="M13 16.5l-2.3 3.3h2.8l-1.8 2.7"/></svg>`,
};

// Open-Meteo weather code → glyph key.
function weatherGlyphKey(code) {
  if (code === 0 || code === 1) return 'sun';
  if (code === 2) return 'partly';
  if (code === 3) return 'cloud';
  if (code === 45 || code === 48) return 'fog';
  if (code >= 95) return 'storm';
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return 'snow';
  if (code >= 51) return 'rain';
  return 'cloud';
}

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

function applySkin(root, pack, assets, opts) {
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

  applyAmbience(root, pack, opts);
}

// ── Ambience ────────────────────────────────────────────────────────────────
// A declarative particle layer behind the components (embers / dust / snow).
// Packs pick an effect + density from tokens; the engine owns the animation —
// packs never ship code. Reduced motion gets one static scatter, no loop.

const AMBIENCE_COLOR_KEY = { embers: 'gold', dust: 'muted', snow: 'accentBright' };

function applyAmbience(root, pack, opts) {
  const prev = root.__aegisAmbience;
  if (prev) {
    cancelAnimationFrame(prev.raf);
    prev.observer.disconnect();
    prev.canvas.remove();
    root.__aegisAmbience = null;
  }
  const ambience = pack.skin.ambience || { effect: 'none', density: 0.5 };
  const effect = ambience.effect;
  if (!AMBIENCE_COLOR_KEY[effect]) return;

  const canvas = document.createElement('canvas');
  canvas.className = 'ambience-layer';
  root.appendChild(canvas);
  const [r, g, b] = hexToRgbParts(pack.skin.palette[AMBIENCE_COLOR_KEY[effect]]);
  const count = Math.round(14 + ambience.density * 66);
  const rand = (lo, hi) => lo + Math.random() * (hi - lo);
  let particles = [];

  // fresh=true spawns just off the entry edge; false scatters anywhere so the
  // first frame is already populated. Velocities are fractions of the surface
  // per second, so density of motion is resolution-independent.
  const spawn = (fresh) => {
    const w = canvas.width, h = canvas.height;
    const p = {
      x: rand(0, w),
      y: rand(0, h),
      vx: 0,
      vy: 0,
      size: rand(0.8, 2.6) * devicePixelRatio,
      alpha: rand(0.2, 0.7),
      phase: rand(0, Math.PI * 2),
      sway: rand(0.2, 1),
    };
    if (effect === 'embers') {
      p.vy = -rand(0.015, 0.05);
      if (fresh) p.y = h + p.size * 4;
    } else if (effect === 'snow') {
      p.vy = rand(0.02, 0.06);
      p.size = rand(1, 3) * devicePixelRatio;
      if (fresh) p.y = -p.size * 4;
    } else { // dust: slow omnidirectional drift, dimmer and smaller
      p.vx = rand(-0.008, 0.008);
      p.vy = rand(-0.008, 0.008);
      p.size = rand(0.6, 1.8) * devicePixelRatio;
      p.alpha = rand(0.12, 0.4);
    }
    return p;
  };

  const stepParticles = (dt, t) => {
    const w = canvas.width, h = canvas.height;
    for (let i = 0; i < particles.length; i++) {
      const p = particles[i];
      p.y += p.vy * h * dt;
      if (effect === 'dust') {
        p.x += p.vx * w * dt;
        if (p.x < -8) p.x = w + 8; else if (p.x > w + 8) p.x = -8;
        if (p.y < -8) p.y = h + 8; else if (p.y > h + 8) p.y = -8;
      } else {
        p.x += Math.sin(t * 0.001 + p.phase) * p.sway * 20 * devicePixelRatio * dt;
        if (effect === 'embers' && p.y < -p.size * 4) particles[i] = spawn(true);
        if (effect === 'snow' && p.y > h + p.size * 4) particles[i] = spawn(true);
      }
    }
  };

  const draw = (t) => {
    const ctx2 = canvas.getContext('2d');
    ctx2.clearRect(0, 0, canvas.width, canvas.height);
    for (const p of particles) {
      let a = p.alpha;
      if (effect === 'embers') {
        a *= 0.65 + 0.35 * Math.sin(t * 0.004 + p.phase);         // flicker
        a *= Math.min(1, Math.max(0, p.y / (canvas.height * 0.35))); // die out near the top
      }
      ctx2.fillStyle = `rgba(${r}, ${g}, ${b}, ${Math.max(0, Math.min(1, a)).toFixed(3)})`;
      ctx2.beginPath();
      ctx2.arc(p.x, p.y, p.size, 0, Math.PI * 2);
      ctx2.fill();
    }
  };

  // Static thumbnails (gallery cards) get one scattered frame, no loop —
  // same rendering path the OS reduced-motion preference takes.
  const reduced = (opts && opts.staticAmbience === true)
    || (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const resize = () => {
    canvas.width = Math.max(1, canvas.clientWidth * devicePixelRatio);
    canvas.height = Math.max(1, canvas.clientHeight * devicePixelRatio);
    particles = Array.from({ length: count }, () => spawn(false));
    if (reduced) draw(0);
  };

  const state = { canvas, raf: 0, observer: new ResizeObserver(resize) };
  state.observer.observe(canvas);
  resize();
  root.__aegisAmbience = state;
  if (reduced) return; // static scatter only

  let last = 0;
  const loop = (t) => {
    // Self-terminate when the skin root is discarded (gallery re-renders,
    // preview swaps) — nobody re-applies skins to detached DOM.
    if (!canvas.isConnected) {
      state.observer.disconnect();
      return;
    }
    state.raf = requestAnimationFrame(loop);
    if (t - last < 33) return; // ~30 fps is plenty for drift
    const dt = Math.min(t - last, 100) / 1000;
    last = t;
    stepParticles(dt, t);
    draw(t);
  };
  state.raf = requestAnimationFrame(loop);
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
  if (style.place) {
    el.style.justifyContent = { top: 'flex-start', center: 'center', bottom: 'flex-end', spread: 'space-between' }[style.place];
  }
  if (style.opacity !== null) el.style.opacity = String(style.opacity);
  // Padding token is documented in px at the 1920-wide design basis; render
  // it container-relative so it scales with the surface (1px ≈ 0.0521cqw).
  if (style.padding !== null) el.style.padding = `${(style.padding * 0.0521).toFixed(3)}cqw`;
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
      const uptime = (sec) => {
        const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
        return d > 0 ? `${d}d ${h}h ${m}m` : `${h}h ${m}m`;
      };
      const values = {
        cpu: res.cpuPercent,
        cores: Array.isArray(res.coresPercent) ? res.coresPercent.slice(0, 32) : [],
        mem: Math.round((res.memUsedBytes / res.memTotalBytes) * 100),
        memText: `${gb(res.memUsedBytes)} / ${gb(res.memTotalBytes)} GB`,
        disk: res.diskTotalBytes > 0 ? Math.round((res.diskUsedBytes / res.diskTotalBytes) * 100) : 0,
        diskText: res.diskTotalBytes > 0 ? `${gb(res.diskUsedBytes)} / ${gb(res.diskTotalBytes)} GB` : '—',
        diskFreeText: res.diskTotalBytes > 0 ? `${Math.round((res.diskTotalBytes - res.diskUsedBytes) / 2 ** 30)} GB` : '—',
        uptimeText: typeof res.uptimeSec === 'number' ? uptime(res.uptimeSec) : '—',
        hostname: typeof res.hostname === 'string' ? res.hostname.slice(0, 24).toUpperCase() : '—',
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
      const muted = cssVar(el, '--muted');

      ctx2.lineWidth = 1 * devicePixelRatio;
      ctx2.strokeStyle = hairline;
      ctx2.beginPath();
      ctx2.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx2.stroke();

      if (component.options.minuteTicks !== false) {
        ctx2.strokeStyle = hairline;
        for (let i = 0; i < 60; i++) {
          if (i % 5 === 0) continue;
          const angle = (i / 60) * Math.PI * 2;
          ctx2.beginPath();
          ctx2.moveTo(cx + Math.sin(angle) * radius * 0.945, cy - Math.cos(angle) * radius * 0.945);
          ctx2.lineTo(cx + Math.sin(angle) * radius * 0.97, cy - Math.cos(angle) * radius * 0.97);
          ctx2.stroke();
        }
      }

      ctx2.strokeStyle = accent;
      for (let i = 0; i < 12; i++) {
        const angle = (i / 12) * Math.PI * 2;
        const inner = i % 3 === 0 ? radius * 0.86 : radius * 0.92;
        ctx2.beginPath();
        ctx2.moveTo(cx + Math.sin(angle) * inner, cy - Math.cos(angle) * inner);
        ctx2.lineTo(cx + Math.sin(angle) * radius * 0.97, cy - Math.cos(angle) * radius * 0.97);
        ctx2.stroke();
      }

      // Numerals in the pack's display font — quarters big and bright, the
      // rest (in 'all' mode) small and muted so the dial keeps its hierarchy.
      const numerals = component.options.numerals || 'quarters';
      if (numerals !== 'none') {
        const fontFamily = getComputedStyle(el).fontFamily;
        ctx2.textAlign = 'center';
        ctx2.textBaseline = 'middle';
        for (let n = 1; n <= 12; n++) {
          const quarter = n % 3 === 0;
          if (numerals === 'quarters' && !quarter) continue;
          const angle = (n / 12) * Math.PI * 2;
          const size = radius * (quarter ? 0.17 : 0.115);
          ctx2.font = `600 ${size}px ${fontFamily}`;
          ctx2.fillStyle = quarter ? bright : muted;
          ctx2.fillText(String(n), cx + Math.sin(angle) * radius * 0.74, cy - Math.cos(angle) * radius * 0.74);
        }
      }

      const now = new Date();
      const seconds = now.getSeconds() + now.getMilliseconds() / 1000;
      const minutes = now.getMinutes() + seconds / 60;
      const hours = (now.getHours() % 12) + minutes / 60;

      // Hands get a short counterweight tail and a soft glow.
      ctx2.shadowColor = cssVar(el, '--glow');
      ctx2.shadowBlur = 6 * devicePixelRatio;
      const hand = (angle, length, width, colour) => {
        ctx2.strokeStyle = colour;
        ctx2.lineWidth = width * devicePixelRatio;
        ctx2.lineCap = 'round';
        ctx2.beginPath();
        ctx2.moveTo(cx - Math.sin(angle) * length * 0.16, cy + Math.cos(angle) * length * 0.16);
        ctx2.lineTo(cx + Math.sin(angle) * length, cy - Math.cos(angle) * length);
        ctx2.stroke();
      };
      hand((hours / 12) * Math.PI * 2, radius * 0.5, 3, bright);
      hand((minutes / 60) * Math.PI * 2, radius * 0.72, 2, accent);
      if (component.options.seconds) hand((seconds / 60) * Math.PI * 2, radius * 0.8, 1, gold);
      ctx2.shadowBlur = 0;

      ctx2.fillStyle = accent;
      ctx2.beginPath();
      ctx2.arc(cx, cy, 3.5 * devicePixelRatio, 0, Math.PI * 2);
      ctx2.fill();
      ctx2.fillStyle = cssVar(el, '--void');
      ctx2.beginPath();
      ctx2.arc(cx, cy, 1.4 * devicePixelRatio, 0, Math.PI * 2);
      ctx2.fill();
    };

    observeCanvas(canvas, draw);
    live.timers.push(setInterval(draw, component.options.seconds ? 100 : 1000));
  }

  // Faint area-fill of a bind's history, drawn inside a bar's track so the
  // bar reads as "now" on top of "the last three minutes".
  function drawTrace(canvas, el, bind) {
    const ctx2 = canvas.getContext('2d');
    const w = canvas.width, h = canvas.height;
    ctx2.clearRect(0, 0, w, h);
    const series = live.telemetry.history[bind];
    if (!series || series.length < 2) return;
    const step = w / Math.max(series.length - 1, 1);
    ctx2.beginPath();
    ctx2.moveTo(0, h);
    series.forEach((v, i) => ctx2.lineTo(i * step, h - (v / 100) * h));
    ctx2.lineTo((series.length - 1) * step, h);
    ctx2.closePath();
    ctx2.globalAlpha = 0.22;
    ctx2.fillStyle = cssVar(el, '--accent');
    ctx2.fill();
    ctx2.globalAlpha = 1;
  }

  // HUD clock — the "arc reactor": counter-rotating ring layers drawn from
  // the original JARVIS geometry (400-unit viewBox, outer radius 186),
  // digital time + date in the centre. Ring alphas are fixed to the original
  // design so pack border settings don't wash the reactor out.
  function buildHudClock(component, el) {
    const wrap = document.createElement('div');
    wrap.className = 'hud-wrap';
    const canvas = document.createElement('canvas');
    canvas.className = 'fill-canvas';
    const face = document.createElement('div');
    face.className = 'hud-face';
    const time = document.createElement('div');
    time.className = 'hud-time';
    const date = document.createElement('div');
    date.className = 'hud-date display-case';
    face.append(time);
    if (component.options.showDate) face.append(date);
    wrap.append(canvas, face);
    el.appendChild(wrap);

    const reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const start = performance.now();

    const draw = () => {
      const ctx2 = canvas.getContext('2d');
      const w = canvas.width, h = canvas.height;
      ctx2.clearRect(0, 0, w, h);
      const cx = w / 2, cy = h / 2;
      const R = Math.min(w, h) / 2 - 2 * devicePixelRatio;
      if (R <= 0) return;
      const u = R / 186; // original geometry unit
      const accent = cssVar(el, '--accent');
      const bright = cssVar(el, '--accent-bright');
      const glow = cssVar(el, '--glow');
      const t = reduced ? 0 : performance.now() - start;
      // Layer rotations from the original: outer 90 s, mid −36 s, inner 18 s.
      const outerA = (t / 90000) * Math.PI * 2;
      const midA = -(t / 36000) * Math.PI * 2;
      const innerA = (t / 18000) * Math.PI * 2;

      const circle = (r, alpha, width, dash) => {
        ctx2.beginPath();
        ctx2.setLineDash(dash || []);
        ctx2.globalAlpha = alpha;
        ctx2.lineWidth = width * devicePixelRatio;
        ctx2.strokeStyle = accent;
        ctx2.arc(cx, cy, r * u, 0, Math.PI * 2);
        ctx2.stroke();
        ctx2.setLineDash([]);
        ctx2.globalAlpha = 1;
      };
      const arc = (r, from, sweep, colour, width, alpha, useGlow) => {
        ctx2.beginPath();
        ctx2.globalAlpha = alpha;
        ctx2.lineWidth = width * devicePixelRatio;
        ctx2.strokeStyle = colour;
        if (useGlow) { ctx2.shadowColor = glow; ctx2.shadowBlur = 7 * devicePixelRatio; }
        ctx2.arc(cx, cy, r * u, from, from + sweep);
        ctx2.stroke();
        ctx2.shadowBlur = 0;
        ctx2.globalAlpha = 1;
      };

      // outer: faint ring + 60 ticks (every 5th brighter), slow spin
      circle(186, 0.45, 1);
      for (let i = 0; i < 60; i++) {
        const a = (i / 60) * Math.PI * 2 + outerA;
        const major = i % 5 === 0;
        const r2 = major ? 176 : 181;
        ctx2.beginPath();
        ctx2.globalAlpha = major ? 0.8 : 0.45;
        ctx2.lineWidth = (major ? 1.5 : 1) * devicePixelRatio;
        ctx2.strokeStyle = accent;
        ctx2.moveTo(cx + Math.cos(a) * 186 * u, cy + Math.sin(a) * 186 * u);
        ctx2.lineTo(cx + Math.cos(a) * r2 * u, cy + Math.sin(a) * r2 * u);
        ctx2.stroke();
        ctx2.globalAlpha = 1;
      }
      // mid: dashed ring + two opposed quarter arcs, counter-rotating
      circle(150, 0.45, 1, [3 * u, 9 * u]);
      arc(162, midA - Math.PI / 2, Math.PI / 2, accent, 2, 0.55, true);
      arc(162, midA + Math.PI / 2, Math.PI / 2, accent, 2, 0.55, true);
      // inner: faint ring + bright three-quarter arc + glow disc
      circle(118, 0.45, 1);
      arc(105, innerA - Math.PI / 2, Math.PI * 1.5, bright, 2.5, 1, true);
      ctx2.beginPath();
      ctx2.globalAlpha = 0.09;
      ctx2.fillStyle = accent;
      ctx2.arc(cx, cy, 92 * u, 0, Math.PI * 2);
      ctx2.fill();
      ctx2.globalAlpha = 0.45;
      ctx2.lineWidth = 1 * devicePixelRatio;
      ctx2.strokeStyle = accent;
      ctx2.stroke();
      ctx2.globalAlpha = 1;
    };

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
        date.textContent = now.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
      }
    };

    observeCanvas(canvas, draw);
    tick();
    live.timers.push(setInterval(tick, 250));
    if (!reduced) live.timers.push(setInterval(draw, 50)); // 20 fps ring drift
  }

  // Per-core CPU load bars (the JARVIS "core load" strip).
  function buildCores(component, el) {
    const label = document.createElement('span');
    label.className = 'comp-label';
    label.textContent = component.options.label || 'Core load';
    const strip = document.createElement('div');
    strip.className = 'cores-strip';
    el.append(label, strip);
    live.telemetry.subscribers.push((values) => {
      const cores = values.cores || [];
      while (strip.childElementCount < cores.length) strip.appendChild(document.createElement('span'));
      while (strip.childElementCount > cores.length) strip.removeChild(strip.lastChild);
      [...strip.children].forEach((bar, i) => { bar.style.height = `${Math.max(4, cores[i])}%`; });
    });
  }

  // Key/value machine readouts.
  function buildSysinfo(component, el) {
    const rows = [];
    const addRow = (name, valueKey, fixed) => {
      const row = document.createElement('div');
      row.className = 'ds-row';
      const key = document.createElement('span');
      key.className = 'ds-key display-case';
      key.textContent = name;
      const value = document.createElement('span');
      value.className = `ds-value${fixed ? ' ds-ok' : ''}`;
      value.textContent = fixed || '—';
      row.append(key, value);
      el.appendChild(row);
      if (!fixed) rows.push({ value, valueKey });
    };
    if (component.options.memory) addRow('Memory', 'memText');
    if (component.options.disk) addRow('Disk free', 'diskFreeText');
    if (component.options.uptime) addRow('Uptime', 'uptimeText');
    if (component.options.host) addRow('Host', 'hostname');
    if (component.options.statusText) addRow('Status', null, component.options.statusText);
    live.telemetry.subscribers.push((values) => {
      for (const row of rows) row.value.textContent = values[row.valueKey] ?? '—';
    });
  }

  function statRow(name, traced, el, bind) {
    const row = document.createElement('div');
    row.className = 'stat-row';
    const label = document.createElement('span');
    label.className = 'stat-name';
    label.textContent = name;
    const bar = document.createElement('div');
    bar.className = 'stat-bar';
    let trace = null;
    if (traced) {
      trace = document.createElement('canvas');
      trace.className = 'stat-trace';
      bar.appendChild(trace);
      observeCanvas(trace, () => drawTrace(trace, el, bind));
    }
    const fill = document.createElement('span');
    bar.appendChild(fill);
    const value = document.createElement('span');
    value.className = 'stat-value';
    value.textContent = '—';
    row.append(label, bar, value);
    return { row, bar, fill, value, trace };
  }

  function buildStats(component, el) {
    const label = document.createElement('span');
    label.className = 'comp-label';
    label.textContent = 'System telemetry';
    el.appendChild(label);
    const traced = component.options.history !== false;
    const rows = [];
    for (const bind of ['cpu', 'mem', 'disk', 'battery']) {
      if (!component.options[bind]) continue;
      const r = statRow(bind.toUpperCase(), traced, el, bind);
      rows.push({ bind, ...r });
      el.appendChild(r.row);
    }
    live.telemetry.subscribers.push((values) => {
      for (const r of rows) {
        r.fill.style.width = `${values[r.bind]}%`;
        r.fill.classList.toggle('hot', values[r.bind] >= (r.bind === 'battery' ? 101 : 85));
        r.value.textContent = bindText(values, r.bind);
        if (r.trace) drawTrace(r.trace, el, r.bind);
      }
    });
  }

  function buildMeter(component, el) {
    const bind = component.options.bind;
    const label = document.createElement('span');
    label.className = 'comp-label';
    label.textContent = component.options.label || bind.toUpperCase();

    if (component.options.variant === 'bar') {
      el.appendChild(label);
      let big = null;
      if (component.options.readout !== false) {
        big = document.createElement('div');
        big.className = 'meter-value';
        big.textContent = '—';
        el.appendChild(big);
      }
      const bar = document.createElement('div');
      bar.className = `stat-bar meter-bar${component.options.ticks !== false ? ' ticked' : ''}`;
      const trace = document.createElement('canvas');
      trace.className = 'stat-trace';
      bar.appendChild(trace);
      observeCanvas(trace, () => drawTrace(trace, el, bind));
      const fill = document.createElement('span');
      bar.appendChild(fill);
      el.appendChild(bar);
      live.telemetry.subscribers.push((values) => {
        fill.style.width = `${values[bind]}%`;
        fill.classList.toggle('hot', values[bind] >= 85);
        if (big) big.textContent = bindText(values, bind);
        drawTrace(trace, el, bind);
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
    const head = document.createElement('div');
    head.className = 'spark-head';
    const label = document.createElement('span');
    label.className = 'comp-label';
    label.textContent = component.options.label || `${bind.toUpperCase()} HISTORY`;
    head.appendChild(label);
    let readout = null;
    if (component.options.readout !== false) {
      readout = document.createElement('span');
      readout.className = 'spark-value';
      readout.textContent = '—';
      head.appendChild(readout);
    }
    const canvas = document.createElement('canvas');
    canvas.className = 'fill-canvas spark';
    el.append(head, canvas);

    const draw = () => {
      const ctx2 = canvas.getContext('2d');
      const w = canvas.width, h = canvas.height;
      ctx2.clearRect(0, 0, w, h);

      // Quarter grid first, so the chart looks composed even before the
      // history has any samples in it.
      if (component.options.grid !== false) {
        ctx2.strokeStyle = cssVar(el, '--hairline-dim');
        ctx2.lineWidth = 1 * devicePixelRatio;
        for (const f of [0.25, 0.5, 0.75]) {
          ctx2.beginPath();
          ctx2.moveTo(0, h * f);
          ctx2.lineTo(w, h * f);
          ctx2.stroke();
        }
      }

      const series = live.telemetry.history[bind];
      if (series.length < 2) return;
      // Stretch whatever history exists across the full width — a fresh boot
      // fills the panel immediately and compresses toward final density.
      const step = w / Math.max(series.length - 1, 1);
      const yFor = (v) => h - (v / 100) * (h - 4 * devicePixelRatio) - 2 * devicePixelRatio;

      ctx2.beginPath();
      ctx2.moveTo(0, h);
      series.forEach((v, i) => ctx2.lineTo(i * step, yFor(v)));
      ctx2.lineTo((series.length - 1) * step, h);
      ctx2.closePath();
      ctx2.fillStyle = cssVar(el, '--glow-wash');
      ctx2.fill();

      ctx2.shadowColor = cssVar(el, '--glow');
      ctx2.shadowBlur = 5 * devicePixelRatio;
      ctx2.beginPath();
      series.forEach((v, i) => {
        if (i === 0) ctx2.moveTo(0, yFor(v));
        else ctx2.lineTo(i * step, yFor(v));
      });
      ctx2.strokeStyle = cssVar(el, '--accent');
      ctx2.lineWidth = 1.5 * devicePixelRatio;
      ctx2.stroke();

      // "Now" dot on the newest sample.
      ctx2.fillStyle = cssVar(el, '--accent-bright');
      ctx2.beginPath();
      ctx2.arc((series.length - 1) * step, yFor(series[series.length - 1]), 2.2 * devicePixelRatio, 0, Math.PI * 2);
      ctx2.fill();
      ctx2.shadowBlur = 0;
    };

    observeCanvas(canvas, draw);
    live.telemetry.subscribers.push((values) => {
      if (readout) readout.textContent = bindText(values, bind);
      draw();
    });
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

  // Local (not UTC) YYYY-MM-DD — reminder dates are the user's wall dates.
  function localIso(date) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  }

  function buildCalendar(component, el) {
    const label = document.createElement('span');
    label.className = 'comp-label';
    const grid = document.createElement('div');
    grid.className = 'cal-grid';
    el.append(label, grid);

    // Reminder markers: dot the days that still have something planned.
    // Repeating events land on every occurrence (expanded in main).
    const decorate = async () => {
      if (!services.reminders || component.options.showReminders === false) return;
      const now = new Date();
      const prefix = localIso(now).slice(0, 8);
      const last = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
      const res = await services.reminders({ from: `${prefix}01`, to: `${prefix}${String(last).padStart(2, '0')}` });
      if (!res.ok) return;
      const entries = res.occurrences || res.reminders;
      const marked = new Set(
        entries.filter((r) => r.date.startsWith(prefix) && !r.done).map((r) => Number(r.date.slice(8))),
      );
      for (const cell of grid.querySelectorAll('.cal-day')) {
        cell.classList.toggle('has-rem', marked.has(Number(cell.textContent)));
      }
    };

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
      decorate();
    };
    render();
    live.timers.push(setInterval(render, 60 * 1000));
  }

  function buildAgenda(component, el) {
    const label = document.createElement('span');
    label.className = 'comp-label';
    label.textContent = component.options.label || 'Planner';
    const listEl = document.createElement('div');
    listEl.className = 'agenda';
    el.append(label, listEl);

    const dayTitle = (iso, todayIso, tomorrowIso) => {
      if (iso === todayIso) return 'Today';
      if (iso === tomorrowIso) return 'Tomorrow';
      const [y, m, d] = iso.split('-').map(Number);
      return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
    };

    const paint = async () => {
      if (!services.reminders) return;
      const today = new Date();
      const todayIso = localIso(today);
      const tomorrowIso = localIso(new Date(today.getTime() + 86400000));
      const horizonIso = localIso(new Date(today.getTime() + (component.options.days - 1) * 86400000));
      const res = await services.reminders({ from: todayIso, to: horizonIso });
      if (!res.ok) return;
      listEl.textContent = '';

      // Expanded occurrences put repeating events on each of their days.
      const entries = res.occurrences || res.reminders;
      const upcoming = entries.filter((r) => r.date >= todayIso && r.date <= horizonIso);

      if (upcoming.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'agenda-empty';
        empty.textContent = 'Nothing planned — add reminders in the manager.';
        listEl.appendChild(empty);
        return;
      }

      let shown = 0;
      let currentDay = null;
      for (const reminder of upcoming) {
        if (shown >= component.options.limit) break;
        if (reminder.date !== currentDay) {
          currentDay = reminder.date;
          const head = document.createElement('div');
          head.className = 'agenda-day display-case';
          head.textContent = dayTitle(reminder.date, todayIso, tomorrowIso);
          listEl.appendChild(head);
        }
        const item = document.createElement('div');
        item.className = `agenda-item${reminder.done ? ' done' : ''}`;
        const time = document.createElement('span');
        time.className = 'agenda-time';
        // Untimed repeating events show their repeat mark where the time goes.
        time.textContent = reminder.time || (reminder.repeat && reminder.repeat !== 'none' ? '↻' : '·');
        const text = document.createElement('span');
        text.className = 'agenda-text';
        text.textContent = reminder.text;
        item.append(time, text);
        listEl.appendChild(item);
        shown++;
      }
      const remaining = upcoming.length - shown;
      if (remaining > 0) {
        const more = document.createElement('div');
        more.className = 'agenda-empty';
        more.textContent = `+ ${remaining} more`;
        listEl.appendChild(more);
      }
    };
    paint();
    live.timers.push(setInterval(paint, 60 * 1000));
  }

  // Live Windows notifications (personal data; read in main). Fails soft:
  // shows how to grant access if the user hasn't, or an unavailable note.
  function buildNotifications(component, el) {
    const label = document.createElement('span');
    label.className = 'comp-label';
    label.textContent = component.options.label || 'Notifications';
    const listEl = document.createElement('div');
    listEl.className = 'notif-feed';
    el.append(label, listEl);

    const relTime = (iso) => {
      if (!iso) return '';
      const then = Date.parse(iso);
      if (Number.isNaN(then)) return '';
      const s = Math.max(0, (Date.now() - then) / 1000);
      if (s < 60) return 'just now';
      const m = Math.floor(s / 60);
      if (m < 60) return `${m}m ago`;
      const h = Math.floor(m / 60);
      if (h < 24) return `${h}h ago`;
      return `${Math.floor(h / 24)}d ago`;
    };

    const message = (text) => {
      listEl.textContent = '';
      const msg = document.createElement('div');
      msg.className = 'notif-empty';
      msg.textContent = text;
      listEl.appendChild(msg);
    };

    const paint = async () => {
      if (!services.notifications) return;
      const res = await services.notifications();
      if (!res || !res.ok) return;
      if (!res.granted) {
        message(res.status === 'unsupported'
          ? 'System notifications need Windows.'
          : 'Allow notification access in Windows Settings › Privacy › Notifications.');
        return;
      }
      const items = res.notifications.slice(0, component.options.limit);
      if (items.length === 0) { message('No notifications.'); return; }

      listEl.textContent = '';
      for (const n of items) {
        const item = document.createElement('div');
        item.className = 'notif-item';

        const head = document.createElement('div');
        head.className = 'notif-head';
        const app = document.createElement('span');
        app.className = 'notif-app display-case';
        app.textContent = component.options.showApp !== false && n.app ? n.app : '';
        const time = document.createElement('span');
        time.className = 'notif-time';
        time.textContent = relTime(n.time);
        head.append(app, time);
        item.appendChild(head);

        if (n.title) {
          const title = document.createElement('div');
          title.className = 'notif-title';
          title.textContent = n.title;
          item.appendChild(title);
        }
        if (n.body) {
          const body = document.createElement('div');
          body.className = 'notif-body';
          body.textContent = n.body;
          item.appendChild(body);
        }
        listEl.appendChild(item);
      }
    };
    paint();
    live.timers.push(setInterval(paint, 20000));
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
    // Compact: one horizontal strip — place · temp · sky · wind.
    if (component.options.compact) {
      el.classList.add('weather-strip');
      const place = document.createElement('span');
      place.className = 'wx-place display-case';
      place.textContent = component.options.place || 'Weather';
      const temp = document.createElement('span');
      temp.className = 'wx-temp';
      temp.textContent = '—°';
      const desc = document.createElement('span');
      desc.className = 'wx-desc display-case';
      const wind = document.createElement('span');
      wind.className = 'wx-wind';
      el.append(place, temp, desc, wind);
      const refresh = async () => {
        if (!services.weather) return;
        const res = await services.weather({ lat: component.options.lat, lon: component.options.lon });
        if (!res.ok) { desc.textContent = 'weather unavailable'; return; }
        temp.textContent = `${Math.round(res.tempC)}°C`;
        desc.textContent = res.description;
        wind.textContent = `wind ${Math.round(res.windKmh)} km/h`;
      };
      refresh();
      live.timers.push(setInterval(refresh, WEATHER_REFRESH_MS));
      return;
    }

    const label = document.createElement('span');
    label.className = 'comp-label';
    label.textContent = component.options.place || 'Weather';
    const main = document.createElement('div');
    main.className = 'weather-main';
    const glyph = document.createElement('span');
    glyph.className = 'weather-glyph';
    const temp = document.createElement('div');
    temp.className = 'clock-time weather-temp';
    temp.textContent = '—';
    main.append(glyph, temp);
    const desc = document.createElement('div');
    desc.className = 'clock-date display-case';
    el.append(label, main, desc);
    let meta = null;
    if (component.options.details !== false) {
      meta = document.createElement('div');
      meta.className = 'weather-meta';
      el.appendChild(meta);
    }

    const refresh = async () => {
      if (!services.weather) return;
      const res = await services.weather({ lat: component.options.lat, lon: component.options.lon });
      if (!res.ok) {
        desc.textContent = 'weather unavailable';
        return;
      }
      temp.textContent = `${Math.round(res.tempC)}°`;
      // Fixed engine-authored markup only — pack/service text never goes near innerHTML.
      glyph.innerHTML = WEATHER_GLYPHS[weatherGlyphKey(res.code)] || WEATHER_GLYPHS.cloud;
      desc.textContent = res.description;
      if (meta) {
        const parts = [];
        if (typeof res.hiC === 'number' && typeof res.loC === 'number') {
          parts.push(`H ${Math.round(res.hiC)}°  L ${Math.round(res.loC)}°`);
        }
        parts.push(`wind ${Math.round(res.windKmh)} km/h`);
        meta.textContent = parts.join(' · ');
      }
    };
    refresh();
    live.timers.push(setInterval(refresh, WEATHER_REFRESH_MS));
  }

  // Launcher: the user's pinned / recent / running apps as clickable tiles.
  // Content comes from main over the launcher service (opaque ids only);
  // in the editor the service has no launch(), so tiles render inert.
  function buildLauncher(component, el) {
    const o = component.options;
    const label = document.createElement('span');
    label.className = 'comp-label';
    label.textContent = o.label || 'Launcher';
    const wrap = document.createElement('div');
    wrap.className = 'launch-wrap';
    el.classList.add(`launch-${o.iconSize || 'm'}`);
    if (o.labels === false) el.classList.add('launch-nolabels');
    el.append(label, wrap);
    if (!services.launcher) return;

    const canAct = typeof services.launcher.launch === 'function';
    const sectionsEnabled = [o.pinned, o.recent, o.running].filter(Boolean).length;

    const tile = (name, fullTitle, icon, onAct) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `launch-tile${canAct ? '' : ' inert'}`;
      button.title = fullTitle || name;
      if (icon) {
        const img = document.createElement('img');
        img.className = 'launch-icon';
        img.alt = '';
        img.src = icon;
        button.appendChild(img);
      } else {
        const mono = document.createElement('span');
        mono.className = 'launch-mono';
        mono.textContent = (name || '?').slice(0, 1).toUpperCase();
        button.appendChild(mono);
      }
      const text = document.createElement('span');
      text.className = 'launch-name';
      text.textContent = name;
      button.appendChild(text);
      if (canAct) button.addEventListener('click', onAct);
      return button;
    };

    const section = (title, tiles) => {
      if (tiles.length === 0) return;
      if (sectionsEnabled > 1) {
        const head = document.createElement('div');
        head.className = 'launch-sec display-case';
        head.textContent = title;
        wrap.appendChild(head);
      }
      const grid = document.createElement('div');
      grid.className = 'launch-grid';
      grid.append(...tiles);
      wrap.appendChild(grid);
    };

    const paint = async () => {
      const res = await services.launcher.state({ running: Boolean(o.running) });
      if (!res.ok) return;
      wrap.textContent = '';
      if (o.pinned) {
        section('Pinned', res.pins.map((p) => tile(p.name, p.name, p.icon, () => services.launcher.launch(p.id))));
      }
      if (o.recent) {
        section('Recent', res.recent.map((r) => tile(r.name, r.name, r.icon, () => services.launcher.launch(r.id))));
      }
      if (o.running) {
        section('Open now', res.running.map((w) => tile(w.name || w.title, w.title, w.icon, () => services.launcher.focus(w.hwnd))));
      }
      if (wrap.childElementCount === 0) {
        const empty = document.createElement('div');
        empty.className = 'launch-empty';
        empty.textContent = 'Pin apps in the manager (Launcher tab).';
        wrap.appendChild(empty);
      }
    };
    paint();
    // Running windows change often; pins/recents also repaint on the
    // launcher:changed broadcast the page subscribes to.
    live.timers.push(setInterval(paint, o.running ? 15000 : 60000));
  }

  const BUILDERS = {
    status: buildStatus,
    clock: buildClock,
    'analog-clock': buildAnalogClock,
    'hud-clock': buildHudClock,
    cores: buildCores,
    sysinfo: buildSysinfo,
    stats: buildStats,
    meter: buildMeter,
    sparkline: buildSparkline,
    text: buildText,
    image: buildImage,
    divider: buildDivider,
    calendar: buildCalendar,
    countdown: buildCountdown,
    weather: buildWeather,
    agenda: buildAgenda,
    notifications: buildNotifications,
    launcher: buildLauncher,
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
