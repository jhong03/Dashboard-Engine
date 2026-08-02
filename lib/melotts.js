'use strict';

// MeloTTS synthesis via a warm sherpa-onnx sidecar (see engine/melotts/).
//
// This is the parallel to lib/piper.js. The difference is the engine: MeloTTS
// models are heavier (a ~170 MB VITS model), so instead of spawning a fresh
// process per clip we keep ONE sidecar alive and stream requests to it — the
// model loads once and every later clip (e.g. each sentence of an assistant
// reply) is fast.
//
// The tuning maths are DELIBERATELY the same as Piper's: a profile drives the
// same rate / expressiveness / steadiness, so a voice sounds consistent no
// matter which engine renders it, and the DSP chain that runs afterwards is
// engine-agnostic.
//
// Security (CLAUDE.md): user text is sent to the sidecar over stdin inside a
// JSON line — never as a command-line argument. The engine has no network and
// only reads the model files in the directory we hand it.

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const piper = require('./piper');

// ── Profile → engine knobs ──────────────────────────────────────────────────
//
// sherpa-onnx expresses rate as length_scale = 1 / speed, so we reuse Piper's
// calibrated length-scale and invert it. expressiveness/steadiness map to the
// VITS noise parameters exactly as they do for Piper. Everything else in the
// profile (pitch, timbre, character) is applied later by the shared DSP chain.
function knobsForProfile(profile, baselineWpm) {
  const prosody = profile.prosody;
  const lengthScale = piper.lengthScaleForRate(prosody.rate, baselineWpm);
  return {
    speed: 1 / lengthScale,
    noiseScale: piper.noiseScaleForExpressiveness(prosody.expressiveness),
    noiseScaleW: piper.noiseWForSteadiness(prosody.steadiness),
  };
}

// ── Engine discovery ────────────────────────────────────────────────────────

// There is one frozen engine binary per language (English, Japanese, Korean),
// each in its own bin/<engineId>/ folder so a user downloads only the languages
// they want. Look in (1) the writable user-data location the downloader uses
// (survives app updates), (2) the app install dir. Returns null if not found —
// callers fall back to Piper/system voice, they never throw.
function findEngine(appRoot, engineId = 'melotts_en') {
  const exe = process.platform === 'win32' ? 'melotts-engine.exe' : 'melotts-engine';
  let userBin = null;
  try { userBin = path.join(require('./paths').userDataDir(), 'bin', engineId, exe); } catch { userBin = null; }
  const candidates = [
    userBin,
    appRoot ? path.join(appRoot, 'bin', engineId, exe) : null,
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function isEngineInstalled(appRoot, engineId) {
  return findEngine(appRoot, engineId) !== null;
}

// A MeloTTS "model" is a directory holding the MeloTTS checkpoint + config and a
// bert/ subdirectory with that language's sentence-BERT.
function isModelInstalled(modelDir) {
  return (
    fs.existsSync(path.join(modelDir, 'checkpoint.pth')) &&
    fs.existsSync(path.join(modelDir, 'config.json')) &&
    fs.existsSync(path.join(modelDir, 'bert', 'config.json'))
  );
}

// ── Warm sidecar ────────────────────────────────────────────────────────────
//
// One long-lived process. It handles a single request at a time (the IPC layer
// already serialises synthesis with synthesisBusy); a second concurrent call
// waits its turn. If the process dies, the next call respawns it.

let child = null;
let childKey = null;          // `${enginePath}|${lang}` — the engine locks to one language
let inflight = null;         // { resolve, reject, parser } for the current request
const waiters = [];          // queued requests when one is already inflight
let stderrTail = '';

function killEngine() {
  if (child) {
    try { child.kill(); } catch { /* ignore */ }
  }
  child = null;
  childKey = null;
}

// One warm process serves ONE language (the engine binary locks to the first
// language it sees), so key it by engine path AND language: switching language
// respawns for the new one.
function ensureChild(enginePath, lang) {
  const key = `${enginePath}|${lang}`;
  if (child && childKey === key) return child;
  killEngine();

  // PYTORCH_JIT=0 makes MeloTTS's @torch.jit.script helpers run eagerly — a
  // frozen build has no .py source for TorchScript to compile from, so JIT must
  // be off. Same maths, just not JIT-compiled.
  const env = { ...process.env, PYTORCH_JIT: '0' };
  delete env.ELECTRON_RUN_AS_NODE; // never leak Electron's node mode into the child
  const proc = spawn(enginePath, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env });
  child = proc;
  childKey = `${enginePath}|${lang}`;

  // Response frame parser. Frames are:
  //   byte 0 status (0 ok / 1 err)
  //   ok:  uint32 LE sampleRate, uint32 LE pcmLen, pcmLen bytes s16le
  //   err: uint32 LE msgLen, msgLen bytes utf8
  let buf = Buffer.alloc(0);
  proc.stdout.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    // Try to complete the current inflight request from the buffer.
    // eslint-disable-next-line no-constant-condition
    while (inflight) {
      if (buf.length < 1) break;
      const status = buf[0];
      if (status === 0) {
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
        req.reject(new Error(msg || 'MeloTTS synthesis failed.'));
      }
      pump();
    }
  });

  proc.stderr.on('data', (chunk) => {
    stderrTail = (stderrTail + chunk.toString('utf8')).slice(-500);
  });

  const onGone = (info) => {
    // Ignore a stale child we already replaced (e.g. after switching to a
    // different-language engine) — its late 'close' must not reject the new
    // engine's pending work.
    if (child !== proc) return;
    const detail = stderrTail.trim().split('\n').pop() || info;
    if (inflight) { const req = inflight; inflight = null; req.reject(new Error(`MeloTTS engine stopped: ${detail}`)); }
    while (waiters.length) { waiters.shift().reject(new Error(`MeloTTS engine stopped: ${detail}`)); }
    killEngine();
  };
  proc.on('error', (err) => onGone(err.message));
  proc.on('close', (code) => onGone(`exit code ${code}`));

  return proc;
}

