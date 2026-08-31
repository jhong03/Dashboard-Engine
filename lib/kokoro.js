'use strict';

// Kokoro TTS via a warm sidecar (engine/kokoro/kokoro_sidecar.py in dev, or a
// frozen kokoro-engine binary once packaged). Parallel to lib/melotts.js and
// lib/piper.js — but ONE ONNX model covers every language/voice, so unlike
// MeloTTS there is no per-language process: a single warm child serves all
// voices. It reuses MeloTTS's stdout binary framing and the profile→rate maths.
//
// Kokoro exposes only speaking SPEED, so expressiveness/steadiness don't apply
// here; the shared DSP chain still shapes pitch, timbre and character afterwards
// (that's what defines a distinctive character voice), so a voice stays consistent.
//
// Security (CLAUDE.md): user text goes to the sidecar over stdin as a JSON line,
// never a command-line argument. The engine has no network.

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const piper = require('./piper');

// Kokoro's `speed` is a plain multiplier (1 = natural). Map it from the profile's
// calibrated rate, reusing Piper's length-scale (speed = 1 / lengthScale).
function knobsForProfile(profile, baselineWpm) {
  const lengthScale = piper.lengthScaleForRate(profile.prosody.rate, baselineWpm);
  return { speed: 1 / lengthScale };
}

// ── Discovery ────────────────────────────────────────────────────────────────

// The model is one pair of files (the ONNX net + the packed voice embeddings).
// Look in the writable user-data dir (where the downloader puts it, survives app
// updates) then the app install dir. Returns { model, voices } or null.
function findModel(appRoot) {
  const dirs = [];
  try { dirs.push(path.join(require('./paths').userDataDir(), 'voices', 'kokoro')); } catch { /* no user dir */ }
  if (appRoot) dirs.push(path.join(appRoot, 'voices', 'kokoro'));
  for (const dir of dirs) {
    const model = path.join(dir, 'kokoro-v1.0.onnx');
    const voices = path.join(dir, 'voices-v1.0.bin');
    if (fs.existsSync(model) && fs.existsSync(voices)) return { model, voices };
  }
  return null;
}

// The runner: a frozen kokoro-engine(.exe) once packaged, else (dev) the repo
// venv's python + the sidecar script (honouring DE_KOKORO_PYTHON). Returns a
// { cmd, args } prefix or null.
function findRunner(appRoot) {
  const exe = process.platform === 'win32' ? 'kokoro-engine.exe' : 'kokoro-engine';
  const frozen = [];
  try { frozen.push(path.join(require('./paths').userDataDir(), 'bin', 'kokoro', exe)); } catch { /* no user dir */ }
  if (appRoot) frozen.push(path.join(appRoot, 'bin', 'kokoro', exe));
  for (const f of frozen) if (fs.existsSync(f)) return { cmd: f, args: [] };
  // Dev fallback: python + the sidecar script.
  const script = appRoot ? path.join(appRoot, 'engine', 'kokoro', 'kokoro_sidecar.py') : null;
  if (script && fs.existsSync(script)) {
    const candidates = [];
    if (process.env.DE_KOKORO_PYTHON) candidates.push(process.env.DE_KOKORO_PYTHON);
    candidates.push(process.platform === 'win32'
      ? path.join(appRoot, 'engine', 'kokoro', '.venv', 'Scripts', 'python.exe')
      : path.join(appRoot, 'engine', 'kokoro', '.venv', 'bin', 'python'));
    for (const py of candidates) if (py && fs.existsSync(py)) return { cmd: py, args: [script] };
  }
  return null;
}

function isReady(appRoot) {
  return !!(findModel(appRoot) && findRunner(appRoot));
}

// ── Warm child ───────────────────────────────────────────────────────────────
// One long-lived process, one request at a time (the IPC layer serialises synth
// with synthesisBusy). If it dies, the next call respawns it.

let child = null;
let inflight = null;
const waiters = [];
let stderrTail = '';

// Free the engine's ~0.4 GB after a spell with no synthesis, so a voice warmed once
// (or left resident from switching voices) doesn't hold RAM forever. The next synth
// respawns it. DE_VOICE_IDLE_MS overrides (0 disables).
let idleTimer = null;
const IDLE_STOP_MS = (() => {
  const n = parseInt(process.env.DE_VOICE_IDLE_MS || '', 10);
  return Number.isInteger(n) && n >= 0 ? n : 5 * 60 * 1000;
})();
function clearIdleStop() { if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; } }
function scheduleIdleStop() {
  clearIdleStop();
  if (!IDLE_STOP_MS || !child) return;
  idleTimer = setTimeout(() => { idleTimer = null; if (!inflight && waiters.length === 0) killEngine(); }, IDLE_STOP_MS);
}

function killEngine() {
  clearIdleStop();
  if (child) { try { child.kill(); } catch { /* ignore */ } }
  child = null;
  const dead = new Error('Kokoro engine restarted.');
  if (inflight) { const r = inflight; inflight = null; try { r.reject(dead); } catch { /* settled */ } }
  while (waiters.length) { try { waiters.shift().reject(dead); } catch { /* settled */ } }
}

