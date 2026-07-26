'use strict';

// Background-music library — the user's OWN audio files, REFERENCED by path
// (never copied, never bundled into a pack or export). Personal data, exactly
// like the launcher's pins: the pack's `music` component only places/styles the
// player; the tracks, the on/off state and the volume live here in user data
// and are served to the wallpaper over the demusic:// protocol by OPAQUE id
// (the renderer never learns a filesystem path).
//
// This is media playback of files the user already owns — a different domain
// from the voice pipeline's hard "no uploaded audio / no voice cloning"
// boundary, which is specifically about cloning a voice from a sample.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FILE = 'music.json';
const MAX_TRACKS = 300;
const AUDIO_EXTS = ['mp3', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'flac', 'wav', 'webm'];
const AUDIO_EXT = new Set(AUDIO_EXTS.map((e) => `.${e}`));
const ID_PATTERN = /^[a-f0-9]{16}$/;

function musicFile(userDir) {
  return path.join(userDir, FILE);
}

function clamp01(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0.5;
}

// A stable opaque id for a path (so the renderer never sees the real path).
function idFor(filePath) {
  return crypto.createHash('sha1').update(filePath).digest('hex').slice(0, 16);
}

function readRaw(userDir) {
  try {
    const text = fs.readFileSync(musicFile(userDir), 'utf8');
    const raw = JSON.parse(text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text);
    if (typeof raw !== 'object' || raw === null) throw new Error('bad');
    const tracks = (Array.isArray(raw.tracks) ? raw.tracks : [])
      .filter((t) => t && typeof t.path === 'string')
      .map((t) => ({
        id: typeof t.id === 'string' && ID_PATTERN.test(t.id) ? t.id : idFor(t.path),
        path: t.path,
        name: typeof t.name === 'string' && t.name.trim() ? t.name.slice(0, 120) : path.basename(t.path),
      }))
      .slice(0, MAX_TRACKS);
    return { enabled: raw.enabled === true, volume: clamp01(raw.volume), tracks };
  } catch {
    return { enabled: false, volume: 0.5, tracks: [] }; // none yet — not an error
  }
}

function write(userDir, data) {
  fs.mkdirSync(userDir, { recursive: true });
  const tmp = `${musicFile(userDir)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, musicFile(userDir));
}

// Public view for a renderer — id + name only, NEVER the filesystem path.
function publicList(userDir) {
  const { enabled, volume, tracks } = readRaw(userDir);
  return { enabled, volume, tracks: tracks.map((t) => ({ id: t.id, name: t.name })) };
}

// Add picked files (main-side dialog paths). Non-audio files and duplicates are
// skipped; the list is capped.
function add(userDir, paths) {
  const data = readRaw(userDir);
  const have = new Set(data.tracks.map((t) => t.path));
  let added = 0;
  for (const p of Array.isArray(paths) ? paths : []) {
    if (typeof p !== 'string' || !AUDIO_EXT.has(path.extname(p).toLowerCase())) continue;
    if (have.has(p) || data.tracks.length >= MAX_TRACKS) continue;
    data.tracks.push({ id: idFor(p), path: p, name: path.basename(p) });
    have.add(p);
    added++;
  }
  write(userDir, data);
  return { ok: true, added, ...publicList(userDir) };
}

function remove(userDir, id) {
  const data = readRaw(userDir);
  data.tracks = data.tracks.filter((t) => t.id !== id);
  write(userDir, data);
  return { ok: true, ...publicList(userDir) };
}

function setEnabled(userDir, enabled) {
  const data = readRaw(userDir);
  data.enabled = enabled === true;
  write(userDir, data);
  return { ok: true, enabled: data.enabled };
}

function setVolume(userDir, volume) {
  const data = readRaw(userDir);
  data.volume = clamp01(volume);
  write(userDir, data);
  return { ok: true, volume: data.volume };
}

// For the demusic:// protocol handler — resolve an OPAQUE id to a real path,
// but ONLY when it's a track the user actually added (never an arbitrary path),
// and only if the file still exists.
function pathForId(userDir, id) {
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) return null;
  const { tracks } = readRaw(userDir);
  const track = tracks.find((t) => t.id === id);
  return track && fs.existsSync(track.path) ? track.path : null;
}

module.exports = { publicList, add, remove, setEnabled, setVolume, pathForId, AUDIO_EXTS };
