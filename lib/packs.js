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
// Background layers (Phase B): a pack composes up to 6 image/video layers,
// back-to-front, each with a parallax depth. A legacy pack that only sets
// skin.wallpaper is normalized to a single depth-0 layer (see sanitizePack).
const MAX_BG_LAYERS = 6;
// WebGL background effects (Phase C): each layer may carry up to 3 shader
// effects. Types are an allowlist; unknown types are dropped (forward-compat).
const MAX_EFFECTS_PER_LAYER = 3;
const EFFECT_TYPES = ['ripple', 'sway', 'drift-warp', 'pulse', 'cursor-ripple', 'waves', 'shimmer', 'shake', 'spin', 'scroll', 'chroma-shift'];
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
// Video wallpapers are a separate class: streamed over depack:// (never
// base64'd into the assets map — a short loop is still tens of MB), so they get
// their own path pattern, extension list and a much larger size cap.
const VIDEO_PATTERN = /^assets\/[a-z0-9._-]+\.(mp4|webm)$/i;
const VIDEO_EXTS = ['.mp4', '.webm'];
const VIDEO_MIME = { '.mp4': 'video/mp4', '.webm': 'video/webm' };
const VIDEO_MAX_BYTES = 30 * 1024 * 1024;

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

// True when a pack ref points at a video (mp4/webm). One function so every
// surface classifies identically — image path vs. streamed depack:// path.
function isVideoAsset(relPath) {
  return typeof relPath === 'string' && VIDEO_EXTS.includes(path.extname(relPath).toLowerCase());
}

// A wallpaper (and, in Phase B, a background layer) may be an image OR a video.
// `assetPath` stays strictly image-only so image/gallery components can never
// smuggle a video into the base64 path.
function mediaPath(value) {
  if (assetPath(value)) return value;
  return typeof value === 'string' && VIDEO_PATTERN.test(value) ? value : null;
}

// A background effect's optional region: confine the effect to a rect/ellipse in
// layer-percent coords, with a soft feathered edge. null when absent/invalid.
function sanitizeRegion(raw) {
  if (typeof raw !== 'object' || raw === null) return null;
  const shape = pick(raw.shape, ['rect', 'ellipse'], null);
  if (!shape) return null;
  return {
    shape,
    x: num(raw.x, 0, 100, 0), y: num(raw.y, 0, 100, 0),
    w: num(raw.w, 0, 100, 100), h: num(raw.h, 0, 100, 100),
    feather: num(raw.feather, 0, 50, 0),
  };
}

