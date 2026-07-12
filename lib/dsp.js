'use strict';

// DSP chain: raw PCM from Piper → one ffmpeg pass → processed PCM.
//
// The whole chain is a single -af filtergraph built from the profile. Order
// is fixed and deliberate:
//
//   pitch → timbre EQ → compression → radio → bitcrush/chorus → reverb → loudnorm
//
// Loudness normalisation is LAST so output level stays consistent no matter
// what the stages above did. Every other stage is bypassed (omitted from the
// graph) at its neutral value, so a neutral profile costs almost nothing and
// adds no colouration.
//
// PCM goes through pipes only — no temp files, no shell, argv is fully
// program-controlled (user text never reaches this module at all).

const { spawn } = require('child_process');

// ── Fixed frequencies of the timbre section (Hz) ────────────────────────────
// These four bands are the product's "timbre" vocabulary; retune here, not
// in the UI.
const WARMTH_SHELF_HZ = 180;
const BRIGHTNESS_SHELF_HZ = 5500;
const PRESENCE_BELL_HZ = 2800;
const PRESENCE_BELL_Q = 1;
const SIBILANCE_BELL_HZ = 7000;
const SIBILANCE_BELL_Q = 2;

// Radio band per the classic telephone/comms spec.
const RADIO_HIGHPASS_HZ = 300;
const RADIO_LOWPASS_HZ = 3400;

// Output loudness target. -18 LUFS leaves headroom for the desktop mixer.
const LOUDNORM = 'loudnorm=I=-18:TP=-1.5:LRA=11';

// Values within EPSILON of neutral count as "off" — sliders rarely return
// exactly 0.0.
const EPSILON = 1e-3;

function isActive(value) {
  return Math.abs(value) > EPSILON;
}

// atempo only accepts 0.5–2.0 per instance; factor any tempo into a chain of
// legal steps (e.g. 0.3 → atempo=0.5,atempo=0.6).
function atempoChain(tempo) {
  const steps = [];
  let remaining = tempo;
  while (remaining < 0.5) {
    steps.push('atempo=0.5');
    remaining /= 0.5;
  }
  while (remaining > 2.0) {
    steps.push('atempo=2.0');
    remaining /= 2.0;
  }
  steps.push(`atempo=${remaining.toFixed(6)}`);
  return steps;
}

// Pitch shift without changing speed: resample to shift pitch+speed together,
// then atempo the speed back out.
function pitchStages(semitones, sampleRate) {
  if (!isActive(semitones)) return [];
  const ratio = Math.pow(2, semitones / 12);
  return [
    `asetrate=${Math.round(sampleRate * ratio)}`,
    `aresample=${sampleRate}`,
    ...atempoChain(1 / ratio),
  ];
}

function timbreStages(timbre) {
  const stages = [];
  if (isActive(timbre.warmth)) {
    stages.push(`bass=g=${timbre.warmth.toFixed(2)}:f=${WARMTH_SHELF_HZ}`);
  }
  if (isActive(timbre.brightness)) {
    stages.push(`treble=g=${timbre.brightness.toFixed(2)}:f=${BRIGHTNESS_SHELF_HZ}`);
  }
  if (isActive(timbre.presence)) {
    stages.push(`equalizer=f=${PRESENCE_BELL_HZ}:t=q:w=${PRESENCE_BELL_Q}:g=${timbre.presence.toFixed(2)}`);
  }
  if (isActive(timbre.sibilance)) {
    stages.push(`equalizer=f=${SIBILANCE_BELL_HZ}:t=q:w=${SIBILANCE_BELL_Q}:g=${timbre.sibilance.toFixed(2)}`);
  }
  // timbre.breath is reserved (needs a noise-mix stage, i.e. filter_complex);
  // deliberately not implemented in M1 — see profiles.js.
  return stages;
}

function compressionStage(amount) {
  if (!isActive(amount)) return [];
  // amount 0→1 sweeps ratio 1:1 → 6:1 and pulls the threshold down from
  // -12 dB to -24 dB, so "more compression" both squashes harder and bites
  // earlier. acompressor takes threshold as linear amplitude, hence the
  // dB→linear conversion. No makeup gain: loudnorm at the end owns level.
  const ratio = 1 + 5 * amount;
  const thresholdDb = -12 - 12 * amount;
  const thresholdLinear = Math.pow(10, thresholdDb / 20);
  return [
    `acompressor=threshold=${thresholdLinear.toFixed(6)}:ratio=${ratio.toFixed(2)}:attack=5:release=120`,
  ];
}

