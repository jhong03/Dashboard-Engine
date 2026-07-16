'use strict';

// Steam Workshop bridge — PROTOTYPE.
//
// Publishes packs to, and reads subscribed packs from, Steam Workshop, the
// same channel Wallpaper Engine uses. It runs against Valve's public test
// AppID 480 ("Spacewar") so the whole create/upload/subscribe flow works with
// NO Steamworks partnership and no fee — swap STEAM_APP_ID for the real AppID
// once the app ships on Steam.
//
// Everything here is lazy and FAIL-SOFT (CLAUDE.md rule): if the native
// binding can't load or the Steam client isn't running/logged in, the engine
// runs unchanged and every entry point reports Workshop as simply unavailable.
// The binding is an OPTIONAL dependency, so `npm install` succeeds without it.

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const packs = require('./packs');
const packstore = require('./packstore');

// Spacewar — Valve's public test app. On a real Steam release this becomes the
// AppID Valve grants us, and steam_appid.txt (dev-only) must be removed.
const STEAM_APP_ID = 480;

// Workshop item visibility, by ISteamUGC's ERemoteStoragePublishedFileVisibility.
const VISIBILITY = { public: 0, friends: 1, private: 2, unlisted: 3 };

// Steam wants a small preview image (png/jpg, ~1 MB max).
const PREVIEW_MAX_BYTES = 1024 * 1024;
const PREVIEW_EXTS = ['.png', '.jpg', '.jpeg', '.gif'];

let binding = null;   // steamworks.js module, false once a load has failed
let client = null;    // the initialised client, or null until Steam is up
let lastReason = null;

// ── connection ──────────────────────────────────────────────────────────────

function loadBinding() {
  if (binding !== null) return binding || null;
  try {
    binding = require('steamworks.js');
  } catch (err) {
    binding = false; // permanent: not installed / unsupported platform
    lastReason = 'Steam integration isn’t installed in this build.';
  }
  return binding || null;
}

// Try to attach to the running Steam client. Not cached on failure — the user
// may launch Steam after the app, so a later call can still succeed.
function ensureClient() {
  if (client) return client;
  const sw = loadBinding();
  if (!sw) return null;
  try {
    client = sw.init(STEAM_APP_ID);
    lastReason = null;
    return client;
  } catch (err) {
    lastReason = 'Steam isn’t running (or you’re not signed in). Start Steam, then retry.';
    return null;
  }
}

function status() {
  const sw = loadBinding();
  if (!sw) return { available: false, reason: lastReason };
  const c = ensureClient();
  if (!c) return { available: false, reason: lastReason };
  let user = null;
  try { user = c.localplayer.getName(); } catch (e) { user = null; }
  return { available: true, appId: STEAM_APP_ID, testApp: STEAM_APP_ID === 480, user };
}

// ── publishing ──────────────────────────────────────────────────────────────

// Copy just the shippable pack files (pack.json + assets/) into a temp folder,
// so internal metadata like .aegis-meta.json never rides up to Workshop.
function stageContent(dir) {
  const stageDir = path.join(os.tmpdir(), `de-workshop-${crypto.randomBytes(6).toString('hex')}`);
  fs.mkdirSync(stageDir, { recursive: true });
  fs.copyFileSync(path.join(dir, 'pack.json'), path.join(stageDir, 'pack.json'));
  const assetsSrc = path.join(dir, 'assets');
  if (fs.existsSync(assetsSrc) && fs.statSync(assetsSrc).isDirectory()) {
    fs.cpSync(assetsSrc, path.join(stageDir, 'assets'), { recursive: true });
  }
  return stageDir;
}

// Pick a preview image from the pack: its wallpaper if present, else the first
// small image asset. Returns an absolute path or null.
function findPreview(dir, pack) {
  const candidates = [];
  if (pack && pack.skin && typeof pack.skin.wallpaper === 'string') candidates.push(pack.skin.wallpaper);
  const assetsDir = path.join(dir, 'assets');
  if (fs.existsSync(assetsDir)) {
    for (const name of fs.readdirSync(assetsDir)) {
      if (PREVIEW_EXTS.includes(path.extname(name).toLowerCase())) candidates.push(path.join('assets', name));
    }
  }
  for (const rel of candidates) {
    const abs = path.join(dir, rel);
    try {
      if (fs.existsSync(abs) && fs.statSync(abs).size <= PREVIEW_MAX_BYTES) return abs;
    } catch (e) { /* skip */ }
  }
  return null;
}

