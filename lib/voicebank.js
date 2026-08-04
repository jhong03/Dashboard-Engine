'use strict';

// Voice bank: manifest loading, licence audit, and the model downloader.
//
// The manifest (voices/voices.json) is treated as untrusted input even though
// we author it today — one day a persona pack will carry its own. Every entry
// is validated before use; anything malformed is dropped with a warning, and
// the app keeps running (fail soft, per CLAUDE.md).
//
// Downloads are integrity-checked: the manifest pins sha256 + size from the
// Hugging Face LFS metadata, and a model that doesn't match is deleted, not
// installed.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { userDataDir } = require('./paths');

// Only this host may serve models. A manifest pointing anywhere else is
// refused — it keeps a tampered pack from making the app fetch arbitrary
// binaries.
const ALLOWED_DOWNLOAD_HOST = 'huggingface.co';

const ID_PATTERN = /^[a-z0-9_]{1,64}$/;
// Plain filename, no separators — prevents a manifest from writing outside
// the voices directory.
const MODEL_PATTERN = /^[A-Za-z0-9._-]+\.onnx$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
// MeloTTS ("HD") voices are a directory of files (a MeloTTS checkpoint + config,
// plus a bert/ subdirectory), not a single file. A file name is a plain filename,
// optionally inside the single "bert/" subdir — never a path that could escape
// the model directory.
const MELO_FILE_PATTERN = /^(?:bert\/)?[A-Za-z0-9._-]+$/;
const MODEL_DIR_PATTERN = /^[a-z0-9_]{1,64}$/;
// The files a MeloTTS pack always needs (VITS checkpoint + config, and the
// sentence-BERT's config; the remaining bert/ files are listed per voice).
const MELO_REQUIRED_FILES = ['checkpoint.pth', 'config.json', 'bert/config.json'];

// A voice renders through Piper unless it explicitly opts into the MeloTTS
// engine. Keeping the default implicit means every existing entry is unchanged.
function engineOf(voice) {
  return voice && voice.engine === 'melotts' ? 'melotts' : 'piper';
}

// The manifest ships WITH the app (read-only, possibly inside a per-machine
// install dir), so it's read from appRoot.
function manifestPath(appRoot) {
  return path.join(appRoot, 'voices', 'voices.json');
}

// Downloaded models live in WRITABLE user data — NOT the install dir, which may
// be read-only (per-machine install) and is replaced on every app update
// (which would silently wipe the models). The appRoot arg is ignored; kept so
// every existing caller stays unchanged.
function voicesDir() {
  return path.join(userDataDir(), 'voices');
}

// One-time migration: models the OWNER downloaded into the old in-repo/in-app
// voices/ dir are copied to the new user-data location so they aren't
// re-downloaded. Best-effort; failures just mean a re-download later.
function migrateModelsFromAppRoot(appRoot) {
  try {
    const oldDir = path.join(appRoot, 'voices');
    const newDir = voicesDir();
    if (path.resolve(oldDir) === path.resolve(newDir) || !fs.existsSync(oldDir)) return;
    fs.mkdirSync(newDir, { recursive: true });
    for (const name of fs.readdirSync(oldDir)) {
      if (!/\.onnx(\.json)?$/i.test(name)) continue; // models + their configs only
      const dest = path.join(newDir, name);
      if (!fs.existsSync(dest)) fs.copyFileSync(path.join(oldDir, name), dest);
    }
  } catch (err) { /* best-effort */ }
}

function isSafeDownloadUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === ALLOWED_DOWNLOAD_HOST;
  } catch {
    return false;
  }
}

