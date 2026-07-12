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
const { ipcMain, dialog } = require('electron');
const { spawn } = require('child_process');

const piper = require('./piper');
const dsp = require('./dsp');
const analyze = require('./analyze');
const bank = require('./voicebank');
const presets = require('./presets');
const profiles = require('./profiles');
const fallback = require('./tts-fallback');
const packs = require('./packs');
const packstore = require('./packstore');
const registry = require('./registry');
const settings = require('./settings');
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

// ── Handlers ────────────────────────────────────────────────────────────────

function registerIpcHandlers(appRoot, userDir, hooks = {}) {
  let synthesisBusy = false;
  const downloadsInFlight = new Set();
  const statsSampler = stats.createSampler();

  // One pack watcher per dashboard webContents, replaced on every pack load —
  // this is the DIY hot-reload: edit pack.json, the dashboard repaints.
  const packWatchers = new Map();

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
    } catch {
      return; // pack directory vanished — the next load will report it
    }
    packWatchers.set(sender.id, { watcher, timer: null });
    sender.once('destroyed', () => {
      const entry = packWatchers.get(sender.id);
      if (entry) {
        entry.watcher.close();
        clearTimeout(entry.timer);
        packWatchers.delete(sender.id);
      }
    });
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
        descriptor: v.descriptor,
        licence: v.licence,
        attribution: v.attribution,
        sizeBytes: v.sizeBytes,
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
    try {
      await bank.downloadVoice(appRoot, voice, (received, total) => {
        const pct = total > 0 ? Math.floor((received / total) * 100) : 0;
        if (pct === lastPct || event.sender.isDestroyed()) return;
        lastPct = pct;
        event.sender.send('aegis:bank:progress', { id: voice.id, received, total, pct });
      });
      return { ok: true };
    } catch (err) {
      return fail(err.message);
    } finally {
      downloadsInFlight.delete(voice.id);
    }
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
      if (!env.piper) {
        return { ...fail('Piper is not installed, so the tuned voice cannot be rendered. You can still hear the text with the system voice.'), canFallback: true };
      }

      const modelPath = bank.modelPathFor(appRoot, voice);
      const baselineWpm = voice.wpmAtScale1 || undefined;
      const { pcm: dryPcm, sampleRate } = await piper.synthesize(text, profile, modelPath, piper.findPiper(appRoot), { baselineWpm });

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

  ipcMain.handle('aegis:packs:load', (event, id) => {
    if (typeof id !== 'string') return fail('Invalid pack id.');
    const loaded = packs.loadPack(appRoot, userDir, id);
    const collected = packs.collectAssets(loaded.dir, loaded.pack);
    resetPackWatcher(event.sender, loaded.pack.id, loaded.dir);
    return {
      ok: true,
      pack: loaded.pack,
      origin: loaded.origin,
      assets: collected.assets,
      warnings: [...loaded.warnings, ...collected.warnings],
    };
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
      filters: [{ name: 'Persona packs', extensions: ['aegispack', 'zip'] }],
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
      defaultPath: `${id}.aegispack`,
      filters: [{ name: 'Persona packs', extensions: ['aegispack'] }],
    });
    if (picked.canceled || !picked.filePath) return { ok: false, error: null };
    try {
      fs.writeFileSync(picked.filePath, exported.buffer);
      return { ok: true, file: picked.filePath };
    } catch (err) {
      return fail(`Could not write the file: ${err.message}`);
    }
  });

  ipcMain.handle('aegis:packs:uninstall', (event, id) => {
    if (typeof id !== 'string') return fail('Invalid pack id.');
    return packstore.uninstall(userDir, id);
  });

  ipcMain.handle('aegis:registry:add', (event, url) => registry.addRegistry(userDir, url));
  ipcMain.handle('aegis:registry:remove', (event, url) => registry.removeRegistry(userDir, String(url)));

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
    hooks.openEditor(typeof id === 'string' ? id : 'aegis-holo');
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

  ipcMain.handle('aegis:editor:save', (event, payload) => {
    if (typeof payload !== 'object' || payload === null) return fail('Invalid request.');
    const { baseId, pack } = payload;
    if (typeof baseId !== 'string') return fail('Invalid base pack id.');
    return packstore.saveEdited(appRoot, userDir, baseId, pack, Object.fromEntries(stagedAssets));
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

  ipcMain.handle('aegis:registry:install', async (event, payload) => {
    if (typeof payload !== 'object' || payload === null) return fail('Invalid request.');
    const { url, id } = payload;
    if (typeof url !== 'string' || typeof id !== 'string') return fail('Invalid request.');
    return registry.installFromRegistry(appRoot, userDir, url, id);
  });

  ipcMain.handle('aegis:stats', () => {
    return { ok: true, ...statsSampler.sample() };
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
    const lat = Number(payload.lat);
    const lon = Number(payload.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
      return fail('Invalid coordinates.');
    }
    const key = `${lat.toFixed(2)},${lon.toFixed(2)}`;
    const cached = weatherCache.get(key);
    if (cached && Date.now() - cached.at < WEATHER_CACHE_MS) return cached.value;

    try {
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}&current=temperature_2m,weather_code,wind_speed_10m`;
      const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
      if (!res.ok) return fail(`Weather service returned HTTP ${res.status}.`);
      const data = await res.json();
      const current = data && data.current;
      if (!current || typeof current.temperature_2m !== 'number') return fail('Weather service returned no data.');
      const value = {
        ok: true,
        tempC: current.temperature_2m,
        windKmh: typeof current.wind_speed_10m === 'number' ? current.wind_speed_10m : 0,
        description: WEATHER_CODES[current.weather_code] || 'unknown',
      };
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
