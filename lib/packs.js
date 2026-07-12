'use strict';

// Persona Pack skins: load / validate / sanitize.
//
// A pack is a directory under packs/<id>/ holding pack.json plus optional
// image assets. Packs are UNTRUSTED third-party content by design (CLAUDE.md
// M2): everything is design tokens and declarative layout — no CSS, no JS,
// no font files. The sanitizer mirrors profiles.js: merge over defaults,
// clamp every number, allowlist every enum, drop everything unknown. Garbage
// in → nearest sane skin out, never a crash.

const fs = require('fs');
const path = require('path');

const PACK_SCHEMA_VERSION = 1;

// Caps: a manifest is a few KB of JSON; a wallpaper is one image.
const PACK_FILE_MAX_BYTES = 64 * 1024;
const WALLPAPER_MAX_BYTES = 5 * 1024 * 1024;

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,47}$/;
// #RGB, #RRGGBB or #RRGGBBAA — the only colour syntax packs may use.
const HEX_COLOR_PATTERN = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
// Wallpaper: relative path inside the pack, image extensions only.
const ASSET_PATTERN = /^assets\/[a-z0-9._-]+\.(png|jpg|jpeg|webp)$/i;

// The dashboard grid is fixed in M2; packs place widgets on it.
const GRID_COLUMNS = 12;
const GRID_ROWS = 8;
const MAX_WIDGETS = 12;

// Font choices are an allowlist of built-in stacks — packs cannot ship font
// files (parsing attack surface + unlicensable). Values map to CSS stacks in
// dashboard.css.
const DISPLAY_FONTS = ['rajdhani', 'system-sans', 'system-serif', 'mono'];

const WALLPAPER_MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };

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
    layout: {
      gap: 14,
      widgets: [
        { type: 'status', area: [1, 1, 12, 2], options: {} },
        { type: 'clock', area: [1, 3, 5, 3], options: { format: '24h', seconds: true, showDate: true } },
        { type: 'stats', area: [6, 3, 7, 3], options: { cpu: true, mem: true } },
      ],
    },
  };
}

// ── Widget sanitizers (per-type option allowlists) ─────────────────────────

const WIDGET_SANITIZERS = {
  clock(options) {
    return {
      format: pick(options.format, ['24h', '12h'], '24h'),
      seconds: bool(options.seconds, true),
      showDate: bool(options.showDate, true),
    };
  },
  stats(options) {
    return {
      cpu: bool(options.cpu, true),
      mem: bool(options.mem, true),
    };
  },
  status() {
    return {}; // draws from pack.persona
  },
};

function sanitizeWidget(raw, warnings) {
  if (typeof raw !== 'object' || raw === null) return null;
  const sanitizer = WIDGET_SANITIZERS[raw.type];
  if (!sanitizer) {
    warnings.push(`Dropped widget of unknown type "${String(raw.type).slice(0, 24)}".`);
    return null;
  }
  const area = Array.isArray(raw.area) ? raw.area : [];
  const col = int(area[0], 1, GRID_COLUMNS, 1);
  const row = int(area[1], 1, GRID_ROWS, 1);
  return {
    type: raw.type,
    area: [
      col,
      row,
      int(area[2], 1, GRID_COLUMNS - col + 1, 1),
      int(area[3], 1, GRID_ROWS - row + 1, 1),
    ],
    options: sanitizer(typeof raw.options === 'object' && raw.options !== null ? raw.options : {}),
  };
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
    if (ASSET_PATTERN.test(skin.wallpaper)) {
      clean.skin.wallpaper = skin.wallpaper;
    } else {
      warnings.push('Wallpaper path rejected — must be assets/<name>.(png|jpg|webp) inside the pack.');
    }
  }

  const layout = typeof raw.layout === 'object' && raw.layout !== null ? raw.layout : {};
  clean.layout.gap = int(layout.gap, 4, 32, clean.layout.gap);
  if (Array.isArray(layout.widgets)) {
    const widgets = layout.widgets.map((w) => sanitizeWidget(w, warnings)).filter(Boolean);
    if (layout.widgets.length > MAX_WIDGETS) {
      warnings.push(`Pack declares ${layout.widgets.length} widgets; only the first ${MAX_WIDGETS} are kept.`);
    }
    if (widgets.length > 0) clean.layout.widgets = widgets.slice(0, MAX_WIDGETS);
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

/** List installed packs (id + display metadata). Never throws. */
function listPacks(appRoot) {
  const warnings = [];
  let entries = [];
  try {
    entries = fs.readdirSync(packsDir(appRoot), { withFileTypes: true })
      .filter((e) => e.isDirectory() && ID_PATTERN.test(e.name))
      .map((e) => e.name);
  } catch {
    warnings.push('No packs directory found.');
    return { packs: [], warnings };
  }
  const packs = [];
  for (const id of entries) {
    const loaded = loadPack(appRoot, id);
    packs.push({ id, name: loaded.pack.name, author: loaded.pack.author, warnings: loaded.warnings });
  }
  packs.sort((a, b) => a.name.localeCompare(b.name));
  return { packs, warnings };
}

/** Load + sanitize one pack. Never throws. */
function loadPack(appRoot, id) {
  const safeId = ID_PATTERN.test(String(id)) ? String(id) : 'default';
  const file = path.join(packDir(appRoot, safeId), 'pack.json');
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
    return { pack, warnings };
  }
  const result = sanitizePack(raw, safeId);
  return { pack: result.pack, warnings: [...warnings, ...result.warnings] };
}

/**
 * Read a pack's wallpaper as a data: URI (or null). The path was validated
 * by the sanitizer; this re-checks containment and size before reading.
 */
function wallpaperDataUri(appRoot, pack) {
  if (!pack.skin.wallpaper) return { uri: null, warnings: [] };
  const dir = packDir(appRoot, pack.id);
  const full = path.resolve(dir, pack.skin.wallpaper);
  if (!full.startsWith(path.resolve(dir) + path.sep)) {
    return { uri: null, warnings: ['Wallpaper path escapes the pack directory — ignored.'] };
  }
  try {
    const stat = fs.statSync(full);
    if (stat.size > WALLPAPER_MAX_BYTES) {
      return { uri: null, warnings: [`Wallpaper is ${(stat.size / 1048576).toFixed(1)} MB (max ${WALLPAPER_MAX_BYTES / 1048576} MB) — ignored.`] };
    }
    const mime = WALLPAPER_MIME[path.extname(full).toLowerCase()];
    return { uri: `data:${mime};base64,${fs.readFileSync(full).toString('base64')}`, warnings: [] };
  } catch {
    return { uri: null, warnings: [`Wallpaper "${pack.skin.wallpaper}" is missing — ignored.`] };
  }
}

module.exports = {
  PACK_SCHEMA_VERSION,
  GRID_COLUMNS,
  GRID_ROWS,
  defaultPack,
  sanitizePack,
  listPacks,
  loadPack,
  packDir,
  wallpaperDataUri,
};
