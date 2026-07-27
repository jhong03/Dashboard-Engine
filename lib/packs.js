'use strict';

// Persona Pack skins: load / validate / sanitize.
//
// Schema 2 — the "rich declarative canvas". A pack is packs/<id>/pack.json
// plus image assets. Components are placed freely on a percent-based canvas
// (rect = [x, y, w, h] in % of the window) with z layering, and each can
// override the skin's look locally. Still NO code in packs (CLAUDE.md M2):
// everything below is tokens, and the sanitizer treats every field as
// hostile — merge over defaults, clamp numbers, allowlist enums, drop
// unknowns. Garbage in → nearest sane skin out, never a crash.
//
// Schema 1 packs (fixed 12x8 grid `layout.widgets`) are converted on load,
// so early DIY packs keep working.

const fs = require('fs');
const path = require('path');

const PACK_SCHEMA_VERSION = 2;

// Caps: a manifest is a few KB of JSON, plus room for a handful of inline
// sandboxed-module HTML fragments; assets are a handful of images.
const PACK_FILE_MAX_BYTES = 256 * 1024;
const ASSET_MAX_BYTES = 5 * 1024 * 1024;
const ASSETS_MAX_TOTAL_BYTES = 20 * 1024 * 1024;
const MAX_COMPONENTS = 24;
const MAX_TEXT_CHARS = 200;
// User-adjustable properties (Wallpaper-Engine style): a pack may expose a
// handful of knobs the USER tweaks without editing the pack. Capped so a
// manifest stays small.
const MAX_PROPS = 16;
const MAX_SELECT_OPTIONS = 16;
const PROP_KEY_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;
// A sandboxed module is a self-contained HTML fragment stored inline in the
// component. It never executes in main or the trusted renderer — it only ever
// reaches an isolated, network-less <iframe sandbox> — but we still cap it so a
// pack manifest stays small and can't balloon pack.json. Fragments reference
// pack images via DE.asset() instead of inlining base64, so 24 KB is plenty.
const MAX_MODULE_HTML_CHARS = 24 * 1024;

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,47}$/;
// #RGB, #RRGGBB or #RRGGBBAA — the only colour syntax packs may use.
const HEX_COLOR_PATTERN = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
// Assets: relative path inside the pack, image extensions only.
const ASSET_PATTERN = /^assets\/[a-z0-9._-]+\.(png|jpg|jpeg|webp)$/i;

// Font choices are an allowlist of built-in stacks — packs cannot ship font
// files (parsing attack surface + unlicensable).
const DISPLAY_FONTS = ['rajdhani', 'system-sans', 'system-serif', 'mono'];

// Live values a meter/sparkline may bind to (cpu/mem/disk sampled in the
// main process; battery via the renderer's Battery API).
const BINDS = ['cpu', 'mem', 'disk', 'battery'];

// What a user property may steer. Kept as explicit allowlists so a hostile
// pack can only ever move values that already exist and are already clamped.
const PALETTE_KEYS = ['void', 'glass', 'accent', 'accentBright', 'muted', 'warn', 'gold'];
const TEXTURE_KEYS = ['scanlines', 'grid', 'glow', 'vignette'];
const AMBIENCE_EFFECTS = ['none', 'embers', 'dust', 'snow', 'petals', 'rain', 'sparkle'];

const ASSET_MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };

// ── Small validators ────────────────────────────────────────────────────────

function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

function num(value, min, max, fallback) {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? clamp(n, min, max) : fallback;
}

function int(value, min, max, fallback) {
  return Math.round(num(value, min, max, fallback));
}

function str(value, maxLen, fallback) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim().slice(0, maxLen) : fallback;
}

