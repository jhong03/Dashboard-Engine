'use strict';

// IPC surface for the tuning panel. Design rules (CLAUDE.md):
//   - every handler validates its input — the renderer is assumed hostile
//     (one day it will be running someone else's persona pack)
//   - expected failures return { ok: false, error } with a human message;
//     handlers never throw raw errors or stack traces at the UI
//   - user text reaches child processes via stdin inside lib/, never argv
//
// All state lives on disk; the only in-memory state here is "is a synthesis
// or download already running", to keep the CPU/network sane.

const fs = require('fs');
const path = require('path');
const { ipcMain, dialog, app, shell, nativeImage } = require('electron');
const { spawn } = require('child_process');

const piper = require('./piper');
const melotts = require('./melotts');
const kokoro = require('./kokoro');
const dsp = require('./dsp');
const analyze = require('./analyze');
const bank = require('./voicebank');
const presets = require('./presets');
const profiles = require('./profiles');
const fallback = require('./tts-fallback');
const packs = require('./packs');
const packstore = require('./packstore');
const videostore = require('./videostore');
const registry = require('./registry');
const workshop = require('./workshop');
const achievements = require('./achievements');
const i18n = require('./i18n');
const launcher = require('./launcher');
const assistant = require('./assistant');
const musicLib = require('./music');
const reminders = require('./reminders');
const pomodoro = require('./pomodoro');
const settings = require('./settings');
const userprops = require('./userprops');
const logger = require('./logger');
const stats = require('./stats');

// Longest test text the panel will synthesize. Tuning needs a sentence or
// three, not an essay; this also bounds synthesis time and IPC payload.
const MAX_TEST_TEXT_CHARS = 500;

// Saved profile filenames: slug only, no separators, always .json.
const PROFILE_FILE_PATTERN = /^[a-z0-9][a-z0-9-_]{0,63}\.json$/;

function profilesDir(appRoot) {
  return path.join(appRoot, 'profiles');
}

function fail(error) {
  return { ok: false, error };
}

// Split a spoken reply into short clips at sentence boundaries, greedily
// packing sentences up to ~a couple hundred chars per clip. Keeping every clip
// short is what stops long assistant replies from drifting through the DSP
// chain: the always-on single-pass `loudnorm` is a dynamic normalizer that
// rides its gain and limits peaks across the clip (fine on a short clip, but it
// swings and distorts on long continuous audio), and any pitch/tempo WSOLA
// stage warbles on long audio too. Each clip is synthesized and processed like
// a tuning clip — which always sounds right — and the PCM is joined back, with
// the natural sentence pauses hiding the seams. ~9 s per clip at normal pace.
const SPEAK_CHUNK_CHARS = 180;
function splitForSpeech(text, maxLen = SPEAK_CHUNK_CHARS) {
  // Break into sentence-ish pieces, THEN hard-split any piece still longer than
  // a clip — a list, code, or a comma-only run-on has no . ! ? to break on, and
  // leaving it whole would re-create the long-clip drift this exists to avoid.
  const pieces = [];
  for (const raw of text.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [text]) {
    let piece = raw.trim();
    while (piece.length > maxLen) {
      // Prefer a word boundary within the limit; if a single token is longer
      // than a whole clip, hard-cut it so nothing is ever unbounded.
      let cut = piece.lastIndexOf(' ', maxLen);
      if (cut <= 0) cut = maxLen;
      const head = piece.slice(0, cut).trim();
      if (head) pieces.push(head);
      piece = piece.slice(cut).trim();
    }
    if (piece) pieces.push(piece);
  }
  // Greedily pack the (now all <= maxLen) pieces into clips.
  const chunks = [];
  let current = '';
  for (const piece of pieces) {
    if (current && current.length + piece.length + 1 > maxLen) {
      chunks.push(current);
      current = piece;
    } else {
      current = current ? `${current} ${piece}` : piece;
    }
  }
  if (current) chunks.push(current);
  return chunks.length ? chunks : [text];
}

