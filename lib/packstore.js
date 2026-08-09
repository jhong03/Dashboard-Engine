'use strict';

// Installed-pack store: the user-data side of the engine/content split.
// Built-in packs live read-only in the repo; everything a user installs —
// from an .aegispack file or a registry — lands here, in
// <userData>/packs/<id>/, with a .aegis-meta.json recording where it came
// from (which is how update checks know what "installed version" means).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const zip = require('./zip');
const packs = require('./packs');

const META_FILE = '.aegis-meta.json';
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,47}$/;
// Asset files that may be copied into / exported from a pack: images and video
// wallpapers (the size caps live in lib/zip.js and lib/packs.videoPathFor).
const ASSET_FILE_PATTERN = /^[a-z0-9._-]+\.(png|jpg|jpeg|webp|mp4|webm)$/i;

function userPacksDir(userDir) {
  return path.join(userDir, 'packs');
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * Install a pack from an .aegispack buffer into the user store.
 * @param {object} origin { source, version } — registry URL + version, or
 *   { source: 'file' } for manual imports. Recorded in the meta file.
 * @returns {{ ok: true, id, warnings } | { ok: false, error }}
 */
function installFromBuffer(appRoot, userDir, buffer, origin = {}) {
  let parsed;
  try {
    parsed = zip.readZip(buffer);
  } catch (err) {
    return { ok: false, error: err.message };
  }
  const { entries, warnings } = parsed;

  const manifestBuf = entries.get('pack.json');
  if (!manifestBuf) return { ok: false, error: 'The archive has no pack.json — not a persona pack.' };

  let raw;
  try {
    const text = manifestBuf.toString('utf8');
    raw = JSON.parse(text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text);
  } catch {
    return { ok: false, error: 'The pack.json inside the archive is not valid JSON.' };
  }

  // Identity: the manifest's own id, else a slug of its name.
  let id = typeof raw.id === 'string' && ID_PATTERN.test(raw.id) ? raw.id : null;
  if (!id && typeof raw.name === 'string') {
    id = raw.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  }
  if (!id || !ID_PATTERN.test(id)) {
    return { ok: false, error: 'The pack has no usable id or name.' };
  }
  // Built-in ids are reserved — a downloaded pack must not shadow engine content.
  if (fs.existsSync(path.join(packs.packDir(appRoot, id), 'pack.json'))) {
    return { ok: false, error: `"${id}" is a built-in pack id and cannot be replaced.` };
  }

  // Run the sanitizer now so a pack that would render as pure defaults is
  // caught at install time, with its warnings shown to the user.
  const sanitized = packs.sanitizePack(raw, id);
  warnings.push(...sanitized.warnings);

  // Extract to a temp dir, then swap into place so a failed install can't
  // leave a half-written pack.
  const finalDir = path.join(userPacksDir(userDir), id);
  const tmpDir = `${finalDir}.tmp`;
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.mkdirSync(path.join(tmpDir, 'assets'), { recursive: true });
    for (const [name, data] of entries) {
      fs.writeFileSync(path.join(tmpDir, name), data);
    }
    fs.writeFileSync(path.join(tmpDir, META_FILE), JSON.stringify({
      installedAt: new Date().toISOString(),
      source: origin.source || 'file',
      // Provenance for the STRICT publish gate (see isPublishable): a plain
      // import from another creator / a registry / a file is 'imported' and
      // NOT republishable; only your own re-downloaded Workshop item is passed
      // 'own-workshop' (by workshop.getEditableCopy) and stays publishable.
      origin: typeof origin.origin === 'string' ? origin.origin : 'imported',
      version: typeof origin.version === 'string' ? origin.version.slice(0, 20) : null,
      // Persist the Workshop item id so the browse UI can show "In library"
      // and avoid re-importing the same subscribed pack.
      workshopId: typeof origin.workshopId === 'string' ? origin.workshopId : null,
      sha256: sha256(buffer),
    }, null, 2));
    fs.rmSync(finalDir, { recursive: true, force: true });
    fs.renameSync(tmpDir, finalDir);
  } catch (err) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    return { ok: false, error: `Could not write the pack to disk: ${err.message}` };
  }
  return { ok: true, id, warnings };
}

