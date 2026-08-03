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
const launcher = require('./launcher');
const assistant = require('./assistant');
const musicLib = require('./music');
const reminders = require('./reminders');
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
function synthClip(appRoot, voice, text, profile) {
  const baselineWpm = voice.wpmAtScale1 || undefined;
  if (bank.engineOf(voice) === 'melotts') {
    return melotts.synthesize(text, profile, bank.resolveModelDir(appRoot, voice), melotts.findEngine(appRoot, voice.engineId), {
      baselineWpm,
      sid: Number.isInteger(voice.sid) ? voice.sid : 0,
      lang: voice.meloLang,
    });
  }
  return piper.synthesize(text, profile, bank.modelPathFor(appRoot, voice), piper.findPiper(appRoot), { baselineWpm });
}

// ── Handlers ────────────────────────────────────────────────────────────────

function registerIpcHandlers(appRoot, userDir, hooks = {}) {
  let synthesisBusy = false;
  const downloadsInFlight = new Set();
  const statsSampler = stats.createSampler();

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
    if (downloadsInFlight.has(voice.id)) return fail('That voice is already downloading.');

    downloadsInFlight.add(voice.id);
    let lastPct = -1;
    const report = (received, total, phase) => {
      const pct = total > 0 ? Math.floor((received / total) * 100) : 0;
      if (pct === lastPct || event.sender.isDestroyed()) return;
      lastPct = pct;
      event.sender.send('aegis:bank:progress', { id: voice.id, received, total, pct, phase });
    };
    try {
      // MeloTTS ("HD") voices need the engine binary in place too. Fetch it
      // first if missing; without a configured download it's a clear message,
      // not a crash.
      if (bank.engineOf(voice) === 'melotts' && !melotts.isEngineInstalled(appRoot, voice.engineId)) {
        const spec = manifest.engines && manifest.engines[voice.engineId];
        if (!spec) {
          return fail('The HD voice engine is not installed and no download is configured yet.');
        }
        await bank.downloadEngine(voice.engineId, spec, (r, t) => report(r, t, 'engine'));
        lastPct = -1;
      }
      await bank.downloadVoice(appRoot, voice, (r, t) => report(r, t, 'voice'));
      return { ok: true };
    } catch (err) {
      return fail(err.message);
    } finally {
      downloadsInFlight.delete(voice.id);
    }
  });

  // Pre-warm the HD engine for a voice so the first real clip isn't a cold-start
  // wait (~model load). Fire-and-forget: it returns immediately and the warm-up
  // synth runs in the background, so the UI can call it the moment a voice is
  // picked. Fail-soft — a missing engine/model just does nothing.
  const PREWARM_TEXT = { EN: 'Hello.', ES: 'Hola.', FR: 'Bonjour.', ZH: '你好。', JP: 'こんにちは。', KR: '안녕하세요。' };
  ipcMain.handle('aegis:voice:prewarm', (event, voiceId) => {
    try {
      if (typeof voiceId !== 'string') return { ok: false };
      const manifest = bank.loadManifest(appRoot);
      const voice = bank.voiceById(manifest, voiceId);
      if (!voice || bank.engineOf(voice) !== 'melotts') return { ok: false };
      if (!bank.isInstalled(appRoot, voice) || !melotts.isEngineInstalled(appRoot, voice.engineId)) return { ok: false };
      melotts.prewarm(
        PREWARM_TEXT[voice.meloLang] || 'Hello.',
        bank.resolveModelDir(appRoot, voice),
        melotts.findEngine(appRoot, voice.engineId),
        { lang: voice.meloLang, sid: Number.isInteger(voice.sid) ? voice.sid : 0 },
      );
      return { ok: true };
    } catch { return { ok: false }; }
  });

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
      return { file, name: profile.name, voice: profile.base.voice };
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
    try {
      profiles.saveProfile(path.join(profilesDir(appRoot), file), clean);
      return { ok: true, file, profile: clean };
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

  ipcMain.handle('aegis:packs:list', () => {
    const listed = packs.listPacks(appRoot, userDir);
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
      assets: { ...collected.assets, ...video.urls },
      warnings: [...loaded.warnings, ...collected.warnings, ...video.warnings],
    };
  });

  // ── User properties: the pack's declared knobs + the user's chosen values ──

  ipcMain.handle('aegis:userprops:get', (event, id) => {
    if (typeof id !== 'string') return fail('Invalid pack id.');
    const loaded = packs.loadPack(appRoot, userDir, id);
    const overrides = userprops.getOverrides(userDir, loaded.pack.id);
    const props = loaded.pack.props || [];
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
    return packstore.installFromBuffer(appRoot, userDir, buffer, { source: 'file' });
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

  ipcMain.handle('aegis:workshop:publish', async (event, req) => {
    if (typeof req !== 'object' || req === null) return fail('Invalid publish request.');
    if (typeof req.packId !== 'string') return fail('Invalid pack id.');
    // Render a real preview image of the dashboard (demo data only, no personal
    // info); publish falls back to the wallpaper if this fails.
    let previewPath = null;
    if (typeof hooks.renderPreview === 'function') {
      try { previewPath = await hooks.renderPreview(req.packId); } catch (err) { previewPath = null; }
    }
    try {
      return await workshop.publish(appRoot, userDir, {
        packId: req.packId,
        title: typeof req.title === 'string' ? req.title : '',
        description: typeof req.description === 'string' ? req.description : '',
        tags: Array.isArray(req.tags) ? req.tags : [],
        visibility: typeof req.visibility === 'string' ? req.visibility : 'unlisted',
        previewPath,
      });
    } finally {
      if (previewPath) { try { fs.rmSync(previewPath, { force: true }); } catch (err) { /* temp file */ } }
    }
  });

  ipcMain.handle('aegis:workshop:subscribed', () => workshop.listSubscribed());

  ipcMain.handle('aegis:workshop:import', (event, itemId) => {
    if (typeof itemId !== 'string') return fail('Invalid item id.');
    return workshop.importSubscribed(appRoot, userDir, itemId);
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
    const result = packstore.createPack(appRoot, userDir, rawPack, extras);
    if (result.ok) {
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
    if (result.ok && typeof hooks.onPackSaved === 'function') hooks.onPackSaved(result.id);
    return result;
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
    if (result.ok) launcherChanged();
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
    if (result.ok) launcherChanged();
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

  // ── AI assistant (BYO key; key stays encrypted in main) ──────────────────
  // The renderer never sees the API key — config:get returns hasKey only.
  // Conversation state lives here so the desktop console and its input share
  // one thread. Replies can be spoken through the tuned voice pipeline.
  // Restore the saved transcript so the desktop chat has history across restarts.
  let assistantThread = assistant.loadThread(userDir); // [{ role:'user'|'assistant', content }]
  const ASSISTANT_MAX_TURNS = 20;
  const ASSISTANT_MAX_PROMPT = 2000;
  const ASSISTANT_MAX_SPEAK = 1200;

  ipcMain.handle('aegis:assistant:config:get', () => {
    return { ok: true, config: assistant.getPublicConfig(userDir) };
  });

  ipcMain.handle('aegis:assistant:config:set', (event, patch) => {
    if (typeof patch !== 'object' || patch === null) return fail('Invalid request.');
    return assistant.saveConfig(userDir, patch);
  });

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

  // The rendered transcript (for the desktop chat panel to restore its history).
  ipcMain.handle('aegis:assistant:history', () => {
    return { ok: true, thread: assistantThread };
  });

  ipcMain.handle('aegis:assistant:reset', () => {
    assistantThread = [];
    assistant.clearThread(userDir);
    return { ok: true };
  });

  ipcMain.handle('aegis:assistant:ask', async (event, prompt) => {
    const text = typeof prompt === 'string' ? prompt.trim().slice(0, ASSISTANT_MAX_PROMPT) : '';
    if (text === '') return fail('Ask me something first.');
    assistantThread.push({ role: 'user', content: text });
    // Trim to the last N turns so context (and cost) stay bounded.
    if (assistantThread.length > ASSISTANT_MAX_TURNS) {
      assistantThread = assistantThread.slice(-ASSISTANT_MAX_TURNS);
    }
    const res = await assistant.ask(userDir, assistantThread);
    if (!res.ok) {
      assistantThread.pop(); // don't keep a user turn that got no reply
      return res;
    }
    assistantThread.push({ role: 'assistant', content: res.text });
    assistant.saveThread(userDir, assistantThread); // persist so history survives a restart
    return { ok: true, text: res.text };
  });

  // Synthesize an assistant reply with its chosen voice profile (or the
  // default), reusing the tuning pipeline. Best-effort: a missing voice or
  // Piper degrades to silence, never an error dialog.
  ipcMain.handle('aegis:assistant:speak', async (event, text) => {
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
        voice = manifest.voices.find((v) => bank.isInstalled(appRoot, v)) || null;
        if (voice) profile = { ...profile, base: { ...profile.base, voice: voice.id } };
      }
      const env = await checkEnv(appRoot);
      if (!voice || !voiceEngineReady(appRoot, voice, env)) {
        return fail('voice-unavailable'); // caller stays silent, shows text only
      }
      const ffmpegPath = env.ffmpeg ? dsp.findFfmpeg() : null;

      // Process each sentence-sized clip separately so long replies keep a
      // consistent, undistorted voice (see splitForSpeech). A short reply is a
      // single clip — identical to the old path, no regression.
      const clips = splitForSpeech(clean);
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

  // ── Active pack (what renders on the desktop) ────────────────────────────

  ipcMain.handle('aegis:active:get', () => {
    return { ok: true, id: settings.getActivePack(userDir) };
  });

  ipcMain.handle('aegis:active:set', (event, id) => {
    if (typeof id !== 'string') return fail('Invalid pack id.');
    const resolved = packs.resolvePackDir(appRoot, userDir, id);
    if (resolved.origin === 'missing') return fail(`No pack named "${id}".`);
    settings.setActivePack(userDir, id);
    if (typeof hooks.onActivePack === 'function') hooks.onActivePack(id);
    return { ok: true, id };
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
      weatherCache.set(key, { at: Date.now(), value });
      // place (the user location's name) rides on top of the cached weather.
      return place ? { ...value, place } : value;
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

module.exports = { registerIpcHandlers, MAX_TEST_TEXT_CHARS };
