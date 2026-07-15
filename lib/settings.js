'use strict';

// Tiny persisted engine settings (user data). Currently just the active
// pack — which persona is rendered on the desktop. Fail-soft like every
// other loader: garbage in, defaults out.

const fs = require('fs');
const path = require('path');

const SETTINGS_FILE = 'settings.json';
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,47}$/;

// Performance-citizenship defaults: cap the wallpaper at 30 fps and pause it
// when a full-screen app is up. Battery-pause is opt-in (some users want the
// wallpaper regardless). maxFps is clamped to a sane, known set.
const FPS_CHOICES = [24, 30, 48, 60];
const DEFAULT_PERFORMANCE = { pauseOnFullscreen: true, pauseOnBattery: false, maxFps: 30 };

function readPerformance(raw) {
  const p = (raw && typeof raw.performance === 'object' && raw.performance) || {};
  return {
    pauseOnFullscreen: typeof p.pauseOnFullscreen === 'boolean' ? p.pauseOnFullscreen : DEFAULT_PERFORMANCE.pauseOnFullscreen,
    pauseOnBattery: typeof p.pauseOnBattery === 'boolean' ? p.pauseOnBattery : DEFAULT_PERFORMANCE.pauseOnBattery,
    maxFps: FPS_CHOICES.includes(p.maxFps) ? p.maxFps : DEFAULT_PERFORMANCE.maxFps,
  };
}

function settingsFile(userDir) {
  return path.join(userDir, SETTINGS_FILE);
}

function load(userDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(settingsFile(userDir), 'utf8'));
    return {
      activePack: typeof raw.activePack === 'string' && ID_PATTERN.test(raw.activePack) ? raw.activePack : null,
      performance: readPerformance(raw),
    };
  } catch {
    return { activePack: null, performance: { ...DEFAULT_PERFORMANCE } };
  }
}

function save(userDir, settings) {
  fs.mkdirSync(userDir, { recursive: true });
  const tmp = `${settingsFile(userDir)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, settingsFile(userDir));
}

function getActivePack(userDir) {
  return load(userDir).activePack;
}

function setActivePack(userDir, id) {
  const settings = load(userDir);
  settings.activePack = ID_PATTERN.test(String(id)) ? String(id) : null;
  save(userDir, settings);
  return settings.activePack;
}

function getPerformance(userDir) {
  return load(userDir).performance;
}

// Merge a partial patch over the current performance settings; unknown/invalid
// fields are dropped by readPerformance on the next load.
function setPerformance(userDir, patch) {
  const settings = load(userDir);
  settings.performance = readPerformance({ performance: { ...settings.performance, ...(patch || {}) } });
  save(userDir, settings);
  return settings.performance;
}

module.exports = { getActivePack, setActivePack, getPerformance, setPerformance, FPS_CHOICES };
