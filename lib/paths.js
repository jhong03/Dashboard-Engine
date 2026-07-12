'use strict';

// User-data location, computed identically inside and outside Electron so
// the CLI tools and the app always see the same installed packs. Matches
// Electron's default userData for an app named "aegis-voice".

const os = require('os');
const path = require('path');

const APP_DIR_NAME = 'aegis-voice';

function userDataDir() {
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), APP_DIR_NAME);
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', APP_DIR_NAME);
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), APP_DIR_NAME);
}

module.exports = { userDataDir };
