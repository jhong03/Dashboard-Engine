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
      version: typeof origin.version === 'string' ? origin.version.slice(0, 20) : null,
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
function exportPack(packDirPath) {
  const entries = [];
  const manifest = path.join(packDirPath, 'pack.json');
  if (!fs.existsSync(manifest)) return { ok: false, error: 'Pack has no pack.json to export.' };
  entries.push({ name: 'pack.json', data: fs.readFileSync(manifest) });

  const assetsDir = path.join(packDirPath, 'assets');
  if (fs.existsSync(assetsDir)) {
    for (const file of fs.readdirSync(assetsDir)) {
      if (/^[a-z0-9._-]+\.(png|jpg|jpeg|webp)$/i.test(file)) {
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
        if (/^[a-z0-9._-]+\.(png|jpg|jpeg|webp)$/i.test(file)) {
          fs.copyFileSync(path.join(sourceAssets, file), path.join(tmpDir, 'assets', file));
        }
      }
    }
    // User-imported images, staged by main. Basename-only, pattern-checked.
    for (const [rel, stagedPath] of Object.entries(extraAssets)) {
      const name = path.basename(rel);
      if (/^[a-z0-9._-]+\.(png|jpg|jpeg|webp)$/i.test(name) && fs.existsSync(stagedPath)) {
        fs.copyFileSync(stagedPath, path.join(tmpDir, 'assets', name));
      }
    }
    fs.writeFileSync(path.join(tmpDir, META_FILE), JSON.stringify({
      installedAt: new Date().toISOString(),
      source: 'editor',
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

module.exports = { userPacksDir, installFromBuffer, exportPack, uninstall, readMeta, saveEdited, sha256 };