function bool(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

function color(value, fallback) {
  return typeof value === 'string' && HEX_COLOR_PATTERN.test(value.trim()) ? value.trim() : fallback;
}

function pick(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

function assetPath(value) {
  return typeof value === 'string' && ASSET_PATTERN.test(value) ? value : null;
}

// ── Defaults ────────────────────────────────────────────────────────────────

function defaultPack() {
  return {
    schema: PACK_SCHEMA_VERSION,
    id: 'default',
    name: 'Untitled Pack',
    author: '',
    persona: {
      name: 'AEGIS',
      tagline: '',
      lines: [],
    },
    skin: {
      palette: {
        void: '#04080F',
        glass: '#0A16238C',
        accent: '#3FD8FF',
        accentBright: '#7FE9FF',
        muted: '#5A7E93',
        warn: '#FFB23E',
        gold: '#E8C56A',
      },
      typography: { display: 'rajdhani', uppercase: true, letterSpacing: 0.2 },
      texture: { scanlines: 0.3, grid: 0.2, glow: 0.4, vignette: 0.35 },
      shape: { cornerNotches: true, borderOpacity: 0.28, panelOpacity: 0.55, radius: 0 },
      ambience: { effect: 'none', density: 0.5 },
      wallpaper: null,
      // How an imported wallpaper image maps onto the surface (crop/adjust).
      wallpaperFit: 'cover',   // cover | contain | stretch
      wallpaperPosX: 50,       // focal point %, 0–100 (which part of a cropped image shows)
      wallpaperPosY: 50,
    },
    canvas: { padding: 2 }, // percent margin around the component area
    props: [], // user-adjustable knobs (see sanitizeProps)
    components: [
      { type: 'status', rect: [2, 4, 96, 22], z: 1, style: {}, options: {} },
      { type: 'clock', rect: [2, 32, 44, 40], z: 1, style: {}, options: { format: '24h', seconds: true, showDate: true } },
      { type: 'stats', rect: [50, 32, 48, 40], z: 1, style: {}, options: { cpu: true, mem: true } },
    ],
  };
}

// ── Per-component style overrides ───────────────────────────────────────────
// Every field is optional; null means "inherit the skin". The renderer maps
// these onto element-scoped CSS custom properties.

function sanitizeStyle(raw) {
  const source = typeof raw === 'object' && raw !== null ? raw : {};
  return {
    accent: color(source.accent, null),
    textColor: color(source.textColor, null),
    font: pick(source.font, DISPLAY_FONTS, null),
    fontScale: source.fontScale === undefined ? null : num(source.fontScale, 0.5, 3, null),
    align: pick(source.align, ['left', 'center', 'right'], null),
    place: pick(source.place, ['top', 'center', 'bottom', 'spread'], null),
    panel: typeof source.panel === 'boolean' ? source.panel : null,
    border: typeof source.border === 'boolean' ? source.border : null,
    notches: typeof source.notches === 'boolean' ? source.notches : null,
    opacity: source.opacity === undefined ? null : num(source.opacity, 0.05, 1, null),
    glow: source.glow === undefined ? null : num(source.glow, 0, 1, null),
    padding: source.padding === undefined ? null : int(source.padding, 0, 48, null),
    rotate: source.rotate === undefined ? null : num(source.rotate, -20, 20, null),
  };
}

// ── Component sanitizers (per-type option allowlists) ───────────────────────

const COMPONENT_SANITIZERS = {
  status() {
    return {};
  },
  clock(options) {
    return {
      format: pick(options.format, ['24h', '12h'], '24h'),
      seconds: bool(options.seconds, true),
      showDate: bool(options.showDate, true),
    };
  },
  'analog-clock'(options) {
    return {
      seconds: bool(options.seconds, true),
      numerals: pick(options.numerals, ['none', 'quarters', 'all'], 'quarters'),
      minuteTicks: bool(options.minuteTicks, true),
    };
  },
  // Sci-fi HUD clock: slowly counter-rotating ring layers around a digital
  // readout (the JARVIS "arc reactor" centrepiece).
  'hud-clock'(options) {
    return {
      format: pick(options.format, ['24h', '12h'], '24h'),
      seconds: bool(options.seconds, true),
      showDate: bool(options.showDate, true),
    };
  },
  // Themeable centrepiece clock (the non-sci-fi counterpart to hud-clock):
  // `minimal` (clean thin ring + ticks) or `halo` (soft ring that fills with
  // the seconds). Palette-driven, quiet, fits warm/cozy/minimal/kawaii packs.
  'ring-clock'(options) {
    return {
      style: pick(options.style, ['minimal', 'halo'], 'minimal'),
      format: pick(options.format, ['24h', '12h'], '24h'),
      seconds: bool(options.seconds, true),
      showDate: bool(options.showDate, true),
    };
  },
  // Per-core CPU load bars.
  cores(options) {
    return { label: str(options.label, 24, null) };
  },
  // Key/value machine readouts (memory, disk free, uptime, host, status).
  sysinfo(options) {
    return {
      memory: bool(options.memory, true),
      disk: bool(options.disk, true),
      uptime: bool(options.uptime, true),
      host: bool(options.host, false),
      statusText: str(options.statusText, 40, null),
    };
  },
  stats(options) {
    return {
      cpu: bool(options.cpu, true),
      mem: bool(options.mem, true),
      disk: bool(options.disk, false),
      battery: bool(options.battery, false),
      history: bool(options.history, true),
    };
  },
  meter(options) {
    return {
      bind: pick(options.bind, BINDS, 'cpu'),
      variant: pick(options.variant, ['ring', 'bar'], 'ring'),
      label: str(options.label, 24, null),
      ticks: bool(options.ticks, true),
      readout: bool(options.readout, true),
    };
  },
  sparkline(options) {
    return {
      bind: pick(options.bind, BINDS, 'cpu'),
      label: str(options.label, 24, null),
      grid: bool(options.grid, true),
      readout: bool(options.readout, true),
    };
  },
  text(options) {
    return { text: str(options.text, MAX_TEXT_CHARS, '') };
  },
  image(options) {
    return {
      src: assetPath(options.src),
      fit: pick(options.fit, ['contain', 'cover'], 'contain'),
    };
  },
  // A looping photo slideshow (Apple-widget style): a list of pack image assets
  // the engine cycles through, one at a time, inside the component's box.
  gallery(options) {
    const images = Array.isArray(options.images)
      ? options.images.map(assetPath).filter(Boolean).slice(0, 30)
      : [];
    return {
      images,
      interval: int(options.interval, 2, 120, 6), // seconds per photo
      fit: pick(options.fit, ['cover', 'contain'], 'cover'),
      transition: pick(options.transition, ['fade', 'none'], 'fade'),
      shuffle: bool(options.shuffle, false),
    };
  },
  divider(options) {
    return { orientation: pick(options.orientation, ['h', 'v'], 'h') };
  },
  calendar(options) {
    return {
      weekStart: pick(options.weekStart, ['sun', 'mon'], 'mon'),
      showReminders: bool(options.showReminders, true),
    };
  },
  // Displays the USER'S pinned/recent/running apps (user data, like agenda) —
  // the pack only places/styles the component, never its content.
  launcher(options) {
    return {
      pinned: bool(options.pinned, true),
      recent: bool(options.recent, true),
      running: bool(options.running, false),
      labels: bool(options.labels, true),
      iconSize: pick(options.iconSize, ['s', 'm', 'l'], 'm'),
      label: str(options.label, 24, null),
    };
  },
  // The assistant console: a prompt affordance that opens the AI chat window
  // when clicked on the desktop. Layout/labels only — no secrets in the pack.
  assistant(options) {
    return {
      label: str(options.label, 120, null),
      button: str(options.button, 24, null),
    };
  },
  // "Now playing" from the Windows media session (Spotify / browser / any
  // player) — personal data, like the launcher/notifications. The pack only
  // places/styles it; the current track is read live in main via SMTC.
  nowplaying(options) {
    return {
      showArt: bool(options.showArt, true),
      showControls: bool(options.showControls, true),
      label: str(options.label, 24, null),
    };
  },
  // Audio visualizer: draws the system-audio spectrum (any player) captured via
  // loopback on the desktop. Layout/style only — no data in the pack. Place a
  // `bloom` one full-screen behind other components for a reactive ambience.
  visualizer(options) {
    return {
      style: pick(options.style, ['bars', 'waveform', 'radial', 'bloom'], 'bars'),
    };
  },
  // Displays the USER'S live Windows notifications (personal data, like the
  // launcher/agenda) — the pack only places/styles the component, never its
  // content. Content is read live in main via UserNotificationListener.
  notifications(options) {
    return {
      limit: int(options.limit, 1, 12, 6),
      label: str(options.label, 24, null),
      showApp: bool(options.showApp, true),
    };
  },
  // Displays the USER'S reminders (user data) — the pack only places/styles it.
  agenda(options) {
    return {
      days: int(options.days, 1, 14, 7),
      limit: int(options.limit, 1, 12, 6),
      label: str(options.label, 40, null),
    };
  },
  countdown(options) {
    // Target must parse as a date and stay in a sane window.
    let target = null;
    if (typeof options.target === 'string') {
      const t = Date.parse(options.target);
      if (!Number.isNaN(t) && t > Date.parse('2000-01-01') && t < Date.parse('2100-01-01')) {
        target = new Date(t).toISOString();
      }
    }
    return { target, label: str(options.label, 40, null) };
  },
  weather(options) {
    return {
      lat: num(options.lat, -90, 90, 0),
      lon: num(options.lon, -180, 180, 0),
      place: str(options.place, 40, null),
      details: bool(options.details, true),
      compact: bool(options.compact, false), // one-line strip: place · temp · sky · wind
    };
  },
  // A designer-authored sandboxed component. `html` is a self-contained HTML
  // fragment (markup + inline <style>/<script>) the designer writes; the engine
  // wraps it in a locked-down <iframe sandbox> with a strict CSP (no network, no
  // same-origin, no Node) and feeds it theme + telemetry over postMessage. The
  // pack ships NO trusted code: this string is treated as hostile everywhere
  // except inside that isolated frame. Length-capped; validated as a plain
  // string only (never parsed or run here).
  module(options) {
    return {
      html: str(options.html, MAX_MODULE_HTML_CHARS, ''),
      scroll: bool(options.scroll, false),
      telemetry: bool(options.telemetry, true), // opt out of the stats feed
    };
  },
};

function sanitizeComponent(raw, warnings) {
  if (typeof raw !== 'object' || raw === null) return null;
  const sanitizer = COMPONENT_SANITIZERS[raw.type];
  if (!sanitizer) {
    warnings.push(`Dropped component of unknown type "${String(raw.type).slice(0, 24)}".`);
    return null;
  }
  const rect = Array.isArray(raw.rect) ? raw.rect : [];
  const x = num(rect[0], 0, 99, 0);
  const y = num(rect[1], 0, 99, 0);
  const component = {
    type: raw.type,
    rect: [x, y, num(rect[2], 0.5, 100 - x, 20), num(rect[3], 0.5, 100 - y, 10)],
    z: int(raw.z, 0, 20, 1),
    style: sanitizeStyle(raw.style),
    options: sanitizer(typeof raw.options === 'object' && raw.options !== null ? raw.options : {}, warnings),
  };
  if (component.type === 'image' && !component.options.src) {
    warnings.push('Dropped an image component: src must be assets/<name>.(png|jpg|webp) inside the pack.');
    return null;
  }
  if (component.type === 'text' && component.options.text === '') {
    warnings.push('Dropped a text component with no text.');
    return null;
  }
  return component;
}

// Schema 1 compatibility: widgets on the old fixed 12x8 grid become percent
// rects, and top-level clock/stats options carry straight over.
function convertV1Widgets(widgets, warnings) {
  const components = [];
  for (const w of Array.isArray(widgets) ? widgets : []) {
    if (typeof w !== 'object' || w === null || !Array.isArray(w.area)) continue;
    const col = int(w.area[0], 1, 12, 1);
    const row = int(w.area[1], 1, 8, 1);
    const spanC = int(w.area[2], 1, 12 - col + 1, 1);
    const spanR = int(w.area[3], 1, 8 - row + 1, 1);
    components.push({
      type: w.type,
      rect: [((col - 1) / 12) * 100, ((row - 1) / 8) * 100, (spanC / 12) * 100, (spanR / 8) * 100],
      z: 1,
      style: w.style,
      options: w.options,
    });
  }
  if (components.length > 0) {
    warnings.push('Pack uses the schema-1 grid layout; converted to canvas rects. Consider upgrading to schema 2 (see PACKS.md).');
  }
  return components;
}

// ── User properties (Wallpaper-Engine-style knobs) ──────────────────────────
// A pack declares `props`: controls the USER adjusts (in Manager → pack detail)
// without editing the pack. Each prop binds to ONE existing, already-clamped
// skin field. The user's chosen values live in user data (lib/userprops), never
// in the pack — so exports/forks stay the author's originals.
//
// bindSpec(prop) returns { coerce, apply } for a valid (type, bind) pair, or
// null. coerce(value) → a validated value (or null); apply(pack, value) writes
// it into the sanitized pack. The allowlist below is the whole contract.

function bindSpec(prop) {
  const target = prop.bind && prop.bind.target;
  const key = prop.bind && prop.bind.key;

  if (prop.type === 'color' && target === 'palette' && PALETTE_KEYS.includes(key)) {
    return { coerce: (v) => color(v, null), apply: (pack, v) => { pack.skin.palette[key] = v; } };
  }
  if (prop.type === 'slider' && target === 'ambience' && key === 'density') {
    return { coerce: (v) => num(v, 0.05, 1, null), apply: (pack, v) => { pack.skin.ambience.density = v; } };
  }
  if (prop.type === 'slider' && target === 'texture' && TEXTURE_KEYS.includes(key)) {
    return { coerce: (v) => num(v, 0, 1, null), apply: (pack, v) => { pack.skin.texture[key] = v; } };
  }
  if (prop.type === 'select' && target === 'ambience' && key === 'effect') {
    return { coerce: (v) => pick(v, AMBIENCE_EFFECTS, null), apply: (pack, v) => { pack.skin.ambience.effect = v; } };
  }
  if (prop.type === 'toggle' && target === 'shape' && key === 'cornerNotches') {
    return { coerce: (v) => (typeof v === 'boolean' ? v : null), apply: (pack, v) => { pack.skin.shape.cornerNotches = v; } };
  }
  return null;
}

// Validate one incoming value for a prop (used when the user changes a control).
// Returns the clamped/checked value, or null if it doesn't fit the prop.
function coerceProp(prop, value) {
  const spec = bindSpec(prop);
  if (!spec) return null;
  const c = spec.coerce(value);
  if (c === null) return null;
  if (prop.type === 'slider') return clamp(c, prop.min, prop.max);
  if (prop.type === 'select') return prop.options.some((o) => o.value === c) ? c : null;
  return c;
}

function sanitizeProps(raw, warnings) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const r of raw.slice(0, MAX_PROPS)) {
    if (typeof r !== 'object' || r === null) continue;
    const key = str(r.key, 40, null);
    if (!key || !PROP_KEY_PATTERN.test(key) || seen.has(key)) {
      warnings.push('Dropped a user property with a missing or duplicate key.');
      continue;
    }
    const type = pick(r.type, ['color', 'slider', 'select', 'toggle'], null);
    if (!type) { warnings.push(`Dropped user property "${key}": unknown type.`); continue; }
    const bind = typeof r.bind === 'object' && r.bind !== null ? r.bind : {};
    const prop = {
      key,
      label: str(r.label, 40, key),
      type,
      bind: { target: str(bind.target, 20, ''), key: str(bind.key, 40, '') },
    };
    const spec = bindSpec(prop);
    if (!spec) { warnings.push(`Dropped user property "${key}": unsupported binding.`); continue; }

    if (type === 'slider') {
      prop.min = num(r.min, -1e6, 1e6, 0);
      prop.max = num(r.max, prop.min, 1e6, Math.max(prop.min + 1, 1));
      prop.step = num(r.step, 0.0001, 1e6, 0.05);
      const rawDefault = num(r.default, prop.min, prop.max, prop.min);
      const coerced = spec.coerce(rawDefault);
      prop.default = clamp(coerced === null ? rawDefault : coerced, prop.min, prop.max);
    } else if (type === 'select') {
      const options = [];
      for (const o of (Array.isArray(r.options) ? r.options : []).slice(0, MAX_SELECT_OPTIONS)) {
        if (typeof o !== 'object' || o === null) continue;
        const v = spec.coerce(o.value);
        if (v === null) continue;
        options.push({ value: v, label: str(o.label, 40, String(v)) });
      }
      if (options.length === 0) { warnings.push(`Dropped user property "${key}": no valid options.`); continue; }
      prop.options = options;
      const def = spec.coerce(r.default);
      prop.default = def !== null && options.some((o) => o.value === def) ? def : options[0].value;
    } else { // color, toggle
      const def = spec.coerce(r.default);
      if (def === null) { warnings.push(`Dropped user property "${key}": invalid default.`); continue; }
      prop.default = def;
    }

    seen.add(key);
    out.push(prop);
  }
  return out;
}

