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

// Only this host may serve models. A manifest pointing anywhere else is
// refused — it keeps a tampered pack from making the app fetch arbitrary
// binaries.
const ALLOWED_DOWNLOAD_HOST = 'huggingface.co';

const ID_PATTERN = /^[a-z0-9_]{1,64}$/;
// Plain filename, no separators — prevents a manifest from writing outside
// the voices directory.
const MODEL_PATTERN = /^[A-Za-z0-9._-]+\.onnx$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

function manifestPath(appRoot) {
  return path.join(appRoot, 'voices', 'voices.json');
}

function voicesDir(appRoot) {
  return path.join(appRoot, 'voices');
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
    excluded: Array.isArray(raw.excluded) ? raw.excluded : [],
    warnings,
  };
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

function isInstalled(appRoot, voice) {
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

module.exports = {
  loadManifest,
  voiceById,
  modelPathFor,
  configPathFor,
  isInstalled,
  auditWarnings,
  sha256OfFile,
  downloadVoice,
};
