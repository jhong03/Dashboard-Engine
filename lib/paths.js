'use strict';

// User-data location, computed identically inside and outside Electron so
// the CLI tools and the app always see the same installed packs. Matches
// Electron's default userData for the app name.
//
// Rebrand migration: the product shipped its early life as "aegis-voice";
// on first run after the rename the old directory is moved wholesale to
// "dashboard-engine" (installed packs, settings, registries — everything).
// If the move fails (locked file, permissions) we keep using the old dir so
// nothing is ever lost to a rename.

const fs = require('fs');
const os = require('os');
const path = require('path');

const APP_DIR_NAME = 'dashboard-engine';
const LEGACY_DIR_NAME = 'aegis-voice';

function baseDir() {
  if (process.platform === 'win32') {
    return process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support');
  }
  return process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
}

let resolved = null;

function userDataDir() {
  if (resolved) return resolved;
  const next = path.join(baseDir(), APP_DIR_NAME);
  const legacy = path.join(baseDir(), LEGACY_DIR_NAME);
  if (!fs.existsSync(next) && fs.existsSync(legacy)) {
    try {
      fs.renameSync(legacy, next);
    } catch {
      resolved = legacy; // migration blocked — stay on the old dir, lose nothing
      return resolved;
    }
  }
  resolved = next;
  return resolved;
}

module.exports = { userDataDir };