// Validate one manifest entry. Returns null (with a reason pushed to
// warnings) rather than throwing, so one bad entry can't take out the bank.
function validateVoice(raw, warnings) {
  const where = raw && typeof raw.id === 'string' ? `voice "${raw.id}"` : 'a voice entry';
  if (typeof raw !== 'object' || raw === null) {
    warnings.push('Dropped a non-object voice entry from the manifest.');
    return null;
  }
  if (raw.engine === 'melotts') return validateMeloVoice(raw, where, warnings);
  const checks = [
    [typeof raw.id === 'string' && ID_PATTERN.test(raw.id), 'invalid id'],
    [typeof raw.model === 'string' && MODEL_PATTERN.test(raw.model), 'invalid model filename'],
    [typeof raw.displayName === 'string' && raw.displayName.length <= 80, 'invalid displayName'],
    [isSafeDownloadUrl(raw.downloadUrl), `download URL must be https on ${ALLOWED_DOWNLOAD_HOST}`],
    [isSafeDownloadUrl(raw.configUrl), `config URL must be https on ${ALLOWED_DOWNLOAD_HOST}`],
    [typeof raw.sha256 === 'string' && SHA256_PATTERN.test(raw.sha256), 'missing/invalid sha256'],
    [Number.isInteger(raw.sizeBytes) && raw.sizeBytes > 0, 'missing/invalid sizeBytes'],
  ];
  for (const [ok, reason] of checks) {
    if (!ok) {
      warnings.push(`Dropped ${where}: ${reason}.`);
      return null;
    }
  }
  // Optional speaker index for multi-speaker Piper models (e.g. VCTK). Must be a
  // non-negative integer; absent means a single-speaker model.
  if (raw.speaker !== undefined && !(Number.isInteger(raw.speaker) && raw.speaker >= 0)) {
    warnings.push(`Dropped ${where}: invalid speaker index.`);
    return null;
  }
  return raw;
}

// A MeloTTS voice is a directory of pinned files rather than one .onnx + config.
// Every file is size + sha256 pinned exactly like a Piper model, and the model
// directory name is a plain slug so nothing can be written outside voices/.
const MELO_LANGS = ['EN', 'ES', 'FR', 'ZH', 'JP', 'KR'];

function validateMeloVoice(raw, where, warnings) {
  const baseChecks = [
    [typeof raw.id === 'string' && ID_PATTERN.test(raw.id), 'invalid id'],
    [typeof raw.displayName === 'string' && raw.displayName.length <= 80, 'invalid displayName'],
    [typeof raw.modelDir === 'string' && MODEL_DIR_PATTERN.test(raw.modelDir), 'invalid modelDir'],
    [typeof raw.engineId === 'string' && ID_PATTERN.test(raw.engineId), 'invalid engineId'],
    [typeof raw.meloLang === 'string' && MELO_LANGS.includes(raw.meloLang), 'invalid meloLang'],
    [Array.isArray(raw.files) && raw.files.length > 0, 'missing files list'],
  ];
  for (const [ok, reason] of baseChecks) {
    if (!ok) { warnings.push(`Dropped ${where}: ${reason}.`); return null; }
  }
  for (const f of raw.files) {
    const ok = f && typeof f === 'object'
      && typeof f.name === 'string' && MELO_FILE_PATTERN.test(f.name)
      && isSafeDownloadUrl(f.url)
      && typeof f.sha256 === 'string' && SHA256_PATTERN.test(f.sha256)
      && Number.isInteger(f.sizeBytes) && f.sizeBytes > 0;
    if (!ok) { warnings.push(`Dropped ${where}: an invalid file entry.`); return null; }
  }
  const names = new Set(raw.files.map((f) => f.name));
  if (!MELO_REQUIRED_FILES.every((n) => names.has(n))) {
    warnings.push(`Dropped ${where}: a MeloTTS voice needs ${MELO_REQUIRED_FILES.join(', ')}.`);
    return null;
  }
  return raw;
}

/**
 * Load and validate the manifest. Never throws.
 * @returns {{ defaultVoice: string|null, voices: object[], excluded: object[], warnings: string[] }}
 */
function loadManifest(appRoot) {
  const warnings = [];
  let raw = null;
  try {
    raw = JSON.parse(fs.readFileSync(manifestPath(appRoot), 'utf8'));
  } catch (err) {
    warnings.push(`Voice manifest is unreadable (${err.message}). The voice bank is empty; synthesis will fall back to the system voice.`);
    return { defaultVoice: null, voices: [], excluded: [], warnings };
  }

  const voices = (Array.isArray(raw.voices) ? raw.voices : [])
    .map((v) => validateVoice(v, warnings))
    .filter(Boolean);

  let defaultVoice = typeof raw.defaultVoice === 'string' ? raw.defaultVoice : null;
  if (defaultVoice && !voices.some((v) => v.id === defaultVoice)) {
    warnings.push(`Default voice "${defaultVoice}" is not in the bank; using the first voice instead.`);
    defaultVoice = null;
  }
  if (!defaultVoice && voices.length > 0) defaultVoice = voices[0].id;

  return {
    defaultVoice,
    voices,
    engines: sanitizeEngines(raw.engines, warnings),
    excluded: Array.isArray(raw.excluded) ? raw.excluded : [],
    warnings,
  };
}