function radioStages(amount, sampleRate) {
  if (!isActive(amount)) return [];
  // A true wet/dry blend needs filter_complex (split + amix); to keep the
  // graph a simple chain in M1 we approximate the blend by interpolating the
  // band edges from "barely audible" to the full 300–3400 Hz comms band, plus
  // drive that scales with the amount. Sounds continuous in practice; swap
  // for a real parallel blend if it ever doesn't.
  const nyquistSafe = Math.min(10000, Math.floor(sampleRate * 0.45));
  const hp = Math.round(50 + (RADIO_HIGHPASS_HZ - 50) * amount);
  const lp = Math.round(nyquistSafe + (RADIO_LOWPASS_HZ - nyquistSafe) * amount);
  const driveDb = (6 * amount).toFixed(2);
  return [
    `highpass=f=${hp}`,
    `lowpass=f=${lp}`,
    // Light drive: push into a soft clipper for that "transmitter" edge.
    `volume=${driveDb}dB`,
    'asoftclip=type=atan',
  ];
}

function bitcrushStage(amount) {
  if (!isActive(amount)) return [];
  // 16 bits (transparent) down to 4 bits (very crushed) plus sample-hold
  // reduction for the classic robotic aliasing.
  const bits = Math.round(16 - 12 * amount);
  const samples = 1 + Math.round(24 * amount);
  return [`acrusher=bits=${bits}:samples=${samples}:mode=log:mix=${amount.toFixed(3)}`];
}

function chorusStage(amount) {
  if (!isActive(amount)) return [];
  // Two detuned taps; the profile value only scales how loud the wet taps
  // are, so 0 is a true bypass and 1 is full sci-fi ensemble.
  const decay1 = (0.4 * amount).toFixed(3);
  const decay2 = (0.32 * amount).toFixed(3);
  return [`chorus=0.7:0.9:50|60:${decay1}|${decay2}:0.25|0.4:2|1.3`];
}

function reverbStages(reverb) {
  if (!isActive(reverb.mix)) return [];
  // aecho as a cheap two-tap room. size stretches the tap delays (small room
  // → tight slapback, large → hall-ish), mix scales how much of each tap
  // survives. Known-cheap; swap for convolution (afir) if it sounds boxy.
  const delay1 = Math.round(20 + 140 * reverb.size);
  const delay2 = Math.round(45 + 220 * reverb.size);
  const decay1 = (0.5 * reverb.mix).toFixed(3);
  const decay2 = (0.35 * reverb.mix).toFixed(3);
  return [`aecho=0.8:0.9:${delay1}|${delay2}:${decay1}|${decay2}`];
}

/**
 * Build the complete -af filtergraph string for a (sanitized) profile.
 * Exported separately so the smoke test and future UI can display it.
 */
function buildFilterGraph(profile, sampleRate) {
  const stages = [
    ...pitchStages(profile.prosody.pitchShift, sampleRate),
    ...timbreStages(profile.timbre),
    ...compressionStage(profile.character.compression),
    ...radioStages(profile.character.radioFilter, sampleRate),
    ...bitcrushStage(profile.character.bitcrush),
    ...chorusStage(profile.character.chorus),
    ...reverbStages(profile.character.reverb),
    LOUDNORM,
  ];
  return stages.join(',');
}

/**
 * Pipe s16le mono PCM through the profile's filtergraph.
 * @returns Promise<{ pcm: Buffer, sampleRate: number }>
 */
function applyDsp(pcm, sampleRate, profile, ffmpegPath) {
  return new Promise((resolve, reject) => {
    const graph = buildFilterGraph(profile, sampleRate);
    const args = [
      '-hide_banner', '-loglevel', 'error',
      '-f', 's16le', '-ar', String(sampleRate), '-ac', '1', '-i', 'pipe:0',
      '-af', graph,
      // loudnorm internally upsamples to 192 kHz; pin the output format so
      // callers always get back what they sent in.
      '-f', 's16le', '-ar', String(sampleRate), '-ac', '1',
      'pipe:1',
    ];

    const child = spawn(ffmpegPath, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    const outChunks = [];
    const errChunks = [];
    child.stdout.on('data', (chunk) => outChunks.push(chunk));
    child.stderr.on('data', (chunk) => errChunks.push(chunk));

    child.on('error', (err) => {
      if (err.code === 'ENOENT') {
        reject(new Error('ffmpeg is not installed or not on PATH — the tuning chain needs it.'));
      } else {
        reject(new Error(`Could not start ffmpeg: ${err.message}`));
      }
    });

    child.on('close', (code) => {
      if (code !== 0) {
        const detail = Buffer.concat(errChunks).toString('utf8').trim().split('\n').pop() || `exit code ${code}`;
        reject(new Error(`Audio processing failed: ${detail}`));
        return;
      }
      resolve({ pcm: Buffer.concat(outChunks), sampleRate });
    });

    child.stdin.on('error', () => { /* EPIPE if ffmpeg died early; close handler reports it */ });
    child.stdin.end(pcm);
  });
}

// ffmpeg discovery mirrors piper's: env override first, then PATH.
function findFfmpeg() {
  return process.env.AEGIS_FFMPEG_PATH || 'ffmpeg';
}

module.exports = {
  buildFilterGraph,
  applyDsp,
  findFfmpeg,
};
