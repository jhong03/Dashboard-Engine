'use strict';

// Registry feeds: how designers everywhere distribute packs and users
// subscribe. A registry is just a static index.json at an https URL:
//
//   { "name": "...", "packs": [ { "id", "name", "author", "description",
//     "version", "download", "sha256", "sizeBytes" } ] }
//
// Trust model (CLAUDE.md M3): adding a registry is like adding a package
// feed — you trust its curation. Integrity is machine-checked regardless:
// the index pins each pack's sha256 + size and the installer rejects any
// download that doesn't match. The index itself is validated as hostile
// input like everything else.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const packstore = require('./packstore');

const REGISTRIES_FILE = 'registries.json';
const MAX_REGISTRIES = 20;
const MAX_INDEX_BYTES = 1024 * 1024;
const MAX_INDEX_PACKS = 200;
const MAX_PACK_DOWNLOAD_BYTES = 30 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 15000;

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,47}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const VERSION_PATTERN = /^[A-Za-z0-9.-]{1,20}$/;

// https everywhere; plain http only for loopback, so a local test registry
// (and designer previews) work without certificates.
function isAllowedUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol === 'https:') return true;
    return url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  } catch {
    return false;
  }
}

// ── Subscription list (user data) ───────────────────────────────────────────

function registriesFile(userDir) {
  return path.join(userDir, REGISTRIES_FILE);
}

function loadRegistries(userDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(registriesFile(userDir), 'utf8'));
    const urls = (Array.isArray(raw.registries) ? raw.registries : [])
      .filter((u) => typeof u === 'string' && isAllowedUrl(u))
      .slice(0, MAX_REGISTRIES);
    return { registries: urls };
  } catch {
    return { registries: [] }; // none yet — not an error
  }
}

function saveRegistries(userDir, urls) {
  fs.mkdirSync(userDir, { recursive: true });
  const tmp = `${registriesFile(userDir)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ registries: urls }, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, registriesFile(userDir));
}

function addRegistry(userDir, url) {
  if (typeof url !== 'string' || !isAllowedUrl(url.trim())) {
    return { ok: false, error: 'Registry URLs must be https (or http://localhost for testing).' };
  }
  const clean = url.trim();
  const { registries } = loadRegistries(userDir);
  if (registries.includes(clean)) return { ok: true, registries };
  if (registries.length >= MAX_REGISTRIES) {
    return { ok: false, error: `You already have ${MAX_REGISTRIES} registries — remove one first.` };
  }
  const next = [...registries, clean];
  saveRegistries(userDir, next);
  return { ok: true, registries: next };
}

function removeRegistry(userDir, url) {
  const { registries } = loadRegistries(userDir);
  const next = registries.filter((u) => u !== url);
  saveRegistries(userDir, next);
  return { ok: true, registries: next };
}

// ── Index fetching + validation ─────────────────────────────────────────────

async function fetchCapped(url, maxBytes) {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const chunks = [];
  let received = 0;
  for await (const chunk of res.body) {
    received += chunk.length;
    if (received > maxBytes) throw new Error(`response exceeds ${Math.round(maxBytes / 1024)} KB`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function validateIndexEntry(raw, warnings) {
  if (typeof raw !== 'object' || raw === null) return null;
  const where = typeof raw.id === 'string' ? `"${raw.id.slice(0, 24)}"` : 'an entry';
  const checks = [
    [typeof raw.id === 'string' && ID_PATTERN.test(raw.id), 'invalid id'],
    [typeof raw.name === 'string' && raw.name.length <= 60, 'invalid name'],
    [typeof raw.version === 'string' && VERSION_PATTERN.test(raw.version), 'invalid version'],
    [isAllowedUrl(raw.download), 'download URL must be https'],
    [typeof raw.sha256 === 'string' && SHA256_PATTERN.test(raw.sha256), 'missing/invalid sha256'],
    [Number.isInteger(raw.sizeBytes) && raw.sizeBytes > 0 && raw.sizeBytes <= MAX_PACK_DOWNLOAD_BYTES, 'missing/oversized sizeBytes'],
  ];
  for (const [ok, reason] of checks) {
    if (!ok) {
      warnings.push(`Registry entry ${where} dropped: ${reason}.`);
      return null;
    }
  }
  return {
    id: raw.id,
    name: raw.name.trim().slice(0, 60),
    author: typeof raw.author === 'string' ? raw.author.trim().slice(0, 60) : '',
    description: typeof raw.description === 'string' ? raw.description.trim().slice(0, 200) : '',
    version: raw.version,
    download: raw.download,
    sha256: raw.sha256,
    sizeBytes: raw.sizeBytes,
  };
}

/** Fetch + validate a registry index. Returns { ok, name, packs, warnings } or { ok:false, error }. */
async function fetchIndex(url) {
  if (!isAllowedUrl(url)) return { ok: false, error: 'Not an allowed registry URL.' };
  let raw;
  try {
    const body = await fetchCapped(url, MAX_INDEX_BYTES);
    const text = body.toString('utf8');
    raw = JSON.parse(text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text);
  } catch (err) {
    return { ok: false, error: `Could not read the registry (${err.message}).` };
  }
  if (typeof raw !== 'object' || raw === null) return { ok: false, error: 'The registry index is not a JSON object.' };

  const warnings = [];
  const entries = Array.isArray(raw.packs) ? raw.packs : [];
  if (entries.length > MAX_INDEX_PACKS) {
    warnings.push(`Registry lists ${entries.length} packs; only the first ${MAX_INDEX_PACKS} are shown.`);
  }
  const packs = entries.slice(0, MAX_INDEX_PACKS).map((e) => validateIndexEntry(e, warnings)).filter(Boolean);
  const name = typeof raw.name === 'string' ? raw.name.trim().slice(0, 60) : url;
  return { ok: true, name, packs, warnings };
}

// ── Install from a registry ─────────────────────────────────────────────────

async function installFromRegistry(appRoot, userDir, registryUrl, packId) {
  const index = await fetchIndex(registryUrl);
  if (!index.ok) return index;
  const entry = index.packs.find((p) => p.id === packId);
  if (!entry) return { ok: false, error: `The registry no longer lists "${packId}".` };

  let buffer;
  try {
    buffer = await fetchCapped(entry.download, Math.min(entry.sizeBytes, MAX_PACK_DOWNLOAD_BYTES));
  } catch (err) {
    return { ok: false, error: `Download failed (${err.message}).` };
  }
  if (buffer.length !== entry.sizeBytes) {
    return { ok: false, error: `Download is ${buffer.length} bytes, the registry promised ${entry.sizeBytes} — refused.` };
  }
  const digest = crypto.createHash('sha256').update(buffer).digest('hex');
  if (digest !== entry.sha256) {
    return { ok: false, error: 'Checksum mismatch — the pack was corrupted or tampered with. It was NOT installed.' };
  }
  return packstore.installFromBuffer(appRoot, userDir, buffer, { source: registryUrl, version: entry.version });
}

/** Which installed packs have a newer version in this index? */
function updatesInIndex(userDir, registryUrl, index) {
  const updates = [];
  for (const entry of index.packs) {
    const meta = packstore.readMeta(userDir, entry.id);
    if (meta && meta.source === registryUrl && meta.version && meta.version !== entry.version) {
      updates.push({ id: entry.id, from: meta.version, to: entry.version });
    }
  }
  return updates;
}

module.exports = {
  loadRegistries,
  addRegistry,
  removeRegistry,
  fetchIndex,
  installFromRegistry,
  updatesInIndex,
  isAllowedUrl,
};
