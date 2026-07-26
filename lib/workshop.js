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

const packs = require('./packs');
const packstore = require('./packstore');

// The Steam app that owns our Workshop items. Defaults to Spacewar (480) —
// Valve's public test app, the only one anyone can publish to without owning an
// app — but is overridable so the moment you have your OWN AppID (Steam Direct
// + app created + Workshop enabled) you can point at it with NO code change:
//
//   • set the env var DE_STEAM_APPID=<your appid>, and
//   • put that same number in steam_appid.txt (so Steam knows which app we are
//     when launched outside Steam; a real Steam-launched build needs neither —
//     Steam supplies the appid and steam_appid.txt must be removed).
//
// For the shipped Steam build, bake your AppID in as this default and delete
// steam_appid.txt.
function resolveAppId() {
  const raw = process.env.DE_STEAM_APPID || process.env.AEGIS_STEAM_APPID;
  const n = raw != null ? Number(raw) : NaN;
  return Number.isInteger(n) && n > 0 ? n : 480;
}
const STEAM_APP_ID = resolveAppId();

// Workshop item visibility, by ISteamUGC's ERemoteStoragePublishedFileVisibility.
const VISIBILITY = { public: 0, friends: 1, private: 2, unlisted: 3 };

// Steam wants a small preview image (png/jpg, ~1 MB max).
const PREVIEW_MAX_BYTES = 1024 * 1024;
const PREVIEW_EXTS = ['.png', '.jpg', '.jpeg', '.gif'];

// Remember which Workshop item we created for each pack, so re-publishing
// UPDATES that one item instead of creating a new item every time (Steam
// rate/count-limits item creation — spamming createItem is what leaves piles of
// blank 0-byte items and eventually "limit exceeded").
const PUBLISHED_FILE = 'workshop-items.json';

function publishedFile(userDir) {
  return path.join(userDir, PUBLISHED_FILE);
}

