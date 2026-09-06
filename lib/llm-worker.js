'use strict';

// Worker thread that SPAWNS and owns the llama.cpp server process.
//
// WHY THIS EXISTS: on Windows, child_process.spawn() creates the process
// SYNCHRONOUSLY on the calling thread (libuv uv_spawn is synchronous on Win32).
// Creating llama-server.exe cold — it pulls in a stack of DLLs at process creation
// and Windows Defender inspects them — can block for ~10 s. Doing that on the
// Electron MAIN thread froze the whole dashboard ("Not Responding" / "clicks have no
// effect", the Steam-review failure). Running the spawn HERE blocks only this worker
// thread; the main thread's event loop stays free, so the UI never freezes.
//
// The child is a process-child of the whole Electron process (worker threads share
// the process), so the main thread can also kill it by PID directly — this worker's
// only real job is to absorb the synchronous spawn.

const { parentPort } = require('worker_threads');
const { spawn } = require('child_process');
const os = require('os');

let child = null;

function killChild() {
  if (child) { try { child.kill(); } catch { /* already gone */ } child = null; }
}

parentPort.on('message', (msg) => {
  if (!msg || typeof msg !== 'object') return;

  if (msg.cmd === 'spawn') {
    killChild(); // never leave a stray server behind
    try {
      // This is the ~10 s synchronous call on a cold start — but it blocks THIS
      // worker thread, not the UI.
      const proc = spawn(msg.exePath, msg.args, {
        cwd: msg.cwd, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true,
      });
      child = proc;
      // Below-normal so inference never starves the wallpaper/UI (best-effort).
      try { os.setPriority(proc.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch (e) { /* not supported */ }
      proc.stderr.on('data', (c) => {
        try { parentPort.postMessage({ event: 'stderr', chunk: c.toString('utf8') }); } catch (e) { /* ignore */ }
      });
      proc.on('error', (err) => {
        if (child === proc) child = null;
        try { parentPort.postMessage({ event: 'exited', reason: 'error', message: String((err && err.message) || err) }); } catch (e) { /* ignore */ }
      });
      proc.on('close', (code) => {
        if (child === proc) child = null;
        try { parentPort.postMessage({ event: 'exited', reason: 'close', code }); } catch (e) { /* ignore */ }
      });
      parentPort.postMessage({ event: 'spawned', pid: proc.pid });
    } catch (err) {
      child = null;
      try { parentPort.postMessage({ event: 'spawn-error', message: String((err && err.message) || err) }); } catch (e) { /* ignore */ }
    }
    return;
  }

  if (msg.cmd === 'stop') {
    killChild();
    try { parentPort.postMessage({ event: 'stopped' }); } catch (e) { /* ignore */ }
  }
});