// Even with a "no emoji / no markdown" persona, a weak model sometimes emits
// them anyway — and read aloud they're noise (or an odd silence). Strip emoji +
// markdown marks + any leaked <think> reasoning BEFORE synthesis so the voice
// only ever speaks clean prose. Normal punctuation/hyphens are left intact.
const EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{2300}-\u{23FF}\u{FE00}-\u{FE0F}\u{200D}]/gu;
function sanitizeForSpeech(text) {
  return String(text)
    .replace(/<think>[\s\S]*?<\/think>/gi, ' ')   // reasoning-model scratchpad
    .replace(EMOJI_RE, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')       // [label](url) -> label
    .replace(/[*_`~#]/g, '')                        // markdown emphasis / code / heading marks
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// ── Environment probe ───────────────────────────────────────────────────────

// Cache: binaries don't appear mid-session, and the probe spawns a process.
let envCache = null;

function probeBinary(exe, args) {
  return new Promise((resolve) => {
    const child = spawn(exe, args, { stdio: 'ignore', windowsHide: true });
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
  });
}

async function checkEnv(appRoot) {
  if (envCache) return envCache;
  const piperPath = piper.findPiper(appRoot);
  const ffmpegPath = dsp.findFfmpeg();
  const [piperOk, ffmpegOk] = await Promise.all([
    probeBinary(piperPath, ['--help']),
    probeBinary(ffmpegPath, ['-version']),
  ]);
  envCache = { ok: true, piper: piperOk, ffmpeg: ffmpegOk, platform: process.platform };
  return envCache;
}

// Can the engine this voice needs actually render right now? Piper voices need
// the piper binary; MeloTTS ("HD") voices need the downloaded engine AND the
// voice's model files. Keeps the two synth handlers from duplicating the check.
function voiceEngineReady(appRoot, voice, env) {
  if (bank.engineOf(voice) === 'melotts') {
    // resolveModelDir prefers a downloaded copy, else a depot-bundled one.
    return melotts.isEngineInstalled(appRoot, voice.engineId) && melotts.isModelInstalled(bank.resolveModelDir(appRoot, voice));
  }
  return !!env.piper;
}

// Resolve the assistant's saved voiceProfile string to a profile object. It's
// either a user profile (a .json in profiles/) or a factory preset (stored with
// a "preset:" prefix so it can never collide with a user file). Returns null if
// it doesn't resolve, so the caller keeps the default profile.
function resolveVoiceProfile(appRoot, voiceProfile) {
  if (typeof voiceProfile !== 'string' || voiceProfile === '') return null;
  if (voiceProfile.startsWith('preset:')) {
    const found = presets.findPreset(presets.listPresets(appRoot), voiceProfile.slice('preset:'.length));
    return found ? found.profile : null;
  }
  if (PROFILE_FILE_PATTERN.test(voiceProfile)) {
    const file = path.join(profilesDir(appRoot), voiceProfile);
    if (fs.existsSync(file)) return profiles.loadProfile(file).profile;
  }
  return null;
}

// Synthesize one clip with whichever engine the voice declares. Returns the same
// { pcm, sampleRate } shape regardless of engine, so the shared DSP chain and
// the callers stay engine-agnostic. MeloTTS voices pick a per-language engine
// binary (engineId) and pass their language (meloLang) to it.
// A voice is "non-English" (for the World Tour achievement) when its MeloTTS
// language isn't EN, or — for the Piper males — its id names another language.
function isNonEnglishVoice(voice) {
  if (!voice) return false;
  if (voice.meloLang) return String(voice.meloLang).toUpperCase() !== 'EN';
  return /^(es|fr|de|pt|zh|ja|jp|ko|kr|vi|tr|uk|pl)[_-]/i.test(String(voice.id || ''));
}

// A voice's 2-letter language: its MeloTTS language, or (for Piper voices) its
// id prefix. Null when unknown. Used so the speak-fallback never substitutes a
// DIFFERENT-language voice — reading e.g. Chinese text through an English voice
// comes out as gibberish, which is worse than staying silent.
function voiceLang(voice) {
  if (!voice) return null;
  const MELO = { EN: 'en', ES: 'es', FR: 'fr', ZH: 'zh', JP: 'ja', KR: 'ko' };
  if (voice.meloLang) return MELO[String(voice.meloLang).toUpperCase()] || null;
  const m = /^([a-z]{2})[_-]/i.exec(String(voice.id || ''));
  if (!m) return null;
  const p = m[1].toLowerCase();
  return p === 'jp' ? 'ja' : p === 'kr' ? 'ko' : p;
}

// The MeloTTS-Chinese engine (zh_hd) was trained on SIMPLIFIED input, so Traditional-
// script text has to be normalized to Simplified before synthesis or its g2p
// mispronounces it. This per-character map preserves the Mandarin READING exactly
// (all TTS needs) and is a strict no-op on already-Simplified / non-Chinese text —
// so the "Traditional Chinese" voice is the same zh_hd voice, just reading either
// script correctly. Loaded once; fail-soft to identity. See scripts/gen-zh-t2s.js.
let zhT2SMap = null;
function zhToSimplified(text) {
  if (zhT2SMap === null) {
    try { zhT2SMap = JSON.parse(fs.readFileSync(path.join(__dirname, 'zh-t2s.json'), 'utf8')); }
    catch { zhT2SMap = {}; }
  }
  if (!text) return text;
  let out = '';
  for (const ch of text) out += (zhT2SMap[ch] || ch);
  return out;
}

function synthClip(appRoot, voice, text, profile) {
  if (isNonEnglishVoice(voice)) achievements.unlock('ACH_WORLD_TOUR');
  const baselineWpm = voice.wpmAtScale1 || undefined;
  if (bank.engineOf(voice) === 'melotts') {
    const engineText = String(voice.meloLang || '').toUpperCase() === 'ZH' ? zhToSimplified(text) : text;
    return melotts.synthesize(engineText, profile, bank.resolveModelDir(appRoot, voice), melotts.findEngine(appRoot, voice.engineId), {
      baselineWpm,
      sid: Number.isInteger(voice.sid) ? voice.sid : 0,
      lang: voice.meloLang,
    });
  }
  if (bank.engineOf(voice) === 'kokoro') {
    return kokoro.synthesize(text, profile, appRoot, { voice: voice.voiceName, lang: voice.langCode, baselineWpm });
  }
  return piper.synthesize(text, profile, bank.resolvePiperModelPath(appRoot, voice), piper.findPiper(appRoot), { baselineWpm, speaker: voice.speaker });
}

// Short, ~2–3 s sample sentences for the community-voice preview, one per
// supported language (voice-language content, not UI strings — they stay in
// their own language regardless of the interface locale).
const PREVIEW_PHRASES = {
  en: 'Hello. This is a short preview of how this voice sounds.',
  es: 'Hola. Esta es una breve muestra de cómo suena esta voz.',
  fr: 'Bonjour. Voici un court aperçu du son de cette voix.',
  zh: '你好，这是这个声音的简短预览。',
  ja: 'こんにちは。これはこの声の短いプレビューです。',
  ko: '안녕하세요. 이 목소리의 짧은 미리듣기입니다.',
};

function previewPhraseFor(voice) {
  const m = /^([a-z]{2})[_-]/i.exec(String((voice && voice.id) || ''));
  let p = m ? m[1].toLowerCase() : 'en';
  if (p === 'jp') p = 'ja'; else if (p === 'kr') p = 'ko';
  return PREVIEW_PHRASES[p] || PREVIEW_PHRASES.en;
}

// Warm-up text + a throwaway profile for priming an engine (the audio is discarded).
const PREWARM_TEXT = { EN: 'Hello.', ES: 'Hola.', FR: 'Bonjour.', ZH: '你好。', JP: 'こんにちは。', KR: '안녕하세요。' };
const PREWARM_PROFILE = { prosody: { rate: 165, expressiveness: 1, steadiness: 0.5, pauseSentence: 200, pauseComma: 100 } };

// Warm a voice's engine AHEAD of real use (fire-and-forget, fail-soft). The FIRST
// synth on a fresh install is the slow one — Windows first-access/Defender scans the
// never-run engine binaries (the MeloTTS onedir bundle is hundreds of _internal
// files) and cold-reads the ~hundreds-of-MB model + BERT, on top of the model load
// itself (~17 s even warm-disk). Doing it in the background BEFORE the user clicks
// (at app startup, or when a voice surface opens) hides that one-time cost so the
// first Test / preview / assistant reply isn't a ~cold-start wait. Reused by the
// prewarm IPC handler AND main's startup warm-up. A missing engine/model is a no-op.
function prewarmVoice(appRoot, voiceId) {
  try {
    if (typeof voiceId !== 'string' || !voiceId) return { ok: false };
    const voice = bank.voiceById(bank.loadManifest(appRoot), voiceId);
    if (!voice) return { ok: false };
    const engine = bank.engineOf(voice);
    if (engine === 'melotts') {
      if (!bank.isInstalled(appRoot, voice) || !melotts.isEngineInstalled(appRoot, voice.engineId)) return { ok: false };
      melotts.prewarm(
        PREWARM_TEXT[voice.meloLang] || 'Hello.',
        bank.resolveModelDir(appRoot, voice),
        melotts.findEngine(appRoot, voice.engineId),
        { lang: voice.meloLang, sid: Number.isInteger(voice.sid) ? voice.sid : 0 },
      );
      return { ok: true };
    }
    if (engine === 'kokoro') {
      // One shared warm child serves every Kokoro voice, so the cold cost (model load
      // + child spawn) is paid once. A throwaway synth in this voice pays it up front.
      if (!kokoro.isReady(appRoot)) return { ok: false };
      kokoro.prewarm(appRoot, voice.voiceName, voice.langCode);
      return { ok: true };
    }
    if (engine === 'piper') {
      // Piper spawns fresh per synth (no persistent warm child), so the cold cost is
      // purely the OS first-access scan of the piper binary + libs + the voice model.
      // One throwaway synth pays it once so the first real clip is fast.
      const modelPath = bank.resolvePiperModelPath(appRoot, voice);
      if (!modelPath || !fs.existsSync(modelPath)) return { ok: false };
      piper.synthesize('Hello.', PREWARM_PROFILE, modelPath, piper.findPiper(appRoot), {
        baselineWpm: voice.wpmAtScale1,
        speaker: Number.isInteger(voice.speaker) ? voice.speaker : undefined,
      }).catch(() => { /* warm-up only — ignore the audio and any error */ });
      return { ok: true };
    }
    return { ok: false };
  } catch { return { ok: false }; }
}

// Warm the voice the DESKTOP assistant (and spoken health alerts) will actually use,
// so the first spoken reply on the desktop isn't a cold start. Only warms when the
// user has picked a voice — someone who never set up voice shouldn't pay the RAM of a
// resident engine on a 24/7 wallpaper. Called from main a few seconds after launch.
function prewarmAssistantVoice(appRoot, userDir) {
  try {
    const cfg = assistant.getPublicConfig(userDir);
    if (!cfg || !cfg.voiceProfile) return; // no explicit voice → don't hold an engine warm
    const prof = resolveVoiceProfile(appRoot, cfg.voiceProfile);
    if (prof && prof.base && prof.base.voice) prewarmVoice(appRoot, prof.base.voice);
  } catch { /* best effort */ }
}

// Preload a configured LOCAL model so its cold start is hidden. No-op for hosted
// endpoints and unconfigured assistants; fully fail-soft.
function warmupAssistant(userDir) {
  try { assistant.warmup(userDir); } catch { /* best effort */ }
}

// ── Handlers ────────────────────────────────────────────────────────────────

function registerIpcHandlers(appRoot, userDir, hooks = {}) {
  let synthesisBusy = false;
  // voiceId -> { pct, phase } for every download running RIGHT NOW. A download
  // runs entirely in main, so it survives the window that started it closing;
  // this map lets a reopened window restore the progress bar and refresh on
  // completion (see aegis:bank:inflight + the broadcast below).
  const downloadsInFlight = new Map();
  const statsSampler = stats.createSampler();

  // Send a message to EVERY window (not just the one that made the call), so a
  // download's progress/completion reaches a window opened after it started.
  const broadcast = (channel, payload) => {
    if (typeof hooks.broadcast === 'function') hooks.broadcast(channel, payload);
  };

  // One pack watcher per dashboard webContents, replaced on every pack load —
  // this is the DIY hot-reload: edit pack.json, the dashboard repaints.
  const packWatchers = new Map();
  // Senders that already have a one-time 'destroyed' cleanup bound. This runs on
  // EVERY packs:load, and the manager loads many packs per render (cards +
  // detail previews) — binding a listener each time leaked them and tripped the
  // MaxListeners warning. Bind once per sender.
  const watcherCleanupBound = new Set();

  function resetPackWatcher(sender, packId, packDirPath) {
    const old = packWatchers.get(sender.id);
    if (old) {
      old.watcher.close();
      clearTimeout(old.timer);
    }
    let watcher;
    try {
      watcher = fs.watch(packDirPath, { persistent: false }, () => {
        const entry = packWatchers.get(sender.id);
        if (!entry) return;
        // Editors fire several events per save; debounce to one repaint.
        clearTimeout(entry.timer);
        entry.timer = setTimeout(() => {
          if (!sender.isDestroyed()) sender.send('aegis:packs:changed', { id: packId });
        }, 300);
      });
      // Deleting a watched directory (the save swap does, briefly) raises
      // EPERM on Windows — without this handler it's an uncaught exception
      // that takes down the whole engine. The post-save broadcast below
      // covers the repaint, and the next pack load re-arms the watcher.
      watcher.on('error', () => {
        const entry = packWatchers.get(sender.id);
        if (entry && entry.watcher === watcher) {
          clearTimeout(entry.timer);
          packWatchers.delete(sender.id);
        }
        try { watcher.close(); } catch { /* already dead */ }
      });
    } catch {
      return; // pack directory vanished — the next load will report it
    }
    packWatchers.set(sender.id, { watcher, timer: null });
    if (!watcherCleanupBound.has(sender.id)) {
      watcherCleanupBound.add(sender.id);
      sender.once('destroyed', () => {
        const entry = packWatchers.get(sender.id);
        if (entry) {
          entry.watcher.close();
          clearTimeout(entry.timer);
          packWatchers.delete(sender.id);
        }
        watcherCleanupBound.delete(sender.id);
      });
    }
  }

  ipcMain.handle('aegis:ranges', () => {
    return { ok: true, ranges: profiles.PARAM_RANGES, schema: profiles.PROFILE_SCHEMA_VERSION };
  });

  ipcMain.handle('aegis:env', () => checkEnv(appRoot));

  ipcMain.handle('aegis:bank:list', () => {
    const manifest = bank.loadManifest(appRoot);
    return {
      ok: true,
      defaultVoice: manifest.defaultVoice,
      warnings: [...manifest.warnings, ...bank.auditWarnings(manifest)],
      voices: manifest.voices.map((v) => ({
        id: v.id,
        displayName: v.displayName,
        sex: v.sex,
        accent: v.accent,
        language: v.language,
        descriptor: v.descriptor,
        licence: v.licence,
        attribution: v.attribution,
        engine: bank.engineOf(v),
        hd: !!v.hd,
        sizeBytes: bank.engineOf(v) === 'melotts'
          ? v.files.reduce((sum, f) => sum + f.sizeBytes, 0)
          : v.sizeBytes,
        wpmAtScale1: v.wpmAtScale1,
        installed: bank.isInstalled(appRoot, v),
      })),
    };
  });

  ipcMain.handle('aegis:bank:download', async (event, voiceId) => {
    if (typeof voiceId !== 'string') return fail('Invalid voice id.');
    const manifest = bank.loadManifest(appRoot);
    const voice = bank.voiceById(manifest, voiceId);
    if (!voice) return fail(`No voice "${voiceId}" in the bank.`);
    if (bank.isInstalled(appRoot, voice)) return { ok: true, already: true };
    if (downloadsInFlight.has(voice.id)) return { ok: true, alreadyDownloading: true };

    // Combined totals so the bar, speed, and ETA span the WHOLE install (engine +
    // voice), not just the current phase — that's the "total needed" the user sees.
    const isMelo = bank.engineOf(voice) === 'melotts';
    const engineNeeded = isMelo && !melotts.isEngineInstalled(appRoot, voice.engineId);
    const engineSpec = engineNeeded ? (manifest.engines && manifest.engines[voice.engineId]) : null;
    const engineTotal = engineSpec ? (engineSpec.sizeBytes || 0) : 0;
    const voiceTotal = isMelo
      ? (Array.isArray(voice.files) ? voice.files.reduce((s, f) => s + (f.sizeBytes || 0), 0) : 0)
      : (voice.sizeBytes || 0);
    const grandTotal = engineTotal + voiceTotal;

    downloadsInFlight.set(voice.id, { pct: 0, phase: 'voice', received: 0, total: grandTotal, bytesPerSec: 0, etaSec: null });
    let lastPct = -1, lastBroadcast = 0;
    // Smoothed download speed (EMA of the instantaneous rate) + ETA, computed here
    // so every window — including one reopened mid-download — sees the same numbers.
    let sampleT = Date.now(), sampleBytes = 0, ema = 0;
    // Broadcast to ALL windows (not event.sender): the window that started the
    // download may be gone, and a reopened one needs the updates.
    const report = (received, _phaseTotal, phase) => {
      const overall = phase === 'engine' ? received : engineTotal + received;
      const now = Date.now();
      const dt = now - sampleT;
      if (dt >= 250) { // sample a few times a second so the rate isn't chunk-noisy
        const inst = ((overall - sampleBytes) / dt) * 1000; // bytes/sec
        ema = ema > 0 ? ema * 0.7 + inst * 0.3 : inst;
        sampleT = now; sampleBytes = overall;
      }
      const bytesPerSec = ema > 0 ? Math.round(ema) : 0;
      const etaSec = bytesPerSec > 0 && grandTotal > overall ? Math.round((grandTotal - overall) / bytesPerSec) : null;
      const pct = grandTotal > 0 ? Math.floor((overall / grandTotal) * 100) : 0;
      downloadsInFlight.set(voice.id, { pct, phase, received: overall, total: grandTotal, bytesPerSec, etaSec });
      // Emit on a whole-percent step OR ~twice a second, so speed/ETA update live.
      if (pct === lastPct && now - lastBroadcast < 500) return;
      lastPct = pct; lastBroadcast = now;
      broadcast('aegis:bank:progress', { id: voice.id, received: overall, total: grandTotal, pct, phase, bytesPerSec, etaSec });
    };
    try {
      // MeloTTS ("HD") voices need the engine binary in place too. Fetch it
      // first if missing; without a configured download it's a clear message,
      // not a crash.
      if (engineNeeded) {
        if (!engineSpec) {
          broadcast('aegis:bank:progress', { id: voice.id, phase: 'error', done: true, ok: false });
          return fail('The HD voice engine is not installed and no download is configured yet.');
        }
        await bank.downloadEngine(voice.engineId, engineSpec, (r, t) => report(r, t, 'engine'));
      }
      await bank.downloadVoice(appRoot, voice, (r, t) => report(r, t, 'voice'));
      // Tell every window it finished so a reopened one refreshes to "installed".
      broadcast('aegis:bank:progress', { id: voice.id, pct: 100, phase: 'done', done: true, ok: true });
      return { ok: true };
    } catch (err) {
      broadcast('aegis:bank:progress', { id: voice.id, phase: 'error', done: true, ok: false, error: err.message });
      return fail(err.message);
    } finally {
      downloadsInFlight.delete(voice.id);
    }
  });

  // Which voices are downloading right now (+ their progress), so a window
  // opened mid-download restores the progress bar instead of showing "Get".
  ipcMain.handle('aegis:bank:inflight', () => ({
    ok: true,
    downloads: [...downloadsInFlight.entries()].map(([id, p]) => ({
      id, pct: p.pct, phase: p.phase, received: p.received, total: p.total, bytesPerSec: p.bytesPerSec, etaSec: p.etaSec,
    })),
  }));

  // Pre-warm the HD engine for a voice so the first real clip isn't a cold-start
  // wait (~model load). Fire-and-forget: it returns immediately and the warm-up
  // synth runs in the background, so the UI can call it the moment a voice is
  // picked. Fail-soft — a missing engine/model just does nothing.
  ipcMain.handle('aegis:voice:prewarm', (event, voiceId) => prewarmVoice(appRoot, voiceId));

  ipcMain.handle('aegis:presets:list', () => {
    const listed = presets.listPresets(appRoot);
    return {
      ok: true,
      warnings: listed.warnings,
      presets: listed.presets.map((p) => ({ file: p.file, profile: p.profile, warnings: p.warnings })),
    };
  });

  ipcMain.handle('aegis:profiles:list', () => {
    let files = [];
    try {
      files = fs.readdirSync(profilesDir(appRoot)).filter((f) => PROFILE_FILE_PATTERN.test(f));
    } catch {
      return { ok: true, profiles: [] }; // no saves yet — not an error
    }
    const items = files.map((file) => {
      const { profile } = profiles.loadProfile(path.join(profilesDir(appRoot), file));
      return {
        file,
        name: profile.name,
        voice: profile.base.voice,
        origin: profile.origin || null,
        // Whether this saved voice is already published (drives "Published ✓ ·
        // Update" in the tuning panel); computed locally so it works offline.
        publishedItemId: workshop.getPublishedVoiceItem(userDir, file),
      };
    });
    return { ok: true, profiles: items };
  });

  ipcMain.handle('aegis:profiles:load', (event, file) => {
    if (typeof file !== 'string' || !PROFILE_FILE_PATTERN.test(file)) {
      return fail('Invalid profile file name.');
    }
    const full = path.join(profilesDir(appRoot), file);
    if (!fs.existsSync(full)) return fail(`Profile "${file}" no longer exists.`);
    const { profile, warnings } = profiles.loadProfile(full);
    return { ok: true, profile, warnings };
  });

  ipcMain.handle('aegis:profiles:save', (event, rawProfile) => {
    const clean = profiles.sanitizeProfile(rawProfile);
    // Filename from the profile name: readable on disk, safe by construction.
    const slug = clean.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'untitled';
    const file = `${slug}.json`;
    const full = path.join(profilesDir(appRoot), file);
    // Provenance for the publish gate: a profile the user tunes and saves here is
    // their own from-scratch work (publishable). If the incoming profile already
    // carries an origin (e.g. an imported voice re-saved — it round-trips through
    // the panel's cloned object), keep it, so an imported voice stays un-republishable.
    // Overwriting an existing file preserves that file's recorded origin.
    if (!clean.origin) {
      let existing = null;
      try { if (fs.existsSync(full)) existing = profiles.loadProfile(full).profile.origin || null; } catch { /* new file */ }
      clean.origin = existing || 'scratch';
    }
    try {
      const saved = profiles.saveProfile(full, clean);
      achievements.unlock('ACH_FOUND_YOUR_VOICE');
      return { ok: true, file, profile: saved };
    } catch (err) {
      return fail(`Could not save the profile: ${err.message}`);
    }
  });

  ipcMain.handle('aegis:test:synthesize', async (event, payload) => {
    if (typeof payload !== 'object' || payload === null) return fail('Invalid request.');
    const text = typeof payload.text === 'string' ? payload.text.trim().slice(0, MAX_TEST_TEXT_CHARS) : '';
    if (text === '') return fail('Type some test text first.');
    const profile = profiles.sanitizeProfile(payload.profile);

    if (synthesisBusy) return fail('A synthesis is already running — give it a second.');
    synthesisBusy = true;
    try {
      const manifest = bank.loadManifest(appRoot);
      const voice = bank.voiceById(manifest, profile.base.voice);
      if (!voice) {
        return fail(`Voice "${profile.base.voice}" is not in the bank. Pick a voice from the list.`);
      }
      if (!bank.isInstalled(appRoot, voice)) {
        return { ...fail(`Voice "${voice.displayName}" is not installed yet — download it from the voice bank.`), canFallback: true };
      }

      const env = await checkEnv(appRoot);
      if (!voiceEngineReady(appRoot, voice, env)) {
        const msg = bank.engineOf(voice) === 'melotts'
          ? 'The HD voice engine is not installed yet — download this HD voice first. You can still hear the text with the system voice.'
          : 'Piper is not installed, so the tuned voice cannot be rendered. You can still hear the text with the system voice.';
        return { ...fail(msg), canFallback: true };
      }

      const { pcm: dryPcm, sampleRate } = await synthClip(appRoot, voice, text, profile);

      // ffmpeg missing is degraded, not fatal: return the raw voice and say so.
      let pcm = dryPcm;
      let warning = null;
      let filtergraph = null;
      if (env.ffmpeg) {
        const wet = await dsp.applyDsp(dryPcm, sampleRate, profile, dsp.findFfmpeg());
        pcm = wet.pcm;
        filtergraph = dsp.buildFilterGraph(profile, sampleRate);
      } else {
        warning = 'ffmpeg is not installed — you are hearing the raw voice; the timbre and character stages are bypassed.';
      }

      const dry = analyze.analyzePcm(dryPcm, sampleRate);
      const wet = pcm === dryPcm ? dry : analyze.analyzePcm(pcm, sampleRate);
      return {
        ok: true,
        pcm,
        sampleRate,
        warning,
        filtergraph,
        stats: {
          durationSeconds: wet.durationSeconds,
          speechSeconds: wet.speechSeconds,
          medianF0Hz: wet.medianF0Hz,
          dryMedianF0Hz: dry.medianF0Hz,
          voicedFraction: wet.voicedFraction,
          wpm: analyze.wordsPerMinute(text, wet.speechSeconds),
        },
      };
    } catch (err) {
      return { ...fail(err.message), canFallback: true };
    } finally {
      synthesisBusy = false;
    }
  });

  // ── Dashboard: packs, stats, window control ──────────────────────────────

  // ACH_COLLECTOR: unlock once 5+ installed (non-built-in) packs exist. Cheap and
  // guarded, so listing packs frequently (cards, previews) stays fast.
  let collectorUnlocked = false;
  function checkCollector() {
    if (collectorUnlocked) return;
    try {
      const dir = path.join(userDir, 'packs');
      if (!fs.existsSync(dir)) return;
      let n = 0;
      for (const name of fs.readdirSync(dir)) {
        try { if (fs.existsSync(path.join(dir, name, 'pack.json'))) n++; } catch { /* skip */ }
        if (n >= 5) break;
      }
      if (n >= 5) { achievements.unlock('ACH_COLLECTOR'); collectorUnlocked = true; }
    } catch { /* fail-soft */ }
  }

  ipcMain.handle('aegis:packs:list', () => {
    const listed = packs.listPacks(appRoot, userDir);
    checkCollector();
    return { ok: true, packs: listed.packs, warnings: listed.warnings };
  });

  // A static snapshot of the pack for its library card (rendered + cached in
  // main from demo data). null uri → the card shows its blueprint fallback.
  ipcMain.handle('aegis:pack:thumbnail', async (event, id) => {
    if (typeof id !== 'string') return fail('Invalid pack id.');
    if (typeof hooks.renderThumbnail !== 'function') return { ok: false };
    try {
      const uri = await hooks.renderThumbnail(id);
      return { ok: !!uri, uri: uri || null };
    } catch (err) {
      return { ok: false };
    }
  });

  ipcMain.handle('aegis:packs:load', (event, id, opts) => {
    if (typeof id !== 'string') return fail('Invalid pack id.');
    const loaded = packs.loadPack(appRoot, userDir, id);
    // The desktop + manager render the user's customized pack; the editor and
    // Workshop preview render the author's originals (no overrides).
    if (opts && opts.withProps) {
      packs.applyUserProps(loaded.pack, userprops.getOverrides(userDir, loaded.pack.id));
    }
    // shared:true → a PUBLIC preview render (Workshop preview image): replace the
    // author's own content with placeholders, exactly like the published pack.json
    // (one source of truth: packstore.sanitizeForShare) so nothing personal is
    // baked into the uploaded image.
    if (opts && opts.shared) {
      loaded.pack = packstore.sanitizeForShare(loaded.pack);
    }
    const collected = packs.collectAssets(loaded.dir, loaded.pack);
    // Video wallpapers ride alongside the image assets in the SAME map, but as
    // opaque depack:// urls (main streams them) rather than base64 — so the
    // renderer keeps its single ctx.assets[src] lookup for both.
    const video = videostore.registerPackVideos(loaded.dir, loaded.pack);
    resetPackWatcher(event.sender, loaded.pack.id, loaded.dir);
    return {
      ok: true,
      pack: loaded.pack,
      origin: loaded.origin,
      // Same strict gate as publishing: true only for the user's own work
      // (from-scratch or their re-downloaded Workshop pack). The editor uses it to
      // lock the Customize-knobs tab on presets/imports/forks (not the author's).
      publishable: packstore.isPublishable(appRoot, userDir, id),
      assets: { ...collected.assets, ...video.urls },
      warnings: [...loaded.warnings, ...collected.warnings, ...video.warnings],
    };
  });

  // ── User properties: the pack's declared knobs + the user's chosen values ──

  ipcMain.handle('aegis:userprops:get', (event, id) => {
    if (typeof id !== 'string') return fail('Invalid pack id.');
    const loaded = packs.loadPack(appRoot, userDir, id);
    const overrides = userprops.getOverrides(userDir, loaded.pack.id);
    let props = loaded.pack.props || [];
    // A preset-effect knob (bind → ambience.effect) is a no-op when the pack uses
    // a CUSTOM particle system (Particle Studio) — the renderer ignores the preset
    // effect and draws the custom `system`. Hide the dead control so the Customize
    // panel doesn't show a misleading "Particles: <preset>" picker for a custom
    // pack. The density knob (bind → ambience.density) still works (it scales the
    // custom particle count), so it stays.
    const amb = loaded.pack.skin && loaded.pack.skin.ambience;
    if (amb && amb.mode === 'custom') {
      props = props.filter((p) => !(p.bind && p.bind.target === 'ambience' && p.bind.key === 'effect'));
    }
    // Current value per prop = a valid override if present, else the default.
    const values = {};
    for (const prop of props) {
      let value = prop.default;
      if (Object.prototype.hasOwnProperty.call(overrides, prop.key)) {
        const coerced = packs.coerceProp(prop, overrides[prop.key]);
        if (coerced !== null) value = coerced;
      }
      values[prop.key] = value;
    }
    return { ok: true, props, values };
  });

  ipcMain.handle('aegis:userprops:set', (event, payload) => {
    if (typeof payload !== 'object' || payload === null) return fail('Invalid request.');
    const { packId, key, value } = payload;
    if (typeof packId !== 'string' || typeof key !== 'string') return fail('Invalid request.');
    const loaded = packs.loadPack(appRoot, userDir, packId);
    const prop = (loaded.pack.props || []).find((p) => p.key === key);
    if (!prop) return fail('Unknown property.');
    const coerced = packs.coerceProp(prop, value);
    if (coerced === null) return fail('That value is not allowed for this property.');
    userprops.setOverride(userDir, loaded.pack.id, key, coerced);
    if (typeof hooks.onUserPropsChanged === 'function') hooks.onUserPropsChanged(loaded.pack.id);
    return { ok: true, value: coerced };
  });

  ipcMain.handle('aegis:userprops:reset', (event, id) => {
    if (typeof id !== 'string') return fail('Invalid pack id.');
    const loaded = packs.loadPack(appRoot, userDir, id);
    userprops.clearPack(userDir, loaded.pack.id);
    if (typeof hooks.onUserPropsChanged === 'function') hooks.onUserPropsChanged(loaded.pack.id);
    return { ok: true };
  });

  // ── Library: install / export / uninstall / registries ──────────────────

  ipcMain.handle('aegis:library:state', async () => {
    const listed = packs.listPacks(appRoot, userDir);
    // The full sanitized pack rides along (a few KB each) so the gallery can
    // draw blueprint thumbnails from palette + component rects.
    const items = listed.packs.map((p) => ({
      ...p,
      meta: p.origin === 'installed' ? packstore.readMeta(userDir, p.id) : null,
      // Strict publish gate + Workshop mapping, both computed locally (no Steam)
      // so the library loads offline: publishable disables the Publish button for
      // seeds/forks/imports; publishedItemId drives "Published ✓ · Update".
      publishable: packstore.isPublishable(appRoot, userDir, p.id),
      publishedItemId: workshop.getPublishedItem(userDir, p.id),
      pack: packs.loadPack(appRoot, userDir, p.id).pack,
    }));
    return { ok: true, packs: items, registries: registry.loadRegistries(userDir).registries, warnings: listed.warnings };
  });

  ipcMain.handle('aegis:registry:preview', async (event, url) => {
    if (typeof url !== 'string') return fail('Invalid preview URL.');
    return registry.fetchPreview(url);
  });

  ipcMain.handle('aegis:packs:installFile', async (event) => {
    const picked = await dialog.showOpenDialog({
      title: 'Install a persona pack',
      filters: [{ name: 'Dashboard packs', extensions: ['dpack', 'aegispack', 'zip'] }],
      properties: ['openFile'],
    });
    if (picked.canceled || picked.filePaths.length === 0) return { ok: false, error: null }; // user cancelled — not an error
    let buffer;
    try {
      const stat = fs.statSync(picked.filePaths[0]);
      if (stat.size > 30 * 1024 * 1024) return fail('That file is larger than the 30 MB pack cap.');
      buffer = fs.readFileSync(picked.filePaths[0]);
    } catch (err) {
      return fail(`Could not read the file: ${err.message}`);
    }
    // freshCopy: a file install is always a brand-new, independent copy — never
    // overwrite an existing pack with the same id (the user's own master included).
    return packstore.installFromBuffer(appRoot, userDir, buffer, { source: 'file', freshCopy: true });
  });

  // Install a pack from a filesystem path (the drag-drop path — the renderer got
  // this path from webUtils.getPathForFile on a file the USER dropped). Validated
  // like installFile: real file, allowed extension, size-capped, then the same
  // zip-slip/bomb-proof installer. Never runs a shell.
  ipcMain.handle('aegis:packs:installPath', async (event, filePath) => {
    if (typeof filePath !== 'string' || !filePath.trim()) return fail('No file to install.');
    const ext = path.extname(filePath).toLowerCase();
    if (!['.dpack', '.aegispack', '.zip'].includes(ext)) return fail('That is not a .dpack file.');
    let buffer;
    try {
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) return fail('That is not a file.');
      if (stat.size > 30 * 1024 * 1024) return fail('That file is larger than the 30 MB pack cap.');
      buffer = fs.readFileSync(filePath);
    } catch (err) {
      return fail(`Could not read the file: ${err.message}`);
    }
    // freshCopy: a dropped pack is always a brand-new, independent copy (see installFile).
    return packstore.installFromBuffer(appRoot, userDir, buffer, { source: 'file', freshCopy: true });
  });

  ipcMain.handle('aegis:packs:export', async (event, id) => {
    if (typeof id !== 'string') return fail('Invalid pack id.');
    const resolved = packs.resolvePackDir(appRoot, userDir, id);
    if (resolved.origin === 'missing') return fail(`No pack named "${id}".`);
    const exported = packstore.exportPack(resolved.dir);
    if (!exported.ok) return exported;
    const picked = await dialog.showSaveDialog({
      title: 'Export persona pack',
      defaultPath: `${id}.dpack`,
      filters: [{ name: 'Dashboard packs', extensions: ['dpack'] }],
    });
    if (picked.canceled || !picked.filePath) return { ok: false, error: null };
    try {
      fs.writeFileSync(picked.filePath, exported.buffer);
      return { ok: true, file: picked.filePath };
    } catch (err) {
      return fail(`Could not write the file: ${err.message}`);
    }
  });

  // ── Steam Workshop (prototype, test AppID 480) ──────────────────────────
  // Every handler is fail-soft: with no Steam, `status` reports unavailable and
  // the others return { ok:false, error } — the UI degrades, nothing throws.

  ipcMain.handle('aegis:workshop:status', () => workshop.status());

  // Can the Workshop run right now? Unpackaged dev has its own client; packaged
  // needs a live Steam session (which owns the client). The Manager gates the
  // Workshop tabs on this so it shows an "Open in Steam" prompt, not a bare error.
  ipcMain.handle('aegis:workshop:available', () =>
    ({ available: typeof hooks.workshopAvailable === 'function' ? !!hooks.workshopAvailable() : true }));

  // Relaunch through Steam so a session spawns (the only way to use the Workshop
  // when the Manager was opened directly, e.g. from the tray). Fail-soft.
  ipcMain.handle('aegis:workshop:launchSession', () =>
    ({ ok: typeof hooks.launchWorkshopSession === 'function' ? !!hooks.launchWorkshopSession() : false }));

  ipcMain.handle('aegis:workshop:publish', async (event, req) => {
    if (typeof req !== 'object' || req === null) return fail('Invalid publish request.');
    if (typeof req.packId !== 'string') return fail('Invalid pack id.');
    // Render a real preview image of the dashboard (demo data only, no personal
    // info); publish falls back to the wallpaper if this fails.
    let previewPath = null;
    if (typeof hooks.renderPreview === 'function') {
      // Steam gets a small STATIC preview (a big animated GIF trips Steam's
      // upload throttle); the live moving preview lives in-app on the Browse detail.
      try { previewPath = await hooks.renderPreview(req.packId); } catch (err) { previewPath = null; }
    }
    try {
      const res = await workshop.publish(appRoot, userDir, {
        packId: req.packId,
        title: typeof req.title === 'string' ? req.title : '',
        description: typeof req.description === 'string' ? req.description : '',
        tags: Array.isArray(req.tags) ? req.tags : [],
        visibility: typeof req.visibility === 'string' ? req.visibility : 'unlisted',
        previewPath,
      });
      if (res && res.ok) achievements.unlock('ACH_PUBLISHED_AUTHOR');
      return res;
    } finally {
      if (previewPath) { try { fs.rmSync(previewPath, { force: true }); } catch (err) { /* temp file */ } }
    }
  });

  ipcMain.handle('aegis:workshop:subscribed', () => workshop.listSubscribed());

  ipcMain.handle('aegis:workshop:import', async (event, itemId) => {
    if (typeof itemId !== 'string') return fail('Invalid item id.');
    const res = await workshop.importSubscribed(appRoot, userDir, itemId);
    if (res && res.ok) { achievements.unlock('ACH_CURATOR'); checkCollector(); }
    return res;
  });

  // Consume side: browse the app's Workshop, subscribe, fetch previews, and open
  // the full Workshop web page in the user's browser.
  ipcMain.handle('aegis:workshop:browse', (event, opts) => {
    const o = typeof opts === 'object' && opts !== null ? opts : {};
    return workshop.browse({
      page: Number(o.page) || 1,
      search: typeof o.search === 'string' ? o.search : '',
      sort: typeof o.sort === 'string' ? o.sort : 'trend',
    });
  });

  ipcMain.handle('aegis:workshop:subscribe', (event, itemId) => {
    if (typeof itemId !== 'string') return fail('Invalid item id.');
    return workshop.subscribe(itemId);
  });

  ipcMain.handle('aegis:workshop:preview', (event, url) => {
    if (typeof url !== 'string') return { ok: false };
    return workshop.previewDataUri(url);
  });

  ipcMain.handle('aegis:workshop:open', async () => {
    try { await shell.openExternal(workshop.workshopPageUrl()); return { ok: true }; }
    catch (err) { return fail(err.message); }
  });

  // ── Creator management: your published dashboards ──────────────────────────
  // See/edit/update the Workshop items you've published, machine-portable via
  // Steam identity. getEditable is gated (workshop.js verifies you own the item).
  ipcMain.handle('aegis:workshop:mine', () => workshop.listMine(userDir));

  // Current visibility of a published item, so the publish dialog can default an
  // UPDATE to its existing audience (never silently changes it). Fail-soft: null.
  ipcMain.handle('aegis:workshop:visibility', async (event, itemId) => {
    if (typeof itemId !== 'string' && typeof itemId !== 'number') return { ok: false, visibility: null };
    try {
      const visibility = await workshop.getItemVisibility(String(itemId));
      return { ok: !!visibility, visibility: visibility || null };
    } catch (err) { return { ok: false, visibility: null }; }
  });

  ipcMain.handle('aegis:workshop:getEditable', async (event, itemId) => {
    if (typeof itemId !== 'string') return fail('Invalid item id.');
    const out = await workshop.getEditableCopy(appRoot, userDir, itemId);
    // On success, open the freshly downloaded copy in the editor (same UX as
    // building from scratch). The pack is already in the library either way.
    if (out && out.ok && out.packId && typeof hooks.openEditor === 'function') {
      try { hooks.openEditor(out.packId); } catch (err) { /* editor unavailable — UI still refreshes */ }
    }
    return out;
  });

  ipcMain.handle('aegis:workshop:openItem', async (event, url) => {
    // Only ever open a Steam Community URL in the browser (no arbitrary shell.open).
    if (typeof url !== 'string' || !/^https:\/\/steamcommunity\.com\//.test(url)) return fail('Invalid Workshop URL.');
    try { await shell.openExternal(url); return { ok: true }; }
    catch (err) { return fail(err.message); }
  });

  // ── Voice profiles on the Workshop (a separate item type from dashboards) ───
  // Publish/browse/manage sharable voice profiles — the auditory side only
  // (parameters, never audio). Every path is fail-soft when Steam is absent.

  // The base voice a published voice depends on: is it installed here, and how
  // big is the download if not? Lets a card say "needs English HD (620 MB)".
  function baseVoiceInfo(baseVoiceId) {
    const id = typeof baseVoiceId === 'string' ? baseVoiceId : null;
    const voice = id ? bank.voiceById(bank.loadManifest(appRoot), id) : null;
    if (!voice) return { baseVoice: id, baseName: id, baseInstalled: false, baseSizeBytes: 0 };
    const sizeBytes = bank.engineOf(voice) === 'melotts'
      ? voice.files.reduce((s, f) => s + (f.sizeBytes || 0), 0)
      : (voice.sizeBytes || 0);
    return { baseVoice: voice.id, baseName: voice.displayName, baseInstalled: bank.isInstalled(appRoot, voice), baseSizeBytes: sizeBytes };
  }

  ipcMain.handle('aegis:voice:publishable', (event, file) => {
    if (typeof file !== 'string') return { ok: true, publishable: false };
    return { ok: true, publishable: profiles.isPublishable(appRoot, file), publishedItemId: workshop.getPublishedVoiceItem(userDir, file) };
  });

  ipcMain.handle('aegis:voice:publish', async (event, req) => {
    if (typeof req !== 'object' || req === null) return fail('Invalid publish request.');
    if (typeof req.profileFile !== 'string') return fail('Invalid voice profile.');
    // Render the preview card (name + base voice + tuning bars; no personal data).
    let previewPath = null;
    if (typeof hooks.renderVoicePreview === 'function') {
      try { previewPath = await hooks.renderVoicePreview(req.profileFile); } catch (err) { previewPath = null; }
    }
    try {
      const res = await workshop.publishVoice(appRoot, userDir, {
        profileFile: req.profileFile,
        title: typeof req.title === 'string' ? req.title : '',
        description: typeof req.description === 'string' ? req.description : '',
        tags: Array.isArray(req.tags) ? req.tags : [],
        visibility: typeof req.visibility === 'string' ? req.visibility : 'unlisted',
        previewPath,
      });
      if (res && res.ok) achievements.unlock('ACH_SOUND_DESIGNER');
      return res;
    } finally {
      if (previewPath) { try { fs.rmSync(previewPath, { force: true }); } catch (err) { /* temp file */ } }
    }
  });

  ipcMain.handle('aegis:voice:browse', async (event, opts) => {
    const o = typeof opts === 'object' && opts !== null ? opts : {};
    const res = await workshop.browseVoices({
      page: Number(o.page) || 1,
      search: typeof o.search === 'string' ? o.search : '',
      sort: typeof o.sort === 'string' ? o.sort : 'trend',
    });
    if (res.ok) res.items = res.items.map((it) => ({ ...it, ...baseVoiceInfo(it.baseVoice) }));
    return res;
  });

  ipcMain.handle('aegis:voice:mine', async () => {
    const res = await workshop.listMineVoices(appRoot, userDir);
    if (res.ok) res.items = res.items.map((it) => ({ ...it, ...baseVoiceInfo(it.baseVoice) }));
    return res;
  });

  // Preview a community voice BEFORE subscribing: synthesize a short sample from
  // the tuning PARAMETERS carried in the Workshop listing (numbers + base-voice
  // id — never any audio) using the locally-installed licensed base voice. Same
  // synth path as the tuning panel's Test, so the sample IS the voice. The
  // renderer is assumed hostile, so params go through sanitizeProfile and the
  // base voice must be a real, installed bank voice.
  ipcMain.handle('aegis:voice:previewSample', async (event, req) => {
    if (typeof req !== 'object' || req === null || typeof req.params !== 'object' || req.params === null) {
      return fail('No voice parameters to preview.');
    }
    const profile = profiles.sanitizeProfile(req.params);
    if (synthesisBusy) return fail('A synthesis is already running — give it a second.');
    synthesisBusy = true;
    try {
      const manifest = bank.loadManifest(appRoot);
      const voice = bank.voiceById(manifest, profile.base.voice);
      if (!voice) return fail('This voice’s base voice isn’t recognized.');
      if (!bank.isInstalled(appRoot, voice)) {
        return { ...fail(`Download the ${voice.displayName} voice to preview this.`), needBase: true };
      }
      const env = await checkEnv(appRoot);
      if (!voiceEngineReady(appRoot, voice, env)) {
        return { ...fail('The HD voice engine isn’t installed yet — download this voice first.'), needBase: true };
      }
      const text = previewPhraseFor(voice);
      const { pcm: dryPcm, sampleRate } = await synthClip(appRoot, voice, text, profile);
      let pcm = dryPcm;
      if (env.ffmpeg) {
        try { const wet = await dsp.applyDsp(dryPcm, sampleRate, profile, dsp.findFfmpeg()); pcm = wet.pcm; }
        catch (e) { pcm = dryPcm; } // DSP is polish; the raw voice still previews
      }
      return { ok: true, pcm, sampleRate };
    } catch (err) {
      return fail('Couldn’t synthesize a preview right now.');
    } finally {
      synthesisBusy = false;
    }
  });

  ipcMain.handle('aegis:voice:getEditable', async (event, itemId) => {
    if (typeof itemId !== 'string') return fail('Invalid item id.');
    const out = await workshop.getEditableVoice(appRoot, userDir, itemId);
    // Open the tuning panel so the creator can adjust + re-publish (the new
    // profile is now in the saved list). Mirrors dashboards opening the editor.
    if (out && out.ok && typeof hooks.openPanel === 'function') {
      try { hooks.openPanel(); } catch (err) { /* panel unavailable — list still updated */ }
    }
    if (out && out.ok) Object.assign(out, baseVoiceInfo(out.baseVoice));
    return out;
  });

  ipcMain.handle('aegis:voice:import', async (event, itemId) => {
    if (typeof itemId !== 'string') return fail('Invalid item id.');
    const out = await workshop.importVoice(appRoot, userDir, itemId);
    if (out && out.ok) Object.assign(out, baseVoiceInfo(out.baseVoice));
    return out;
  });

  ipcMain.handle('aegis:packs:uninstall', (event, id) => {
    if (typeof id !== 'string') return fail('Invalid pack id.');
    return packstore.uninstall(userDir, id);
  });

  ipcMain.handle('aegis:registry:add', (event, url) => {
    if (typeof url !== 'string') return fail('Invalid registry URL.');
    return registry.addRegistry(userDir, url);
  });
  ipcMain.handle('aegis:registry:remove', (event, url) => {
    if (typeof url !== 'string') return fail('Invalid registry URL.');
    return registry.removeRegistry(userDir, url);
  });

  ipcMain.handle('aegis:registry:browse', async (event, url) => {
    if (typeof url !== 'string') return fail('Invalid registry URL.');
    const index = await registry.fetchIndex(url);
    if (!index.ok) return index;
    const installedIds = new Set(
      packs.listPacks(appRoot, userDir).packs.filter((p) => p.origin === 'installed').map((p) => p.id),
    );
    return {
      ...index,
      packs: index.packs.map((p) => ({ ...p, installed: installedIds.has(p.id) })),
      updates: registry.updatesInIndex(userDir, url, index),
    };
  });

  // ── Editor ────────────────────────────────────────────────────────────────

  ipcMain.handle('aegis:open-editor', (event, id) => {
    if (typeof hooks.openEditor !== 'function') return fail('The editor is unavailable in this session.');
    hooks.openEditor(typeof id === 'string' ? id : 'jarvis');
    return { ok: true };
  });

  // User-imported images. The dialog and the copy both happen HERE: the file
  // is staged into user data immediately, and saves only ever copy staged
  // files — the renderer names assets but can never point at disk paths.
  const stagingDir = path.join(userDir, 'editor-staging');
  const stagedAssets = new Map(); // 'assets/<name>' → absolute staged path
  try {
    fs.rmSync(stagingDir, { recursive: true, force: true }); // stale leftovers
  } catch { /* best effort */ }

  const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp'];
  const ASSET_MAX_BYTES = 5 * 1024 * 1024;
  const VIDEO_EXTENSIONS = ['mp4', 'webm'];
  const VIDEO_MAX_BYTES = 30 * 1024 * 1024;

  ipcMain.handle('aegis:editor:importImage', async (event, existingNames) => {
    const picked = await dialog.showOpenDialog({
      title: 'Import an image into this pack',
      filters: [{ name: 'Images', extensions: IMAGE_EXTENSIONS }],
      properties: ['openFile'],
    });
    if (picked.canceled || picked.filePaths.length === 0) return { ok: false, error: null }; // cancelled
    const sourcePath = picked.filePaths[0];

    let stat;
    try {
      stat = fs.statSync(sourcePath);
    } catch (err) {
      return fail(`Could not read the file: ${err.message}`);
    }
    if (stat.size > ASSET_MAX_BYTES) {
      return fail(`That image is ${(stat.size / 1048576).toFixed(1)} MB — the per-image cap is ${ASSET_MAX_BYTES / 1048576} MB.`);
    }

    // Safe, deduped asset name from the original basename.
    const parsed = path.parse(sourcePath);
    const ext = parsed.ext.toLowerCase().replace('.', '');
    if (!IMAGE_EXTENSIONS.includes(ext)) return fail('Images must be png, jpg, or webp.');
    let base = parsed.name.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'image';
    const taken = new Set([...(Array.isArray(existingNames) ? existingNames.filter((n) => typeof n === 'string') : []), ...stagedAssets.keys()]);
    let rel = `assets/${base}.${ext}`;
    let counter = 2;
    while (taken.has(rel)) rel = `assets/${base}-${counter++}.${ext}`;

    try {
      fs.mkdirSync(stagingDir, { recursive: true });
      const stagedPath = path.join(stagingDir, path.basename(rel));
      fs.copyFileSync(sourcePath, stagedPath);
      stagedAssets.set(rel, stagedPath);
      const mime = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' }[ext];
      return { ok: true, rel, uri: `data:${mime};base64,${fs.readFileSync(stagedPath).toString('base64')}` };
    } catch (err) {
      return fail(`Could not import the image: ${err.message}`);
    }
  });

  // Import a VIDEO wallpaper (mp4/webm). Staged like an image, but returned as a
  // depack:// url instead of a data URI (30 MB never rides base64) — the editor
  // stage plays it live via lib/videostore before the pack is even saved.
  ipcMain.handle('aegis:editor:importVideo', async (event, existingNames) => {
    const picked = await dialog.showOpenDialog({
      title: 'Import a video wallpaper into this pack',
      filters: [{ name: 'Video', extensions: VIDEO_EXTENSIONS }],
      properties: ['openFile'],
    });
    if (picked.canceled || picked.filePaths.length === 0) return { ok: false, error: null }; // cancelled
    const sourcePath = picked.filePaths[0];

    let stat;
    try {
      stat = fs.statSync(sourcePath);
    } catch (err) {
      return fail(`Could not read the file: ${err.message}`);
    }
    if (stat.size > VIDEO_MAX_BYTES) {
      return fail(`That video is ${(stat.size / 1048576).toFixed(1)} MB — the video cap is ${VIDEO_MAX_BYTES / 1048576} MB. Trim or re-encode it smaller.`);
    }

    const parsed = path.parse(sourcePath);
    const ext = parsed.ext.toLowerCase().replace('.', '');
    if (!VIDEO_EXTENSIONS.includes(ext)) return fail('Video wallpapers must be mp4 or webm.');
    let base = parsed.name.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'video';
    const taken = new Set([...(Array.isArray(existingNames) ? existingNames.filter((n) => typeof n === 'string') : []), ...stagedAssets.keys()]);
    let rel = `assets/${base}.${ext}`;
    let counter = 2;
    while (taken.has(rel)) rel = `assets/${base}-${counter++}.${ext}`;

    try {
      fs.mkdirSync(stagingDir, { recursive: true });
      const stagedPath = path.join(stagingDir, path.basename(rel));
      fs.copyFileSync(sourcePath, stagedPath);
      stagedAssets.set(rel, stagedPath);
      const uri = videostore.registerStagedVideo(stagedPath);
      if (!uri) return fail('Could not stage the video for preview.');
      return { ok: true, rel, uri };
    } catch (err) {
      return fail(`Could not import the video: ${err.message}`);
    }
  });

  // Stage a PAINTED effect mask (Phase D). Unlike imported images (a file the
  // user picks) the mask is generated in the editor canvas, so it arrives as a
  // grayscale PNG data URL. It is staged exactly like an import — decoded,
  // size-checked, written under editor-staging, tracked in stagedAssets — so the
  // next editor:save copies it into the pack. The renderer never touches disk;
  // the rel name is validated to the fixed mask shape so nothing else can be
  // written through this path.
  const MASK_NAME_PATTERN = /^assets\/mask-[a-z0-9]{1,16}\.png$/;
  const MASK_MAX_BYTES = 4 * 1024 * 1024;
  ipcMain.handle('aegis:editor:stageMask', (event, payload) => {
    if (typeof payload !== 'object' || payload === null) return fail('Invalid request.');
    const { rel, dataUrl } = payload;
    if (typeof rel !== 'string' || !MASK_NAME_PATTERN.test(rel)) return fail('Invalid mask name.');
    if (typeof dataUrl !== 'string') return fail('Invalid mask data.');
    const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
    if (!m) return fail('A mask must be a PNG.');
    let buf;
    try { buf = Buffer.from(m[1], 'base64'); } catch { return fail('Could not decode the mask.'); }
    if (buf.length === 0 || buf.length > MASK_MAX_BYTES) return fail('The mask is empty or too large.');
    // PNG magic — refuse anything that isn't actually a PNG.
    if (!(buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47)) return fail('That is not a PNG.');
    try {
      fs.mkdirSync(stagingDir, { recursive: true });
      const stagedPath = path.join(stagingDir, path.basename(rel));
      fs.writeFileSync(stagedPath, buf);
      stagedAssets.set(rel, stagedPath);
      return { ok: true, rel };
    } catch (err) {
      return fail(`Could not stage the mask: ${err.message}`);
    }
  });

  // Drop a staged mask when its effect is removed, so an orphaned mask never
  // rides into the saved pack. Best-effort; the rel is validated to the mask
  // shape and only the basename is ever deleted (inside the staging dir).
  ipcMain.handle('aegis:editor:unstageMask', (event, rel) => {
    if (typeof rel !== 'string' || !MASK_NAME_PATTERN.test(rel)) return { ok: false };
    const stagedPath = stagedAssets.get(rel);
    stagedAssets.delete(rel);
    if (stagedPath) { try { fs.rmSync(stagedPath, { force: true }); } catch { /* best effort */ } }
    return { ok: true };
  });

  // Drop a staged image (e.g. a particle sprite the editor rejected as too big),
  // so it never rides into the saved pack. Basename-only, image-name validated.
  const STAGED_IMAGE_PATTERN = /^assets\/[a-z0-9._-]+\.(png|jpg|jpeg|webp)$/i;
  ipcMain.handle('aegis:editor:unstageAsset', (event, rel) => {
    if (typeof rel !== 'string' || !STAGED_IMAGE_PATTERN.test(rel)) return { ok: false };
    const stagedPath = stagedAssets.get(rel);
    stagedAssets.delete(rel);
    if (stagedPath) { try { fs.rmSync(stagedPath, { force: true }); } catch { /* best effort */ } }
    return { ok: true };
  });

  // From-scratch builder: create a new pack from the assembled manifest and
  // open it in the editor to fine-tune. Every asset the pack REFERENCES (the
  // wallpaper, background parallax layers, image/gallery components) that the
  // builder staged is carried in — but not stray staged files it doesn't use.
  ipcMain.handle('aegis:builder:create', (event, payload) => {
    if (typeof payload !== 'object' || payload === null) return fail('Invalid request.');
    const rawPack = payload.pack;
    if (typeof rawPack !== 'object' || rawPack === null) return fail('Invalid pack.');
    const extras = {};
    const wantRef = (rel) => {
      if (typeof rel !== 'string' || !rel) return;
      const key = `assets/${path.basename(rel)}`;
      if (stagedAssets.has(key)) extras[key] = stagedAssets.get(key);
    };
    const skin = rawPack.skin || {};
    wantRef(skin.wallpaper);
    if (skin.background && Array.isArray(skin.background.layers)) {
      for (const layer of skin.background.layers) wantRef(layer && layer.src);
    }
    for (const c of Array.isArray(rawPack.components) ? rawPack.components : []) {
      if (c && c.options && c.options.src) wantRef(c.options.src);
      if (c && c.options && Array.isArray(c.options.images)) for (const img of c.options.images) wantRef(img);
    }
    // A custom particle system may carry an imported sprite image / emitter mask.
    const amb = skin.ambience;
    if (amb && amb.system) {
      if (amb.system.sprite) wantRef(amb.system.sprite.custom);
      if (amb.system.emitter) wantRef(amb.system.emitter.mask);
    }
    const result = packstore.createPack(appRoot, userDir, rawPack, extras);
    if (result.ok) {
      achievements.unlock('ACH_FROM_SCRATCH');
      if (typeof hooks.onPackSaved === 'function') hooks.onPackSaved(result.id);
      // Open the editor unless the caller is taking another path (e.g. publish).
      if (payload.openInEditor !== false && typeof hooks.openEditor === 'function') hooks.openEditor(result.id);
    }
    return result;
  });

  ipcMain.handle('aegis:editor:save', (event, payload) => {
    if (typeof payload !== 'object' || payload === null) return fail('Invalid request.');
    const { baseId, pack } = payload;
    if (typeof baseId !== 'string') return fail('Invalid base pack id.');
    const result = packstore.saveEdited(appRoot, userDir, baseId, pack, Object.fromEntries(stagedAssets));
    // The save swap can kill the fs watcher (see resetPackWatcher), so the
    // repaint must not depend on it: tell every window directly.
    if (result.ok) {
      achievements.unlock('ACH_INTERIOR_DESIGNER');
      if (typeof hooks.onPackSaved === 'function') hooks.onPackSaved(result.id);
    }
    return result;
  });

  // ── Edit a module component's code in an external editor (VS Code) ──────────
  // The tiny inline code box is cramped for real work. This writes the module
  // code to a temp FILE, opens it in VS Code, and watches the file so saves sync
  // straight back into the editor. SECURITY: the launch command is
  // `code "<app-generated temp path>"` — the user's CODE only ever goes into the
  // FILE (fs.writeFileSync), never onto a command line, so this doesn't build a
  // shell command from user text. Fail-soft: no VS Code → a friendly hint.
  const moduleEditSessions = new Map();   // token -> { file, watcher, wcId }
  const moduleEditByWc = new Map();       // webContents id -> Set<token>
  function stopModuleEdit(token) {
    const s = moduleEditSessions.get(token);
    if (!s) return;
    try { if (s.watcher) s.watcher.close(); } catch (e) { /* already gone */ }
    try { fs.rmSync(s.file, { force: true }); } catch (e) { /* already gone */ }
    moduleEditSessions.delete(token);
    const set = moduleEditByWc.get(s.wcId);
    if (set) set.delete(token);
  }

  ipcMain.handle('aegis:module:editExternal', async (event, html) => {
    if (typeof html !== 'string') return fail('Invalid module code.');
    if (html.length > 256 * 1024) return fail('Module code is too large to edit externally.');
    const os = require('os');
    const token = require('crypto').randomBytes(8).toString('hex');
    const dir = path.join(os.tmpdir(), 'dashboard-engine-module-edit');
    const file = path.join(dir, `module-${token}.html`);
    try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(file, html, 'utf8'); }
    catch (e) { return fail('Could not create the temporary file.'); }

    // Launch VS Code. shell:true so `code` / `code.cmd` resolves via PATH (spawning
    // a .cmd needs a shell on modern Node); the path is app-generated + quoted, so
    // a temp dir with spaces is fine and there's no user text on the line. `code`
    // exits 0 on a successful hand-off, non-zero when it isn't installed / on PATH.
    const launched = await new Promise((resolve) => {
      let settled = false;
      const done = (v) => { if (!settled) { settled = true; resolve(v); } };
      let child;
      try { child = spawn(`code "${file}"`, { shell: true, windowsHide: true, stdio: 'ignore' }); }
      catch (e) { return done(false); }
      child.once('error', () => done(false));
      child.once('exit', (code) => done(code === 0));
      setTimeout(() => done(true), 2500); // still running = it's opening a fresh window
    });
    if (!launched) { try { fs.rmSync(file, { force: true }); } catch (e) {} return { ok: false, reason: 'vscode-missing' }; }

    // Watch the DIR (survives VS Code's atomic save-and-rename) and push the file
    // back on change. Every fs.watch gets an error handler — deleting a watched
    // path is an EPERM crash on Windows otherwise.
    const wc = event.sender;
    const wcId = wc.id;
    const base = path.basename(file);
    let debounce = null;
    let watcher = null;
    try {
      watcher = fs.watch(dir, { persistent: false }, (_evt, fname) => {
        if (fname && fname !== base) return;
        clearTimeout(debounce);
        debounce = setTimeout(() => {
          let code = null;
          try { code = fs.readFileSync(file, 'utf8'); } catch (e) { return; }
          if (code != null && !wc.isDestroyed()) wc.send('aegis:module:external:changed', { token, html: code });
        }, 150);
      });
      watcher.on('error', () => { /* watched dir vanished — never crash */ });
    } catch (e) { /* no watch — the file still opened, just no live sync */ }

    moduleEditSessions.set(token, { file, watcher, wcId });
    if (!moduleEditByWc.has(wcId)) moduleEditByWc.set(wcId, new Set());
    moduleEditByWc.get(wcId).add(token);
    // Tear down every session for this window when it closes.
    wc.once('destroyed', () => {
      const set = moduleEditByWc.get(wcId);
      if (set) { for (const tk of Array.from(set)) stopModuleEdit(tk); moduleEditByWc.delete(wcId); }
    });
    return { ok: true, token };
  });

  ipcMain.handle('aegis:module:editStop', (event, token) => {
    if (typeof token === 'string') stopModuleEdit(token);
    return { ok: true };
  });

  // Every image inside a pack's assets/ dir (the editor's picker for image
  // components and wallpapers), as size-capped data URIs.
  ipcMain.handle('aegis:packs:assetsAll', (event, id) => {
    if (typeof id !== 'string') return fail('Invalid pack id.');
    const resolved = packs.resolvePackDir(appRoot, userDir, id);
    if (resolved.origin === 'missing') return fail(`No pack named "${id}".`);
    const assetsDir = path.join(resolved.dir, 'assets');
    const listing = {};
    try {
      const files = fs.readdirSync(assetsDir).filter((f) => /^[a-z0-9._-]+\.(png|jpg|jpeg|webp)$/i.test(f)).slice(0, 24);
      const fake = { ...packs.loadPack(appRoot, userDir, id).pack };
      fake.components = files.map((f) => ({ type: 'image', options: { src: `assets/${f}` } }));
      fake.skin = { ...fake.skin, wallpaper: null };
      const collected = packs.collectAssets(resolved.dir, fake);
      Object.assign(listing, collected.assets);
    } catch {
      // no assets dir — empty listing is fine
    }
    return { ok: true, assets: listing };
  });

  // ── Reminders / daily planner (personal data, never inside packs) ────────

  function remindersChanged() {
    if (typeof hooks.onRemindersChanged === 'function') hooks.onRemindersChanged();
  }

  // Optional {from, to} (YYYY-MM-DD) asks for expanded occurrences — the
  // planner grid and the wallpaper calendar/agenda need repeats laid out on
  // concrete days. Raw entries always come back for editing.
  const DATE_ARG = /^\d{4}-\d{2}-\d{2}$/;
  ipcMain.handle('aegis:reminders:list', (event, payload) => {
    const listing = reminders.list(userDir);
    const result = { ok: true, ...listing };
    if (typeof payload === 'object' && payload !== null
      && typeof payload.from === 'string' && DATE_ARG.test(payload.from)
      && typeof payload.to === 'string' && DATE_ARG.test(payload.to)) {
      result.occurrences = reminders.expand(listing.reminders, payload.from, payload.to);
    }
    return result;
  });

  ipcMain.handle('aegis:reminders:add', (event, payload) => {
    if (typeof payload !== 'object' || payload === null) return fail('Invalid request.');
    const result = reminders.add(userDir, {
      date: payload.date,
      time: payload.time || null,
      text: payload.text,
      repeat: payload.repeat,
      lead: payload.lead,
    });
    if (result.ok) remindersChanged();
    return result;
  });

  ipcMain.handle('aegis:reminders:update', (event, payload) => {
    if (typeof payload !== 'object' || payload === null || typeof payload.id !== 'string') {
      return fail('Invalid request.');
    }
    const patch = typeof payload.patch === 'object' && payload.patch !== null ? payload.patch : {};
    const result = reminders.update(userDir, payload.id, {
      date: patch.date,
      time: patch.time,
      text: patch.text,
      repeat: patch.repeat,
      lead: patch.lead,
    });
    if (result.ok) remindersChanged();
    return result;
  });

  ipcMain.handle('aegis:reminders:remove', (event, id) => {
    if (typeof id !== 'string') return fail('Invalid reminder id.');
    const result = reminders.remove(userDir, id);
    if (result.ok) remindersChanged();
    return result;
  });

  ipcMain.handle('aegis:reminders:toggle', (event, id) => {
    if (typeof id !== 'string') return fail('Invalid reminder id.');
    const result = reminders.toggle(userDir, id);
    if (result.ok) remindersChanged();
    return result;
  });

  // ── Pomodoro / focus timer (personal timing state, never inside a pack) ──
  // The timer runs in MAIN (see lib/pomodoro.js) so it survives the desktop's
  // performance freeze; the wallpaper `pomodoro` component only displays it and
  // sends these control actions. A control call carries the component's editor
  // options as `cfg`, so durations/behaviour follow whatever the user is using.

  // Start / Stop(=pause) / Reset / Break, plus `sync` (a component adopting its
  // own durations on mount). `break` carries the chosen minutes; < 1 clears a
  // queued break.
  const POMODORO_ACTIONS = new Set(['start', 'pause', 'reset', 'break', 'sync']);

  function pomodoroChanged(info) {
    if (typeof hooks.onPomodoroChanged === 'function') hooks.onPomodoroChanged(info || { event: 'control' });
  }

  ipcMain.handle('aegis:pomodoro:get', () => ({ ok: true, state: pomodoro.get(userDir) }));

  ipcMain.handle('aegis:pomodoro:control', (event, payload) => {
    const req = (typeof payload === 'object' && payload !== null) ? payload : {};
    const action = typeof req.action === 'string' ? req.action : '';
    if (!POMODORO_ACTIONS.has(action)) return fail('Unknown timer action.');
    const opts = {};
    if (typeof req.cfg === 'object' && req.cfg !== null) opts.cfg = req.cfg;
    if (action === 'break') opts.breakMin = Number(req.breakMin); // may be 0 → clear a queued break
    const state = pomodoro.control(userDir, action, opts);
    // Main re-arms its phase-end timer against the new schedule and broadcasts
    // the fresh state to every window so all pomodoro components stay in sync.
    pomodoroChanged({ event: 'control' });
    return { ok: true, state };
  });

  // ── Launcher (personal data; packs only place/style the component) ───────
  // The renderer deals in opaque ids. Anything launchable was first put into
  // `launchable` by OUR enumeration (Start Menu / Recent / pins); a made-up
  // id resolves to nothing. Running-window focus is allowlisted the same way
  // against the last enumeration snapshot.

  function launcherChanged() {
    if (typeof hooks.onLauncherChanged === 'function') hooks.onLauncherChanged();
  }

  const launchable = new Map();   // id → { name, target }
  const iconCache = new Map();    // target → data URI | null
  const runningCache = { at: 0, list: [], byHwnd: new Set() };

  const THUMBNAIL_EXT = /\.(png|jpe?g|gif|bmp|webp|ico|tiff?|mp4|mkv|mov|avi|webm|m4v)$/i;

  async function entryIcon(target) {
    if (iconCache.has(target)) return iconCache.get(target);
    let uri = null;

    // A .lnk's own icon is a blank "document with arrow" — icons come from
    // the TARGET (Word file → Word icon, folder → folder icon). Launching
    // still opens the .lnk itself, so shortcut args/working dirs survive.
    let iconPath = target;
    if (/\.lnk$/i.test(target)) {
      try { iconPath = shell.readShortcutLink(target).target || target; } catch { /* unreadable link */ }
    }

    // Pictures and videos: the shell's real thumbnail beats a type icon.
    if (THUMBNAIL_EXT.test(iconPath)) {
      try {
        const thumb = await nativeImage.createThumbnailFromPath(iconPath, { width: 64, height: 64 });
        if (!thumb.isEmpty()) uri = thumb.toDataURL();
      } catch { /* no thumbnail (file gone, codec) — fall through to type icon */ }
    }

    if (!uri) {
      for (const candidate of new Set([iconPath, target])) {
        try {
          const icon = await app.getFileIcon(candidate, { size: 'large' });
          if (icon && !icon.isEmpty()) { uri = icon.toDataURL(); break; }
        } catch { /* try the next candidate */ }
      }
    }

    iconCache.set(target, uri);
    return uri;
  }

  async function listRunningWindows() {
    if (Date.now() - runningCache.at < 5000) return runningCache.list;
    const json = await new Promise((resolve) => {
      const child = spawn('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', path.join(appRoot, 'scripts', 'windows-list.ps1'),
      ], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
      let out = '';
      child.stdout.on('data', (chunk) => { out += chunk.toString('utf8'); });
      child.on('error', () => resolve('[]'));
      child.on('close', () => resolve(out || '[]'));
    });
    let raw = [];
    // PS 5.1 stdout leads with a UTF-8 BOM; a single window serializes bare.
    try { raw = JSON.parse(json.charCodeAt(0) === 0xFEFF ? json.slice(1) : json); } catch { raw = []; }
    if (raw && !Array.isArray(raw)) raw = Array.isArray(raw.value) ? raw.value : [raw];
    const ourExe = process.execPath.toLowerCase();
    const list = [];
    for (const w of raw) {
      if (typeof w !== 'object' || w === null) continue;
      const hwnd = Number(w.hwnd);
      const title = typeof w.title === 'string' ? w.title.slice(0, 120) : '';
      if (!Number.isFinite(hwnd) || hwnd <= 0 || title === '') continue;
      const exe = typeof w.exe === 'string' && w.exe !== '' ? w.exe : null;
      if (exe && exe.toLowerCase() === ourExe) continue; // hide our own windows
      list.push({ hwnd, title, exe, name: typeof w.name === 'string' ? w.name.slice(0, 60) : '' });
    }
    runningCache.at = Date.now();
    runningCache.list = list;
    runningCache.byHwnd = new Set(list.map((w) => w.hwnd));
    return list;
  }

  ipcMain.handle('aegis:launcher:state', async (event, payload) => {
    const wantRunning = typeof payload === 'object' && payload !== null && payload.running === true;
    const store = launcher.loadStore(userDir);
    const enrich = async (entries) => {
      const out = [];
      for (const entry of entries) {
        launchable.set(entry.id, { name: entry.name, target: entry.target });
        out.push({ id: entry.id, name: entry.name, icon: await entryIcon(entry.target) });
      }
      return out;
    };
    // The shell's Recent folder is full of protocol shortcuts (ms-screenclip,
    // ms-gamingoverlay, …) that aren't files at all — keep only shortcuts
    // whose target really exists on disk.
    const isRealFile = (entry) => {
      if (!/\.lnk$/i.test(entry.target)) return fs.existsSync(entry.target);
      try {
        const resolved = shell.readShortcutLink(entry.target).target;
        return typeof resolved === 'string' && resolved !== '' && fs.existsSync(resolved);
      } catch {
        return false;
      }
    };
    const recentIds = new Set(store.pins.map((p) => p.id));
    const recents = [...store.recentApps, ...launcher.listRecentFiles()]
      .filter(isRealFile)
      .filter((r) => !recentIds.has(r.id) && recentIds.add(r.id)) // dedupe, skip pinned
      .slice(0, 10);
    const state = {
      ok: true,
      pins: await enrich(store.pins),
      recent: await enrich(recents),
      running: [],
    };
    if (wantRunning) {
      for (const w of await listRunningWindows()) {
        state.running.push({
          hwnd: w.hwnd,
          title: w.title,
          name: w.name,
          icon: w.exe ? await entryIcon(w.exe) : null,
        });
      }
    }
    return state;
  });

  ipcMain.handle('aegis:launcher:launch', async (event, id) => {
    if (typeof id !== 'string') return fail('Invalid entry.');
    const entry = launchable.get(id);
    if (!entry) return fail('That entry is no longer available.');
    const problem = await shell.openPath(entry.target);
    if (problem) return fail(`Could not open: ${problem}`);
    launcher.recordRecentApp(userDir, entry.name, entry.target);
    launcherChanged();
    return { ok: true };
  });

  ipcMain.handle('aegis:launcher:focus', async (event, hwnd) => {
    const n = Number(hwnd);
    if (!Number.isFinite(n) || !runningCache.byHwnd.has(n)) return fail('That window is gone.');
    return new Promise((resolve) => {
      const child = spawn('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', path.join(appRoot, 'scripts', 'window-focus.ps1'),
        '-TargetHwnd', String(n),
      ], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
      child.on('error', () => resolve(fail('Could not focus that window.')));
      child.on('close', (code) => resolve(code === 0 ? { ok: true } : fail('Could not focus that window.')));
    });
  });

  // Manager-side pin management.
  ipcMain.handle('aegis:launcher:apps', () => {
    return { ok: true, apps: launcher.listApps().map((a) => ({ id: a.id, name: a.name })) };
  });

  ipcMain.handle('aegis:launcher:pinApp', (event, id) => {
    if (typeof id !== 'string') return fail('Invalid app.');
    const found = launcher.listApps().find((a) => a.id === id);
    if (!found) return fail('That app is no longer in the Start Menu.');
    const result = launcher.pin(userDir, found.name, found.target);
    if (result.ok) { launcherChanged(); achievements.unlock('ACH_QUICK_LAUNCH'); }
    return result;
  });

  ipcMain.handle('aegis:launcher:pinPath', async (event, payload) => {
    const kind = typeof payload === 'object' && payload !== null && payload.kind === 'folder' ? 'folder' : 'file';
    const picked = await dialog.showOpenDialog({
      title: kind === 'folder' ? 'Pin a folder' : 'Pin a file',
      properties: [kind === 'folder' ? 'openDirectory' : 'openFile'],
    });
    if (picked.canceled || picked.filePaths.length === 0) return { ok: true, cancelled: true };
    const target = picked.filePaths[0];
    const result = launcher.pin(userDir, path.basename(target) || target, target);
    if (result.ok) { launcherChanged(); achievements.unlock('ACH_QUICK_LAUNCH'); }
    return result;
  });

  ipcMain.handle('aegis:launcher:unpin', (event, id) => {
    if (typeof id !== 'string') return fail('Invalid pin.');
    const result = launcher.unpin(userDir, id);
    if (result.ok) launcherChanged();
    return result;
  });

  ipcMain.handle('aegis:launcher:pinMove', (event, payload) => {
    if (typeof payload !== 'object' || payload === null || typeof payload.id !== 'string') return fail('Invalid pin.');
    const result = launcher.movePin(userDir, payload.id, Number(payload.delta) || 0);
    if (result.ok) launcherChanged();
    return result;
  });

  // ── System notifications (WinRT UserNotificationListener) ────────────────
  // PERSONAL data — the user's own Windows toast notifications, DISPLAYED by
  // the notifications component but never stored in a pack/export. Read only
  // in main. Cached so a desktop + preview don't each spawn PowerShell.
  const notifCache = { at: 0, value: null };
  const NOTIF_CACHE_MS = 12 * 1000;

  ipcMain.handle('aegis:notifications', async () => {
    if (process.platform !== 'win32') {
      return { ok: true, granted: false, status: 'unsupported', notifications: [] };
    }
    if (notifCache.value && Date.now() - notifCache.at < NOTIF_CACHE_MS) return notifCache.value;

    const raw = await new Promise((resolve) => {
      const child = spawn('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', path.join(appRoot, 'scripts', 'notifications-list.ps1'),
      ], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
      let out = '';
      const killer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, 12000);
      child.stdout.on('data', (chunk) => { out += chunk.toString('utf8'); });
      child.on('error', () => { clearTimeout(killer); resolve(null); });
      child.on('close', () => { clearTimeout(killer); resolve(out); });
    });

    let parsed = null;
    // PS 5.1 stdout leads with a UTF-8 BOM; strip before JSON.parse.
    try { parsed = JSON.parse(raw && raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw); } catch { /* unavailable */ }

    let value;
    if (!parsed || parsed.ok !== true) {
      value = { ok: true, granted: false, status: 'unavailable', notifications: [] };
    } else if (!parsed.granted) {
      value = { ok: true, granted: false, status: String(parsed.status || 'denied').toLowerCase(), notifications: [] };
    } else {
      const rawItems = Array.isArray(parsed.items) ? parsed.items : (parsed.items ? [parsed.items] : []);
      const notifications = rawItems
        .filter((n) => n && typeof n === 'object' && (n.title || n.body))
        .map((n) => ({
          id: (Number.isInteger(n.id) && n.id >= 0) ? n.id : null, // for dismiss
          app: typeof n.app === 'string' ? n.app.slice(0, 40) : '',
          title: typeof n.title === 'string' ? n.title.slice(0, 120) : '',
          body: typeof n.body === 'string' ? n.body.slice(0, 200) : '',
          time: typeof n.time === 'string' ? n.time : null,
        }))
        .sort((a, b) => (b.time || '').localeCompare(a.time || '')) // newest first
        .slice(0, 40);
      value = { ok: true, granted: true, status: 'allowed', notifications };
    }
    notifCache.at = Date.now();
    notifCache.value = value;
    return value;
  });

  // Dismiss (clear) live Windows notifications — one/some by id, or all. Ids are
  // validated to uint32 and passed as a SEPARATE argv (never interpolated into a
  // shell string). Fail-soft; invalidates the read cache so the next poll re-syncs.
  ipcMain.handle('aegis:notifications:dismiss', async (event, payload) => {
    if (process.platform !== 'win32') return { ok: false };
    let arg;
    if (payload && payload.all === true) {
      arg = 'all';
    } else {
      const ids = Array.isArray(payload && payload.ids) ? payload.ids : [];
      const clean = ids.filter((n) => Number.isInteger(n) && n >= 0 && n <= 0xFFFFFFFF).slice(0, 100);
      if (clean.length === 0) return { ok: false };
      arg = clean.join(',');
    }
    await new Promise((resolve) => {
      const child = spawn('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', path.join(appRoot, 'scripts', 'notifications-dismiss.ps1'),
        '-Ids', arg,
      ], { stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true });
      const killer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, 12000);
      child.on('error', () => { clearTimeout(killer); resolve(); });
      child.on('close', () => { clearTimeout(killer); resolve(); });
    });
    notifCache.value = null; // force a fresh read next poll
    return { ok: true };
  });

  // ── AI assistant (BYO key; key stays encrypted in main) ──────────────────
  // The renderer never sees the API key — config:get returns hasKey only.
  // Conversation state lives here so the desktop console and its input share
  // one thread. Replies can be spoken through the tuned voice pipeline.
  // Restore the ACTIVE session's transcript so the desktop chat has history
  // across restarts. The user can keep several conversations (sessions) — see the
  // aegis:assistant:session:* handlers; `assistantThread` mirrors the active one.
  let assistantThread = assistant.activeThread(userDir); // [{ role:'user'|'assistant', content }]
  const ASSISTANT_MAX_PROMPT = 2000;
  const ASSISTANT_MAX_SPEAK = 1200;
  let assistantStreamSeq = 0; // tags each streamed reply so the UI can match deltas

  ipcMain.handle('aegis:assistant:config:get', () => {
    return { ok: true, config: assistant.getPublicConfig(userDir) };
  });

  ipcMain.handle('aegis:assistant:config:set', (event, patch) => {
    if (typeof patch !== 'object' || patch === null) return fail('Invalid request.');
    const res = assistant.saveConfig(userDir, patch);
    // Just configured a local model? Start loading it so the first reply is fast.
    warmupAssistant(userDir);
    return res;
  });

  // Preload a local model (Ollama/LM Studio) ahead of the first message so its
  // cold start is hidden. Fired when the chat opens / the desktop loads. No-op
  // for hosted endpoints; fully fail-soft.
  ipcMain.handle('aegis:assistant:warmup', () => { warmupAssistant(userDir); return { ok: true }; });

  // Save the user's current prompt as a named persona (their own preset), or
  // remove one. Just prompt text — no secrets.
  ipcMain.handle('aegis:assistant:preset:add', (event, payload) => {
    if (typeof payload !== 'object' || payload === null) return fail('Invalid request.');
    return assistant.addPersonaPreset(userDir, payload.name, payload.prompt);
  });

  ipcMain.handle('aegis:assistant:preset:remove', (event, name) => {
    if (typeof name !== 'string') return fail('Invalid request.');
    return assistant.removePersonaPreset(userDir, name);
  });

  // Live list of models the keyless free endpoint offers (best-effort).
  // Legacy channel: the assistant is now BYO OpenAI-compatible, so there's no
  // hosted free-model list to fetch. Kept as a harmless no-op for old renderers.
  ipcMain.handle('aegis:assistant:models', async () => {
    return { ok: true, models: [] };
  });

  // The rendered transcript (for the desktop chat panel to restore its history),
  // plus the session list so the panel can show the chat switcher in one call.
  ipcMain.handle('aegis:assistant:history', () => {
    return { ok: true, thread: assistantThread, ...assistant.listSessions(userDir) };
  });

  ipcMain.handle('aegis:assistant:reset', () => {
    assistant.clearActiveThread(userDir); // empty the ACTIVE session, keep it
    assistantThread = [];
    return { ok: true };
  });

  // ── Chat sessions (multiple local conversations; personal data, never packed) ─
  ipcMain.handle('aegis:assistant:sessions', () => {
    return { ok: true, ...assistant.listSessions(userDir) };
  });

  ipcMain.handle('aegis:assistant:session:new', () => {
    const list = assistant.newSession(userDir);
    assistantThread = []; // the new session starts empty
    return { ok: true, ...list, thread: assistantThread };
  });

  ipcMain.handle('aegis:assistant:session:switch', (event, id) => {
    if (typeof id !== 'string') return fail('Invalid session.');
    const list = assistant.switchSession(userDir, id);
    assistantThread = assistant.activeThread(userDir);
    return { ok: true, ...list, thread: assistantThread };
  });

  ipcMain.handle('aegis:assistant:session:rename', (event, payload) => {
    const req = (typeof payload === 'object' && payload !== null) ? payload : {};
    if (typeof req.id !== 'string' || typeof req.title !== 'string') return fail('Invalid request.');
    return { ok: true, ...assistant.renameSession(userDir, req.id, req.title) };
  });

  ipcMain.handle('aegis:assistant:session:delete', (event, id) => {
    if (typeof id !== 'string') return fail('Invalid session.');
    const list = assistant.deleteSession(userDir, id);
    assistantThread = assistant.activeThread(userDir); // active may have changed
    return { ok: true, ...list, thread: assistantThread };
  });

  ipcMain.handle('aegis:assistant:ask', async (event, prompt) => {
    const text = typeof prompt === 'string' ? prompt.trim().slice(0, ASSISTANT_MAX_PROMPT) : '';
    if (text === '') return fail('Ask me something first.');
    assistantThread.push({ role: 'user', content: text });
    // Context (and cost) are bounded in assistant.ask, which sends only the last
    // `contextLimit` messages; the full transcript is kept for scrollback.
    // Stream the reply back to the asking window as it's generated. The push
    // events are harmless to any caller that doesn't subscribe (e.g. the
    // manager Test button), which still uses the returned {ok,text}.
    const wc = event.sender;
    const streamId = ++assistantStreamSeq;
    const send = (msg) => {
      try { if (wc && !wc.isDestroyed()) wc.send('aegis:assistant:stream', msg); } catch { /* window gone */ }
    };
    send({ id: streamId, start: true });
    const res = await assistant.ask(userDir, assistantThread, (delta) => send({ id: streamId, delta }));
    if (!res.ok) {
      assistantThread.pop(); // don't keep a user turn that got no reply
      send({ id: streamId, error: res.error || 'Something went wrong.' });
      return res;
    }
    assistantThread.push({ role: 'assistant', content: res.text });
    achievements.unlock('ACH_ARE_YOU_THERE');
    // Persist to the active session (auto-titles it from the first message) and
    // keep the in-memory copy capped to what was saved.
    assistantThread = assistant.saveActiveThread(userDir, assistantThread);
    send({ id: streamId, done: true, text: res.text });
    return { ok: true, text: res.text, id: streamId };
  });

  // Synthesize arbitrary text with the assistant's chosen voice profile, reused
  // by the assistant reply speak AND the spoken health alerts (below). Returns
  // PCM for the caller (renderer) to play. Best-effort: a missing voice or Piper
  // degrades to a fail result, never an error dialog.
  async function synthSpeech(text) {
    const clean = typeof text === 'string' ? text.trim().slice(0, ASSISTANT_MAX_SPEAK) : '';
    if (clean === '') return fail('Nothing to speak.');
    if (synthesisBusy) return fail('busy');
    synthesisBusy = true;
    try {
      const cfg = assistant.getPublicConfig(userDir);
      let profile = resolveVoiceProfile(appRoot, cfg.voiceProfile) || profiles.defaultProfile();
      const manifest = bank.loadManifest(appRoot);
      // Prefer the profile's voice; if it isn't installed, fall back to any
      // installed voice so the assistant can still speak.
      let voice = bank.voiceById(manifest, profile.base.voice);
      if (!voice || !bank.isInstalled(appRoot, voice)) {
        // Fall back ONLY to a voice of the SAME language as the one the user
        // chose. Substituting a different language (e.g. an English voice for an
        // uninstalled Chinese one) reads the reply as gibberish — worse than
        // staying silent. If the chosen language has no installed voice we return
        // 'voice-unavailable' below, and the caller shows the text + a "download
        // this voice" hint. (want=null only for a truly unknown voice → any.)
        const want = voiceLang(voice);
        voice = manifest.voices.find((v) => bank.isInstalled(appRoot, v) && (!want || voiceLang(v) === want)) || null;
        if (voice) profile = { ...profile, base: { ...profile.base, voice: voice.id } };
      }
      const env = await checkEnv(appRoot);
      if (!voice || !voiceEngineReady(appRoot, voice, env)) {
        return fail('voice-unavailable'); // caller stays silent, shows text only
      }
      const ffmpegPath = env.ffmpeg ? dsp.findFfmpeg() : null;

      // Strip emoji / markdown / leaked reasoning so they're never read aloud,
      // even if the model ignored its "plain spoken sentences" persona. If that
      // leaves nothing (a reply that was ONLY emoji), stay silent gracefully.
      const speakText = sanitizeForSpeech(clean);
      if (!speakText) return fail('Nothing to speak.');

      // Process each sentence-sized clip separately so long replies keep a
      // consistent, undistorted voice (see splitForSpeech). A short reply is a
      // single clip — identical to the old path, no regression.
      const clips = splitForSpeech(speakText);
      let sampleRate = voice.sampleRate || 22050;
      const parts = [];
      for (const clip of clips) {
        const synth = await synthClip(appRoot, voice, clip, profile);
        sampleRate = synth.sampleRate;
        let part = synth.pcm;
        if (ffmpegPath) {
          const wet = await dsp.applyDsp(part, sampleRate, profile, ffmpegPath);
          part = wet.pcm;
        }
        parts.push(part);
      }
      return { ok: true, pcm: Buffer.concat(parts), sampleRate };
    } catch (err) {
      return fail(err.message);
    } finally {
      synthesisBusy = false;
    }
  }

  ipcMain.handle('aegis:assistant:speak', (event, text) => synthSpeech(text));

  // ── Spoken system-health alerts ───────────────────────────────────────────
  // The desktop's sysinfo health line asks main to speak when a metric crosses a
  // threshold. Gated by the opt-in setting, rate-limited here so it can never
  // become chatter, and de-duplicated across multiple health components. Returns
  // PCM (the desktop plays it) or a skipped result.
  let lastHealthAlertAt = 0;
  const healthAlertBy = {}; // metric -> { sev, at }
  const HEALTH_ALERT_GAP_MS = 30 * 1000;         // min gap between ANY two spoken alerts
  const HEALTH_ALERT_REPEAT_MS = 5 * 60 * 1000;  // don't repeat a metric at same/lower severity within this

  function composeHealthAlert(metric, severity, value) {
    const v = Math.round(value);
    const key = String(metric || '').toUpperCase();
    const names = { CPU: 'C P U', MEM: 'Memory', DISK: 'Disk', BATTERY: 'Battery' };
    const name = names[key] || 'System';
    if (key === 'BATTERY') {
      return severity === 2 ? `Alert. Battery critical. ${v} percent remaining.` : `Warning. Battery low. ${v} percent.`;
    }
    return severity === 2 ? `Alert. ${name} usage critical. ${v} percent.` : `Warning. ${name} usage high. ${v} percent.`;
  }

  ipcMain.handle('aegis:health:alert', async (event, payload) => {
    if (!settings.getHealthVoiceAlerts(userDir)) return { ok: false, skipped: 'off' };
    if (typeof payload !== 'object' || payload === null) return fail('Invalid alert.');
    const metric = String(payload.metric || '').slice(0, 16).toUpperCase();
    const severity = payload.severity === 2 ? 2 : 1;
    const value = Number(payload.value);
    if (!metric || !Number.isFinite(value)) return fail('Invalid alert.');
    const now = Date.now();
    if (now - lastHealthAlertAt < HEALTH_ALERT_GAP_MS) return { ok: false, skipped: 'cooldown' };
    const prev = healthAlertBy[metric];
    if (prev && severity <= prev.sev && now - prev.at < HEALTH_ALERT_REPEAT_MS) return { ok: false, skipped: 'repeat' };
    const out = await synthSpeech(composeHealthAlert(metric, severity, value));
    if (out.ok) { lastHealthAlertAt = now; healthAlertBy[metric] = { sev: severity, at: now }; }
    return out;
  });

  // ── Background music (the user's OWN local files; personal data) ──────────
  // The `music` component plays these on the desktop. Paths live in main and
  // are streamed to the wallpaper by opaque id over demusic:// — a renderer
  // never sees a filesystem path, and nothing here ever enters a pack/export.
  // Pass the originating window so the broadcast can skip it — the sender
  // already reflects its own change and re-rendering it drops keyboard focus.
  function musicChanged(event) {
    if (typeof hooks.onMusicChanged === 'function') hooks.onMusicChanged(event && event.sender);
  }

  ipcMain.handle('aegis:music:list', () => {
    return { ok: true, ...musicLib.publicList(userDir) };
  });

  ipcMain.handle('aegis:music:add', async (event) => {
    const picked = await dialog.showOpenDialog({
      title: 'Add music',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Audio', extensions: musicLib.AUDIO_EXTS }],
    });
    if (picked.canceled || !picked.filePaths.length) {
      return { ok: true, added: 0, ...musicLib.publicList(userDir) };
    }
    const res = musicLib.add(userDir, picked.filePaths);
    if (res && res.ok) achievements.unlock('ACH_MOOD_MUSIC');
    musicChanged(event);
    return res;
  });

  ipcMain.handle('aegis:music:remove', (event, id) => {
    if (typeof id !== 'string') return fail('Invalid track id.');
    const res = musicLib.remove(userDir, id);
    musicChanged(event);
    return res;
  });

  ipcMain.handle('aegis:music:enabled', (event, on) => {
    const res = musicLib.setEnabled(userDir, on === true);
    musicChanged(event);
    return res;
  });

  ipcMain.handle('aegis:music:volume', (event, v) => {
    const res = musicLib.setVolume(userDir, Number(v));
    musicChanged(event);
    return res;
  });

  // ── Now playing (Windows media session; personal data, read-only + control) ─
  ipcMain.handle('aegis:media:state', () => {
    const state = typeof hooks.getMediaState === 'function' ? hooks.getMediaState() : { has: false };
    return { ok: true, media: state };
  });

  ipcMain.handle('aegis:media:control', (event, action) => {
    if (typeof hooks.mediaControl !== 'function') return fail('Media control is unavailable.');
    return hooks.mediaControl(String(action || ''));
  });

  // ── Per-app volume mixer (Windows Core Audio; personal data, desktop-only) ──
  // Reading state starts/activates the daemon (in main). A target id is a PID, or
  // "master"/"system"; an unknown id is a no-op in the daemon, so a made-up id
  // can't touch anything real. Volumes are clamped, mute is boolean.
  const AUDIO_ID = /^(master|system|\d{1,10})$/;

  ipcMain.handle('aegis:audio:state', () => {
    if (typeof hooks.getAudioState !== 'function') return { ok: false, master: null, sessions: [] };
    const state = hooks.getAudioState();
    return (state && typeof state === 'object') ? state : { ok: false, master: null, sessions: [] };
  });

  ipcMain.handle('aegis:audio:set', (event, payload) => {
    if (typeof hooks.audioSet !== 'function') return fail('The volume mixer is unavailable.');
    const req = (typeof payload === 'object' && payload !== null) ? payload : {};
    const id = typeof req.id === 'string' ? req.id : '';
    if (!AUDIO_ID.test(id)) return fail('Invalid audio target.');
    const patch = {};
    if (req.volume !== undefined && req.volume !== null) {
      patch.volume = Math.max(0, Math.min(100, Math.round(Number(req.volume)) || 0));
    }
    if (req.muted !== undefined && req.muted !== null) patch.muted = req.muted === true;
    if (patch.volume === undefined && patch.muted === undefined) return fail('Nothing to set.');
    hooks.audioSet(id, patch);
    return { ok: true };
  });

  // ── Active pack (what renders on the desktop) ────────────────────────────

  ipcMain.handle('aegis:active:get', () => {
    return { ok: true, id: settings.getActivePack(userDir) };
  });

  ipcMain.handle('aegis:active:set', (event, id) => {
    if (typeof id !== 'string') return fail('Invalid pack id.');
    const resolved = packs.resolvePackDir(appRoot, userDir, id);
    if (resolved.origin === 'missing') return fail(`No pack named "${id}".`);
    settings.setActivePack(userDir, id);
    achievements.unlock('ACH_FIRST_LIGHT');
    if (typeof hooks.onActivePack === 'function') hooks.onActivePack(id);
    return { ok: true, id };
  });

  // ── UI language (i18n) ───────────────────────────────────────────────────
  // Renderers fetch the active dictionary SYNCHRONOUSLY at load (via preload) so
  // there's no flash of untranslated text. The picker lists + sets the locale,
  // then the renderer reloads to apply. Fail-soft everywhere (English fallback).
  ipcMain.on('aegis:i18n:get', (event) => {
    event.returnValue = i18n.getActive(userDir, settings.getLocale(userDir), app.getLocale());
  });
  ipcMain.handle('aegis:i18n:list', () => {
    return {
      ok: true,
      current: i18n.getActive(userDir, settings.getLocale(userDir), app.getLocale()).lang,
      explicit: settings.getLocale(userDir),
      locales: i18n.listLocales(userDir).map((c) => ({ code: c, name: i18n.languageName(c) })),
    };
  });
  ipcMain.handle('aegis:i18n:set', (event, code) => {
    const saved = settings.setLocale(userDir, code == null ? null : String(code));
    // Return the freshly-resolved dictionary so the renderer can swap languages
    // LIVE (no page reload). The tray menu is rebuilt fresh on each right-click,
    // so it picks up the new language automatically.
    const active = i18n.getActive(userDir, saved, app.getLocale());
    return { ok: true, locale: saved, lang: active.lang, dict: active.dict, available: active.available };
  });

  // ── Engine settings: performance + auto-start ────────────────────────────
  // These are also on the tray's Performance submenu; the Settings tab is the
  // full-screen surface for the same prefs (plus start-with-Windows).

  ipcMain.handle('aegis:settings:performance:get', () => {
    return { ok: true, performance: settings.getPerformance(userDir), fpsChoices: settings.FPS_CHOICES };
  });

  ipcMain.handle('aegis:settings:performance:set', (event, patch) => {
    if (typeof patch !== 'object' || patch === null) return fail('Invalid request.');
    // Whitelist fields; settings.setPerformance re-validates types/ranges too.
    const clean = {};
    if (typeof patch.pauseOnFullscreen === 'boolean') clean.pauseOnFullscreen = patch.pauseOnFullscreen;
    if (typeof patch.pauseOnBattery === 'boolean') clean.pauseOnBattery = patch.pauseOnBattery;
    if (typeof patch.maxFps === 'number') clean.maxFps = patch.maxFps;
    const performance = settings.setPerformance(userDir, clean);
    if (typeof hooks.onPerformanceChanged === 'function') hooks.onPerformanceChanged();
    return { ok: true, performance };
  });

  ipcMain.handle('aegis:settings:backgroundMotion:get', () => {
    return { ok: true, backgroundMotion: settings.getBackgroundMotion(userDir) };
  });

  ipcMain.handle('aegis:settings:backgroundMotion:set', (event, patch) => {
    if (typeof patch !== 'object' || patch === null) return fail('Invalid request.');
    const clean = {};
    if (typeof patch.parallax === 'number') clean.parallax = patch.parallax;
    const backgroundMotion = settings.setBackgroundMotion(userDir, clean);
    if (typeof hooks.onBackgroundMotionChanged === 'function') hooks.onBackgroundMotionChanged(backgroundMotion);
    return { ok: true, backgroundMotion };
  });

  // Library detail-sidebar width (px), so the user's resize sticks across restarts.
  ipcMain.handle('aegis:settings:detailWidth:get', () => {
    return { ok: true, detailWidth: settings.getDetailWidth(userDir) };
  });
  ipcMain.handle('aegis:settings:detailWidth:set', (event, px) => {
    return { ok: true, detailWidth: settings.setDetailWidth(userDir, px) };
  });
  ipcMain.handle('aegis:settings:editorLayout:get', () => {
    return { ok: true, layout: settings.getEditorLayout(userDir) };
  });
  ipcMain.handle('aegis:settings:editorLayout:set', (event, layout) => {
    const clean = layout && typeof layout === 'object'
      ? { pal: Number(layout.pal) || undefined, insp: Number(layout.insp) || undefined }
      : {};
    return { ok: true, layout: settings.setEditorLayout(userDir, clean) };
  });

  ipcMain.handle('aegis:settings:autostart:get', () => {
    const supported = typeof hooks.setAutoStart === 'function';
    const enabled = typeof hooks.getAutoStart === 'function' ? Boolean(hooks.getAutoStart()) : false;
    return { ok: true, enabled, supported };
  });

  ipcMain.handle('aegis:settings:autostart:set', (event, enabled) => {
    if (typeof hooks.setAutoStart !== 'function') return fail('Auto-start is unavailable on this platform.');
    return { ok: true, enabled: Boolean(hooks.setAutoStart(Boolean(enabled))) };
  });

  ipcMain.handle('aegis:settings:onboarded:get', () => {
    return { ok: true, onboarded: settings.getOnboarded(userDir) };
  });

  // The user's default weather location — used by any pack whose weather
  // component has no location of its own.
  ipcMain.handle('aegis:settings:weather:get', () => {
    return { ok: true, location: settings.getWeatherLocation(userDir) };
  });

  // Set by city name (geocoded via Open-Meteo, keyless) or null to clear.
  ipcMain.handle('aegis:settings:weather:set', async (event, payload) => {
    if (payload === null) { settings.setWeatherLocation(userDir, null); return { ok: true, location: null }; }
    if (typeof payload !== 'object') return fail('Invalid request.');
    const query = String(payload.query || '').trim().slice(0, 80);
    if (!query) return fail('Type a city or place name.');
    try {
      const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(query)}&count=1&language=en&format=json`;
      const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
      if (!res.ok) return fail(`Location lookup returned HTTP ${res.status}.`);
      const data = await res.json();
      const hit = data && Array.isArray(data.results) && data.results[0];
      if (!hit || typeof hit.latitude !== 'number' || typeof hit.longitude !== 'number') {
        return fail(`No place found for “${query}”. Try a bigger nearby city.`);
      }
      const place = [hit.name, hit.admin1, hit.country_code].filter(Boolean).join(', ').slice(0, 60);
      const location = settings.setWeatherLocation(userDir, { lat: hit.latitude, lon: hit.longitude, place });
      if (typeof hooks.onWeatherLocationChanged === 'function') hooks.onWeatherLocationChanged();
      return { ok: true, location };
    } catch (err) {
      return fail(`Location lookup failed (${err.message}).`);
    }
  });

  // Speak system-health alerts via the assistant voice.
  ipcMain.handle('aegis:settings:healthvoice:get', () => {
    return { ok: true, enabled: settings.getHealthVoiceAlerts(userDir) };
  });
  ipcMain.handle('aegis:settings:healthvoice:set', (event, enabled) => {
    return { ok: true, enabled: settings.setHealthVoiceAlerts(userDir, Boolean(enabled)) };
  });

  // Geocode a city NAME to coordinates for a weather COMPONENT (no global side
  // effect — unlike settings:weather:set, this never changes the user's default
  // location). Lets the editor set a weather location by name instead of lat/lon.
  ipcMain.handle('aegis:weather:geocode', async (event, query) => {
    const q = String(query || '').trim().slice(0, 80);
    if (!q) return fail('Type a city or place name.');
    try {
      const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=1&language=en&format=json`;
      const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
      if (!res.ok) return fail(`Location lookup returned HTTP ${res.status}.`);
      const data = await res.json();
      const hit = data && Array.isArray(data.results) && data.results[0];
      if (!hit || typeof hit.latitude !== 'number' || typeof hit.longitude !== 'number') {
        return fail(`No place found for “${q}”. Try a bigger nearby city.`);
      }
      const place = [hit.name, hit.admin1, hit.country_code].filter(Boolean).join(', ').slice(0, 60);
      return { ok: true, lat: hit.latitude, lon: hit.longitude, place };
    } catch (err) {
      return fail(`Location lookup failed (${err.message}).`);
    }
  });

  // Open the full authoring guide (PACKS.md) in the user's default handler.
  // Ships with the app (appRoot), so it works installed and in dev.
  ipcMain.handle('aegis:guide:open', async () => {
    try {
      const err = await shell.openPath(path.join(appRoot, 'PACKS.md'));
      // A machine with no .md handler returns a non-empty error string.
      if (err) return fail('No app is set to open .md files. The guide is PACKS.md in the app folder.');
      return { ok: true };
    } catch (err) {
      return fail(err.message);
    }
  });

  // Open the diagnostics/logs folder (engine.log + native crash dumps live near
  // it) so a user can find and share it when reporting a problem. Creates the
  // folder first so "open" never fails on a machine that hasn't logged yet.
  ipcMain.handle('aegis:logs:open', async () => {
    const dir = logger.logsDir(userDir);
    try {
      require('fs').mkdirSync(dir, { recursive: true });
      const err = await shell.openPath(dir);
      if (err) return fail(err);
      return { ok: true, dir };
    } catch (err) {
      return fail(err.message);
    }
  });

  ipcMain.handle('aegis:settings:onboarded:set', (event, value) => {
    return { ok: true, onboarded: settings.setOnboarded(userDir, value === true) };
  });

  // App version + the bundled third-party license notices (Settings → About).
  // Distributing these notices is a licence obligation for the bundled voices
  // (CC-BY / CC-BY-SA / MIT), fonts (OFL), and engines (MeloTTS/Piper/espeak-ng).
  // Read from the shipped THIRD-PARTY-NOTICES.md; fail-soft to a short pointer.
  ipcMain.handle('aegis:licenses:get', () => {
    let version = '';
    try { version = app.getVersion(); } catch { version = ''; }
    let text = '';
    try { text = fs.readFileSync(path.join(appRoot, 'THIRD-PARTY-NOTICES.md'), 'utf8'); }
    catch { text = 'Third-party notices file not found. See THIRD-PARTY-NOTICES.md in the application folder.'; }
    return { ok: true, version, text };
  });

  // Open the notices in the user's default handler (a fuller read than the box).
  ipcMain.handle('aegis:licenses:open', async () => {
    try {
      const err = await shell.openPath(path.join(appRoot, 'THIRD-PARTY-NOTICES.md'));
      if (err) return fail('No app is set to open .md files. The notices are THIRD-PARTY-NOTICES.md in the app folder.');
      return { ok: true };
    } catch (err) {
      return fail(err.message);
    }
  });

  ipcMain.handle('aegis:settings:display:get', () => {
    const info = typeof hooks.getDisplays === 'function' ? hooks.getDisplays() : { displays: [], selectedId: null };
    return { ok: true, ...info };
  });

  // id: an integer Electron display id to pin, or null to follow the primary.
  ipcMain.handle('aegis:settings:display:set', (event, id) => {
    if (id !== null && !Number.isInteger(id)) return fail('Invalid display.');
    settings.setDisplayId(userDir, id);
    if (typeof hooks.onDisplayChanged === 'function') hooks.onDisplayChanged();
    return { ok: true };
  });

  ipcMain.handle('aegis:registry:install', async (event, payload) => {
    if (typeof payload !== 'object' || payload === null) return fail('Invalid request.');
    const { url, id } = payload;
    if (typeof url !== 'string' || typeof id !== 'string') return fail('Invalid request.');
    return registry.installFromRegistry(appRoot, userDir, url, id);
  });

  ipcMain.handle('aegis:stats', () => {
    return { ok: true, ...statsSampler.sample() };
  });

  // The primary display's dimensions — the editor sizes its canvas to the
  // exact aspect ratio the desktop surface really renders at.
  ipcMain.handle('aegis:display', () => {
    const { screen } = require('electron');
    const bounds = screen.getPrimaryDisplay().bounds;
    return { ok: true, width: bounds.width, height: bounds.height };
  });

  // Weather via Open-Meteo (keyless, https). Cached per coordinate pair so a
  // desktop full of weather components costs one request per 10 minutes.
  const weatherCache = new Map();
  const WEATHER_CACHE_MS = 10 * 60 * 1000;
  const WEATHER_CODES = {
    0: 'clear sky', 1: 'mainly clear', 2: 'partly cloudy', 3: 'overcast',
    45: 'fog', 48: 'rime fog', 51: 'light drizzle', 53: 'drizzle', 55: 'heavy drizzle',
    61: 'light rain', 63: 'rain', 65: 'heavy rain', 66: 'freezing rain', 67: 'freezing rain',
    71: 'light snow', 73: 'snow', 75: 'heavy snow', 77: 'snow grains',
    80: 'light showers', 81: 'showers', 82: 'violent showers',
    85: 'snow showers', 86: 'snow showers', 95: 'thunderstorm', 96: 'thunderstorm', 99: 'thunderstorm',
  };

  ipcMain.handle('aegis:weather', async (event, payload) => {
    if (typeof payload !== 'object' || payload === null) return fail('Invalid request.');
    let lat = Number(payload.lat);
    let lon = Number(payload.lon);
    let place = null;
    // A component with no location of its own (unset or 0,0 "null island") falls
    // back to the user's default location from Settings — so a pack authored
    // elsewhere shows the buyer's weather, not a stranger's city.
    const unset = !Number.isFinite(lat) || !Number.isFinite(lon) || (lat === 0 && lon === 0);
    if (unset) {
      const loc = settings.getWeatherLocation(userDir);
      if (!loc) return { ok: false, needsLocation: true, error: 'Set your weather location in Settings.' };
      lat = loc.lat; lon = loc.lon; place = loc.place || null;
    }
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
      return fail('Invalid coordinates.');
    }
    const key = `${lat.toFixed(2)},${lon.toFixed(2)}`;
    const cached = weatherCache.get(key);
    if (cached && Date.now() - cached.at < WEATHER_CACHE_MS) return cached.value;

    try {
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}`
        + '&current=temperature_2m,weather_code,wind_speed_10m'
        + '&daily=temperature_2m_max,temperature_2m_min&forecast_days=1&timezone=auto';
      const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
      if (!res.ok) return fail(`Weather service returned HTTP ${res.status}.`);
      const data = await res.json();
      const current = data && data.current;
      if (!current || typeof current.temperature_2m !== 'number') return fail('Weather service returned no data.');
      const dailyNum = (field) => (data.daily && Array.isArray(data.daily[field]) && typeof data.daily[field][0] === 'number'
        ? data.daily[field][0] : null);
      const value = {
        ok: true,
        tempC: current.temperature_2m,
        windKmh: typeof current.wind_speed_10m === 'number' ? current.wind_speed_10m : 0,
        description: WEATHER_CODES[current.weather_code] || 'unknown',
        code: typeof current.weather_code === 'number' ? current.weather_code : null,
        hiC: dailyNum('temperature_2m_max'),
        loC: dailyNum('temperature_2m_min'),
      };
      // Cache the resolved location NAME alongside the weather. Otherwise the
      // name is only attached on the FIRST (cache-miss) fetch's return, and every
      // later cache hit drops it — including the frequent desktop re-renders that
      // rebuild the component from scratch (its label restarts at "Weather" and
      // never gets the city back). Caching place fixes the "shows Weather, not my
      // city" bug for both the full and compact weather layouts.
      if (place) value.place = place;
      weatherCache.set(key, { at: Date.now(), value });
      return value;
    } catch (err) {
      return fail(`Weather unavailable (${err.message}).`);
    }
  });

  ipcMain.handle('aegis:open-panel', () => {
    if (typeof hooks.openPanel === 'function') {
      hooks.openPanel();
      return { ok: true };
    }
    return fail('The tuning panel is unavailable in this session.');
  });

  ipcMain.handle('aegis:open-manager', () => {
    if (typeof hooks.openManager === 'function') {
      hooks.openManager('assistant');
      return { ok: true };
    }
    return fail('The manager is unavailable in this session.');
  });

  ipcMain.handle('aegis:test:fallback', async (event, payload) => {
    if (typeof payload !== 'object' || payload === null) return fail('Invalid request.');
    const text = typeof payload.text === 'string' ? payload.text.trim().slice(0, fallback.MAX_FALLBACK_CHARS) : '';
    if (text === '') return fail('Type some test text first.');
    const hint = typeof payload.voiceHint === 'string' ? payload.voiceHint : '';
    try {
      await fallback.speakWithSystemVoice(appRoot, text, hint);
      return { ok: true };
    } catch (err) {
      return fail(err.message);
    }
  });
}

module.exports = { registerIpcHandlers, MAX_TEST_TEXT_CHARS, prewarmVoice, prewarmAssistantVoice, warmupAssistant };
