'use strict';

// Two-process coordination for the "Steam session vs. persistent engine" split
// (Wallpaper-Engine-style: Steam shows "playing" only while the Manager is open,
// and the wallpaper keeps running when it isn't).
//
//   ENGINE  — the persistent process: tray + wallpaper + Manager + all NON-Steam
//             IPC. Runs a local IPC server on a per-user named pipe. NOT the
//             Steam-tracked process (spawned detached, or started at login), and it
//             NEVER touches the Steam API (that would make Steam mark IT "playing").
//   SESSION — the Steam-LAUNCHED process. It owns the Steam API client (Workshop +
//             achievements) and stays alive only until the engine says the Manager
//             closed. Its lifetime = Steam's "playing" indicator.
//
// The engine forwards every Steam-touching operation to the session over an RPC on
// this same pipe, so the persistent engine never opens a Steam connection.
//
// Protocol: newline-delimited JSON.
//   session -> engine : {cmd:'open-manager'} | {cmd:'edit', id}
//                       {cmd:'rpc-result', id, ok, result?, error?}
//   engine  -> session: {cmd:'session-end'}                 (Manager closed -> quit)
//                       {cmd:'rpc', id, method, args}        (run a Steam op)
//
// FAIL-SOFT (CLAUDE.md): every path is guarded. If a session can't reach or start an
// engine, it calls onFail so the caller can fall back to running the engine itself —
// the desktop must never end up with no wallpaper.

const net = require('net');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const { spawn } = require('child_process');

const RPC_TIMEOUT_MS = 60000; // Steam ops (publish upload) can be slow; fail soft after.
const ENGINE_ARG = '--engine'; // marks a spawned process as the persistent engine

// Spawn the persistent engine so it OUTLIVES this Steam-launched session (a normal
// Manager close). detached + unref keeps it running when the session exits.
//
// NOTE (the reliable path): on Windows this leaves the engine INSIDE Steam's job
// object — the SUSPECTED cause of the "Workshop only works on the first launch"
// bug (a lingering job member may stop Steam from cleanly relaunching a fresh
// session). A job-breakaway spawn via WMI Win32_Process.Create was tried (commit
// 028586a) but broke startup on the real cold Steam launch: WMI verifies fine in a
// warm shell (right session, environment, quoting) yet the engine did not come up
// reliably when launched cold from inside Steam's job, and routing the fallback
// through WMI too removed the reliable safety net. So we're back to this direct
// spawn (build-4 behaviour) PLUS the session-lifecycle engine.log breadcrumbs, so
// one real reproduction shows exactly WHERE the relaunch breaks before we commit to
// a specific breakaway mechanism. execPath is our OWN binary path (never user input).
function spawnDetachedEngine(execPath, log) {
  try { spawn(execPath, [ENGINE_ARG], { detached: true, stdio: 'ignore', windowsHide: true }).unref(); }
  catch (e) { log && log(`engine spawn (detached) failed: ${e && e.message}`); }
}

