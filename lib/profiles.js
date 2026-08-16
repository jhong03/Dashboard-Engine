'use strict';

// Voice profiles: load / save / validate.
//
// A profile is ~1 KB of JSON containing ONLY parameters — never audio, never
// recordings. That is a legal boundary for the whole project (see CLAUDE.md).
//
// Design rule: a malformed profile must never crash the app. Anything we load
// is deep-merged over the defaults and every numeric value is clamped to its
// documented range. Garbage in → nearest sane profile out.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PROFILE_SCHEMA_VERSION = 1;

// Saved profile filenames: slug only, no separators, always .json. Shared with
// lib/ipc.js so the on-disk contract lives in one place.
const PROFILE_FILE_PATTERN = /^[a-z0-9][a-z0-9-_]{0,63}\.json$/;

// Where user-tuned profiles live (the factory presets live in presets/, loaded
// by lib/presets.js). Kept here so the workshop voice pipeline and ipc agree.
function profilesDir(appRoot) {
  return path.join(appRoot, 'profiles');
}

// Provenance of a profile, mirroring pack provenance in .aegis-meta.json:
//   'scratch'      — tuned by this user (publishable)
//   'own-workshop' — re-downloaded from YOUR published item (publishable, portable)
//   'imported'     — someone else's Workshop voice (NOT publishable as your own)
// A legacy profile with no origin is treated as the user's own work (scratch).
const PROFILE_ORIGINS = ['scratch', 'own-workshop', 'imported'];
const PUBLISHABLE_ORIGINS = ['scratch', 'own-workshop'];

// Every tunable parameter with its legal range. This is THE source of truth —
// the UI (Stage 4) reads its slider bounds from here too, so ranges are never
// duplicated. Paths are dot-separated into the profile object.
const PARAM_RANGES = {
  'prosody.pitchShift':     { min: -12,  max: 12,   default: 0 },     // semitones
  'prosody.rate':           { min: 90,   max: 260,  default: 165 },   // words/min
  'prosody.expressiveness': { min: 0,    max: 1.6,  default: 1.0 },   // scales Piper noise-scale
  'prosody.steadiness':     { min: 0,    max: 1,    default: 0.5 },   // inverse of Piper noise-w
  'prosody.pauseSentence':  { min: 0,    max: 1200, default: 300 },   // ms
  'timbre.warmth':          { min: -6,   max: 6,    default: 0 },     // dB, low shelf @ 180 Hz
  'timbre.resonance':       { min: -6,   max: 6,    default: 0 },     // dB, bell @ 300 Hz — low-mid body / "magnetic" resonance
  'timbre.brightness':      { min: -8,   max: 8,    default: 0 },     // dB, high shelf @ 5500 Hz
  'timbre.presence':        { min: -6,   max: 6,    default: 0 },     // dB, bell @ 2800 Hz
  'timbre.sibilance':       { min: -8,   max: 0,    default: 0 },     // dB, bell @ 7000 Hz (cut only)
  'timbre.breath':          { min: 0,    max: 1,    default: 0 },     // reserved — not in the M1 DSP chain yet
  'character.compression':  { min: 0,    max: 1,    default: 0 },     // 0 = bypass, 1 = 6:1 broadcast squash
  'character.radioFilter':  { min: 0,    max: 1,    default: 0 },     // 0 = bypass, 1 = full 300–3400 Hz comms band
  'character.reverb.mix':   { min: 0,    max: 1,    default: 0 },
  'character.reverb.size':  { min: 0,    max: 1,    default: 0.3 },
  'character.bitcrush':     { min: 0,    max: 1,    default: 0 },
  'character.chorus':       { min: 0,    max: 1,    default: 0 },
};

// The neutral profile every load is merged onto. Base voice defaults to the
// first bundled voice; the caller can override before synthesis.
function defaultProfile() {
  const p = {
    schema: PROFILE_SCHEMA_VERSION,
    id: crypto.randomUUID(),
    name: 'Untitled',
    author: '',
    created: new Date().toISOString(),
    base: {
      engine: 'melotts',
      voice: 'en_us_hd',
      fallback: { engine: 'system', match: 'United States' },
    },
    prosody: {},
    timbre: {},
    character: { reverb: {} },
  };
  for (const [paramPath, range] of Object.entries(PARAM_RANGES)) {
    setByPath(p, paramPath, range.default);
  }
  return p;
}

