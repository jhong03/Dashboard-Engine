'use strict';

// End-to-end self test: boot the real app, let the renderer run one scripted
// synthesis + profile save over the actual IPC bridge, and read the verdict
// from its console output.
//
//   npm run selftest
//
// Exits 0 on [SELFTEST] PASS, 1 otherwise. Needs piper + ffmpeg + the default
// voice installed — this is the "does the whole panel actually work" check,
// not a unit test.

const { spawn } = require('child_process');
const path = require('path');

const APP_ROOT = path.join(__dirname, '..');
const TIMEOUT_MS = 60000;

// Pure-node pre-check (Particle Studio, Phase E): the data-driven particle
// engine must be DETERMINISTIC — same seed ⇒ same first-frame state — and every
// factory preset must sanitize to a valid custom system. This is the parity
// property that keeps preset resolution consistent; it runs before the Electron
// boot so a regression fails fast without a window.
function particleChecks() {
  const P = require(path.join(APP_ROOT, 'src', 'particles.js'));
  const packs = require(path.join(APP_ROOT, 'lib', 'packs.js'));
  const seeded = (s) => { let a = s >>> 0; return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
  const dims = { w: 1920, h: 1080 };
  const PALETTE = { void: '#04080F', glass: '#0A1623', accent: '#3FD8FF', accentBright: '#7FE9FF', muted: '#5A7E93', warn: '#FFB23E', gold: '#E8C56A' };
  const fail = (m) => { console.error(`[SELFTEST] particle check FAILED: ${m}`); process.exit(1); };
  for (const name of Object.keys(P.FACTORY_PRESETS)) {
    const def = P.factoryFor(name);
    const a = JSON.stringify(P.createParticleSystem(def, dims, seeded(42)).snapshot());
    const b = JSON.stringify(P.createParticleSystem(def, dims, seeded(42)).snapshot());
    if (a !== b) fail(`factory '${name}' is not deterministic under a fixed seed`);
    const { pack } = packs.sanitizePack({ schema: 2, name: 'x', author: 'x', persona: { name: 'x', tagline: '', lines: [] }, skin: { palette: PALETTE, ambience: { mode: 'custom', system: P.factoryFor(name) } }, components: [] }, 'x');
    const sys = pack.skin.ambience.system;
    if (!(pack.skin.ambience.mode === 'custom' && sys && sys.count >= 1 && sys.count <= 400)) fail(`factory '${name}' did not sanitize to a valid custom system`);
  }
  console.log('[SELFTEST] particle determinism + factory presets OK');
}
particleChecks();

// Under plain Node, require('electron') resolves to the binary's path.
const electronPath = require('electron');

const env = { ...process.env, DE_SELFTEST: '1' };
// Inherited from Electron-based shells (VS Code); with it set, the child
// would run as bare Node and never open a window.
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electronPath, ['.', '--enable-logging'], {
  cwd: APP_ROOT,
  env,
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});

let verdict = null;
const timer = setTimeout(() => {
  verdict = verdict || 'TIMEOUT';
  child.kill();
}, TIMEOUT_MS);

function scan(chunk) {
  const text = chunk.toString('utf8');
  const match = /\[SELFTEST\] (PASS|FAIL)([^\r\n"]*)/.exec(text);
  if (match && !verdict) {
    verdict = match[1];
    console.log(`selftest: ${match[1]}${match[2]}`);
  }
}
child.stdout.on('data', scan);
child.stderr.on('data', scan);

child.on('error', (err) => {
  clearTimeout(timer);
  console.error(`selftest: could not launch Electron — ${err.message}`);
  process.exitCode = 1;
});

child.on('close', () => {
  clearTimeout(timer);
  if (verdict === 'PASS') {
    process.exitCode = 0;
  } else {
    console.error(`selftest: ${verdict === 'TIMEOUT' ? 'timed out waiting for the app' : verdict || 'app exited without reporting'}`);
    process.exitCode = 1;
  }
});