/**
 * Overlay the user's chosen property values onto a freshly-loaded pack. Mutates
 * and returns the pack (each loadPack yields a new object, so this is safe).
 * Unknown / invalid overrides fall back to the prop's default.
 */
function applyUserProps(pack, overrides) {
  if (!Array.isArray(pack.props) || pack.props.length === 0) return pack;
  const ov = typeof overrides === 'object' && overrides !== null ? overrides : {};
  for (const prop of pack.props) {
    const spec = bindSpec(prop);
    if (!spec) continue;
    let value = prop.default;
    if (Object.prototype.hasOwnProperty.call(ov, prop.key)) {
      const coerced = coerceProp(prop, ov[prop.key]);
      if (coerced !== null) value = coerced;
    }
    spec.apply(pack, value);
  }
  return pack;
}

// ── Pack sanitizer ──────────────────────────────────────────────────────────

/**
 * Merge an untrusted pack manifest over defaults. Never throws.
 * @returns {{ pack: object, warnings: string[] }}
 */
function sanitizePack(raw, packId) {
  const warnings = [];
  const clean = defaultPack();
  clean.id = ID_PATTERN.test(packId) ? packId : 'default';
  if (typeof raw !== 'object' || raw === null) {
    warnings.push('Pack manifest is not an object; using the default skin.');
    return { pack: clean, warnings };
  }

  if (typeof raw.schema === 'number' && raw.schema > PACK_SCHEMA_VERSION) {
    warnings.push(`Pack schema ${raw.schema} is newer than this app understands (${PACK_SCHEMA_VERSION}).`);
  }
  clean.name = str(raw.name, 60, clean.name);
  clean.author = str(raw.author, 60, clean.author);

  const persona = typeof raw.persona === 'object' && raw.persona !== null ? raw.persona : {};
  clean.persona.name = str(persona.name, 40, clean.persona.name);
  clean.persona.tagline = str(persona.tagline, 80, clean.persona.tagline);
  if (Array.isArray(persona.lines)) {
    clean.persona.lines = persona.lines
      .filter((l) => typeof l === 'string' && l.trim() !== '')
      .slice(0, 8)
      .map((l) => l.trim().slice(0, 80));
  }

  const skin = typeof raw.skin === 'object' && raw.skin !== null ? raw.skin : {};
  const palette = typeof skin.palette === 'object' && skin.palette !== null ? skin.palette : {};
  for (const key of Object.keys(clean.skin.palette)) {
    clean.skin.palette[key] = color(palette[key], clean.skin.palette[key]);
  }

  const typography = typeof skin.typography === 'object' && skin.typography !== null ? skin.typography : {};
  clean.skin.typography.display = pick(typography.display, DISPLAY_FONTS, clean.skin.typography.display);
  clean.skin.typography.uppercase = bool(typography.uppercase, clean.skin.typography.uppercase);
  clean.skin.typography.letterSpacing = num(typography.letterSpacing, 0, 0.4, clean.skin.typography.letterSpacing);

  const texture = typeof skin.texture === 'object' && skin.texture !== null ? skin.texture : {};
  for (const key of Object.keys(clean.skin.texture)) {
    clean.skin.texture[key] = num(texture[key], 0, 1, clean.skin.texture[key]);
  }

  const shape = typeof skin.shape === 'object' && skin.shape !== null ? skin.shape : {};
  clean.skin.shape.cornerNotches = bool(shape.cornerNotches, clean.skin.shape.cornerNotches);
  clean.skin.shape.borderOpacity = num(shape.borderOpacity, 0.05, 1, clean.skin.shape.borderOpacity);
  clean.skin.shape.panelOpacity = num(shape.panelOpacity, 0, 1, clean.skin.shape.panelOpacity);
  clean.skin.shape.radius = int(shape.radius, 0, 16, clean.skin.shape.radius);

  // Ambience is declarative like everything else: an effect name and a
  // density — the engine draws it, packs never ship animation code.
  const ambience = typeof skin.ambience === 'object' && skin.ambience !== null ? skin.ambience : {};
  clean.skin.ambience.effect = pick(ambience.effect, AMBIENCE_EFFECTS, clean.skin.ambience.effect);
  clean.skin.ambience.density = num(ambience.density, 0.05, 1, clean.skin.ambience.density);

  if (typeof skin.wallpaper === 'string') {
    if (assetPath(skin.wallpaper)) {
      clean.skin.wallpaper = skin.wallpaper;
    } else {
      warnings.push('Wallpaper path rejected — must be assets/<name>.(png|jpg|webp) inside the pack.');
    }
  }
  // How the wallpaper image is fitted/cropped (harmless when there's no image).
  clean.skin.wallpaperFit = pick(skin.wallpaperFit, ['cover', 'contain', 'stretch'], clean.skin.wallpaperFit);
  clean.skin.wallpaperPosX = num(skin.wallpaperPosX, 0, 100, clean.skin.wallpaperPosX);
  clean.skin.wallpaperPosY = num(skin.wallpaperPosY, 0, 100, clean.skin.wallpaperPosY);

  const canvas = typeof raw.canvas === 'object' && raw.canvas !== null ? raw.canvas : {};
  clean.canvas.padding = num(canvas.padding, 0, 12, clean.canvas.padding);

  clean.props = sanitizeProps(raw.props, warnings);

  // Components: schema 2 `components`, falling back to schema 1 `layout.widgets`.
  let rawComponents = Array.isArray(raw.components) ? raw.components : null;
  if (!rawComponents && typeof raw.layout === 'object' && raw.layout !== null) {
    rawComponents = convertV1Widgets(raw.layout.widgets, warnings);
  }
  if (rawComponents) {
    if (rawComponents.length > MAX_COMPONENTS) {
      warnings.push(`Pack declares ${rawComponents.length} components; only the first ${MAX_COMPONENTS} are kept.`);
    }
    const components = rawComponents
      .slice(0, MAX_COMPONENTS)
      .map((c) => sanitizeComponent(c, warnings))
      .filter(Boolean);
    if (components.length > 0) clean.components = components;
  }

  return { pack: clean, warnings };
}

