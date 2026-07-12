'use strict';

// Preset audition — render factory presets to wav files you can listen to.
//
//   npm run audition                render every preset whose voice is installed
//   npm run audition -- <name>      render one (file name or preset id)
//
// Writes out/audition-<file>.wav and prints measured F0 / rate next to the
// preset's targets, same numbers the Stage 4 panel will show live.

const fs = require('fs');
const path = require('path');

const piper = require('../lib/piper');
const dsp = require('../lib/dsp');
const analyze = require('../lib/analyze');
const bank = require('../lib/voicebank');
const presets = require('../lib/presets');
const { writeWav } = require('../lib/wav');

const APP_ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(APP_ROOT, 'out');

// One fixed line for every preset so renders are comparable; long enough to
// hear pacing, pauses and the DSP character.
const AUDITION_TEXT =
  'Good evening. All systems are online, and every diagnostic reports nominal performance across the board.';

async function renderPreset(entry, manifest, piperPath, ffmpegPath) {
  const { file, profile } = entry;
  const voice = bank.voiceById(manifest, profile.base.voice);
  if (!voice) {
    console.log(`  SKIP  ${file}: voice "${profile.base.voice}" is not in the bank.`);
    return;
  }
  if (!bank.isInstalled(APP_ROOT, voice)) {
    console.log(`  SKIP  ${file}: voice not installed — npm run voices -- download ${voice.id}`);
    return;
  }

  const modelPath = bank.modelPathFor(APP_ROOT, voice);
  const baselineWpm = voice.wpmAtScale1 || undefined;
  const { pcm, sampleRate } = await piper.synthesize(AUDITION_TEXT, profile, modelPath, piperPath, { baselineWpm });
  const wet = await dsp.applyDsp(pcm, sampleRate, profile, ffmpegPath);

  const outFile = path.join(OUT_DIR, `audition-${file.replace(/\.json$/, '')}.wav`);
  writeWav(outFile, wet.pcm, sampleRate);

  const stats = analyze.analyzePcm(wet.pcm, sampleRate);
  const wpm = analyze.wordsPerMinute(AUDITION_TEXT, stats.speechSeconds);
  console.log(`  OK    ${profile.name.padEnd(18)} ${voice.id.padEnd(24)} ${stats.durationSeconds.toFixed(1)}s   F0 ${stats.medianF0Hz.toFixed(0)} Hz   ${wpm.toFixed(0)} wpm (target ${profile.prosody.rate})   -> ${path.relative(APP_ROOT, outFile)}`);
}

async function main() {
  const key = process.argv[2];
  const manifest = bank.loadManifest(APP_ROOT);
  const listed = presets.listPresets(APP_ROOT);
  for (const w of [...manifest.warnings, ...listed.warnings]) console.warn(`  ! ${w}`);
  for (const p of listed.presets) {
    for (const w of p.warnings) console.warn(`  ! ${p.file}: ${w}`);
  }

  let targets = listed.presets;
  if (key) {
    const one = presets.findPreset(listed, key);
    if (!one) throw new Error(`No preset "${key}". Available: ${listed.presets.map((p) => p.file.replace(/\.json$/, '')).join(', ')}`);
    targets = [one];
  }
  if (targets.length === 0) throw new Error('No presets found in presets/.');

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const piperPath = piper.findPiper(APP_ROOT);
  const ffmpegPath = dsp.findFfmpeg();

  console.log('Preset audition');
  console.log('===============');
  for (const entry of targets) {
    await renderPreset(entry, manifest, piperPath, ffmpegPath);
  }
  console.log('');
  console.log(`Listen in ${path.relative(APP_ROOT, OUT_DIR)}${path.sep}`);
}

main().catch((err) => {
  console.error(`\naudition: ${err.message}`);
  process.exitCode = 1;
});