async function publish(appRoot, userDir, opts) {
  const c = ensureClient();
  if (!c) return { ok: false, error: lastReason || 'Steam is not available.' };

  const id = String(opts && opts.packId || '');
  const resolved = packs.resolvePackDir(appRoot, userDir, id);
  if (!resolved || resolved.origin === 'missing') return { ok: false, error: `No pack named “${id}”.` };
  const loaded = packs.loadPack(appRoot, userDir, id);

  let stageDir = null;
  try {
    stageDir = stageContent(resolved.dir);
    // Prefer a freshly rendered preview of the dashboard (passed in by main);
    // fall back to the pack's wallpaper or first image asset.
    let preview = opts && opts.previewPath && fs.existsSync(opts.previewPath) ? opts.previewPath : null;
    if (!preview) preview = findPreview(resolved.dir, loaded.pack);
    const visibility = VISIBILITY[opts && opts.visibility] != null ? VISIBILITY[opts.visibility] : VISIBILITY.unlisted;

    const created = await c.workshop.createItem(STEAM_APP_ID);
    const itemId = created.itemId; // bigint

    const update = {
      title: String(opts && opts.title || loaded.pack.name || 'Untitled pack').slice(0, 128),
      description: String(opts && opts.description || '').slice(0, 8000),
      changeNote: 'Published from Dashboard Engine.',
      contentPath: stageDir,
      tags: Array.isArray(opts && opts.tags) ? opts.tags.slice(0, 10).map((t) => String(t).slice(0, 24)) : [],
      visibility,
    };
    if (preview) update.previewPath = preview;

    const result = await c.workshop.updateItem(itemId, update, STEAM_APP_ID);
    return {
      ok: true,
      itemId: itemId.toString(),
      needsToAcceptAgreement: !!result.needsToAcceptAgreement,
      url: `https://steamcommunity.com/sharedfiles/filedetails/?id=${itemId.toString()}`,
    };
  } catch (err) {
    return { ok: false, error: `Workshop upload failed: ${err.message}` };
  } finally {
    if (stageDir) { try { fs.rmSync(stageDir, { recursive: true, force: true }); } catch (e) { /* leave temp */ } }
  }
}

// ── subscriptions ─────────────────────────────────────────────────────────────

function listSubscribed() {
  const c = ensureClient();
  if (!c) return { ok: false, error: lastReason, items: [] };
  try {
    const ids = c.workshop.getSubscribedItems() || [];
    const items = ids.map((id) => {
      let info = null;
      try { info = c.workshop.installInfo(id); } catch (e) { info = null; }
      return {
        itemId: id.toString(),
        folder: info ? info.folder : null,
        installed: !!(info && info.folder),
        sizeOnDisk: info ? Number(info.sizeOnDisk) : 0,
      };
    });
    return { ok: true, items };
  } catch (err) {
    return { ok: false, error: err.message, items: [] };
  }
}

// Bring a subscribed Workshop pack into the normal library (so it renders in
// the gallery and can be set active) by installing its folder like any .dpack.
function importSubscribed(appRoot, userDir, itemId) {
  const c = ensureClient();
  if (!c) return { ok: false, error: lastReason || 'Steam is not available.' };
  let info = null;
  try { info = c.workshop.installInfo(BigInt(String(itemId))); } catch (e) { info = null; }
  if (!info || !info.folder || !fs.existsSync(path.join(info.folder, 'pack.json'))) {
    return { ok: false, error: 'That item isn’t downloaded yet — let Steam finish, then retry.' };
  }
  const exported = packstore.exportPack(info.folder);
  if (!exported.ok) return exported;
  return packstore.installFromBuffer(appRoot, userDir, exported.buffer, { source: 'workshop', workshopId: String(itemId) });
}

function subscribe(itemId) {
  const c = ensureClient();
  if (!c) return Promise.resolve({ ok: false, error: lastReason });
  return c.workshop.subscribe(BigInt(String(itemId)))
    .then(() => ({ ok: true }))
    .catch((err) => ({ ok: false, error: err.message }));
}

module.exports = { STEAM_APP_ID, status, publish, listSubscribed, importSubscribed, subscribe };