// One shader effect on a background layer. Every numeric param is clamped to an
// explicit range with a sane default; an unknown type is dropped (not an error)
// so a newer pack degrades gracefully on an older engine.
function sanitizeEffect(raw, warnings) {
  if (typeof raw !== 'object' || raw === null) return null;
  const type = raw.type;
  if (!EFFECT_TYPES.includes(type)) {
    warnings.push(`Dropped an unknown background effect "${String(type).slice(0, 24)}".`);
    return null;
  }
  const base = { type };
  const mask = assetPath(raw.mask); // image only; used as a multiply mask
  if (mask) {
    // A painted mask and a rect/ellipse region both scope an effect; if both are
    // given the mask wins (locked decision), so drop the region to keep the
    // shader path unambiguous. Only a mask-less effect keeps its region.
    base.mask = mask;
  } else {
    const region = sanitizeRegion(raw.region);
    if (region) base.region = region;
  }
  if (type === 'ripple') {
    return { ...base, speed: num(raw.speed, 0, 3, 1), scale: num(raw.scale, 0.5, 8, 3), strength: num(raw.strength, 0, 1, 0.5) };
  }
  if (type === 'sway') {
    return { ...base, speed: num(raw.speed, 0, 3, 0.5), strength: num(raw.strength, 0, 1, 0.5), direction: num(raw.direction, 0, 360, 0) };
  }
  if (type === 'drift-warp') {
    return { ...base, speed: num(raw.speed, 0, 3, 0.5), scale: num(raw.scale, 0.5, 8, 3) };
  }
  if (type === 'pulse') {
    return { ...base, speed: num(raw.speed, 0, 3, 1), amount: num(raw.amount, 0, 1, 0.3), paletteKey: pick(raw.paletteKey, PALETTE_KEYS, null) };
  }
  // Directional travelling sine ripple: waves march along `angle`; `wavelength`
  // sets their spacing (bigger = longer, calmer swells).
  if (type === 'waves') {
    return { ...base, angle: num(raw.angle, 0, 360, 0), wavelength: num(raw.wavelength, 0.5, 8, 2), speed: num(raw.speed, 0, 3, 0.6), strength: num(raw.strength, 0, 1, 0.5) };
  }
  // Sparkle-noise brighten gated by the mask/region (glints on water, dust motes
  // catching light). `density` = how many sparkles, `speed` = twinkle rate.
  if (type === 'shimmer') {
    return { ...base, density: num(raw.density, 0, 1, 0.5), speed: num(raw.speed, 0, 3, 1) };
  }
  // Whole-layer jitter. `amplitude` is HARD-clamped (0–1 maps to ≤0.008 UV in the
  // shader) — a big screen-shake is motion-sickness bait, so the ceiling is tiny.
  if (type === 'shake') {
    return { ...base, speed: num(raw.speed, 0, 3, 1), amplitude: num(raw.amplitude, 0, 1, 0.3) };
  }
  // Region-centred swirl; rotation eases off with distance over `radius`.
  if (type === 'spin') {
    return { ...base, speed: num(raw.speed, 0, 3, 0.5), radius: num(raw.radius, 0.05, 1, 0.5) };
  }
  // UV scroll with wrap (drifting clouds / starfields). Best with a tileable
  // texture; `angle` sets the drift direction, `speed` the rate.
  if (type === 'scroll') {
    return { ...base, angle: num(raw.angle, 0, 360, 0), speed: num(raw.speed, 0, 3, 0.5) };
  }
  // Subtle RGB split oscillation (dreamy/glitch). `amount` is capped small
  // (0–1 → ≤0.01 UV) so it reads as a shimmer of colour, not a broken image.
  if (type === 'chroma-shift') {
    return { ...base, amount: num(raw.amount, 0, 1, 0.4), speed: num(raw.speed, 0, 3, 1) };
  }
  // cursor-ripple — `speed` is how fast a ring expands (higher = snappier, less
  // "laggy"); `decay` how quickly it fades.
  return { ...base, strength: num(raw.strength, 0, 1, 0.5), speed: num(raw.speed, 0.2, 3, 1.4), decay: num(raw.decay, 0.2, 3, 1) };
}

function sanitizeEffects(raw, warnings) {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, MAX_EFFECTS_PER_LAYER).map((e) => sanitizeEffect(e, warnings)).filter(Boolean);
}

// ── Custom particle system (Particle Studio, Phase E) ────────────────────────
// The ambience "custom" mode: a fully data-driven particle definition. Every
// field is clamped to the same ranges the editor exposes and the engine expects
// (src/particles.js). Only written when the pack opts into custom mode, so the
// 7 built-in presets (which carry no `system`) stay byte-identical.
const EMITTER_SHAPES = ['screen', 'top', 'bottom', 'left', 'right', 'point', 'mask'];
const BUILTIN_SPRITES = ['dot', 'streak', 'flake', 'leaf', 'note', 'spark', 'ring'];
const OPACITY_LIFES = ['fadeInOut', 'fadeOut', 'constant'];
const PARTICLE_BLENDS = ['normal', 'screen', 'additive'];
const POINTER_MODES = ['none', 'attract', 'repel'];

