'use strict';

// Pipeline smoke test — prove the whole chain with zero UI:
//
//   text → piper (raw PCM) → ffmpeg DSP chain → wav on disk → analyzer
//
// Run with: npm run smoke
// Exits non-zero with an actionable message if piper / ffmpeg / the model is
// missing. Writes out/smoke.wav so you can listen to the result.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const piper = require('../lib/piper');
const dsp = require('../lib/dsp');
const analyze = require('../lib/analyze');
const bank = require('../lib/voicebank');
const packs = require('../lib/packs');
const packstore = require('../lib/packstore');
const zip = require('../lib/zip');
const videostore = require('../lib/videostore');
const { loadProfile } = require('../lib/profiles');
const { writeWav } = require('../lib/wav');

const APP_ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(APP_ROOT, 'out');
const OUT_WAV = path.join(OUT_DIR, 'smoke.wav');
const BUTLER_PRESET = path.join(APP_ROOT, 'presets', 'composed-butler.json');

const TEST_SENTENCE = 'Good evening. All systems are online, and every diagnostic reports nominal performance across the board.';

// The Butler factory preset is the smoke fixture — loaded through the real
// sanitizing loader so the smoke test also proves the preset path.
const { profile: BUTLER, warnings: presetWarnings } = loadProfile(BUTLER_PRESET);

async function main() {
  console.log('Dashboard Engine voice pipeline smoke test');
  console.log('=========================================');
  for (const w of presetWarnings) console.warn(`  ! ${w}`);
  console.log(`profile   : ${BUTLER.name} (${path.relative(APP_ROOT, BUTLER_PRESET)})`);
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

  // 4. Video wallpaper pipeline — generate a tiny webm and prove it survives
  //    sanitize → zip export → install → and streams by depack:// id (never
  //    base64'd). Fail-SOFT on the generation step: no ffmpeg / codec → SKIP,
  //    never a red smoke test. Once a clip exists, the assertions are hard.
  console.log('');
  videoWallpaperCheck(ffmpegPath);

  console.log('');
  console.log('Smoke test PASSED.');
}

// Prove the whole video-wallpaper chain with zero UI (the renderer half is
// covered by the editor/desktop; this covers schema → carrier → protocol).
function videoWallpaperCheck(ffmpegPath) {
  const OUT_WEBM = path.join(OUT_DIR, 'wp-smoke.webm');
  fs.mkdirSync(OUT_DIR, { recursive: true });
  try {
    // 2 s, tiny, realtime VP8 — codec is irrelevant here (we test packaging,
    // not decode), so favour speed.
    execFileSync(ffmpegPath, [
      '-y', '-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=10:duration=2',
      '-c:v', 'libvpx', '-b:v', '120k', '-deadline', 'realtime', '-cpu-used', '8',
      OUT_WEBM,
    ], { stdio: 'ignore' });
  } catch (err) {
    console.log('[4/4] video wallpaper   : SKIPPED (ffmpeg/webm encoder unavailable)');
    return;
  }

  const assert = (cond, msg) => { if (!cond) throw new Error(`video wallpaper: ${msg}`); };
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'de-vidsmoke-'));
  const packDir = path.join(tmpRoot, 'pack');
  const userDir = path.join(tmpRoot, 'user');
  try {
    fs.mkdirSync(path.join(packDir, 'assets'), { recursive: true });
    fs.copyFileSync(OUT_WEBM, path.join(packDir, 'assets', 'loop.webm'));
    fs.writeFileSync(path.join(packDir, 'pack.json'), JSON.stringify({
      schema: 2, id: 'vidsmoke', name: 'Vid Smoke',
      skin: { wallpaper: 'assets/loop.webm', wallpaperVideo: { playbackRate: 1.5 } },
      components: [{ type: 'clock', rect: [10, 10, 40, 30] }],
    }));

    // Sanitizer accepts the video wallpaper + clamps the rate.
    const san = packs.sanitizePack(JSON.parse(fs.readFileSync(path.join(packDir, 'pack.json'))), 'vidsmoke');
    assert(san.pack.skin.wallpaper === 'assets/loop.webm', 'sanitizer dropped the video wallpaper');
    assert(packs.collectVideoRefs(san.pack).length === 1, 'collectVideoRefs missed the video');

    // Export → zip carries the video; install writes it to disk.
    const exp = packstore.exportPack(packDir);
    assert(exp.ok && zip.readZip(exp.buffer).entries.has('assets/loop.webm'), 'video lost in zip round-trip');
    const inst = packstore.installFromBuffer(path.join(__dirname, '..'), userDir, exp.buffer, { source: 'file' });
    assert(inst.ok && fs.existsSync(path.join(userDir, 'packs', inst.id, 'assets', 'loop.webm')), 'video not installed to disk');

    // collectAssets must NOT base64 the video; videostore streams it by id.
    const loaded = packs.loadPack(path.join(__dirname, '..'), userDir, inst.id);
    const collected = packs.collectAssets(loaded.dir, loaded.pack);
    assert(!collected.assets['assets/loop.webm'], 'video was base64-inlined (should stream over depack://)');
    const reg = videostore.registerPackVideos(loaded.dir, loaded.pack);
    const url = reg.urls['assets/loop.webm'];
    assert(url && url.startsWith('depack://'), 'no depack:// url registered');
    const id = url.replace('depack://', '').replace('/', '');
    assert(videostore.pathForId(id), 'protocol could not resolve the registered id');
    assert(videostore.pathForId('deadbeef') === null, 'protocol resolved an unregistered id');

    console.log(`[4/4] video wallpaper   : OK (webm ${fs.statSync(OUT_WEBM).size} B → zip → install → depack:// resolve; rate ${loaded.pack.skin.wallpaperVideo.playbackRate})`);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error('');
  console.error(`Smoke test FAILED: ${err.message}`);
  process.exitCode = 1;
});