// Send the next queued request if the engine is idle.
function pump() {
  if (inflight || waiters.length === 0 || !child) return;
  const next = waiters.shift();
  inflight = next;
  const line = JSON.stringify(next.request) + '\n';
  child.stdin.write(line, (err) => {
    if (err && inflight === next) {
      inflight = null;
      next.reject(new Error(`Could not send to MeloTTS engine: ${err.message}`));
    }
  });
}

/**
 * Synthesize text to raw PCM (s16le, mono) using the MeloTTS engine.
 * @param {string} text
 * @param {object} profile — the same profile Piper uses
 * @param {string} modelDir — directory with model.onnx + lexicon.txt + tokens.txt
 * @param {string} enginePath — path to melotts-engine(.exe); see findEngine()
 * @param {object} [opts] — opts.baselineWpm (voices.json wpmAtScale1); opts.sid
 * @returns Promise<{ pcm: Buffer, sampleRate: number }>
 */
function synthesize(text, profile, modelDir, enginePath, opts = {}) {
  return new Promise((resolve, reject) => {
    if (typeof text !== 'string' || text.trim() === '') {
      reject(new Error('Nothing to speak: the text is empty.'));
      return;
    }
    if (!enginePath) {
      reject(new Error('The HD voice engine is not installed yet.'));
      return;
    }
    if (!isModelInstalled(modelDir)) {
      reject(new Error('This HD voice is not fully downloaded yet.'));
      return;
    }

    const knobs = knobsForProfile(profile, opts.baselineWpm);
    const request = {
      modelDir,
      text: text.replace(/\s*\n\s*/g, ' ').trim(),
      lang: opts.lang || 'EN',
      sid: Number.isInteger(opts.sid) ? opts.sid : 0,
      speed: Number(knobs.speed.toFixed(3)),
      noiseScale: Number(knobs.noiseScale.toFixed(3)),
      noiseScaleW: Number(knobs.noiseScaleW.toFixed(3)),
    };

    try {
      ensureChild(enginePath, request.lang);
    } catch (err) {
      reject(new Error(`Could not start the MeloTTS engine: ${err.message}`));
      return;
    }
    waiters.push({ request, resolve, reject });
    pump();
  });
}

// Free the engine (e.g. on app quit). Safe to call anytime.
function shutdown() {
  while (waiters.length) waiters.shift().reject(new Error('MeloTTS engine shutting down.'));
  if (inflight) { inflight.reject(new Error('MeloTTS engine shutting down.')); inflight = null; }
  killEngine();
}

module.exports = {
  knobsForProfile,
  findEngine,
  isEngineInstalled,
  isModelInstalled,
  synthesize,
  shutdown,
};
