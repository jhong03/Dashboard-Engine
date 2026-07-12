'use strict';

// Stage 1 smoke test — prove the whole pipeline with zero UI:
//
//   text → piper (raw PCM) → ffmpeg DSP chain → wav on disk → analyzer
//
// Run with: npm run smoke
// Exits non-zero with an actionable message if piper / ffmpeg / the model is
// missing. Writes out/smoke.wav so you can listen to the result.

const fs = require('fs');
const path = require('path');

const piper = require('../lib/piper');
const dsp = require('../lib/dsp');
const analyze = require('../lib/analyze');
const bank = require('../lib/voicebank');
const { sanitizeProfile } = require('../lib/profiles');

const APP_ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(APP_ROOT, 'out');
const OUT_WAV = path.join(OUT_DIR, 'smoke.wav');

const TEST_SENTENCE = 'Good evening. All systems are online, and every diagnostic reports nominal performance across the board.';

// The Butler factory preset (Stage 3), hardcoded here as the smoke fixture:
// low, composed, brisk, warm, British.
const BUTLER = sanitizeProfile({
  schema: 1,
  name: 'Composed Butler',
  base: { engine: 'piper', voice: 'northern_english_male' },
  prosody: {
    pitchShift: -2.0,
    rate: 180,
    expressiveness: 0.45,
    steadiness: 0.6,
    pauseSentence: 250,
    pauseComma: 90,
  },
  timbre: {
    warmth: 2.5,
    brightness: -4.0,
    presence: 0.0,
    sibilance: -2.0,
    breath: 0.15,
  },
  character: {
    compression: 0.5,
    radioFilter: 0.0,
    reverb: { mix: 0.08, size: 0.3 },
    bitcrush: 0.0,
    chorus: 0.0,
  },
});

// Minimal RIFF/WAVE writer for s16le mono. Inline because the app itself
// plays PCM straight from memory; only the smoke test needs a file.
function writeWav(filePath, pcm, sampleRate) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);            // fmt chunk size
  header.writeUInt16LE(1, 20);             // PCM
  header.writeUInt16LE(1, 22);             // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); // byte rate (16-bit mono)
  header.writeUInt16LE(2, 32);             // block align
  header.writeUInt16LE(16, 34);            // bits per sample
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  fs.writeFileSync(filePath, Buffer.concat([header, pcm]));
}

async function main() {
  console.log('AEGIS voice pipeline smoke test');
  console.log('================================');
  console.log(`profile   : ${BUTLER.name}`);
  console.log(`text      : "${TEST_SENTENCE}"`);

  // Resolve the profile's base voice through the bank so the smoke test
  // exercises the same path the app will.
  const manifest = bank.loadManifest(APP_ROOT);
  for (const w of [...manifest.warnings, ...bank.auditWarnings(manifest)]) console.warn(`  ! ${w}`);
  const voice = bank.voiceById(manifest, BUTLER.base.voice);
  if (!voice) {
    throw new Error(`Voice "${BUTLER.base.voice}" is not in the bank. Run "npm run voices" to see it.`);
  }
  if (!bank.isInstalled(APP_ROOT, voice)) {
    throw new Error(`Voice "${voice.id}" is not installed. Run: npm run voices -- download ${voice.id}`);
  }
  const modelPath = bank.modelPathFor(APP_ROOT, voice);
  // Calibrated per-voice rate baseline; null until `npm run calibrate --write`.
  const baselineWpm = voice.wpmAtScale1 || undefined;

  const piperPath = piper.findPiper(APP_ROOT);
  const ffmpegPath = dsp.findFfmpeg();
  console.log(`piper     : ${piperPath}`);
  console.log(`ffmpeg    : ${ffmpegPath}`);
  console.log(`voice     : ${voice.id} (${voice.licence}) baseline ${baselineWpm || 'uncalibrated'}`);
  console.log('');

  // 1. Synthesize
  const t0 = Date.now();
  const { pcm: rawPcm, sampleRate } = await piper.synthesize(TEST_SENTENCE, BUTLER, modelPath, piperPath, { baselineWpm });
  const tSynth = Date.now() - t0;
  console.log(`[1/3] piper synthesis  : ${rawPcm.length} bytes PCM @ ${sampleRate} Hz (${tSynth} ms)`);
  console.log(`      piper flags      : ${piper.piperArgsForProfile(BUTLER, '<model>', baselineWpm).join(' ')}`);

  // 2. DSP
  const graph = dsp.buildFilterGraph(BUTLER, sampleRate);
  const t1 = Date.now();
  const { pcm: wetPcm } = await dsp.applyDsp(rawPcm, sampleRate, BUTLER, ffmpegPath);
  const tDsp = Date.now() - t1;
  console.log(`[2/3] ffmpeg DSP chain : ${wetPcm.length} bytes PCM (${tDsp} ms)`);
  console.log(`      filtergraph      : ${graph}`);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  writeWav(OUT_WAV, wetPcm, sampleRate);

  // 3. Analyze — measured on the PROCESSED audio, i.e. what the user hears.
  const dry = analyze.analyzePcm(rawPcm, sampleRate);
  const wet = analyze.analyzePcm(wetPcm, sampleRate);
  const wpm = analyze.wordsPerMinute(TEST_SENTENCE, wet.speechSeconds);
  console.log(`[3/3] analysis`);
  console.log('');
  console.log(`  wav written        : ${OUT_WAV}`);
  console.log(`  duration           : ${wet.durationSeconds.toFixed(2)} s (speech: ${wet.speechSeconds.toFixed(2)} s)`);
  console.log(`  MEASURED F0        : ${wet.medianF0Hz.toFixed(1)} Hz  (dry, pre-DSP: ${dry.medianF0Hz.toFixed(1)} Hz)`);
  console.log(`  MEASURED RATE      : ${wpm.toFixed(0)} wpm  (target: ${BUTLER.prosody.rate} wpm)`);
  console.log(`  voiced frames      : ${(wet.voicedFraction * 100).toFixed(0)}%`);

  // Sanity check the pitch shifter: -2 st should scale F0 by 2^(-2/12) ≈ 0.891.
  if (dry.medianF0Hz > 0 && wet.medianF0Hz > 0) {
    const measuredShift = 12 * Math.log2(wet.medianF0Hz / dry.medianF0Hz);
    console.log(`  pitch shift check  : ${measuredShift.toFixed(2)} st measured (target ${BUTLER.prosody.pitchShift} st)`);
  }

  console.log('');
  console.log('Smoke test PASSED.');
}

main().catch((err) => {
  console.error('');
  console.error(`Smoke test FAILED: ${err.message}`);
  process.exitCode = 1;
});
