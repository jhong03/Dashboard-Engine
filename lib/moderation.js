'use strict';

// Content moderation for Steam Workshop items (F3 — UGC moderation).
//
// A bundled, versioned kill-switch: `moderation/blocklist.json` lists the Workshop
// item ids the app refuses to install/import. It is the developer-side response
// mechanism — when a user or Valve report is confirmed, the id is added here and the
// next app release stops that item from installing on every machine, in parallel with
// requesting Valve to remove it from the Workshop.
//
// FAIL-SOFT (CLAUDE.md rule): a missing or malformed list blocks NOTHING. A bad
// moderation file must never break an install. Ids are numeric Workshop ids that
// cross IPC as strings (BigInt), so everything is compared as trimmed numeric strings.

const fs = require('fs');
const path = require('path');

const DEFAULT_REASON =
  'This item was removed for violating the content guidelines and can’t be installed.';

// Keyed by appRoot so a test (or dev vs. packaged) can’t poison the cache; in the app
// there is only ever one appRoot, loaded once.
const cache = new Map(); // appRoot → { version, map: Map<idString, reason> }

function blocklistPath(appRoot) {
  return path.join(appRoot, 'moderation', 'blocklist.json');
}

function load(appRoot) {
  if (cache.has(appRoot)) return cache.get(appRoot);
  const map = new Map();
  let version = 0;
  try {
    const raw = JSON.parse(fs.readFileSync(blocklistPath(appRoot), 'utf8'));
    version = Number(raw && raw.version) || 0;
    const list = raw && Array.isArray(raw.blocked) ? raw.blocked : [];
    for (const entry of list) {
      // An entry may be a bare id or { id, reason }.
      const id = String(entry && entry.id != null ? entry.id : entry).trim();
      if (!/^[0-9]+$/.test(id)) continue; // Workshop ids are numeric — ignore junk
      const reason = entry && typeof entry.reason === 'string' && entry.reason.trim()
        ? entry.reason.trim() : DEFAULT_REASON;
      map.set(id, reason);
    }
  } catch (e) { /* fail-soft: no file / bad JSON → nothing blocked */ }
  const result = { version, map };
  cache.set(appRoot, result);
  return result;
}

// The block reason for a Workshop item id, or null if it isn't blocked.
function blockReason(appRoot, itemId) {
  if (itemId == null) return null;
  const id = String(itemId).trim();
  if (!id) return null;
  return load(appRoot).map.get(id) || null;
}

function isBlocked(appRoot, itemId) {
  return blockReason(appRoot, itemId) != null;
}

// Test/dev helper: drop the cached list so a rewritten blocklist re-reads.
function _clearCache() { cache.clear(); }

module.exports = { load, isBlocked, blockReason, blocklistPath, DEFAULT_REASON, _clearCache };
