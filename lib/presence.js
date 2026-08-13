'use strict';

// Full-screen presence watcher. Runs ONE long-lived PowerShell process
// (scripts/fullscreen-watch.ps1) that reports when a full-screen app (a game,
// video, or presentation) takes over THE MONITOR THE WALLPAPER IS ON, so the
// engine can pause the animated wallpaper and stay a good 24/7 citizen. A
// full-screen app on a DIFFERENT monitor leaves the wallpaper visible, so it
// must not pause — the watcher is told which monitor to watch (see setMonitor).
//
// Fail-soft everywhere (CLAUDE.md): non-Windows, a spawn failure, or the
// watcher dying all leave the state at "not full-screen" — the wallpaper keeps
// running rather than wrongly freezing.

const { spawn } = require('child_process');
const path = require('path');

// Create a monitor. `onChange(isFullscreen: boolean)` fires only on transitions.
// `initialMonitor` is the wallpaper's monitor rank (Left,Top order; -1 = primary).
// Returns { stop(), setMonitor(index) } — setMonitor re-points the watcher at a
// different screen (the user picked another display, or one was plugged in);
// stop() must be called on quit so the child process doesn't linger.
function createPresenceMonitor(appRoot, onChange, initialMonitor = -1) {
  if (process.platform !== 'win32') return { stop() {}, setMonitor() {} };

  const script = path.join(appRoot, 'scripts', 'fullscreen-watch.ps1');
  let child = null;
  let stopped = false;
  let last = false;
  let monitor = Number.isInteger(initialMonitor) ? initialMonitor : -1;

  const emit = (value) => {
    if (value === last) return;
    last = value;
    try { onChange(value); } catch (err) { /* never let a listener break the watcher */ }
  };

  const spawnChild = () => {
    let proc;
    try {
      proc = spawn('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', script, '-Monitor', String(monitor),
      ], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    } catch (err) {
      child = null;
      if (!stopped) emit(false); // couldn't spawn → fail-soft, never full-screen
      return;
    }
    child = proc;

    let buffer = '';
    proc.stdout.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line === 'FULLSCREEN') emit(true);
        else if (line === 'NORMAL') emit(false);
      }
    });
    proc.on('error', () => { /* keep last state; fail-soft */ });
    proc.on('close', () => {
      // Only react if this is still the ACTIVE child. During a deliberate
      // re-point (setMonitor) the old process closes while `child` already points
      // at the new one, so we neither clear it nor flap the state — the new
      // watcher reports the real value and `last` is held until then.
      if (child !== proc) return;
      child = null;
      if (!stopped) emit(false); // watcher gone → assume not full-screen
    });
  };

  spawnChild();

  return {
    stop() {
      stopped = true;
      if (child) { try { child.kill(); } catch (err) { /* already gone */ } child = null; }
    },
    // Re-point at a different monitor. Cheap and rare (only on a display change);
    // respawn rather than message the running PowerShell (simpler, and the script
    // reads its target once at start).
    setMonitor(index) {
      const idx = Number.isInteger(index) ? index : -1;
      if (stopped || idx === monitor) return;
      monitor = idx;
      const old = child;
      spawnChild(); // sets `child` to the new process (or null if it failed)
      if (old && old !== child) { try { old.kill(); } catch (err) { /* already gone */ } }
    },
  };
}

module.exports = { createPresenceMonitor };