function sanitizeParticleSystem(raw) {
  const r = (typeof raw === 'object' && raw !== null) ? raw : {};
  const em = (typeof r.emitter === 'object' && r.emitter !== null) ? r.emitter : {};
  const sp = (typeof r.sprite === 'object' && r.sprite !== null) ? r.sprite : {};
  const cl = (typeof r.color === 'object' && r.color !== null) ? r.color : {};
  const pt = (typeof r.pointer === 'object' && r.pointer !== null) ? r.pointer : {};

  const emitter = { shape: pick(em.shape, EMITTER_SHAPES, 'screen'), x: num(em.x, 0, 100, 50), y: num(em.y, 0, 100, 50) };
  const emMask = assetPath(em.mask); if (emMask) emitter.mask = emMask;

  const sprite = { builtin: pick(sp.builtin, BUILTIN_SPRITES, 'dot') };
  const spCustom = assetPath(sp.custom); if (spCustom) sprite.custom = spCustom;

  const colorOut = { paletteKey: (cl.paletteKey === 'custom' || PALETTE_KEYS.includes(cl.paletteKey)) ? cl.paletteKey : 'accent', jitter: num(cl.jitter, 0, 1, 0) };
  const customHex = color(cl.custom, null); if (customHex) colorOut.custom = customHex;

  let sizeMin = num(r.sizeMin, 0.1, 8, 0.4), sizeMax = num(r.sizeMax, 0.1, 8, 1);
  if (sizeMin > sizeMax) { const s = sizeMin; sizeMin = sizeMax; sizeMax = s; }
  let speedMin = num(r.speedMin, 0, 30, 1), speedMax = num(r.speedMax, 0, 30, 4);
  if (speedMin > speedMax) { const s = speedMin; speedMin = speedMax; speedMax = s; }

  return {
    emitter, sprite,
    count: int(r.count, 1, 400, 60),
    sizeMin, sizeMax, speedMin, speedMax,
    direction: num(r.direction, 0, 360, 180),
    spread: num(r.spread, 0, 180, 20),
    gravity: num(r.gravity, -20, 20, 0),
    wind: num(r.wind, -20, 20, 0),
    drag: num(r.drag, 0, 1, 0),
    color: colorOut,
    opacityLife: pick(r.opacityLife, OPACITY_LIFES, 'fadeOut'),
    rotate: num(r.rotate, 0, 10, 0),
    wobble: num(r.wobble, 0, 10, 0),
    blend: pick(r.blend, PARTICLE_BLENDS, 'normal'),
    pointer: { mode: pick(pt.mode, POINTER_MODES, 'none'), radius: num(pt.radius, 5, 60, 20), strength: num(pt.strength, 0, 1, 0.5) },
  };
}

// Base surface fill: a CSS gradient painted behind the wallpaper layer stack,
// instead of the flat void colour. A stop's colour is either a palette token
// (void/glass/accent/…) so it tracks the colourway, or a literal hex. type
// 'solid' (or fewer than 2 stops) falls back to the plain void colour.
const FILL_TYPES = ['solid', 'linear', 'radial', 'conic', 'mesh'];
function sanitizeFill(raw) {
  const base = { type: 'solid', preset: 'none', angle: 155, posX: 50, posY: 50, stops: [], animate: false, grain: false };
  if (typeof raw !== 'object' || raw === null) return base;
  const type = pick(raw.type, FILL_TYPES, 'solid');
  const stops = [];
  for (const rs of (Array.isArray(raw.stops) ? raw.stops : []).slice(0, 6)) {
    if (typeof rs !== 'object' || rs === null) continue;
    // A palette token tracks the colourway; anything else must be a valid hex.
    const c = (typeof rs.color === 'string' && PALETTE_KEYS.includes(rs.color)) ? rs.color : color(rs.color, null);
    if (!c) continue;
    stops.push({ color: c, at: num(rs.at, 0, 100, 0) });
  }
  return {
    type,
    preset: str(raw.preset, 24, type === 'solid' ? 'none' : type),
    angle: num(raw.angle, 0, 360, 155),
    posX: num(raw.posX, 0, 100, 50),
    posY: num(raw.posY, 0, 100, 50),
    stops,
    animate: bool(raw.animate, false),
    grain: bool(raw.grain, false),
  };
}

// ── Defaults ────────────────────────────────────────────────────────────────

