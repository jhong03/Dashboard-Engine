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

// Caps: a manifest is a few KB of JSON; assets are a handful of images.
const PACK_FILE_MAX_BYTES = 64 * 1024;
const ASSET_MAX_BYTES = 5 * 1024 * 1024;
const ASSETS_MAX_TOTAL_BYTES = 20 * 1024 * 1024;
const MAX_COMPONENTS = 24;
const MAX_TEXT_CHARS = 200;

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
      wallpaper: null,
    },
    canvas: { padding: 2 }, // percent margin around the component area
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
    return { seconds: bool(options.seconds, true) };
  },
  stats(options) {
    return {
      cpu: bool(options.cpu, true),
      mem: bool(options.mem, true),
      disk: bool(options.disk, false),
      battery: bool(options.battery, false),
    };
  },
  meter(options) {
    return {
      bind: pick(options.bind, BINDS, 'cpu'),
      variant: pick(options.variant, ['ring', 'bar'], 'ring'),
      label: str(options.label, 24, null),
    };
  },
  sparkline(options) {
    return {
      bind: pick(options.bind, BINDS, 'cpu'),
      label: str(options.label, 24, null),
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
  divider(options) {
    return { orientation: pick(options.orientation, ['h', 'v'], 'h') };
  },
  calendar(options) {
    return {
      weekStart: pick(options.weekStart, ['sun', 'mon'], 'mon'),
      showReminders: bool(options.showReminders, true),
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

  if (typeof skin.wallpaper === 'string') {
    if (assetPath(skin.wallpaper)) {
      clean.skin.wallpaper = skin.wallpaper;
    } else {
      warnings.push('Wallpaper path rejected — must be assets/<name>.(png|jpg|webp) inside the pack.');
    }
  }

  const canvas = typeof raw.canvas === 'object' && raw.canvas !== null ? raw.canvas : {};
  clean.canvas.padding = num(canvas.padding, 0, 12, clean.canvas.padding);

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
};
