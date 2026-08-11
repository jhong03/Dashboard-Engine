'use strict';

// Runtime UI localization (main side). FAIL-SOFT by design (CLAUDE.md rule):
// every missing locale, file, or key falls back to English, so a broken or
// partial translation can never break the UI.
//
// A locale dictionary is a FLAT JSON map of key -> string:
//   { "manager.nav.installed": "Installed", "tray.quit": "Quit Dashboard Engine" }
// Keys are dotted for readability. Values may contain {name}-style params that
// the caller's t() fills in. English (locales/en.json) is the canonical source
// of truth — translators copy it and translate the values.
//
// Locales load from TWO places, later overriding earlier:
//   1. the app's bundled  <appRoot>/locales/<code>.json
//   2. the user's         <userDir>/locales/<code>.json   (community translations
//      just drop in here — no rebuild needed)
// The active locale's dict is English overlaid with the locale's entries, so any
// untranslated key shows English rather than a raw key.

const fs = require('fs');
const path = require('path');

const EN = 'en';
// A base language code (2–3 letters) with an OPTIONAL script/region subtag, e.g.
// "en", "zh", or "zh-hant" (Traditional Chinese). Lowercased everywhere so Set
// lookups and filenames stay consistent cross-platform.
const CODE_PATTERN = /^[a-z]{2,3}(-[a-z]{2,4})?$/;

function appLocalesDir() {
  return path.join(__dirname, '..', 'locales');
}
function userLocalesDir(userDir) {
  return path.join(userDir, 'locales');
}

// Map an OS/Electron locale (e.g. "es-ES", "zh-CN", "zh-TW") to one of our codes.
// Chinese is script-aware: Traditional regions/scripts -> "zh-hant", everything
// else zh -> Simplified "zh". An explicit "zh-hant" passes straight through.
function normalizeLocale(raw) {
  const s = String(raw || '').toLowerCase().trim().replace(/_/g, '-');
  if (!s) return null;
  const parts = s.split('-');
  const base = parts[0];
  if (base === 'zh') {
    const sub = parts.slice(1).join('-');
    // Traditional: explicit Hant script, or the TW/HK/MO regions.
    if (/(^|-)hant(-|$)/.test(sub) || /(^|-)(tw|hk|mo)(-|$)/.test(sub)) return 'zh-hant';
    return 'zh';
  }
  return CODE_PATTERN.test(base) ? base : null;
}

// One locale file -> flat { key: string } dict, or null if unreadable/invalid.
// Non-string values are dropped (a dict is strings only).
function readLocaleFile(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const out = {};
    for (const [k, v] of Object.entries(raw)) {
      if (typeof k === 'string' && typeof v === 'string') out[k] = v;
    }
    return out;
  } catch {
    return null;
  }
}

// The English dictionary (canonical), cached — it's the fallback for every key.
let enCache = null;
function loadEnglish() {
  if (!enCache) enCache = readLocaleFile(path.join(appLocalesDir(), EN + '.json')) || {};
  return enCache;
}

// Available locale CODES across app + user folders, always including 'en'.
function listLocales(userDir) {
  const codes = new Set([EN]);
  for (const dir of [appLocalesDir(), userLocalesDir(userDir)]) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { names = []; }
    for (const name of names) {
      const m = /^([a-z]{2,3}(?:-[a-z]{2,4})?)\.json$/i.exec(name);
      if (m) codes.add(m[1].toLowerCase());
    }
  }
  return [...codes];
}

// The merged dict for a locale: English base ⊕ app file ⊕ user file.
function mergedDict(userDir, code) {
  const dict = { ...loadEnglish() };
  const apply = (dir, c) => { const d = readLocaleFile(path.join(dir, c + '.json')); if (d) Object.assign(dict, d); };
  if (code && code !== EN) {
    apply(appLocalesDir(), code);
    apply(userLocalesDir(userDir), code);
  } else {
    // Even English can be overridden by a user file (fix wording without a build).
    apply(userLocalesDir(userDir), EN);
  }
  return dict;
}

// Resolve the active locale code: an explicit setting wins; else the OS locale
// if we have that translation; else English.
function resolveCode(userDir, settingsLocale, osLocale) {
  const avail = new Set(listLocales(userDir));
  const wanted = normalizeLocale(settingsLocale);
  if (wanted && avail.has(wanted)) return wanted;
  const os = normalizeLocale(osLocale);
  if (os && avail.has(os)) return os;
  return EN;
}

// The full active-locale payload handed to a renderer: the resolved code, its
// merged dict, and the list of available codes (for the language picker).
function getActive(userDir, settingsLocale, osLocale) {
  const lang = resolveCode(userDir, settingsLocale, osLocale);
  return { lang, dict: mergedDict(userDir, lang), available: listLocales(userDir) };
}

// Main-side string lookup (for the tray + native menus/dialogs), same {param}
// substitution as the renderer's t().
function translate(dict, key, params) {
  let s = (dict && typeof dict[key] === 'string') ? dict[key] : key;
  if (params) s = s.replace(/\{(\w+)\}/g, (_, k) => (params[k] != null ? String(params[k]) : `{${k}}`));
  return s;
}

// Native language names for the picker (endonyms), best-effort; unknown codes
// fall back to the code itself.
const LANGUAGE_NAMES = {
  en: 'English', es: 'Español', fr: 'Français', de: 'Deutsch', pt: 'Português',
  it: 'Italiano', zh: '简体中文', 'zh-hant': '繁體中文', ja: '日本語', ko: '한국어',
  ru: 'Русский', vi: 'Tiếng Việt', tr: 'Türkçe', uk: 'Українська', pl: 'Polski', nl: 'Nederlands',
};
function languageName(code) {
  return LANGUAGE_NAMES[code] || String(code || '').toUpperCase();
}

module.exports = {
  EN, getActive, listLocales, translate, normalizeLocale, languageName, LANGUAGE_NAMES,
};
