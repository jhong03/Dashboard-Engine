'use strict';

// Bundled local LLM — the assistant's ONE and ONLY model. A single llama.cpp
// server (llama-server.exe) serves the bundled Qwen2.5-1.5B GGUF over an
// OpenAI-compatible HTTP API on loopback (127.0.0.1). It ships in the app depot,
// so it installs automatically with the app via Steam — no external software, no
// account, no model choice. (This is the Steam-review requirement: the AI must
// work out of the box with a single bundled model.)
//
// Lifecycle: spawned LAZILY on first assistant use (so it never adds to launch
// cost), kept warm during a session, and stopped on the performance freeze / app
// quit to hand a game its RAM back. FAIL-SOFT: if the binary/model is missing or
// the server can't start (too little RAM, ancient CPU), ensureServer() resolves
// null and the assistant simply reports "unavailable" — the rest of the app is
// unaffected. The endpoint is loopback-only, matching the assistant's no-cloud
// privacy rule.

const { spawn } = require('child_process');
const net = require('net');
const os = require('os');
const path = require('path');
const fs = require('fs');
const http = require('http');

// Cosmetic model id — llama-server serves whatever model it loaded regardless of
// the "model" field in the request, so this is just a label for the API shape.
const MODEL_NAME = 'qwen2.5-1.5b-instruct';
const CTX = 4096;                       // context window — small keeps CPU fast + RAM low
const HEALTH_TIMEOUT_MS = 120 * 1000;   // first load reads ~1 GB off disk; be patient on weak/HDD machines

let child = null;
let port = 0;
let starting = null;      // in-flight ensureServer() promise — concurrent asks share one spawn
let lastStderr = '';

function serverExe() { return process.platform === 'win32' ? 'llama-server.exe' : 'llama-server'; }

// The bundled runtime + model live in bin/llm/. Prefer a user-data copy (so a
// future updater could refresh it without touching the install), else the app
// install dir. Returns the directory that actually has the server binary, or null.
function binDir(appRoot) {
  const dirs = [];
  try { dirs.push(path.join(require('./paths').userDataDir(), 'bin', 'llm')); } catch { /* ignore */ }
  if (appRoot) dirs.push(path.join(appRoot, 'bin', 'llm'));
  for (const d of dirs) {
    try { if (fs.existsSync(path.join(d, serverExe()))) return d; } catch { /* ignore */ }
  }
  return null;
}

// The single bundled GGUF (any *.gguf in the runtime dir).
function findModel(dir) {
  try {
    const f = fs.readdirSync(dir).find((n) => n.toLowerCase().endsWith('.gguf'));
    return f ? path.join(dir, f) : null;
  } catch { return null; }
}

// Is the bundled assistant model present at all? (binary + a gguf). Used to show
// the feature as available without spawning anything.
function isInstalled(appRoot) {
  const dir = binDir(appRoot);
  return !!(dir && findModel(dir));
}

// Ask the OS for a free loopback port (avoids a fixed-port collision).
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

// llama-server's /health returns 200 once the model is loaded (503 while loading).
function health(p) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: p, path: '/health', timeout: 2000 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

async function waitHealthy(p, deadline) {
  while (Date.now() < deadline) {
    if (child === null) return false; // the process died while we waited
    if (await health(p)) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

// Thread count for inference. os.cpus() reports LOGICAL cores; using cores-1 there
// oversubscribes the physical cores on a hyperthreaded CPU and saturates the whole
// machine (the "assistant spikes my CPU" report). A 1.5B model is memory-bandwidth
// bound past ~4-6 threads anyway, so cap low and leave 2 logical cores free for the
// wallpaper + UI. DE_LLM_THREADS overrides for tuning.
function threads() {
  const env = parseInt(process.env.DE_LLM_THREADS || '', 10);
  if (Number.isInteger(env) && env >= 1) return env;
  const n = (os.cpus() || []).length || 4;
  return Math.max(2, Math.min(6, n - 2));
}

/**
 * Ensure the bundled model server is running; resolve { baseUrl, model } (an
 * OpenAI-compatible loopback endpoint) or null on any failure. Safe to call on
 * every request — a healthy server is reused, and concurrent callers share one
 * spawn.
 */
async function ensureServer(appRoot) {
  if (child && port && (await health(port))) {
    return { baseUrl: `http://127.0.0.1:${port}/v1`, model: MODEL_NAME };
  }
  if (starting) return starting;
  starting = (async () => {
    try {
      const dir = binDir(appRoot);
      if (!dir) return null;
      const model = findModel(dir);
      if (!model) return null;
      const p = await freePort().catch(() => 0);
      if (!p) return null;
      // Loopback only. -c small for CPU speed; -t leaves a core for the rest of
      // the app; --no-webui / GPU flags are intentionally omitted for broad
      // version + hardware compatibility (this is the CPU build).
      const args = ['--model', model, '--host', '127.0.0.1', '--port', String(p),
        '-c', String(CTX), '-t', String(threads())];
      const proc = spawn(path.join(dir, serverExe()), args, {
        cwd: dir, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true,
      });
      proc.stderr.on('data', (c) => { lastStderr = (lastStderr + c.toString('utf8')).slice(-2000); });
      proc.on('error', () => { if (child === proc) { child = null; port = 0; } });
      proc.on('close', () => { if (child === proc) { child = null; port = 0; } });
      // Run inference BELOW normal priority so Windows keeps the wallpaper + UI
      // responsive during a reply — the server still gets full CPU when nothing else
      // needs it, but yields instantly when the desktop does. Best-effort.
      try { os.setPriority(proc.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch (e) { /* not supported / no permission */ }
      child = proc;
      port = p;
      const ok = await waitHealthy(p, Date.now() + HEALTH_TIMEOUT_MS);
      if (!ok) { stop(); return null; }
      return { baseUrl: `http://127.0.0.1:${p}/v1`, model: MODEL_NAME };
    } catch {
      stop();
      return null;
    } finally {
      starting = null;
    }
  })();
  return starting;
}

// Stop the server (performance freeze / app quit) so a game gets its RAM back.
function stop() {
  if (child) { try { child.kill(); } catch { /* ignore */ } }
  child = null;
  port = 0;
}

function lastError() { return lastStderr.trim().split('\n').slice(-6).join('\n'); }

module.exports = { ensureServer, stop, isInstalled, lastError };
