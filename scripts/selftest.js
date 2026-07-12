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
