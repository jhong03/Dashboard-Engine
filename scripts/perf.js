'use strict';

// Launch the app with the dev-only performance HUD on.
//
//   npm run perf                 # desktop + HUD (?perf=1)
//   npm run perf -- --pack sakura
//
// The HUD is a small overlay on the desktop (and editor stage) reading:
//   fps / p95   display frame-rate + 95th-percentile frame time (jank).
//   loops       concurrent app raf loops per surface — the invariant is ≤1
//               (ambience + background + timeline all share ONE raf). 2 = a
//               stray loop somewhere.
//   iv / to     live setInterval + pending setTimeout counts. On a FROZEN
//               wallpaper (full-screen game) these fall to ~0.
//   heap        JS heap (MB). Watch it return to baseline after pack switches;
//               a climbing heap over 10 switches = a leak.
//   gl-tex/vram live GL texture count + estimated VRAM (Σ w·h·4). Budget: 1 GL
//               context per surface, textures freed on pack switch.
//   parts       live ambience particle count (hard cap 400).
//
// It sets DE_PERF=1 → the window URLs carry ?perf=1 → src/perf-hud.js activates.
// Everything the HUD instruments is behind that flag, so a normal run is
// untouched. Note: like any dev launch, this bounces off a running INSTALLED
// instance (single-instance lock) — close the wallpaper first, or test the
// built app with steam_appid present.

const { spawn } = require('child_process');
const path = require('path');

const APP_ROOT = path.join(__dirname, '..');
const electronPath = require('electron');

const env = { ...process.env, DE_PERF: '1' };
// VS Code shells inherit this; with it set the child runs as bare Node and never
// opens a window.
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electronPath, ['.', ...process.argv.slice(2)], {
  cwd: APP_ROOT,
  env,
  stdio: 'inherit',
});
child.on('exit', (code) => process.exit(code == null ? 0 : code));