/** Read the install metadata for a user pack (null for built-ins/missing). */
function readMeta(userDir, id) {
  try {
    return JSON.parse(fs.readFileSync(path.join(userPacksDir(userDir), id, META_FILE), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Export any pack (built-in or installed) as an .aegispack buffer.
 * The meta file is deliberately excluded — it's local install state.
 */
// Replace the author's own filled-in CONTENT with neutral mock/placeholder values
// before a pack is SHARED (publish or export), so a public pack demonstrates the
// DESIGN without carrying the author's personal data (weather location, countdown
// date + event, custom text/labels/status lines, assistant prompt). Structure and
// look are kept — component types, positions, styles, skin/colours, and the pack's
// persona/character. Live-only data (reminders, launcher pins, notifications,
// now-playing, system stats) is never stored in a pack, so there's nothing to
// strip there. Returns a deep clone; the author's local pack is never mutated.
function sanitizeForShare(pack) {
  let clean;
  try { clean = JSON.parse(JSON.stringify(pack)); } catch (e) { return pack; }
  if (!Array.isArray(clean.components)) return clean;
  for (const c of clean.components) {
    if (!c || typeof c !== 'object' || !c.options) continue;
    const o = c.options;
    switch (c.type) {
      case 'weather':
        // Reveals where the author lives → follow each subscriber's own location.
        o.lat = 0; o.lon = 0; o.place = null;
        break;
      case 'countdown':
        // The author's target date + event title → neutral placeholder.
        o.target = '2030-01-01';
        o.label = 'Countdown';
        break;
      case 'text':
        if ('text' in o) o.text = 'Sample text';
        break;
      case 'sysinfo':
        if ('statusText' in o) o.statusText = null; // → the default status line
        break;
      case 'assistant':
        if ('label' in o) o.label = null;   // → default prompt text
        if ('button' in o) o.button = null; // → default button text
        break;
      case 'stats': case 'meter': case 'sparkline': case 'cores':
      case 'agenda': case 'notifications': case 'launcher': case 'nowplaying':
        if ('label' in o) o.label = null;   // custom caption → auto/default label
        break;
      default:
        break; // clock/analog/hud/ring/divider/calendar/image/gallery/module: design/assets/code
    }
  }
  return clean;
}

// pack.json bytes with personal data stripped (see sanitizeForShare). Falls back
// to the raw bytes if the manifest can't be parsed, so export never fails here.
function shareableManifest(manifestPath) {
  const raw = fs.readFileSync(manifestPath);
  try { return Buffer.from(JSON.stringify(sanitizeForShare(JSON.parse(raw.toString('utf8'))), null, 2), 'utf8'); }
  catch (e) { return raw; }
}

function exportPack(packDirPath) {
  const entries = [];
  const manifest = path.join(packDirPath, 'pack.json');
  if (!fs.existsSync(manifest)) return { ok: false, error: 'Pack has no pack.json to export.' };
  entries.push({ name: 'pack.json', data: shareableManifest(manifest) });

  const assetsDir = path.join(packDirPath, 'assets');
  if (fs.existsSync(assetsDir)) {
    for (const file of fs.readdirSync(assetsDir)) {
      if (ASSET_FILE_PATTERN.test(file)) {
        entries.push({ name: `assets/${file}`, data: fs.readFileSync(path.join(assetsDir, file)) });
      }
    }
  }
  return { ok: true, buffer: zip.writeZip(entries) };
}

// Ids the editor may not claim: anything that exists as a built-in.
function isBuiltinId(appRoot, id) {
  return fs.existsSync(path.join(packs.packDir(appRoot, id), 'pack.json'));
}

// Derive a unique, on-disk-safe pack id from a display name, avoiding built-in
// ids and existing user packs.
function uniquePackId(appRoot, userDir, name, fallback) {
  const base = (typeof name === 'string' && name.trim() !== '' ? name : fallback)
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || fallback;
  let id = base;
  let counter = 2;
  while (isBuiltinId(appRoot, id) || fs.existsSync(path.join(userPacksDir(userDir), id))) {
    id = `${base}-${counter++}`.slice(0, 48);
  }
  return id;
}

/**
 * Create a brand-new user pack from an assembled manifest (the "from scratch"
 * builder). No base pack to fork — the manifest is sanitized and written fresh,
 * with any main-staged assets (an imported wallpaper) copied in. Marked
 * source:'editor' so a later editor save stays in place.
 * @param {Object<string,string>} extraAssets rel name → absolute STAGED path
 *   (main-staged only; never renderer paths).
 * @returns {{ ok: true, id, warnings } | { ok: false, error }}
 */
function createPack(appRoot, userDir, rawPack, extraAssets = {}) {
  const targetId = uniquePackId(appRoot, userDir, rawPack && rawPack.name, 'my-pack');
  const sanitized = packs.sanitizePack(rawPack, targetId);
  const finalDir = path.join(userPacksDir(userDir), targetId);
  const tmpDir = `${finalDir}.tmp`;
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.mkdirSync(path.join(tmpDir, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'pack.json'), JSON.stringify(sanitized.pack, null, 2) + '\n', 'utf8');
    for (const [rel, stagedPath] of Object.entries(extraAssets)) {
      const name = path.basename(rel);
      if (ASSET_FILE_PATTERN.test(name) && fs.existsSync(stagedPath)) {
        fs.copyFileSync(stagedPath, path.join(tmpDir, 'assets', name));
      }
    }
    fs.writeFileSync(path.join(tmpDir, META_FILE), JSON.stringify({
      // 'scratch' = built from nothing in the guided builder → publishable
      // (the strict gate's whole point: only original work reaches Workshop).
      installedAt: new Date().toISOString(), source: 'editor', origin: 'scratch', version: null, forkedFrom: null,
    }, null, 2));
    fs.rmSync(finalDir, { recursive: true, force: true });
    fs.renameSync(tmpDir, finalDir);
  } catch (err) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    return { ok: false, error: `Could not create the pack: ${err.message}` };
  }
  return { ok: true, id: targetId, warnings: sanitized.warnings };
}

/**
 * Save an edited pack. Fork-on-save semantics (CLAUDE.md M3 editor):
 * packs the user authored in the editor (meta.source === 'editor') save in
 * place; anything else — built-ins, registry installs, file imports — forks
 * to a new pack in the user store, assets copied along, original untouched.
 * @param {Object<string,string>} extraAssets rel name → absolute path of
 *   files STAGED BY THE MAIN PROCESS (user-imported images). Never
 *   renderer-supplied paths.
 * @returns {{ ok: true, id, forked, warnings } | { ok: false, error }}
 */
function saveEdited(appRoot, userDir, baseId, rawPack, extraAssets = {}) {
  const resolved = packs.resolvePackDir(appRoot, userDir, baseId);
  if (resolved.origin === 'missing') return { ok: false, error: `No pack named "${baseId}" to save over.` };

  const meta = resolved.origin === 'installed' ? readMeta(userDir, baseId) : null;
  const editableInPlace = resolved.origin === 'installed' && meta && meta.source === 'editor';

  let targetId = baseId;
  if (!editableInPlace) {
    const base = (typeof rawPack.name === 'string' && rawPack.name.trim() !== '' ? rawPack.name : baseId)
      .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'edited-pack';
    targetId = base;
    let counter = 2;
    while (isBuiltinId(appRoot, targetId) || fs.existsSync(path.join(userPacksDir(userDir), targetId))) {
      targetId = `${base}-${counter++}`.slice(0, 48);
    }
  }

  const sanitized = packs.sanitizePack(rawPack, targetId);
  const finalDir = path.join(userPacksDir(userDir), targetId);
  const tmpDir = `${finalDir}.tmp`;
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.mkdirSync(path.join(tmpDir, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'pack.json'), JSON.stringify(sanitized.pack, null, 2) + '\n', 'utf8');

    // Carry the source pack's assets so image/wallpaper references survive
    // the fork (and in-place saves keep files the manifest stopped naming —
    // the author may re-reference them).
    const sourceAssets = path.join(resolved.dir, 'assets');
    if (fs.existsSync(sourceAssets)) {
      for (const file of fs.readdirSync(sourceAssets)) {
        if (ASSET_FILE_PATTERN.test(file)) {
          fs.copyFileSync(path.join(sourceAssets, file), path.join(tmpDir, 'assets', file));
        }
      }
    }
    // User-imported images, staged by main. Basename-only, pattern-checked.
    for (const [rel, stagedPath] of Object.entries(extraAssets)) {
      const name = path.basename(rel);
      if (ASSET_FILE_PATTERN.test(name) && fs.existsSync(stagedPath)) {
        fs.copyFileSync(stagedPath, path.join(tmpDir, 'assets', name));
      }
    }
    fs.writeFileSync(path.join(tmpDir, META_FILE), JSON.stringify({
      installedAt: new Date().toISOString(),
      source: 'editor',
      // In-place saves keep the pack's provenance (a 'scratch' or 'own-workshop'
      // pack the user authored stays publishable across edits); a fork of a
      // built-in / registry / imported pack is 'fork' → NOT publishable, so a
      // low-effort reskin can never be pushed to Workshop as original work.
      origin: editableInPlace ? ((meta && meta.origin) || 'scratch') : 'fork',
      // Keep the Workshop item id across in-place edits (an own-workshop pack you
      // re-downloaded and edited) so the Browse "In library" badge still resolves.
      // The authoritative update mapping lives in workshop-items.json regardless.
      workshopId: editableInPlace ? (meta && meta.workshopId) || null : null,
      version: null,
      forkedFrom: editableInPlace ? (meta && meta.forkedFrom) || null : baseId,
    }, null, 2));
    fs.rmSync(finalDir, { recursive: true, force: true });
    fs.renameSync(tmpDir, finalDir);
  } catch (err) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    return { ok: false, error: `Could not save the pack: ${err.message}` };
  }
  return { ok: true, id: targetId, forked: !editableInPlace, warnings: sanitized.warnings };
}

