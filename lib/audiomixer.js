'use strict';

// Per-app volume mixer: a long-lived PowerShell daemon (scripts/audio-mixer.ps1)
// holding the Windows Core Audio (WASAPI) session objects. WE drive the poll
// cadence — a LIST command over stdin returns a snapshot — so main can pause
// enumeration while the wallpaper is frozen (a full-screen game). SET/MUTE go
// over stdin too, which keeps sliders responsive (no ~½ s PowerShell spawn per
// drag). Applying volume is stdin text, never a shell command line (CLAUDE.md).
//
// PERSONAL data (running apps): only DISPLAYED on the wallpaper, never written
// into a pack. Fail-soft everywhere: non-Windows, a spawn failure, or the daemon
// dying leaves the state "unavailable" and the wallpaper keeps running.

const { spawn } = require('child_process');
const path = require('path');

const POLL_MS = 1200;               // how often to re-enumerate while active
const TARGET = /^(master|system|\d{1,10})$/; // valid session id: master / system / a PID

const UNAVAILABLE = { ok: false, master: null, sessions: [] };

/**
 * @param {(state:object)=>void} onChange fires whenever a fresh snapshot arrives.
 * @returns {{ state():object, setVolume, setMute, setMaster, setMasterMute, setActive, refresh, stop }}
 */
function createAudioMixer(appRoot, onChange) {
  let last = { ok: false, master: null, sessions: [] };

  const noop = { state: () => last, setVolume() {}, setMute() {}, setActive() {}, refresh() {}, stop() {} };
  if (process.platform !== 'win32') return noop;

  let child = null;
  let buffer = '';
  let pollTimer = null;
  let active = false;

  try {
    child = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', path.join(appRoot, 'scripts', 'audio-mixer.ps1'),
    ], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
  } catch (err) {
    return noop; // spawn failed — mixer unavailable, fail-soft
  }

  const fire = (state) => {
    last = state;
    try { onChange(state); } catch (err) { /* never let a listener break the reader */ }
  };

  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith('SESSIONS ')) continue;
      let obj = null;
      try { obj = JSON.parse(line.slice(9)); } catch { continue; }
      if (!obj || obj.ok !== true) { fire({ ok: false, master: null, sessions: [] }); continue; }
      fire({
        ok: true,
        master: obj.master && typeof obj.master === 'object' ? obj.master : null,
        sessions: Array.isArray(obj.sessions) ? obj.sessions : [],
      });
    }
  });
  child.on('error', () => { /* keep last state; fail-soft */ });
  child.on('close', () => { child = null; stopPolling(); fire({ ...UNAVAILABLE }); });

  function write(cmd) {
    if (!child || !child.stdin.writable) return;
    try { child.stdin.write(cmd + '\n'); } catch (err) { /* pipe gone — fail-soft */ }
  }

  function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  // The id is validated against a strict shape here; main additionally checks it
  // against the last snapshot's ids before calling, so only real sessions move.
  const validId = (id) => typeof id === 'string' && TARGET.test(id);
  const clampPct = (v) => Math.max(0, Math.min(100, Math.round(Number(v))));

  return {
    state: () => last,
    // id is "master", "system", or a PID — the daemon resolves each. Master is
    // just id "master", so there's no separate method.
    setVolume(id, pct) { if (validId(id)) write(`SET ${id} ${clampPct(pct)}`); },
    setMute(id, muted) { if (validId(id)) write(`MUTE ${id} ${muted ? 1 : 0}`); },
    // Poll only while the wallpaper is actually visible (a mixer component is up
    // and the desktop isn't frozen). Turning active on refreshes immediately.
    setActive(on) {
      const want = Boolean(on);
      if (want === active) return;
      active = want;
      if (active) { write('LIST'); pollTimer = setInterval(() => write('LIST'), POLL_MS); }
      else stopPolling();
    },
    refresh() { write('LIST'); },
    stop() {
      stopPolling();
      if (child) { try { write('QUIT'); child.kill(); } catch (err) { /* already gone */ } child = null; }
    },
  };
}

module.exports = { createAudioMixer };