// A per-user pipe/socket name so two accounts on one machine never collide.
function linkPath() {
  const id = crypto.createHash('sha1')
    .update(`${os.userInfo().username || 'user'}|dashboard-engine`)
    .digest('hex').slice(0, 12);
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\de-engine-${id}`
    : path.join(os.tmpdir(), `de-engine-${id}.sock`);
}

// Read newline-delimited JSON off a socket, calling onMessage(obj) per line. Returns
// a function to feed chunks in. Malformed lines are skipped (never throw).
function lineReader(onMessage) {
  let buf = '';
  return (chunk) => {
    buf += chunk.toString('utf8');
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
      let msg = null; try { msg = JSON.parse(line); } catch { msg = null; }
      if (msg && typeof msg.cmd === 'string') { try { onMessage(msg); } catch { /* fail-soft */ } }
    }
  };
}

function writeMsg(socket, obj) {
  try { socket.write(`${JSON.stringify(obj)}\n`); return true; } catch { return false; }
}

// ENGINE side. handlers: { onOpen(), onEdit(id), onSessionGone(), onError(err) }.
// Returns { endSession(), call(method, args), hasSession(), close() }.
//   call(method, args) -> Promise: forwards a Steam op to the connected session and
//     resolves with its result; rejects (code NO_SESSION) if none is connected.
function serve(handlers) {
  let activeSocket = null;
  const pending = new Map();  // rpc id -> { resolve, reject, timer }
  let rpcSeq = 0;

  const rejectAllPending = (reason) => {
    for (const [, p] of pending) { clearTimeout(p.timer); try { p.reject(reason); } catch { /* ignore */ } }
    pending.clear();
  };

  const log = handlers.log || (() => {});
  const server = net.createServer((socket) => {
    // If a session is already connected when a new one arrives (e.g. a silent
    // session and its steam:// fallback both landed), end the OLD one so we never
    // leave two "playing" processes alive.
    if (activeSocket && activeSocket !== socket) {
      log('a new session connected while one was active — ending the old one');
      try { writeMsg(activeSocket, { cmd: 'session-end' }); } catch { /* ignore */ }
    }
    activeSocket = socket;
    log('session connected (Steam session owns the Steam client)');
    const feed = lineReader((msg) => {
      if (msg.cmd === 'open-manager') handlers.onOpen && handlers.onOpen();
      else if (msg.cmd === 'workshop-session') handlers.onWorkshopSession && handlers.onWorkshopSession();
      else if (msg.cmd === 'edit') handlers.onEdit && handlers.onEdit(String(msg.id || 'jarvis'));
      else if (msg.cmd === 'rpc-result') {
        const p = pending.get(msg.id);
        if (p) { pending.delete(msg.id); clearTimeout(p.timer); msg.ok ? p.resolve(msg.result) : p.reject(new Error(msg.error || 'Steam op failed.')); }
      }
    });
    socket.on('data', feed);
    socket.on('error', () => {});
    socket.on('close', () => {
      if (activeSocket === socket) { activeSocket = null; rejectAllPending(Object.assign(new Error('Session ended.'), { code: 'NO_SESSION' })); }
      log('session disconnected (no Steam client until a new session connects)');
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
      if (activeSocket) writeMsg(activeSocket, { cmd: 'session-end' });
    },
    hasSession() { return !!activeSocket; },
    // Forward a Steam operation to the session; resolves with its return value.
    call(method, args) {
      return new Promise((resolve, reject) => {
        if (!activeSocket) return reject(Object.assign(new Error('No Steam session is open.'), { code: 'NO_SESSION' }));
        const id = ++rpcSeq;
        const timer = setTimeout(() => { pending.delete(id); reject(Object.assign(new Error('Steam op timed out.'), { code: 'TIMEOUT' })); }, RPC_TIMEOUT_MS);
        pending.set(id, { resolve, reject, timer });
        if (!writeMsg(activeSocket, { cmd: 'rpc', id, method, args })) {
          pending.delete(id); clearTimeout(timer);
          reject(Object.assign(new Error('No Steam session is open.'), { code: 'NO_SESSION' }));
        }
      });
    },
    close() { try { server.close(); } catch { /* none */ } },
  };
}

// SESSION side. Ensures an engine is running (spawns one DETACHED if not) and asks
// it to run `intent`. onEnd() fires when the engine says the Manager closed OR the
// connection drops (session should quit). onFail() fires if no engine can be reached
// or started (caller runs the engine itself). onRpc(method, args) -> Promise runs a
// Steam op the engine forwarded (this process owns the Steam client). execPath is the
// app binary.
function connect(execPath, intent, { onEnd, onFail, onRpc, log }) {
  const say = log || (() => {});
  let settled = false;
  const finish = (fn) => { if (!settled) { settled = true; try { fn && fn(); } catch { /* fail-soft */ } } };

  let attempts = 0;
  let spawnedEngine = false;
  const spawnEngine = () => {
    if (spawnedEngine) return;
    spawnedEngine = true;
    // No engine listening yet → start one. It must OUTLIVE this session (see
    // spawnDetachedEngine).
    say('no engine on the pipe; spawning the persistent engine');
    spawnDetachedEngine(execPath, say);
  };

  const tryConnect = () => {
    if (settled) return;
    let connected = false;
    const socket = net.connect(linkPath());
    socket.on('connect', () => {
      connected = true;
      say(`connected to engine; requesting ${intent.cmd || 'open'}`);
      writeMsg(socket, intent);
      const feed = lineReader((msg) => {
        if (msg.cmd === 'session-end') { say('engine reports manager closed; ending session'); finish(onEnd); return; } // Manager closed
        if (msg.cmd === 'rpc') {
          // Run the forwarded Steam op and reply. onRpc must resolve/reject; either
          // way the engine gets a rpc-result (never left hanging).
          Promise.resolve()
            .then(() => (onRpc ? onRpc(msg.method, msg.args || []) : Promise.reject(new Error('Steam is unavailable.'))))
            .then((result) => writeMsg(socket, { cmd: 'rpc-result', id: msg.id, ok: true, result }))
            .catch((err) => writeMsg(socket, { cmd: 'rpc-result', id: msg.id, ok: false, error: (err && err.message) || 'Steam op failed.' }));
        }
      });
      socket.on('data', feed);
    });
    socket.on('error', () => { socket.destroy(); });
    socket.on('close', () => {
      if (settled) return;
      if (connected) return finish(onEnd); // was connected, engine/Manager went away
      // Not connected yet: no engine listening. Start one, then keep retrying.
      attempts++;
      if (attempts === 1) spawnEngine();
      if (attempts > 40) { say('no engine after ~8s of retries; falling back'); return finish(onFail); }
      setTimeout(tryConnect, 200);
    });
  };
  tryConnect();
}

module.exports = { linkPath, serve, connect, spawnDetachedEngine };
