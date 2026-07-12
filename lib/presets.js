'use strict';

// Factory presets: the profiles shipped in presets/. They go through the
// same sanitizing loader as user profiles — a bad preset file (or a hand-
// edited one) degrades to defaults with a warning instead of crashing.

const fs = require('fs');
const path = require('path');
const { loadProfile } = require('./profiles');

function presetsDir(appRoot) {
  return path.join(appRoot, 'presets');
}

/**
 * List all factory presets. Never throws.
 * @returns {{ presets: Array<{file: string, profile: object, warnings: string[]}>, warnings: string[] }}
 */
function listPresets(appRoot) {
  const warnings = [];
  let entries = [];
  try {
    entries = fs.readdirSync(presetsDir(appRoot)).filter((f) => f.endsWith('.json'));
  } catch {
    warnings.push('No presets directory found — factory presets are unavailable.');
    return { presets: [], warnings };
  }

  const presets = entries.map((file) => {
    const loaded = loadProfile(path.join(presetsDir(appRoot), file));
    return { file, profile: loaded.profile, warnings: loaded.warnings };
  });
  presets.sort((a, b) => a.profile.name.localeCompare(b.profile.name));
  return { presets, warnings };
}

/** Find a preset by its file name (with or without .json) or profile id. */
function findPreset(listed, key) {
  const wanted = key.endsWith('.json') ? key : `${key}.json`;
  return (
    listed.presets.find((p) => p.file === wanted) ||
    listed.presets.find((p) => p.profile.id === key) ||
    null
  );
}

module.exports = { listPresets, findPreset, presetsDir };
