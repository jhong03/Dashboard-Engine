'use strict';

// Full-screen presence watcher. Runs ONE long-lived PowerShell process
// (scripts/fullscreen-watch.ps1) that reports when a full-screen app (a game,
// video, or presentation) takes over the screen, so the engine can pause the
// animated wallpaper and stay a good 24/7 citizen.
//
// Fail-soft everywhere (CLAUDE.md): non-Windows, a spawn failure, or the
// watcher dying all leave the state at "not full-screen" — the wallpaper keeps
// running rather than wrongly freezing.

const { spawn } = require('child_process');
const path = require('path');

// Create a monitor. `onChange(isFullscreen: boolean)` fires only on transitions.
// Returns { stop() } — call it on quit so the child process doesn't linger.
function createPresenceMonitor(appRoot, onChange) {
  if (process.platform !== 'win32') return { stop() {} };

  let child = null;
  let stopped = false;
  let last = false;

  const emit = (value) => {
    if (value === last) return;
    last = value;
    try { onChange(value); } catch (err) { /* never let a listener break the watcher */ }
  };

  try {
    child = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', path.join(appRoot, 'scripts', 'fullscreen-watch.ps1'),
    ], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  } catch (err) {
    return { stop() {} }; // spawn failed — fail-soft, never full-screen
  }

  let buffer = '';
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line === 'FULLSCREEN') emit(true);
      else if (line === 'NORMAL') emit(false);
    }
  });
  child.on('error', () => { /* keep last state; fail-soft */ });
  child.on('close', () => {
    child = null;
    if (!stopped) emit(false); // watcher gone → assume not full-screen (don't strand a frozen wallpaper)
  });

  return {
    stop() {
      stopped = true;
      if (child) { try { child.kill(); } catch (err) { /* already gone */ } child = null; }
    },
  };
}

module.exports = { createPresenceMonitor };
