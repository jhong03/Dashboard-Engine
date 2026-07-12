'use strict';

// Piper synthesis: spawn the piper CLI, feed it text on STDIN, collect raw
// PCM from stdout.
//
// Security rule (CLAUDE.md): user text NEVER appears in a command line. It is
// written to the child's stdin only. Every argv element below is either a
// fixed flag or a number we computed from a clamped profile.

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// ── Calibration constants ───────────────────────────────────────────────────

// Piper's --length-scale is inverse speed (2.0 = half speed). To map a target
// words-per-minute onto it we need a baseline: the wpm a medium-quality model
// produces at length-scale 1.0. 165 wpm is an estimate for the en medium
// models; TODO: tune empirically per-voice once the analyzer gives us real
// measured rates (a per-voice override can live in voices.json later).
const BASELINE_WPM_AT_SCALE_1 = 165;

const LENGTH_SCALE_MIN = 0.5;
const LENGTH_SCALE_MAX = 2.0;

// Piper's own default noise-scale; profile.expressiveness (0–1.6) scales it.
const PIPER_DEFAULT_NOISE_SCALE = 0.667;
const NOISE_SCALE_MIN = 0.1;
const NOISE_SCALE_MAX = 1.0;

// noise-w controls phoneme duration variance. Higher steadiness = less
// variance, so the mapping is inverted.
const NOISE_W_MIN = 0.2;
const NOISE_W_MAX = 1.0;

// Sample rate if a model config is missing/unreadable. All the en_* medium
// voices we bundle are 22050 Hz; low-quality models are 16000.
const FALLBACK_SAMPLE_RATE = 22050;

function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

// ── Profile → Piper flags ───────────────────────────────────────────────────

function lengthScaleForRate(wpm) {
  return clamp(BASELINE_WPM_AT_SCALE_1 / wpm, LENGTH_SCALE_MIN, LENGTH_SCALE_MAX);
}

function noiseScaleForExpressiveness(expressiveness) {
  return clamp(PIPER_DEFAULT_NOISE_SCALE * expressiveness, NOISE_SCALE_MIN, NOISE_SCALE_MAX);
}

function noiseWForSteadiness(steadiness) {
  return clamp(0.8 * (1 - steadiness) + 0.2, NOISE_W_MIN, NOISE_W_MAX);
}

function piperArgsForProfile(profile, modelPath) {
  const prosody = profile.prosody;
  return [
    '--model', modelPath,
    '--length-scale', lengthScaleForRate(prosody.rate).toFixed(3),
    '--noise-scale', noiseScaleForExpressiveness(prosody.expressiveness).toFixed(3),
    '--noise-w', noiseWForSteadiness(prosody.steadiness).toFixed(3),
    // Piper takes seconds; the profile stores ms because every other pause in
    // the schema is ms.
    '--sentence-silence', (prosody.pauseSentence / 1000).toFixed(3),
    // NOTE: prosody.pauseComma has no Piper flag; comma pauses would need
    // text pre-processing (e.g. inserting break markers). Deferred — see
    // PARAM_RANGES comment in profiles.js.
    '--output-raw',
  ];
}

// ── Model config ────────────────────────────────────────────────────────────

// Piper ships a <model>.onnx.json next to each model; it holds the true
// sample rate. Reading it beats hardcoding, since low/medium/high models
// differ.
function sampleRateForModel(modelPath) {
  try {
    const config = JSON.parse(fs.readFileSync(`${modelPath}.json`, 'utf8'));
    const rate = config && config.audio && config.audio.sample_rate;
    if (Number.isInteger(rate) && rate > 0) return rate;
  } catch {
    // fall through to default
  }
  return FALLBACK_SAMPLE_RATE;
}

// ── Binary discovery ────────────────────────────────────────────────────────

// Look for piper in (1) an explicit env override, (2) the project-local bin/
// where the downloader puts it, (3) PATH. Returns null if not found — callers
// fail soft to system TTS, they don't throw.
function findPiper(appRoot) {
  const exe = process.platform === 'win32' ? 'piper.exe' : 'piper';
  const candidates = [
    process.env.AEGIS_PIPER_PATH,
    appRoot ? path.join(appRoot, 'bin', 'piper', exe) : null,
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return exe; // resolved via PATH by spawn; synthesize() reports ENOENT cleanly
}

// ── Synthesis ───────────────────────────────────────────────────────────────

/**
 * Synthesize text to raw PCM (s16le, mono).
 * @returns Promise<{ pcm: Buffer, sampleRate: number }>
 * Rejects with a human-readable Error — no raw stack traces reach the UI.
 */
function synthesize(text, profile, modelPath, piperPath) {
  return new Promise((resolve, reject) => {
    if (typeof text !== 'string' || text.trim() === '') {
      reject(new Error('Nothing to speak: the test text is empty.'));
      return;
    }
    if (!fs.existsSync(modelPath)) {
      reject(new Error(`Voice model not found: ${path.basename(modelPath)}. Download it from the voice bank.`));
      return;
    }

    const sampleRate = sampleRateForModel(modelPath);
    const args = piperArgsForProfile(profile, modelPath);

    // windowsHide keeps a console window from flashing up on every synthesis.
    const child = spawn(piperPath, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    const pcmChunks = [];
    const stderrChunks = [];
    child.stdout.on('data', (chunk) => pcmChunks.push(chunk));
    child.stderr.on('data', (chunk) => stderrChunks.push(chunk));

    child.on('error', (err) => {
      if (err.code === 'ENOENT') {
        reject(new Error('Piper is not installed (binary not found). Falling back to the system voice is available.'));
      } else {
        reject(new Error(`Could not start Piper: ${err.message}`));
      }
    });

    child.on('close', (code) => {
      if (code !== 0) {
        // Piper logs progress to stderr even on success, so only surface it
        // on failure, trimmed to something a human can read.
        const detail = Buffer.concat(stderrChunks).toString('utf8').trim().split('\n').pop() || `exit code ${code}`;
        reject(new Error(`Piper synthesis failed: ${detail}`));
        return;
      }
      const pcm = Buffer.concat(pcmChunks);
      if (pcm.length === 0) {
        reject(new Error('Piper produced no audio. The model file may be truncated — try re-downloading it.'));
        return;
      }
      resolve({ pcm, sampleRate });
    });

    // Text goes to stdin ONLY. Piper reads one line per utterance, so
    // newlines inside the text are flattened to spaces to keep it one clip.
    child.stdin.on('error', () => { /* EPIPE if piper died early; close handler reports it */ });
    child.stdin.end(text.replace(/\s*\n\s*/g, ' ').trim() + '\n');
  });
}

module.exports = {
  BASELINE_WPM_AT_SCALE_1,
  lengthScaleForRate,
  noiseScaleForExpressiveness,
  noiseWForSteadiness,
  piperArgsForProfile,
  sampleRateForModel,
  findPiper,
  synthesize,
};