// Engine specs describe a downloadable synthesis binary (e.g. the MeloTTS
// sidecar). Same integrity discipline as a voice: https on the allowed host,
// pinned sha256 + size, a plain filename that can't escape the engine dir.
const ENGINE_EXE_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

function sanitizeEngines(raw, warnings) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [name, spec] of Object.entries(raw)) {
    if (!ID_PATTERN.test(name)) { warnings.push(`Dropped engine "${name}": invalid name.`); continue; }
    const ok = spec && typeof spec === 'object'
      && typeof spec.exe === 'string' && ENGINE_EXE_PATTERN.test(spec.exe)
      && isSafeDownloadUrl(spec.url)
      && typeof spec.sha256 === 'string' && SHA256_PATTERN.test(spec.sha256)
      && Number.isInteger(spec.sizeBytes) && spec.sizeBytes > 0;
    if (!ok) { warnings.push(`Dropped engine "${name}": incomplete/invalid spec.`); continue; }
    // `archive: "zip"` means the URL is a zip of a PyInstaller --onedir bundle
    // (many files, no per-spawn self-extraction); it is downloaded then unpacked
    // to the engine dir. Anything else must be a single-file (onefile) engine.
    if (spec.archive !== undefined && spec.archive !== 'zip') {
      warnings.push(`Dropped engine "${name}": unknown archive "${spec.archive}".`);
      continue;
    }
    out[name] = { exe: spec.exe, url: spec.url, sha256: spec.sha256, sizeBytes: spec.sizeBytes };
    if (spec.archive === 'zip') out[name].archive = 'zip';
  }
  return out;
}

function voiceById(bank, id) {
  return bank.voices.find((v) => v.id === id) || null;
}

function modelPathFor(appRoot, voice) {
  return path.join(voicesDir(appRoot), voice.model);
}

function configPathFor(appRoot, voice) {
  return path.join(voicesDir(appRoot), `${voice.model}.json`);
}

// MeloTTS voices install into their own directory under voices/. This is the
// WRITABLE download destination (user-data), never the app dir.
function modelDirFor(appRoot, voice) {
  return path.join(voicesDir(appRoot), voice.modelDir);
}

// A MeloTTS model can also be BUNDLED with the app (read-only, e.g. English HD
// shipped in the Steam depot at appRoot/voices/<modelDir>/) instead of
// downloaded. This is that read-only bundled location; null if we have no root.
function bundledModelDirFor(appRoot, voice) {
  return appRoot ? path.join(appRoot, 'voices', voice.modelDir) : null;
}

// A pack is "present" in a dir when its required files are all there. Cheap
// check (3 files) matching lib/melotts.isModelInstalled, used to pick between
// the downloaded copy and a bundled one.
function meloModelPresentIn(dir) {
  return !!dir && MELO_REQUIRED_FILES.every((n) => fs.existsSync(path.join(dir, n)));
}

// Where this voice's model actually is FOR READING/synthesis: prefer the
// downloaded copy in user-data, else a copy bundled with the app. Falls back to
// the (writable) user-data path when neither exists, so callers then correctly
// report "not installed". Piper voices don't use this — MeloTTS only.
function resolveModelDir(appRoot, voice) {
  const userDir = modelDirFor(appRoot, voice);
  if (meloModelPresentIn(userDir)) return userDir;
  const appDir = bundledModelDirFor(appRoot, voice);
  if (meloModelPresentIn(appDir)) return appDir;
  return userDir;
}

