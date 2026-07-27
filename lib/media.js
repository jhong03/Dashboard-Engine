'use strict';

// "Now playing" monitor: a long-lived PowerShell watcher (scripts/
// media-nowplaying.ps1) reads the Windows System Media Transport Controls — the
// current track from Spotify, a browser, ANY player — and emits JSON lines.
// Transport control is a separate one-shot (scripts/media-control.ps1).
//
// PERSONAL data (like notifications/launcher): it's only DISPLAYED on the
// wallpaper, never written into a pack or export. Fail-soft everywhere
// (CLAUDE.md): non-Windows, a spawn failure, or the watcher dying leaves the
// state at "nothing playing" and the wallpaper keeps running.

const { spawn } = require('child_process');
const path = require('path');

const CONTROL_ACTIONS = new Set(['playpause', 'next', 'previous']);

function psArgs(appRoot, script, extra = []) {
  return ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', path.join(appRoot, 'scripts', script), ...extra];
}

/**
 * @param {(state:object)=>void} onChange fires whenever the now-playing state changes.
 * @returns {{ current():object, control(action:string):Promise, stop():void }}
 */
function createMediaMonitor(appRoot, onChange, excludeId = '') {
  let last = { has: false };
  const exclude = typeof excludeId === 'string' ? excludeId : '';

  const controlOffline = () => Promise.resolve({ ok: false, error: 'Media control is only available on Windows.' });
  if (process.platform !== 'win32') {
    return { current: () => last, control: controlOffline, stop() {} };
  }

  let child = null;
  let buffer = '';
  try {
    child = spawn('powershell.exe', psArgs(appRoot, 'media-nowplaying.ps1', ['-Exclude', exclude]),
      { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  } catch {
    child = null; // spawn failed — fail-soft, stays "nothing playing"
  }

  if (child) {
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        let obj = null;
        try { obj = JSON.parse(line); } catch { continue; }
        if (!obj || obj.ok === false) continue; // keep last state on a transient error line
        last = obj.has ? obj : { has: false };
        try { onChange(last); } catch { /* never let a listener break the reader */ }
      }
    });
    child.on('error', () => { /* keep last state; fail-soft */ });
    child.on('close', () => { child = null; });
  }

  // One-shot transport control. The action is validated and passed as a
  // separate argv element — never interpolated into a command line.
  const control = (action) => new Promise((resolve) => {
    if (!CONTROL_ACTIONS.has(action)) { resolve({ ok: false, error: 'Invalid media action.' }); return; }
    let out = '';
    let proc;
    try {
      proc = spawn('powershell.exe', psArgs(appRoot, 'media-control.ps1', ['-Action', action, '-Exclude', exclude]),
        { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    } catch { resolve({ ok: false, error: 'Could not run media control.' }); return; }
    proc.stdout.on('data', (d) => { out += d.toString('utf8'); });
    proc.on('error', () => resolve({ ok: false, error: 'Media control failed.' }));
    proc.on('close', () => {
      try { resolve(JSON.parse(out.trim().split('\n').pop() || '{"ok":true}')); }
      catch { resolve({ ok: true }); }
    });
  });

  return {
    current: () => last,
    control,
    stop() { if (child) { try { child.kill(); } catch { /* already gone */ } child = null; } },
  };
}

module.exports = { createMediaMonitor, CONTROL_ACTIONS };