function defaultPack() {
  return {
    schema: PACK_SCHEMA_VERSION,
    id: 'default',
    name: 'Untitled Pack',
    author: '',
    persona: {
      name: 'Dashboard',
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
      // Playback knobs for a video wallpaper (ignored when the wallpaper is an
      // image). Muting is forced in the renderer — never a field here — because
      // pack audio is out of scope; background music is the separate feature.
      wallpaperVideo: { playbackRate: 1 }, // 0.25–2
      // Layered parallax background (Phase B). Empty by default; a wallpaper-only
      // pack is normalized into a single depth-0 layer at the end of sanitizePack.
      background: {
        layers: [], parallax: { strength: 1, axis: 'both' },
        // Base surface fill painted behind the layer stack (a gradient instead of
        // the flat void colour). type 'solid' = just palette.void.
        fill: { type: 'solid', preset: 'none', angle: 155, posX: 50, posY: 50, stops: [], animate: false, grain: false },
      },
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
  // readout (the hud-clock reactor-ring centrepiece).
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
      // Live health line: when on, the Status readout reflects real CPU / memory
      // / disk / battery thresholds instead of a fixed motto (see buildSysinfo).
      // statusText becomes the "all clear" text.
      health: bool(options.health, false),
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
  // Focus / Pomodoro timer. The countdown itself is MAIN-backed (wall-clock,
  // persisted in user data) so it survives the performance freeze — the pack
  // only carries the display and the DEFAULT durations/behaviour. No personal
  // timing state is ever stored in a pack (see lib/pomodoro.js).
  pomodoro(options) {
    return {
      focusMin: int(options.focusMin, 1, 180, 25),
      shortBreakMin: int(options.shortBreakMin, 1, 180, 5),  // the "short" Break choice
      longBreakMin: int(options.longBreakMin, 1, 180, 15),   // the "long" Break choice
      cyclesBeforeLong: int(options.cyclesBeforeLong, 1, 12, 4), // focus-session pips before the tally wraps
      sound: bool(options.sound, true),          // Web-Audio chime at phase end (desktop, when active)
      notify: bool(options.notify, true),         // desktop notification at phase end
      showPips: bool(options.showPips, true),     // draw the cycle dots
    };
  },
  // Per-app volume mixer (Windows Core Audio) — displays the USER'S running audio
  // apps (personal data, like the launcher); the pack only places/styles it and
  // sets a couple of display options. The live sessions are read in main.
  mixer(options) {
    return {
      showMaster: bool(options.showMaster, true), // a system master slider on top
      label: str(options.label, 24, null),
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
  // Optional recolour + motion. A palette TOKEN (tracks the colourway) OR a custom
  // hex; a speed multiplier; additive glow. Absent/invalid → the effect's built-in
  // default colour, normal speed, flat blend — so older packs render identically.
  if (typeof ambience.colorKey === 'string' && PALETTE_KEYS.includes(ambience.colorKey)) {
    clean.skin.ambience.colorKey = ambience.colorKey;
  }
  const ambColor = color(ambience.color, null);
  if (ambColor) clean.skin.ambience.color = ambColor;
  clean.skin.ambience.speed = num(ambience.speed, 0.2, 3, 1);
  clean.skin.ambience.glow = bool(ambience.glow, false);
  // Particle Studio (Phase E): an optional fully-custom particle system. Only
  // written for a pack that opts into custom mode — a preset pack carries no
  // `mode`/`system`, so it stays byte-identical and renders via the built-in
  // preset engine. Named user presets (saved from the editor) ride alongside.
  if (ambience.mode === 'custom') {
    clean.skin.ambience.mode = 'custom';
    clean.skin.ambience.system = sanitizeParticleSystem(ambience.system);
  }
  if (Array.isArray(ambience.presets)) {
    const saved = [];
    for (const up of ambience.presets.slice(0, 12)) {
      if (typeof up !== 'object' || up === null) continue;
      const name = str(up.name, 40, '').trim();
      if (name) saved.push({ name, system: sanitizeParticleSystem(up.system) });
    }
    if (saved.length) clean.skin.ambience.presets = saved;
  }

  if (typeof skin.wallpaper === 'string') {
    if (mediaPath(skin.wallpaper)) {
      clean.skin.wallpaper = skin.wallpaper;
    } else {
      warnings.push('Wallpaper path rejected — must be assets/<name>.(png|jpg|webp|mp4|webm) inside the pack.');
    }
  }
  // How the wallpaper image/video is fitted/cropped (harmless when there's none).
  clean.skin.wallpaperFit = pick(skin.wallpaperFit, ['cover', 'contain', 'stretch'], clean.skin.wallpaperFit);
  clean.skin.wallpaperPosX = num(skin.wallpaperPosX, 0, 100, clean.skin.wallpaperPosX);
  clean.skin.wallpaperPosY = num(skin.wallpaperPosY, 0, 100, clean.skin.wallpaperPosY);
  const wpv = typeof skin.wallpaperVideo === 'object' && skin.wallpaperVideo !== null ? skin.wallpaperVideo : {};
  clean.skin.wallpaperVideo = { playbackRate: num(wpv.playbackRate, 0.25, 2, 1) };

  // Background layers + parallax (Phase B). Each layer is an image OR a video,
  // with a parallax depth (0 = fixed, 1 = full move) and an optional drift.
  const bg = typeof skin.background === 'object' && skin.background !== null ? skin.background : {};
  const rawLayers = Array.isArray(bg.layers) ? bg.layers : [];
  if (rawLayers.length > MAX_BG_LAYERS) {
    warnings.push(`Pack declares ${rawLayers.length} background layers; only the first ${MAX_BG_LAYERS} are kept.`);
  }
  const layers = [];
  for (const rl of rawLayers.slice(0, MAX_BG_LAYERS)) {
    if (typeof rl !== 'object' || rl === null) continue;
    const src = mediaPath(rl.src);
    if (!src) { warnings.push('Dropped a background layer — src must be assets/<name>.(png|jpg|webp|mp4|webm).'); continue; }
    const drift = typeof rl.drift === 'object' && rl.drift !== null ? rl.drift : {};
    layers.push({
      src,
      depth: num(rl.depth, 0, 1, 0),
      fit: pick(rl.fit, ['cover', 'contain', 'stretch'], 'cover'),
      posX: num(rl.posX, 0, 100, 50),
      posY: num(rl.posY, 0, 100, 50),
      opacity: num(rl.opacity, 0.05, 1, 1),
      // Drift velocity in px/s at the 1920 design basis (the renderer converts).
      drift: { x: num(drift.x, -20, 20, 0), y: num(drift.y, -20, 20, 0) },
      // WebGL shader effects (Phase C); [] when none / no GL.
      effects: sanitizeEffects(rl.effects, warnings),
    });
  }
  const parallax = typeof bg.parallax === 'object' && bg.parallax !== null ? bg.parallax : {};
  clean.skin.background = {
    layers,
    parallax: {
      strength: num(parallax.strength, 0, 2, 1),
      axis: pick(parallax.axis, ['both', 'x', 'y'], 'both'),
    },
    fill: sanitizeFill(bg.fill),
  };

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

  // Normalize wallpaper <-> background layers so the RENDERER consumes only
  // `background.layers`, while `skin.wallpaper` stays meaningful for older
  // engines. Two directions, done in ONE place:
  //   - a legacy pack (wallpaper only) → one depth-0 layer synthesized
  //   - a single depth-0-layer pack → skin.wallpaper kept in sync
  // A multi-layer pack leaves skin.wallpaper as authored (best-effort legacy).
  const bgLayers = clean.skin.background.layers;
  if (bgLayers.length === 0 && clean.skin.wallpaper) {
    bgLayers.push({
      src: clean.skin.wallpaper,
      depth: 0,
      fit: clean.skin.wallpaperFit,
      posX: clean.skin.wallpaperPosX,
      posY: clean.skin.wallpaperPosY,
      opacity: 1,
      drift: { x: 0, y: 0 },
      effects: [],
    });
  } else if (bgLayers.length === 1 && bgLayers[0].depth === 0) {
    clean.skin.wallpaper = bgLayers[0].src;
    clean.skin.wallpaperFit = bgLayers[0].fit;
    clean.skin.wallpaperPosX = bgLayers[0].posX;
    clean.skin.wallpaperPosY = bgLayers[0].posY;
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
  // Background layer images (the sanitizer normalized any wallpaper into a
  // layer). Video layers never enter the base64 path — they stream over
  // depack:// (see collectVideoRefs / lib/videostore).
  for (const layer of (pack.skin.background && pack.skin.background.layers) || []) {
    if (layer.src && !isVideoAsset(layer.src)) wanted.add(layer.src);
    // Effect mask images (Phase C) are base64'd like any image so the GL shader
    // can sample them.
    for (const fx of Array.isArray(layer.effects) ? layer.effects : []) {
      if (fx.mask) wanted.add(fx.mask);
    }
  }
  for (const component of pack.components) {
    if (component.type === 'image' && component.options.src) wanted.add(component.options.src);
    if (component.type === 'gallery' && Array.isArray(component.options.images)) {
      for (const src of component.options.images) wanted.add(src);
    }
  }
  // Custom ambience particle system (Phase E): a custom sprite and/or a mask
  // emitter are pack images, base64'd like everything else so they travel in
  // exports/publish. Saved user presets may reference the same asset kinds.
  const amb = pack.skin.ambience;
  const addSystemAssets = (s) => {
    if (!s || typeof s !== 'object') return;
    if (s.sprite && s.sprite.custom) wanted.add(s.sprite.custom);
    if (s.emitter && s.emitter.mask) wanted.add(s.emitter.mask);
  };
  if (amb && amb.mode === 'custom') addSystemAssets(amb.system);
  for (const up of (amb && Array.isArray(amb.presets) ? amb.presets : [])) addSystemAssets(up.system);
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

/**
 * Video assets the pack references (the wallpaper today; background layers in a
 * later phase), deduped. These stream over depack:// and are NEVER base64'd
 * into `collectAssets` — main resolves each to a path via lib/videostore.
 * @returns {string[]} relative asset paths
 */
function collectVideoRefs(pack) {
  const refs = new Set();
  for (const layer of (pack.skin.background && pack.skin.background.layers) || []) {
    if (layer.src && isVideoAsset(layer.src)) refs.add(layer.src);
  }
  return [...refs];
}

/**
 * Resolve a pack video ref to an absolute path, re-checking containment,
 * existence and the 30 MB cap (mirrors assetDataUri's containment check). The
 * path shape was validated by the sanitizer, but every access re-verifies.
 * @returns {{ path: string|null, warning: string|null }}
 */
function videoPathFor(dir, relPath) {
  if (!isVideoAsset(relPath)) {
    return { path: null, warning: `Video "${relPath}" has an unsupported type — ignored.` };
  }
  const full = path.resolve(dir, relPath);
  if (!full.startsWith(path.resolve(dir) + path.sep)) {
    return { path: null, warning: `Video "${relPath}" escapes the pack directory — ignored.` };
  }
  try {
    const stat = fs.statSync(full);
    if (stat.size > VIDEO_MAX_BYTES) {
      return { path: null, warning: `Video "${relPath}" is ${(stat.size / 1048576).toFixed(1)} MB (max ${VIDEO_MAX_BYTES / 1048576} MB) — ignored.` };
    }
    return { path: full, warning: null };
  } catch {
    return { path: null, warning: `Video "${relPath}" is missing — ignored.` };
  }
}

module.exports = {
  PACK_SCHEMA_VERSION,
  MAX_COMPONENTS,
  MAX_BG_LAYERS,
  defaultPack,
  sanitizePack,
  listPacks,
  loadPack,
  packDir,
  resolvePackDir,
  collectAssets,
  collectVideoRefs,
  videoPathFor,
  isVideoAsset,
  VIDEO_EXTS,
  VIDEO_MIME,
  VIDEO_MAX_BYTES,
  applyUserProps,
  coerceProp,
};