function isInstalled(appRoot, voice) {
  if (engineOf(voice) === 'melotts') {
    // Installed if the full pinned file set is present in EITHER the downloaded
    // dir or a bundled one (a depot-shipped voice needs no download).
    const dir = resolveModelDir(appRoot, voice);
    return voice.files.every((f) => fs.existsSync(path.join(dir, f.name)));
  }
  return fs.existsSync(modelPathFor(appRoot, voice)) && fs.existsSync(configPathFor(appRoot, voice));
}

// Licence problems the app must surface on startup — a voice with no
// verified licence is never silently shipped (see voices.json).
function auditWarnings(bank) {
  const warnings = [];
  for (const voice of bank.voices) {
    if (typeof voice.licence !== 'string' || voice.licence.trim() === '' || /unverified/i.test(voice.licence)) {
      warnings.push(`Voice "${voice.id}" has no verified licence — it must not ship until audited.`);
    }
  }
  return warnings;
}

function sha256OfFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(filePath)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')))
      .on('error', reject);
  });
}

// Stream an HTTPS response to disk, hashing as we go. Atomic: writes to
// .tmp and renames only after size + sha256 both match the manifest.
async function downloadToFile(url, destPath, expected, onProgress) {
  const res = await fetch(url);
  if (!res.ok || !res.body) {
    throw new Error(`Download failed (HTTP ${res.status}) for ${path.basename(destPath)}.`);
  }

  const tmpPath = `${destPath}.tmp`;
  const out = fs.createWriteStream(tmpPath);
  const hash = crypto.createHash('sha256');
  let received = 0;

  try {
    for await (const chunk of res.body) {
      hash.update(chunk);
      received += chunk.length;
      if (onProgress) onProgress(received, expected.sizeBytes || 0);
      // Respect backpressure so a fast connection can't balloon memory.
      if (!out.write(chunk)) {
        await new Promise((resolve) => out.once('drain', resolve));
      }
    }
    await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));

    if (expected.sizeBytes && received !== expected.sizeBytes) {
      throw new Error(`Download of ${path.basename(destPath)} is ${received} bytes, expected ${expected.sizeBytes} — connection may have been cut. Try again.`);
    }
    if (expected.sha256) {
      const digest = hash.digest('hex');
      if (digest !== expected.sha256) {
        throw new Error(`Checksum mismatch for ${path.basename(destPath)} — the file is corrupt or was tampered with. It was NOT installed.`);
      }
    }
    fs.renameSync(tmpPath, destPath);
  } catch (err) {
    out.destroy();
    fs.rmSync(tmpPath, { force: true });
    throw err;
  }
}

/**
 * Download a voice's model + config into voices/. Resolves when both are
 * installed and verified. onProgress(receivedBytes, totalBytes) fires for the
 * model file only (the config is ~5 KB).
 */
async function downloadVoice(appRoot, voice, onProgress) {
  if (engineOf(voice) === 'melotts') return downloadMeloVoice(appRoot, voice, onProgress);

  fs.mkdirSync(voicesDir(appRoot), { recursive: true });

  // Config first: it's tiny, and a model without its config is unusable.
  // Piper configs are JSON; parse to reject an HTML error page early.
  await downloadToFile(voice.configUrl, configPathFor(appRoot, voice), {});
  try {
    JSON.parse(fs.readFileSync(configPathFor(appRoot, voice), 'utf8'));
  } catch {
    fs.rmSync(configPathFor(appRoot, voice), { force: true });
    throw new Error(`Config for "${voice.id}" was not valid JSON — download may have been intercepted. It was NOT installed.`);
  }

  await downloadToFile(voice.downloadUrl, modelPathFor(appRoot, voice), {
    sha256: voice.sha256,
    sizeBytes: voice.sizeBytes,
  }, onProgress);
}

// Download every pinned file of a MeloTTS voice into its model directory.
// Progress is reported against the summed byte total so the UI shows one bar
// for the whole (large) HD pack. Each file is sha256-verified by downloadToFile
// before it's kept, exactly like a Piper model.
async function downloadMeloVoice(appRoot, voice, onProgress) {
  const dir = modelDirFor(appRoot, voice);
  fs.mkdirSync(dir, { recursive: true });
  const total = voice.files.reduce((sum, f) => sum + f.sizeBytes, 0);
  let completed = 0;
  for (const f of voice.files) {
    const dest = path.join(dir, f.name);
    fs.mkdirSync(path.dirname(dest), { recursive: true }); // e.g. the bert/ subdir
    await downloadToFile(
      f.url,
      dest,
      { sha256: f.sha256, sizeBytes: f.sizeBytes },
      (received) => { if (onProgress) onProgress(completed + received, total); },
    );
    completed += f.sizeBytes;
  }
}