function loadPublished(userDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(publishedFile(userDir), 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch (err) {
    return {};
  }
}

function getPublishedItem(userDir, packId) {
  const value = loadPublished(userDir)[packId];
  return typeof value === 'string' && /^[0-9]+$/.test(value) ? value : null;
}

function setPublishedItem(userDir, packId, itemId) {
  const map = loadPublished(userDir);
  map[packId] = String(itemId);
  try {
    fs.mkdirSync(userDir, { recursive: true });
    fs.writeFileSync(publishedFile(userDir), JSON.stringify(map, null, 2));
  } catch (err) { /* best-effort — a lost mapping just means a new item next time */ }
}

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

// Copy the shippable pack files (pack.json + assets/) — plus the preview image —
// into a STABLE per-pack folder under user data, so internal metadata like
// .aegis-meta.json never rides up to Workshop.
//
// Why user-data and not the system temp dir, and why we DON'T delete it after:
// Steam's UGC uploader reads the content folder ASYNCHRONOUSLY after
// updateItem() resolves. Staging in os.tmpdir() and rm-ing it in a finally
// block (as before) raced that read and left 0-byte items — Steam's uploader
// has also been flaky reading the system temp dir. A stable folder that
// persists through the whole upload (overwritten on the next publish) fixes it.
function stagingRoot(userDir) {
  return path.join(userDir, 'workshop-staging');
}

function stageContent(userDir, packId, dir, previewPath) {
  const safeId = String(packId).replace(/[^a-z0-9_-]/gi, '_') || 'pack';
  const stageDir = path.join(stagingRoot(userDir), safeId);
  fs.rmSync(stageDir, { recursive: true, force: true }); // overwrite the last publish
  fs.mkdirSync(stageDir, { recursive: true });
  fs.copyFileSync(path.join(dir, 'pack.json'), path.join(stageDir, 'pack.json'));
  const assetsSrc = path.join(dir, 'assets');
  if (fs.existsSync(assetsSrc) && fs.statSync(assetsSrc).isDirectory()) {
    fs.cpSync(assetsSrc, path.join(stageDir, 'assets'), { recursive: true });
  }
  // Copy the preview alongside so it also survives the async upload (main's
  // rendered preview is a temp file that may be cleaned right after publish).
  let stagedPreview = null;
  if (previewPath && fs.existsSync(previewPath)) {
    const ext = (path.extname(previewPath) || '.png').toLowerCase();
    const dest = path.join(stageDir, `preview${PREVIEW_EXTS.includes(ext) ? ext : '.png'}`);
    try { fs.copyFileSync(previewPath, dest); stagedPreview = dest; } catch (e) { stagedPreview = null; }
  }
  return { stageDir, stagedPreview };
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

// Find one of our already-published items with this title, so re-publishing a
// pack that was published before the local mapping existed UPDATES that item
// instead of piling up duplicates. Best-effort — returns a bigint id or null.
async function findExistingItemByTitle(c, title) {
  const want = String(title || '').trim().toLowerCase();
  if (!want) return null;
  try {
    const me = c.localplayer.getSteamId();
    let seen = 0;
    for (let page = 1; page <= 8; page++) {
      const res = await c.workshop.getUserItems(
        page, me.accountId,
        0, // UserListType.Published
        0, // UGCType.Items
        1, // UserListOrder.CreationOrderDesc (newest first)
        { creator: STEAM_APP_ID, consumer: STEAM_APP_ID },
      );
      const items = (res && res.items) || [];
      for (const it of items) {
        if (it && it.title && String(it.title).trim().toLowerCase() === want) return it.publishedFileId;
      }
      seen += items.length;
      if (items.length === 0 || seen >= ((res && res.totalResults) || 0)) break;
    }
  } catch (err) { /* fall through — create a new item */ }
  return null;
}

// The newest Workshop item we own on this app, regardless of title. Used to
// ADOPT an existing item when item creation is capped (the Spacewar test app
// limits how many items one account can have; earlier testing piles them up).
async function findNewestItem(c) {
  try {
    const me = c.localplayer.getSteamId();
    const res = await c.workshop.getUserItems(
      1, me.accountId,
      0, // Published
      0, // Items
      1, // CreationOrderDesc (newest first)
      { creator: STEAM_APP_ID, consumer: STEAM_APP_ID },
    );
    const items = (res && res.items) || [];
    if (items[0] && items[0].publishedFileId != null) return items[0].publishedFileId;
  } catch (err) { /* fall through */ }
  return null;
}

function isLimitExceeded(err) {
  return /limit exceeded/i.test(String((err && err.message) || err));
}

async function publish(appRoot, userDir, opts) {
  const c = ensureClient();
  if (!c) return { ok: false, error: lastReason || 'Steam is not available.' };

  const id = String(opts && opts.packId || '');
  const resolved = packs.resolvePackDir(appRoot, userDir, id);
  if (!resolved || resolved.origin === 'missing') return { ok: false, error: `No pack named “${id}”.` };
  const loaded = packs.loadPack(appRoot, userDir, id);

  try {
    // Prefer a freshly rendered preview of the dashboard (passed in by main);
    // fall back to the pack's wallpaper or first image asset.
    let preview = opts && opts.previewPath && fs.existsSync(opts.previewPath) ? opts.previewPath : null;
    if (!preview) preview = findPreview(resolved.dir, loaded.pack);
    // Stage into a stable folder that persists through Steam's async upload.
    const { stageDir, stagedPreview } = stageContent(userDir, id, resolved.dir, preview);
    const visibility = VISIBILITY[opts && opts.visibility] != null ? VISIBILITY[opts.visibility] : VISIBILITY.unlisted;

    // Reuse the item created for this pack before; only ever create one. Record
    // its id IMMEDIATELY so a failed upload can't spawn duplicates — the next
    // publish updates that same item. If there's no local record, adopt any
    // existing item of ours with the same title (handles items published
    // before the mapping existed) so we never pile up new duplicates.
    let stored = getPublishedItem(userDir, id);
    if (!stored) {
      const found = await findExistingItemByTitle(c, (opts && opts.title) || loaded.pack.name);
      if (found) { stored = found.toString(); setPublishedItem(userDir, id, stored); }
    }
    let reused = stored !== null;
    let adopted = false;
    let itemId;
    if (reused) {
      itemId = BigInt(stored);
    } else {
      try {
        const created = await c.workshop.createItem(STEAM_APP_ID);
        itemId = created.itemId; // bigint
        setPublishedItem(userDir, id, itemId.toString());
      } catch (err) {
        // Item-creation cap on the test app: rather than failing forever, adopt
        // our newest existing item and update THAT — so publishing still works.
        if (!isLimitExceeded(err)) throw err;
        const newest = await findNewestItem(c);
        if (!newest) throw err;
        itemId = newest;
        adopted = true;
        reused = true;
        setPublishedItem(userDir, id, itemId.toString());
      }
    }

    const update = {
      title: String(opts && opts.title || loaded.pack.name || 'Untitled pack').slice(0, 128),
      description: String(opts && opts.description || '').slice(0, 8000),
      changeNote: 'Published from Dashboard Engine.',
      contentPath: stageDir,
      tags: Array.isArray(opts && opts.tags) ? opts.tags.slice(0, 10).map((t) => String(t).slice(0, 24)) : [],
      visibility,
    };
    if (stagedPreview) update.previewPath = stagedPreview;

    // The staged content/preview live in a stable per-pack folder (see
    // stageContent) and are intentionally NOT deleted here — Steam's uploader
    // reads them asynchronously after this resolves, and deleting early left
    // 0-byte items. The next publish overwrites the folder. The item mapping is
    // sticky on failure so a retry updates the SAME item; to start fresh, delete
    // workshop-items.json.
    const result = await c.workshop.updateItem(itemId, update, STEAM_APP_ID);
    setPublishedItem(userDir, id, itemId.toString());
    return {
      ok: true,
      itemId: itemId.toString(),
      updated: reused,
      adopted,
      note: adopted
        ? 'You’ve hit the Spacewar test-app item limit from earlier testing, so this reused your newest existing Workshop item instead of making a new one. On your own Steam AppID this limit goes away.'
        : null,
      needsToAcceptAgreement: !!result.needsToAcceptAgreement,
      url: `https://steamcommunity.com/sharedfiles/filedetails/?id=${itemId.toString()}`,
    };
  } catch (err) {
    const msg = String((err && err.message) || err);
    // Steam rate-limits item creation/updates; too many publishes in a short
    // window trip this and leave a 0-byte item. Reusing one item per pack keeps
    // it rare, but say so plainly rather than surfacing the raw code.
    if (isLimitExceeded(err)) {
      return { ok: false, error: 'You’ve reached the Spacewar test-app’s Workshop item limit (earlier testing created many items). This isn’t time-based — delete some at steamcommunity.com → your Workshop files, or ship on your own Steam AppID where the limit is far higher. (The engine also tries to reuse an existing item automatically.)' };
    }
    return { ok: false, error: `Workshop upload failed: ${msg}` };
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