function ensureChild(appRoot) {
  if (child) return child;
  const runner = findRunner(appRoot);
  const model = findModel(appRoot);
  if (!runner || !model) throw new Error('Kokoro engine or model not installed.');

  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE; // never leak Electron's node mode into the child
  // Clean, empty CWD (same rationale as the MeloTTS engine — a frozen Python keeps
  // '' on sys.path, and a Steam-launched CWD is unpredictable).
  let cwd;
  try { cwd = path.join(os.tmpdir(), 'dashboard-engine-engine-cwd'); fs.mkdirSync(cwd, { recursive: true }); } catch { cwd = undefined; }

  const proc = spawn(runner.cmd, [...runner.args, model.model, model.voices], { cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env });
  child = proc;

  // Same framing as MeloTTS: byte 0 status (0 ok / non-zero err); ok →
  // uint32-LE sampleRate, uint32-LE pcmLen, pcmLen bytes s16le; err → uint32-LE
  // msgLen, msgLen bytes utf-8.
  let buf = Buffer.alloc(0);
  proc.stdout.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (inflight) {
      if (buf.length < 1) break;
      if (buf[0] === 0) {
        if (buf.length < 9) break;
        const sampleRate = buf.readUInt32LE(1);
        const pcmLen = buf.readUInt32LE(5);
        if (buf.length < 9 + pcmLen) break;
        const pcm = buf.subarray(9, 9 + pcmLen);
        buf = buf.subarray(9 + pcmLen);
        const req = inflight; inflight = null;
        req.resolve({ pcm: Buffer.from(pcm), sampleRate });
      } else {
        if (buf.length < 5) break;
        const msgLen = buf.readUInt32LE(1);
        if (buf.length < 5 + msgLen) break;
        const msg = buf.subarray(5, 5 + msgLen).toString('utf8');
        buf = buf.subarray(5 + msgLen);
        const req = inflight; inflight = null;
        req.reject(new Error(msg || 'Kokoro synthesis failed.'));
      }
      pump();
    }
  });
  proc.stderr.on('data', (chunk) => { stderrTail = (stderrTail + chunk.toString('utf8')).slice(-500); });

  const onGone = (info) => {
    if (child !== proc) return;
    const detail = stderrTail.trim().split('\n').pop() || info;
    if (inflight) { const req = inflight; inflight = null; req.reject(new Error(`Kokoro engine stopped: ${detail}`)); }
    while (waiters.length) waiters.shift().reject(new Error(`Kokoro engine stopped: ${detail}`));
    killEngine();
  };
  proc.on('error', (err) => onGone(err.message));
  proc.on('close', (code) => onGone(`exit code ${code}`));
  return proc;
}

function pump() {
  if (inflight) return;
  if (waiters.length === 0) { scheduleIdleStop(); return; } // engine idle — free it after a spell
  if (!child) return;
  clearIdleStop();
  const next = waiters.shift();
  inflight = next;
  const line = JSON.stringify(next.request) + '\n';
  child.stdin.write(line, (err) => {
    if (err && inflight === next) { inflight = null; next.reject(new Error(`Could not send to Kokoro engine: ${err.message}`)); }
  });
}

/**
 * Synthesize text to raw PCM (s16le, mono) with the Kokoro engine.
 * @param {string} text
 * @param {object} profile — same profile shape every engine uses
 * @param {string} appRoot
 * @param {object} [opts] — { voice: kokoro voice id (e.g. "bm_george"),
 *   lang: kokoro lang (e.g. "en-gb"), baselineWpm: voices.json wpmAtScale1 }
 * @returns Promise<{ pcm: Buffer, sampleRate: number }>
 */
function synthesize(text, profile, appRoot, opts = {}) {
  return new Promise((resolve, reject) => {
    if (typeof text !== 'string' || text.trim() === '') { reject(new Error('Nothing to speak: the text is empty.')); return; }
    if (!isReady(appRoot)) { reject(new Error('The Kokoro voice engine is not installed yet.')); return; }
    let proc;
    try { proc = ensureChild(appRoot); } catch (e) { reject(e); return; }
    if (!proc) { reject(new Error('Kokoro engine unavailable.')); return; }
    const knobs = knobsForProfile(profile, opts.baselineWpm);
    const request = {
      text: text.replace(/\s*\n\s*/g, ' ').trim(),
      voice: opts.voice || 'bm_george',
      lang: opts.lang || 'en-us',
      speed: Number(knobs.speed.toFixed(3)),
    };
    waiters.push({ request, resolve, reject });
    pump();
  });
}

function prewarm(appRoot, voice = 'bm_george', lang = 'en-us') {
  try {
    if (!isReady(appRoot)) return;
    synthesize('Hello.', require('./profiles').defaultProfile(), appRoot, { voice, lang }).catch(() => {});
  } catch { /* best effort */ }
}

module.exports = { synthesize, findModel, findRunner, isReady, prewarm, knobsForProfile, killEngine };
