'use strict';

// Controlled regression check for the native desktop helpers. It deliberately
// uses an invalid HWND, so it exercises PowerShell + Add-Type + the helper's
// validation path without reparenting any real window under Explorer.

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const attach = path.join(ROOT, 'scripts', 'desktop-attach.ps1');
const watcher = path.join(ROOT, 'scripts', 'fullscreen-watch.ps1');

function fail(message) {
  console.error(`[desktop-check] FAILED: ${message}`);
  process.exitCode = 1;
}

if (process.platform !== 'win32') {
  console.log('[desktop-check] SKIPPED (Windows helpers are platform-specific)');
  process.exit(0);
}

for (const file of [attach, watcher]) {
  if (!fs.existsSync(file)) { fail(`missing ${file}`); process.exit(1); }
}

function invalidHwndCheck(args, label) {
  const result = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', attach, '1', ...args,
  ], { cwd: ROOT, encoding: 'utf8', timeout: 30000, windowsHide: true });
  const output = `${result.stdout || ''}\n${result.stderr || ''}`;
  if (result.error) {
    fail(`${label} helper could not start: ${result.error.message}`);
    return false;
  }
  if (result.status === 0 || !output.includes('invalid-window')) {
    fail(`invalid HWND was not rejected safely by ${label} (status=${result.status}, output=${output.trim().slice(0, 300)})`);
    return false;
  }
  return true;
}

if (invalidHwndCheck([], 'attach') && invalidHwndCheck(['-Detach'], 'detach')) {
  console.log('[desktop-check] attach/detach helpers compile and reject invalid HWND');
}

// Start the watcher just long enough to observe its initial state, then stop
// this test-owned process. It only reads foreground/monitor state.
const proc = spawn('powershell.exe', [
  '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
  '-File', watcher, '-Monitor', '-1', '-ExcludeHwnd', '1',
], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
let output = '';
let done = false;
const finish = (ok, detail) => {
  if (done) return;
  done = true;
  clearTimeout(timer);
  try { proc.kill(); } catch { /* already closed */ }
  if (!ok) fail(detail);
  else console.log('[desktop-check] fullscreen watcher starts and reports an initial state');
};
proc.stdout.on('data', (chunk) => {
  output += chunk.toString('utf8');
  if (/\b(?:NORMAL|FULLSCREEN)\b/.test(output)) finish(true);
});
proc.on('error', (error) => finish(false, `fullscreen watcher could not start: ${error.message}`));
proc.on('close', (code) => {
  if (!done) finish(false, `fullscreen watcher exited before initial state (code=${code})`);
});
const timer = setTimeout(() => finish(false, 'fullscreen watcher timed out before initial state'), 10000);
