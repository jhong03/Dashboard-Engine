'use strict';

// Pack VIDEO wallpapers streamed to the wallpaper over depack://<opaque-id>,
// exactly like background music over demusic:// (see lib/music.js). A custom
// streaming scheme (not file://, which the page CSP forbids) lets main gate
// every request: only ids for videos a CURRENTLY-LOADED pack references ever
// resolve. A video is NEVER base64'd into the assets data-URI map — a short
// loop is still tens of MB, which would blow the pack byte budget and stall the
// renderer — so it rides by opaque id instead.
//
// The id is a hash of the absolute path (like music's idFor): opaque to the
// renderer (a hash can't be reversed to a path) and STABLE, so re-registering
// the same pack across surfaces (desktop + editor + manager preview) yields the
// same URL and never invalidates another surface's in-flight stream.

const fs = require('fs');
const crypto = require('crypto');
const packs = require('./packs');

// opaque id -> absolute file path. Populated ONLY from validated pack video
// refs (packs.videoPathFor); an id that isn't in here 404s.
const registry = new Map();
const ID_PATTERN = /^[a-f0-9]{24}$/;

function idFor(absPath) {
  return crypto.createHash('sha256').update(absPath).digest('hex').slice(0, 24);
}

/**
 * Build the { relPath: 'depack://<id>/' } url map for a loaded pack's videos
 * and remember id -> path so the protocol handler can stream them. `dir` is the
 * pack's resolved directory; each ref is re-validated (containment + exists +
 * size cap) by packs.videoPathFor before it's registered.
 * @returns {{ urls: Object<string,string>, warnings: string[] }}
 */
function registerPackVideos(dir, pack) {
  const urls = {};
  const warnings = [];
  for (const relPath of packs.collectVideoRefs(pack)) {
    const resolved = packs.videoPathFor(dir, relPath);
    if (!resolved.path) {
      if (resolved.warning) warnings.push(resolved.warning);
      continue; // missing / oversized / escapes dir — the renderer falls back
    }
    const id = idFor(resolved.path);
    registry.set(id, resolved.path);
    urls[relPath] = `depack://${id}/`;
  }
  return { urls, warnings };
}

/**
 * Resolve an opaque id to a real path for the protocol handler — ONLY a
 * registered id, and (defence in depth) only a recognised video that still
 * exists, even if the registry were somehow stale.
 * @returns {string|null}
 */
function pathForId(id) {
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) return null;
  const abs = registry.get(id);
  if (!abs || !packs.isVideoAsset(abs)) return null;
  return fs.existsSync(abs) ? abs : null;
}

module.exports = { registerPackVideos, pathForId };