// ── Disk access ─────────────────────────────────────────────────────────────

function packsDir(appRoot) {
  return path.join(appRoot, 'packs');
}

function packDir(appRoot, id) {
  return path.join(packsDir(appRoot), id);
}

// Engine/content split: built-in reference packs live in the repo, installed
// packs live in user data. Built-in ids are reserved (the installer refuses
// them), so resolution order is builtin → installed.
function resolvePackDir(appRoot, userDir, id) {
  const safeId = ID_PATTERN.test(String(id)) ? String(id) : 'default';
  const builtin = packDir(appRoot, safeId);
  if (fs.existsSync(path.join(builtin, 'pack.json'))) return { dir: builtin, origin: 'builtin' };
  const installed = path.join(userDir, 'packs', safeId);
  if (fs.existsSync(path.join(installed, 'pack.json'))) return { dir: installed, origin: 'installed' };
  return { dir: builtin, origin: 'missing' }; // loadPack will warn + default
}

function listDirIds(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && ID_PATTERN.test(e.name))
      .map((e) => e.name);
  } catch {
    return null;
  }
}

/** List built-in + installed packs (id, display metadata, origin). Never throws. */
function listPacks(appRoot, userDir) {
  const warnings = [];
  const builtinIds = listDirIds(packsDir(appRoot));
  if (builtinIds === null) warnings.push('No built-in packs directory found.');
  const installedIds = (listDirIds(path.join(userDir, 'packs')) || [])
    .filter((id) => {
      if ((builtinIds || []).includes(id)) {
        warnings.push(`Installed pack "${id}" shadows a built-in id and is ignored.`);
        return false;
      }
      return true;
    });

  const packs = [];
  for (const [ids, origin] of [[builtinIds || [], 'builtin'], [installedIds, 'installed']]) {
    for (const id of ids) {
      const loaded = loadPack(appRoot, userDir, id);
      packs.push({ id, origin, name: loaded.pack.name, author: loaded.pack.author, warnings: loaded.warnings });
    }
  }
  packs.sort((a, b) => a.name.localeCompare(b.name));
  return { packs, warnings };
}

