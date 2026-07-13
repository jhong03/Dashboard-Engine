'use strict';

// Launcher data for the wallpaper launcher component. PERSONAL data — like
// reminders, pins and recents live in user data and are only DISPLAYED by
// packs; a pack places and styles the component, never its content.
//
// Security model: the renderer only ever sees opaque entry ids. Every
// launchable path lives in main-side snapshots built from OUR enumeration
// (Start Menu / Recent folder / user pins picked through main-side dialogs).
// A renderer-supplied id that isn't in a snapshot simply doesn't resolve.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FILE = 'launcher.json';
const MAX_PINS = 24;
const MAX_RECENT_APPS = 12;
const MAX_RECENT_FILES = 24; // pre-filter cap; protocol junk is dropped later
const MAX_NAME = 80;
const SCAN_DEPTH = 3;
const APP_CACHE_MS = 5 * 60 * 1000;

function launcherFile(userDir) {
  return path.join(userDir, FILE);
}

function entryId(target) {
  return crypto.createHash('sha1').update(target.toLowerCase()).digest('hex').slice(0, 16);
}

function cleanName(lnkPath) {
  return path.basename(lnkPath, path.extname(lnkPath)).slice(0, MAX_NAME);
}

// ── Start Menu apps ─────────────────────────────────────────────────────────

function startMenuDirs() {
  const dirs = [];
  if (process.env.APPDATA) dirs.push(path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs'));
  if (process.env.ProgramData) dirs.push(path.join(process.env.ProgramData, 'Microsoft', 'Windows', 'Start Menu', 'Programs'));
  return dirs;
}

function scanShortcuts(dir, depth, out) {
  if (depth > SCAN_DEPTH || out.length > 800) return;
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // dir missing/unreadable — fail soft
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) scanShortcuts(full, depth + 1, out);
    else if (/\.lnk$/i.test(entry.name)) out.push(full);
  }
}

let appCache = { at: 0, apps: [] };

/** Installed apps from the Start Menu (both roots), deduped by name. */
function listApps() {
  if (Date.now() - appCache.at < APP_CACHE_MS) return appCache.apps;
  const shortcuts = [];
  for (const dir of startMenuDirs()) scanShortcuts(dir, 0, shortcuts);
  const seen = new Set();
  const apps = [];
  for (const lnk of shortcuts) {
    const name = cleanName(lnk);
    if (/uninstall|readme|website|documentation/i.test(name)) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    apps.push({ id: entryId(lnk), name, target: lnk });
  }
  apps.sort((a, b) => a.name.localeCompare(b.name));
  appCache = { at: Date.now(), apps };
  return apps;
}

// ── Recent files/folders (the shell's own Recent folder) ────────────────────

function listRecentFiles() {
  if (!process.env.APPDATA) return [];
  const dir = path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Recent');
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && /\.lnk$/i.test(e.name));
  } catch {
    return [];
  }
  const withTimes = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    try {
      withTimes.push({ target: full, mtime: fs.statSync(full).mtimeMs });
    } catch { /* raced a deletion — skip */ }
  }
  withTimes.sort((a, b) => b.mtime - a.mtime);
  return withTimes.slice(0, MAX_RECENT_FILES).map((f) => ({
    id: entryId(f.target),
    name: cleanName(f.target),
    target: f.target,
  }));
}

// ── Pins + engine-tracked recent apps (launcher.json) ───────────────────────

function validPin(raw) {
  if (typeof raw !== 'object' || raw === null) return null;
  if (typeof raw.target !== 'string' || raw.target.trim() === '' || raw.target.length > 1024) return null;
  if (typeof raw.name !== 'string' || raw.name.trim() === '') return null;
  return {
    id: entryId(raw.target),
    name: raw.name.trim().slice(0, MAX_NAME),
    target: raw.target,
  };
}

function loadStore(userDir) {
  let raw = null;
  try {
    const text = fs.readFileSync(launcherFile(userDir), 'utf8');
    raw = JSON.parse(text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text);
  } catch {
    return { pins: [], recentApps: [] };
  }
  const dedupe = (list, cap) => {
    const seen = new Set();
    const out = [];
    for (const item of Array.isArray(list) ? list : []) {
      const pin = validPin(item);
      if (!pin || seen.has(pin.id)) continue;
      seen.add(pin.id);
      out.push(pin);
      if (out.length >= cap) break;
    }
    return out;
  };
  return { pins: dedupe(raw.pins, MAX_PINS), recentApps: dedupe(raw.recentApps, MAX_RECENT_APPS) };
}

function saveStore(userDir, store) {
  fs.mkdirSync(userDir, { recursive: true });
  const tmp = `${launcherFile(userDir)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, launcherFile(userDir));
}

/** Pin a target (an enumerated app's .lnk, or a dialog-picked file/folder). */
function pin(userDir, name, target) {
  const entry = validPin({ name, target });
  if (!entry) return { ok: false, error: 'That cannot be pinned.' };
  const store = loadStore(userDir);
  if (store.pins.some((p) => p.id === entry.id)) return { ok: false, error: 'Already pinned.' };
  if (store.pins.length >= MAX_PINS) return { ok: false, error: `Up to ${MAX_PINS} pins.` };
  store.pins.push(entry);
  saveStore(userDir, store);
  return { ok: true, pin: entry };
}

function unpin(userDir, id) {
  const store = loadStore(userDir);
  const next = store.pins.filter((p) => p.id !== id);
  if (next.length === store.pins.length) return { ok: false, error: 'That pin no longer exists.' };
  store.pins = next;
  saveStore(userDir, store);
  return { ok: true };
}

function movePin(userDir, id, delta) {
  const store = loadStore(userDir);
  const from = store.pins.findIndex((p) => p.id === id);
  if (from === -1) return { ok: false, error: 'That pin no longer exists.' };
  const to = Math.min(store.pins.length - 1, Math.max(0, from + (delta < 0 ? -1 : 1)));
  const [entry] = store.pins.splice(from, 1);
  store.pins.splice(to, 0, entry);
  saveStore(userDir, store);
  return { ok: true };
}

/** Remember an app launch so the Recent section reflects launcher usage. */
function recordRecentApp(userDir, name, target) {
  const entry = validPin({ name, target });
  if (!entry) return;
  const store = loadStore(userDir);
  store.recentApps = [entry, ...store.recentApps.filter((r) => r.id !== entry.id)].slice(0, MAX_RECENT_APPS);
  saveStore(userDir, store);
}

module.exports = { listApps, listRecentFiles, loadStore, pin, unpin, movePin, recordRecentApp };