function getByPath(obj, dotted) {
  return dotted.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function setByPath(obj, dotted, value) {
  const keys = dotted.split('.');
  const last = keys.pop();
  let cursor = obj;
  for (const k of keys) {
    if (typeof cursor[k] !== 'object' || cursor[k] === null) cursor[k] = {};
    cursor = cursor[k];
  }
  cursor[last] = value;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

// Coerce anything a hostile/corrupt file might contain into a finite number,
// or fall back to the default. Strings like "2.5" are accepted because hand-
// edited JSON is a first-class use case.
function toFiniteNumber(value, fallback) {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : fallback;
}

// Merge an untrusted object over the defaults, clamping every parameter.
// Never throws. Unknown keys are dropped so a profile can't smuggle payloads.
function sanitizeProfile(raw) {
  const clean = defaultProfile();
  if (typeof raw !== 'object' || raw === null) return clean;

  if (typeof raw.id === 'string' && raw.id.length <= 64) clean.id = raw.id;
  if (typeof raw.name === 'string') clean.name = raw.name.slice(0, 80) || 'Untitled';
  if (typeof raw.author === 'string') clean.author = raw.author.slice(0, 80);
  if (typeof raw.created === 'string' && !Number.isNaN(Date.parse(raw.created))) {
    clean.created = raw.created;
  }

  const base = typeof raw.base === 'object' && raw.base !== null ? raw.base : {};
  if (['piper', 'melotts', 'system'].includes(base.engine)) clean.base.engine = base.engine;
  if (typeof base.voice === 'string' && base.voice.length <= 64) clean.base.voice = base.voice;
  if (typeof base.fallback === 'object' && base.fallback !== null) {
    if (typeof base.fallback.match === 'string') {
      clean.base.fallback.match = base.fallback.match.slice(0, 80);
    }
  }

  for (const [paramPath, range] of Object.entries(PARAM_RANGES)) {
    const rawValue = getByPath(raw, paramPath);
    const n = toFiniteNumber(rawValue, range.default);
    setByPath(clean, paramPath, clamp(n, range.min, range.max));
  }

  // Provenance travels WITH the profile so publishability survives a save/load
  // round-trip (the tuning panel structuredClones the whole object). Only known
  // values are kept; absent = a fresh from-scratch profile (stamped on save).
  if (typeof raw.origin === 'string' && PROFILE_ORIGINS.includes(raw.origin)) clean.origin = raw.origin;
  // The Workshop item this profile maps to (own-workshop), so a later publish
  // UPDATES the same item. A plain numeric string; never a path or payload.
  if (typeof raw.workshopId === 'string' && /^[0-9]{1,20}$/.test(raw.workshopId)) clean.workshopId = raw.workshopId;
  return clean;
}

// Load a profile from disk. Returns { profile, warnings } — never throws.
// On unreadable/corrupt input you get the default profile plus a warning,
// because the app must keep running no matter what was on disk.
function loadProfile(filePath) {
  const warnings = [];
  let raw = null;
  try {
    // Strip a UTF-8 BOM (U+FEFF) — Notepad and PowerShell add one, and
    // JSON.parse rejects it.
    const text = fs.readFileSync(filePath, 'utf8');
    raw = JSON.parse(text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text);
  } catch (err) {
    warnings.push(`Profile "${path.basename(filePath)}" is unreadable (${err.message}); using defaults.`);
    return { profile: defaultProfile(), warnings };
  }
  if (typeof raw.schema === 'number' && raw.schema > PROFILE_SCHEMA_VERSION) {
    warnings.push(`Profile schema ${raw.schema} is newer than this app understands (${PROFILE_SCHEMA_VERSION}); values outside known ranges will be clamped.`);
  }
  return { profile: sanitizeProfile(raw), warnings };
}

// Save is atomic (write temp, rename) so a crash mid-write can't leave a
// half-file that would then fail to load.
function saveProfile(filePath, profile) {
  const clean = sanitizeProfile(profile);
  const tmp = `${filePath}.tmp`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(clean, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, filePath);
  return clean;
}

// List the user's saved profiles with just what the UI (and the publish gate)
// needs: file name, display name, base voice, and provenance. Never throws —
// no profiles dir yet is simply an empty list.
function listProfiles(appRoot) {
  const dir = profilesDir(appRoot);
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => PROFILE_FILE_PATTERN.test(f));
  } catch {
    return [];
  }
  return files.map((file) => {
    const { profile } = loadProfile(path.join(dir, file));
    return {
      file,
      name: profile.name,
      voice: profile.base.voice,
      origin: profile.origin || null,
      workshopId: profile.workshopId || null,
    };
  });
}

// Can this saved profile be published as the user's own voice? Only user-tuned
// work (scratch / own-workshop, or a legacy profile with no recorded origin);
// a voice imported from another creator's Workshop item is refused. This is the
// authoritative gate — the UI also hides the button, but the renderer is assumed
// hostile (CLAUDE.md), so lib/workshop.js re-checks this before uploading.
function isPublishable(appRoot, file) {
  if (typeof file !== 'string' || !PROFILE_FILE_PATTERN.test(file)) return false;
  const full = path.join(profilesDir(appRoot), file);
  if (!fs.existsSync(full)) return false;
  const { profile } = loadProfile(full);
  if (!profile.origin) return true; // legacy tuned profile — the user's own work
  return PUBLISHABLE_ORIGINS.includes(profile.origin);
}

// Save an untrusted profile object (from a downloaded Workshop voice.json) as a
// NEW local profile file, stamping its provenance. Slug is derived from the
// name and deduped so importing never overwrites an existing profile. Returns
// { ok, file, profile } or { ok:false, error }. Never throws on bad input —
// sanitizeProfile clamps anything hostile to a safe profile.
function importVoiceProfile(appRoot, raw, opts = {}) {
  const clean = sanitizeProfile(raw);
  if (PROFILE_ORIGINS.includes(opts.origin)) clean.origin = opts.origin;
  if (typeof opts.workshopId === 'string' && /^[0-9]{1,20}$/.test(opts.workshopId)) clean.workshopId = opts.workshopId;
  else delete clean.workshopId; // an imported (not own) voice carries no mapping
  const dir = profilesDir(appRoot);
  const base = clean.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 44) || 'voice';
  let file = `${base}.json`;
  let counter = 2;
  try {
    while (fs.existsSync(path.join(dir, file))) file = `${base}-${counter++}.json`;
  } catch { /* no dir yet — the first name is free */ }
  try {
    const saved = saveProfile(path.join(dir, file), clean);
    return { ok: true, file, profile: saved };
  } catch (err) {
    return { ok: false, error: `Could not save the voice: ${err.message}` };
  }
}

module.exports = {
  PROFILE_SCHEMA_VERSION,
  PROFILE_FILE_PATTERN,
  PARAM_RANGES,
  PROFILE_ORIGINS,
  profilesDir,
  defaultProfile,
  sanitizeProfile,
  loadProfile,
  saveProfile,
  listProfiles,
  isPublishable,
  importVoiceProfile,
  clamp,
  getByPath,
  setByPath,
};
