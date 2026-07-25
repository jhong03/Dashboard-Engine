'use strict';

// Per-pack user property overrides. A pack declares adjustable knobs (packs.js
// sanitizeProps); the values the USER picks for them live here, in user data —
// NEVER in the pack, so exports and forks stay the author's originals.
//
// Shape on disk (userprops.json): { "<packId>": { "<propKey>": <value> } }.
// Fail-soft like every other loader: unreadable/garbage → empty, defaults win.
// Values are re-validated against the pack's prop definitions before use
// (packs.coerceProp), so nothing here is trusted blindly.

const fs = require('fs');
const path = require('path');

const FILE = 'userprops.json';

function file(userDir) {
  return path.join(userDir, FILE);
}

function loadAll(userDir) {
  try {
    const data = JSON.parse(fs.readFileSync(file(userDir), 'utf8'));
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

function saveAll(userDir, data) {
  fs.mkdirSync(userDir, { recursive: true });
  const tmp = `${file(userDir)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file(userDir));
}

// The raw override map for one pack ({} if none). Callers validate each value
// against the current pack schema before applying it.
function getOverrides(userDir, packId) {
  const entry = loadAll(userDir)[packId];
  return entry && typeof entry === 'object' ? entry : {};
}

function setOverride(userDir, packId, key, value) {
  const all = loadAll(userDir);
  const current = all[packId] && typeof all[packId] === 'object' ? all[packId] : {};
  current[key] = value;
  all[packId] = current;
  saveAll(userDir, all);
  return current;
}

// Drop all overrides for a pack — "reset to the author's defaults".
function clearPack(userDir, packId) {
  const all = loadAll(userDir);
  if (Object.prototype.hasOwnProperty.call(all, packId)) {
    delete all[packId];
    saveAll(userDir, all);
  }
}

module.exports = { getOverrides, setOverride, clearPack };
