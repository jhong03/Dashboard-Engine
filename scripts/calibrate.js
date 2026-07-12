'use strict';

// Rate calibration — measure each installed voice's natural speaking rate.
//
// The rate slider maps words-per-minute onto Piper's --length-scale, which
// needs to know what the voice produces at scale 1.0. That varies per voice
// (Stage 1 shipped with a guess that was ~30% off), so we measure it:
// synthesize a fixed passage at exactly length-scale 1.0, time the trimmed
// speech span, and store the result in voices.json as wpmAtScale1.
//
//   npm run calibrate                 measure all installed voices
//   npm run calibrate -- <id>         measure one voice
//   npm run calibrate -- --write      also update voices.json
//
// Measured articulation rate: sentence pauses are zeroed so the number
// reflects speech, not silence (the pause sliders own silence separately).

const fs = require('fs');
const path = require('path');

const piper = require('../lib/piper');
const analyze = require('../lib/analyze');
const bank = require('../lib/voicebank');
const { sanitizeProfile } = require('../lib/profiles');

const APP_ROOT = path.join(__dirname, '..');
const MANIFEST_PATH = path.join(APP_ROOT, 'voices', 'voices.json');

// One long sentence (46 words): no sentence breaks to pause over, enough
// material for a stable estimate.
const CALIBRATION_TEXT =
  'The quiet observatory hummed through the night while its long array of ' +
  'sensors swept the northern sky for signals, and every reading that ' +
  'arrived was measured, compared against the archive, logged in the ' +
  'journal, and passed along to the small team waiting patiently downstairs.';

// Force --length-scale to exactly 1.0: the scale is baselineWpm / rate, so
// passing the same number as both cancels out.
const UNIT_SCALE_WPM = 165;

async function calibrateVoice(voice, piperPath) {
  const profile = sanitizeProfile({
    prosody: { rate: UNIT_SCALE_WPM, pauseSentence: 0 },
  });
  const modelPath = bank.modelPathFor(APP_ROOT, voice);
  const { pcm, sampleRate } = await piper.synthesize(
    CALIBRATION_TEXT, profile, modelPath, piperPath, { baselineWpm: UNIT_SCALE_WPM });
  const { speechSeconds, medianF0Hz } = analyze.analyzePcm(pcm, sampleRate);
  const wpm = analyze.wordsPerMinute(CALIBRATION_TEXT, speechSeconds);
  return { wpm: Math.round(wpm), medianF0Hz: Math.round(medianF0Hz) };
}

// Update wpmAtScale1 in the manifest without disturbing anything else in the
// file (comments, excluded list, key order).
function writeBaseline(voiceId, wpm) {
  const raw = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  const entry = (raw.voices || []).find((v) => v.id === voiceId);
  if (!entry) return false;
  entry.wpmAtScale1 = wpm;
  const tmp = `${MANIFEST_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(raw, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, MANIFEST_PATH);
  return true;
}

async function main() {
  const args = process.argv.slice(2);
  const write = args.includes('--write');
  const ids = args.filter((a) => a !== '--write');

  const manifest = bank.loadManifest(APP_ROOT);
  for (const w of manifest.warnings) console.warn(`  ! ${w}`);

  let targets = manifest.voices.filter((v) => bank.isInstalled(APP_ROOT, v));
  if (ids.length > 0) {
    targets = ids.map((id) => {
      const v = bank.voiceById(manifest, id);
      if (!v) throw new Error(`No voice named "${id}" in the bank.`);
      if (!bank.isInstalled(APP_ROOT, v)) throw new Error(`Voice "${id}" is not installed. Run: npm run voices -- download ${id}`);
      return v;
    });
  }
  if (targets.length === 0) {
    throw new Error('No installed voices to calibrate. Run: npm run voices -- download <id>');
  }

  const piperPath = piper.findPiper(APP_ROOT);
  console.log('Voice rate calibration (length-scale 1.0)');
  console.log('=========================================');
  for (const voice of targets) {
    const { wpm, medianF0Hz } = await calibrateVoice(voice, piperPath);
    const prior = voice.wpmAtScale1 == null ? 'uncalibrated' : `manifest: ${voice.wpmAtScale1}`;
    console.log(`  ${voice.id.padEnd(24)} ${String(wpm).padStart(3)} wpm   F0 ~${medianF0Hz} Hz   (${prior})`);
    if (write) {
      writeBaseline(voice.id, wpm);
    }
  }
  console.log('');
  console.log(write ? 'voices.json updated.' : 'Dry run — pass --write to store these in voices.json.');
}

main().catch((err) => {
  console.error(`\ncalibrate: ${err.message}`);
  process.exitCode = 1;
});