/** Load + sanitize one pack from either root. Never throws. */
function loadPack(appRoot, userDir, id) {
  const safeId = ID_PATTERN.test(String(id)) ? String(id) : 'default';
  const resolved = resolvePackDir(appRoot, userDir, safeId);
  const file = path.join(resolved.dir, 'pack.json');
  let raw = null;
  const warnings = [];
  try {
    const stat = fs.statSync(file);
    if (stat.size > PACK_FILE_MAX_BYTES) {
      warnings.push(`pack.json is ${stat.size} bytes (max ${PACK_FILE_MAX_BYTES}); using the default skin.`);
    } else {
      // Strip a UTF-8 BOM (U+FEFF) — Notepad and PowerShell add one, and
      // JSON.parse rejects it. DIY authors on Windows hit this constantly.
      const text = fs.readFileSync(file, 'utf8');
      raw = JSON.parse(text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text);
    }
  } catch (err) {
    warnings.push(`Pack "${safeId}" is unreadable (${err.message}); using the default skin.`);
  }
  if (raw === null) {
    // Already warned above; skip the sanitizer's redundant "not an object".
    const pack = defaultPack();
    pack.id = safeId;
    return { pack, warnings, dir: resolved.dir, origin: resolved.origin };
  }
  const result = sanitizePack(raw, safeId);
  return { pack: result.pack, warnings: [...warnings, ...result.warnings], dir: resolved.dir, origin: resolved.origin };
}