/**
 * The STRICT publish gate (owner directive: heightened quality — only original
 * work reaches Workshop). A pack may be published/updated ONLY when it is:
 *   - a from-scratch builder pack  (meta.origin === 'scratch'), or
 *   - your own re-downloaded item  (meta.origin === 'own-workshop').
 * Everything else is blocked: built-in seeds, forks of seeds/registry packs,
 * and packs imported from other creators or a file/registry.
 *
 * Enforced in BOTH the UI (disable the Publish button) and the publish IPC
 * handler (reject), so a hostile renderer can't bypass it.
 */
function isPublishable(appRoot, userDir, id) {
  const resolved = packs.resolvePackDir(appRoot, userDir, id);
  if (!resolved || resolved.origin !== 'installed') return false; // built-in / missing → never
  const meta = readMeta(userDir, id);
  if (!meta) {
    // Legacy user pack that predates origin tagging. We can't be sure, so treat
    // it as user-authored (publishable) — the same benefit-of-the-doubt these
    // packs had before the gate existed.
    return true;
  }
  if (meta.origin === 'scratch' || meta.origin === 'own-workshop') return true;
  if (meta.origin === 'imported' || meta.origin === 'fork') return false;
  // Meta exists but has no origin (older editor/fork saves): a fork set
  // forkedFrom; a from-scratch pack was source:'editor' with no forkedFrom.
  return meta.source === 'editor' && !meta.forkedFrom;
}

/** Remove an installed pack. Refuses anything outside the user store. */
function uninstall(userDir, id) {
  if (!ID_PATTERN.test(String(id))) return { ok: false, error: 'Invalid pack id.' };
  const dir = path.join(userPacksDir(userDir), id);
  if (!fs.existsSync(path.join(dir, META_FILE)) && !fs.existsSync(path.join(dir, 'pack.json'))) {
    return { ok: false, error: `"${id}" is not an installed pack.` };
  }
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `Could not remove the pack: ${err.message}` };
  }
}

module.exports = { userPacksDir, installFromBuffer, exportPack, uninstall, readMeta, saveEdited, createPack, isPublishable, sha256, sanitizeForShare, shareableManifest };
