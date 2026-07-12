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

// Every tunable parameter with its legal range. This is THE source of truth —
// the UI (Stage 4) reads its slider bounds from here too, so ranges are never
// duplicated. Paths are dot-separated into the profile object.
const PARAM_RANGES = {
  'prosody.pitchShift':     { min: -12,  max: 12,   default: 0 },     // semitones
  'prosody.rate':           { min: 90,   max: 260,  default: 165 },   // words/min
  'prosody.expressiveness': { min: 0,    max: 1.6,  default: 1.0 },   // scales Piper noise-scale
  'prosody.steadiness':     { min: 0,    max: 1,    default: 0.5 },   // inverse of Piper noise-w
  'prosody.pauseSentence':  { min: 0,    max: 1200, default: 300 },   // ms
  'prosody.pauseComma':     { min: 0,    max: 600,  default: 100 },   // ms (not yet wired to Piper — see piper.js)
  'timbre.warmth':          { min: -6,   max: 6,    default: 0 },     // dB, low shelf @ 180 Hz
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
      engine: 'piper',
      voice: 'alan',
      fallback: { engine: 'system', match: 'United Kingdom' },
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
  if (base.engine === 'piper' || base.engine === 'system') clean.base.engine = base.engine;
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

module.exports = {
  PROFILE_SCHEMA_VERSION,
  PARAM_RANGES,
  defaultProfile,
  sanitizeProfile,
  loadProfile,
  saveProfile,
  clamp,
  getByPath,
  setByPath,
};
