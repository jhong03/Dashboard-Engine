'use strict';

// Two-process coordination for the "Steam session vs. persistent engine" split
// (Wallpaper-Engine-style: Steam shows "playing" only while the Manager is open,
// and the wallpaper keeps running when it isn't).
//
//   ENGINE  — the persistent process: tray + wallpaper + Manager + all IPC. Runs a
//             local IPC server on a per-user named pipe. NOT the Steam-tracked
//             process (it's spawned detached, or started at login).
//   SESSION — the Steam-LAUNCHED process. Thin: it asks the engine to open the
//             Manager, then stays alive only until the engine says the Manager
//             closed. Its lifetime = Steam's "playing" indicator.
//
// Protocol: newline-delimited JSON over the pipe.
//   session -> engine : {cmd:'open-manager'} | {cmd:'edit', id}
//   engine  -> session: {cmd:'session-end'}   (Manager closed -> session should quit)
//
// FAIL-SOFT (CLAUDE.md): every path is guarded. If a session can't reach or start
// an engine, it calls onFail so the caller can fall back to running the engine
// itself — the desktop must never end up with no wallpaper.

const net = require('net');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const { spawn } = require('child_process');

// A per-user pipe/socket name so two accounts on one machine never collide.
function linkPath() {
  const id = crypto.createHash('sha1')
    .update(`${os.userInfo().username || 'user'}|dashboard-engine`)
    .digest('hex').slice(0, 12);
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\de-engine-${id}`
    : path.join(os.tmpdir(), `de-engine-${id}.sock`);
}

// ENGINE side. handlers: { onOpen(), onEdit(id), onSessionGone(), onError(err) }.
// Returns { endSession(), close() }. Throws is impossible — errors go to onError.
function serve(handlers) {
  let activeSocket = null;
  const server = net.createServer((socket) => {
    activeSocket = socket;
    let buf = '';
    socket.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        let msg = null; try { msg = JSON.parse(line); } catch { msg = null; }
        if (!msg || typeof msg.cmd !== 'string') continue;
        try {
          if (msg.cmd === 'open-manager') handlers.onOpen && handlers.onOpen();
          else if (msg.cmd === 'edit') handlers.onEdit && handlers.onEdit(String(msg.id || 'jarvis'));
        } catch { /* a handler throwing must not kill the engine */ }
      }
    });
    socket.on('error', () => {});
    socket.on('close', () => {
      if (activeSocket === socket) activeSocket = null;
      try { handlers.onSessionGone && handlers.onSessionGone(); } catch { /* fail-soft */ }
    });
  });
  server.on('error', (err) => { try { handlers.onError && handlers.onError(err); } catch { /* fail-soft */ } });
  // A stale POSIX socket file from a crashed engine blocks listen(); Windows frees
  // an abandoned pipe on its own.
  if (process.platform !== 'win32') { try { fs.unlinkSync(linkPath()); } catch { /* none */ } }
  server.listen(linkPath());
  return {
    // Tell the current session its Manager closed, so it exits (Steam -> not playing).
    endSession() {
      if (!activeSocket) return;
      try { activeSocket.write(`${JSON.stringify({ cmd: 'session-end' })}\n`); } catch { /* gone */ }
    },
    close() { try { server.close(); } catch { /* none */ } },
  };
}

// SESSION side. Ensures an engine is running (spawns one DETACHED if not) and asks
// it to run `intent`. onEnd() fires when the engine says the Manager closed OR the
// connection drops (session should quit). onFail() fires if no engine can be
// reached or started (caller runs the engine itself). execPath is the app binary.
function connect(execPath, intent, { onEnd, onFail }) {
  let settled = false;
  const finish = (fn) => { if (!settled) { settled = true; try { fn && fn(); } catch { /* fail-soft */ } } };

  let attempts = 0;
  let spawnedEngine = false;
  const spawnEngine = () => {
    if (spawnedEngine) return;
    spawnedEngine = true;
    // detached + unref so the engine outlives THIS session (a normal Manager close).
    // Surviving a Steam "Stop" additionally needs escaping Steam's job object — the
    // one thing that has to be validated on the real Steam client; if it doesn't,
    // we escalate this spawn to a job-breakaway launcher.
    try { spawn(execPath, ['--engine'], { detached: true, stdio: 'ignore', windowsHide: true }).unref(); }
    catch { /* handled by the retry cap -> onFail */ }
  };

  const tryConnect = () => {
    if (settled) return;
    let connected = false;
    const socket = net.connect(linkPath());
    socket.on('connect', () => {
      connected = true;
      try { socket.write(`${JSON.stringify(intent)}\n`); } catch { /* dropped */ }
      let buf = '';
      socket.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        if (buf.includes('session-end')) finish(onEnd); // Manager closed
      });
    });
    socket.on('error', () => { socket.destroy(); });
    socket.on('close', () => {
      if (settled) return;
      if (connected) return finish(onEnd); // was connected, engine/Manager went away
      // Not connected yet: no engine listening. Start one, then keep retrying.
      attempts++;
      if (attempts === 1) spawnEngine();
      if (attempts > 40) return finish(onFail); // ~8 s of 200 ms retries -> give up
      setTimeout(tryConnect, 200);
    });
  };
  tryConnect();
}

module.exports = { linkPath, serve, connect };