// Where a downloaded engine binary lives — writable user data, like models,
// so an app update doesn't wipe it. Matches lib/melotts.js findEngine().
function engineDir(name) {
  return path.join(userDataDir(), 'bin', name);
}

function enginePathFor(name, spec) {
  return path.join(engineDir(name), spec.exe);
}

function isEngineDownloaded(name, spec) {
  return fs.existsSync(enginePathFor(name, spec));
}

// Unpack a downloaded engine zip (a PyInstaller --onedir bundle: hundreds of
// files, ~2 GB) into destDir. Windows-only (the engine is a Windows .exe).
// Prefer bsdtar (System32\tar.exe, shipped since Win10 1803) — it unpacks the
// bundle in ~12 s where PowerShell's Expand-Archive takes minutes — and fall
// back to Expand-Archive if tar is missing. Paths are app-controlled (never user
// text); Expand-Archive's are single-quoted with quotes doubled as belt-and-braces.
function extractEngineZip(zipPath, destDir) {
  return new Promise((resolve, reject) => {
    if (process.platform !== 'win32') {
      reject(new Error('The HD voice engine is only available on Windows.'));
      return;
    }
    const opts = { windowsHide: true, maxBuffer: 4 * 1024 * 1024 };
    execFile('tar', ['-xf', zipPath, '-C', destDir], opts, (err) => {
      if (!err) { resolve(); return; }
      // tar unavailable/failed — fall back to PowerShell Expand-Archive.
      const q = (p) => `'${String(p).replace(/'/g, "''")}'`;
      const cmd = `Expand-Archive -LiteralPath ${q(zipPath)} -DestinationPath ${q(destDir)} -Force`;
      execFile('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', cmd], opts,
        (err2, _stdout, stderr2) => {
          if (err2) reject(new Error(`Could not unpack the HD voice engine: ${(stderr2 || err2.message).trim().split('\n').pop()}`));
          else resolve();
        });
    });
  });
}

// Download an engine (sha256 + size pinned) to its bin dir. A `zip`-archive
// engine is fetched to a temp file, verified, then unpacked in place (the whole
// --onedir bundle); a plain engine is a single verified binary.
async function downloadEngine(name, spec, onProgress) {
  const dir = engineDir(name);
  fs.mkdirSync(dir, { recursive: true });

  if (spec.archive === 'zip') {
    const tmpZip = path.join(dir, '.engine-download.zip');
    try {
      await downloadToFile(spec.url, tmpZip, { sha256: spec.sha256, sizeBytes: spec.sizeBytes }, onProgress);
      await extractEngineZip(tmpZip, dir);
    } finally {
      fs.rmSync(tmpZip, { force: true });
    }
    if (!fs.existsSync(enginePathFor(name, spec))) {
      throw new Error(`The HD voice engine archive did not contain ${spec.exe}. It was NOT installed.`);
    }
    if (process.platform !== 'win32') { try { fs.chmodSync(enginePathFor(name, spec), 0o755); } catch { /* best effort */ } }
    return;
  }

  const dest = enginePathFor(name, spec);
  await downloadToFile(spec.url, dest, { sha256: spec.sha256, sizeBytes: spec.sizeBytes }, onProgress);
  if (process.platform !== 'win32') {
    try { fs.chmodSync(dest, 0o755); } catch { /* best effort */ }
  }
}

module.exports = {
  loadManifest,
  voiceById,
  engineOf,
  modelPathFor,
  configPathFor,
  modelDirFor,
  resolveModelDir,
  isInstalled,
  auditWarnings,
  sha256OfFile,
  downloadVoice,
  enginePathFor,
  isEngineDownloaded,
  downloadEngine,
  migrateModelsFromAppRoot,
};