// Read one validated pack asset as a data: URI. Containment + size are
// re-checked here even though the sanitizer validated the path shape.
function assetDataUri(dir, relPath, budget) {
  const full = path.resolve(dir, relPath);
  if (!full.startsWith(path.resolve(dir) + path.sep)) {
    return { uri: null, bytes: 0, warning: `Asset "${relPath}" escapes the pack directory — ignored.` };
  }
  try {
    const stat = fs.statSync(full);
    if (stat.size > ASSET_MAX_BYTES) {
      return { uri: null, bytes: 0, warning: `Asset "${relPath}" is ${(stat.size / 1048576).toFixed(1)} MB (max ${ASSET_MAX_BYTES / 1048576} MB) — ignored.` };
    }
    if (budget.used + stat.size > ASSETS_MAX_TOTAL_BYTES) {
      return { uri: null, bytes: 0, warning: `Asset "${relPath}" skipped — the pack exceeds ${ASSETS_MAX_TOTAL_BYTES / 1048576} MB of images.` };
    }
    budget.used += stat.size;
    const mime = ASSET_MIME[path.extname(full).toLowerCase()];
    return { uri: `data:${mime};base64,${fs.readFileSync(full).toString('base64')}`, bytes: stat.size, warning: null };
  } catch {
    return { uri: null, bytes: 0, warning: `Asset "${relPath}" is missing — ignored.` };
  }
}

/**
 * Collect every asset the pack references (wallpaper + image components) as
 * data: URIs from the pack's resolved directory, deduped, within a total
 * byte budget.
 * @returns {{ assets: Object<string,string>, warnings: string[] }}
 */
function collectAssets(dir, pack) {
  const wanted = new Set();
  if (pack.skin.wallpaper) wanted.add(pack.skin.wallpaper);
  for (const component of pack.components) {
    if (component.type === 'image' && component.options.src) wanted.add(component.options.src);
    if (component.type === 'gallery' && Array.isArray(component.options.images)) {
      for (const src of component.options.images) wanted.add(src);
    }
  }
  const assets = {};
  const warnings = [];
  const budget = { used: 0 };
  for (const relPath of wanted) {
    const result = assetDataUri(dir, relPath, budget);
    if (result.uri) assets[relPath] = result.uri;
    if (result.warning) warnings.push(result.warning);
  }
  return { assets, warnings };
}

module.exports = {
  PACK_SCHEMA_VERSION,
  MAX_COMPONENTS,
  defaultPack,
  sanitizePack,
  listPacks,
  loadPack,
  packDir,
  resolvePackDir,
  collectAssets,
  applyUserProps,
  coerceProp,
};
