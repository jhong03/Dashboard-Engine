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
const https = require('https');

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

// Drop a pack's item mapping (the item was deleted on Steam, so the id is
// stale and would make updates fail with "file not found").
function clearPublishedItem(userDir, packId) {
  const map = loadPublished(userDir);
  if (Object.prototype.hasOwnProperty.call(map, packId)) {
    delete map[packId];
    try { fs.writeFileSync(publishedFile(userDir), JSON.stringify(map, null, 2)); } catch (err) { /* best-effort */ }
  }
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
  const root = stagingRoot(userDir);
  const stageDir = path.join(root, safeId);
  fs.rmSync(stageDir, { recursive: true, force: true }); // overwrite the last publish
  fs.mkdirSync(stageDir, { recursive: true });
  fs.copyFileSync(path.join(dir, 'pack.json'), path.join(stageDir, 'pack.json'));
  const assetsSrc = path.join(dir, 'assets');
  if (fs.existsSync(assetsSrc) && fs.statSync(assetsSrc).isDirectory()) {
    fs.cpSync(assetsSrc, path.join(stageDir, 'assets'), { recursive: true });
  }
  // The preview lives OUTSIDE the content folder (a sibling file) — Steam's UGC
  // "a file was not found" error can come from the preview overlapping the
  // content enumeration, and this keeps them cleanly separate. It also survives
  // the async upload (main's rendered preview is a temp file cleaned right after
  // publish returns).
  let stagedPreview = null;
  if (previewPath && fs.existsSync(previewPath)) {
    const ext = (path.extname(previewPath) || '.png').toLowerCase();
    const dest = path.join(root, `${safeId}__preview${PREVIEW_EXTS.includes(ext) ? ext : '.png'}`);
    try { fs.rmSync(dest, { force: true }); fs.copyFileSync(previewPath, dest); stagedPreview = dest; } catch (e) { stagedPreview = null; }
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

// Whether a Workshop item still exists (a deleted item makes updates fail with
// "file not found"). Best-effort: on any query error, treat it as gone so we
// fall back to creating/adopting a fresh item rather than looping on a ghost.
async function itemExists(c, itemId) {
  try {
    const info = await c.workshop.getItem(itemId, { onlyIds: true });
    return !!info;
  } catch (err) {
    return false;
  }
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

    // Resolve which Workshop item to update. Order:
    //  1. the id we stored for this pack — but ONLY if it still exists (a stale
    //     mapping to a deleted item is exactly what caused "file not found");
    //  2. an existing item of ours with the same title (published before the
    //     local mapping existed) — so we never pile up duplicates;
    //  3. a fresh createItem; if that's capped, adopt our newest existing item.
    let itemId = null;
    let reused = false;
    let adopted = false;

    const stored = getPublishedItem(userDir, id);
    if (stored) {
      if (await itemExists(c, BigInt(stored))) { itemId = BigInt(stored); reused = true; }
      else { console.log(`[workshop] stored item ${stored} no longer exists — creating a fresh one.`); clearPublishedItem(userDir, id); }
    }
    if (!itemId) {
      const found = await findExistingItemByTitle(c, (opts && opts.title) || loaded.pack.name);
      if (found) { itemId = found; reused = true; setPublishedItem(userDir, id, itemId.toString()); }
    }
    if (!itemId) {
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

    // Diagnostics: exactly what we're handing Steam, and whether each path is
    // real. Prints to the terminal (npm start) so a "file was not found" can be
    // traced to the content folder vs the preview.
    try {
      const files = fs.existsSync(stageDir) ? fs.readdirSync(stageDir) : '(missing)';
      console.log('[workshop] updateItem', JSON.stringify({
        itemId: itemId.toString(),
        state: adopted ? 'adopted' : reused ? 'reused' : 'created',
        appId: STEAM_APP_ID,
        contentPath: stageDir,
        contentExists: fs.existsSync(stageDir),
        packJsonExists: fs.existsSync(path.join(stageDir, 'pack.json')),
        contentFiles: files,
        previewPath: update.previewPath || null,
        previewExists: update.previewPath ? fs.existsSync(update.previewPath) : null,
      }, null, 2));
    } catch (e) { console.log('[workshop] diag failed:', e.message); }

    // The staged content/preview live in a stable per-pack folder (see
    // stageContent) and are intentionally NOT deleted here — Steam's uploader
    // reads them asynchronously after this resolves, and deleting early left
    // 0-byte items. The next publish overwrites the folder. The item mapping is
    // sticky on failure so a retry updates the SAME item; to start fresh, delete
    // workshop-items.json.
    // The submit (SubmitItemUpdate) has its OWN rate limit, separate from the
    // item-count cap on createItem — too many uploads in a short window trips
    // it, and THAT one is time-based (waiting clears it). We surface that plainly
    // rather than the delete-your-items message that fits the creation cap.
    const rateLimited = {
      ok: false,
      error: 'Steam is rate-limiting Workshop uploads — too many publishes in a short time (all the test runs). Unlike the item cap, this one is time-based: wait ~15–30 minutes, then publish once. Your pack content and preview are valid; only Steam’s upload throttle is blocking. On your own AppID this limit is far higher.',
    };
    const submit = (withPreview) => {
      const u = { ...update };
      if (!withPreview) delete u.previewPath;
      return c.workshop.updateItem(itemId, u, STEAM_APP_ID);
    };
    let result;
    let previewSkipped = false;
    try {
      result = await submit(!!update.previewPath);
    } catch (err) {
      const emsg = String((err && err.message) || err);
      console.log('[workshop] updateItem FAILED:', emsg, '| had preview:', !!update.previewPath);
      if (isLimitExceeded(err)) return rateLimited;
      // "a file was not found" is almost always the preview — retry once without
      // it so the pack CONTENT still uploads (the item just won't get an image).
      if (/not found/i.test(emsg) && update.previewPath) {
        previewSkipped = true;
        console.log('[workshop] retrying updateItem without preview…');
        try { result = await submit(false); }
        catch (err2) { if (isLimitExceeded(err2)) return rateLimited; throw err2; }
      } else {
        throw err;
      }
    }
    setPublishedItem(userDir, id, itemId.toString());
    return {
      ok: true,
      itemId: itemId.toString(),
      updated: reused,
      adopted,
      note: [
        adopted ? 'You’ve hit the Spacewar test-app item limit from earlier testing, so this reused your newest existing Workshop item instead of making a new one. On your own Steam AppID this limit goes away.' : null,
        previewSkipped ? 'Steam wouldn’t accept the preview image, so the pack was published without one — you can add a preview on the item’s Steam page.' : null,
      ].filter(Boolean).join(' ') || null,
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

// ── browse (consume side) ────────────────────────────────────────────────────

// ISteamUGC EUGCQuery values we surface as sort options.
const SORT_QUERY = { trend: 3, newest: 1, top: 12, updated: 19 };

// The app's Workshop web page — for full discovery in the Steam UI.
function workshopPageUrl() {
  return `https://steamcommunity.com/app/${STEAM_APP_ID}/workshop/`;
}

// Browse the app's Workshop. Returns lightweight item cards; the preview image
// is a remote URL fetched separately (previewDataUri) so the renderer's strict
// CSP never loads a remote host directly.
async function browse(opts) {
  const c = ensureClient();
  if (!c) return { ok: false, error: lastReason || 'Steam is not available.', items: [] };
  const page = Math.max(1, Math.min(50, Number(opts && opts.page) || 1));
  const search = String((opts && opts.search) || '').trim().slice(0, 120);
  const queryType = SORT_QUERY[(opts && opts.sort)] != null ? SORT_QUERY[opts.sort] : SORT_QUERY.trend;
  try {
    const subs = new Set(((c.workshop.getSubscribedItems && c.workshop.getSubscribedItems()) || []).map((x) => x.toString()));
    const res = await c.workshop.getAllItems(
      page, queryType, 0 /* UGCType.Items */, STEAM_APP_ID, STEAM_APP_ID,
      { searchText: search || undefined, includeLongDescription: false },
    );
    const items = ((res && res.items) || []).filter(Boolean).map((it) => {
      const id = it.publishedFileId.toString();
      let downloaded = false;
      if (subs.has(id)) { try { const info = c.workshop.installInfo(it.publishedFileId); downloaded = !!(info && info.folder); } catch (e) { downloaded = false; } }
      return {
        itemId: id,
        title: String(it.title || 'Untitled').slice(0, 120),
        description: String(it.description || '').replace(/\[[^\]]*\]/g, '').slice(0, 200),
        tags: Array.isArray(it.tags) ? it.tags.slice(0, 8) : [],
        votesUp: Number(it.numUpvotes) || 0,
        url: it.url || `https://steamcommunity.com/sharedfiles/filedetails/?id=${id}`,
        previewUrl: typeof it.previewUrl === 'string' ? it.previewUrl : null,
        subscribed: subs.has(id),
        downloaded,
      };
    });
    return { ok: true, items, page, total: Number((res && res.totalResults)) || items.length, testApp: STEAM_APP_ID === 480 };
  } catch (err) {
    return { ok: false, error: err.message, items: [] };
  }
}

// Fetch a Workshop preview image and return it as a data: URI so the manager's
// CSP (img-src 'self' data:) can show it. Cached by URL; size/type capped.
const previewCache = new Map();
function previewDataUri(url) {
  return new Promise((resolve) => {
    if (typeof url !== 'string' || !/^https:\/\//.test(url)) return resolve({ ok: false });
    if (previewCache.has(url)) return resolve({ ok: true, uri: previewCache.get(url) });
    let req;
    try { req = https.get(url, onResponse); } catch (e) { return resolve({ ok: false }); }
    function onResponse(res) {
      const type = String(res.headers['content-type'] || '');
      if (res.statusCode !== 200 || !/^image\//.test(type)) { res.resume(); return resolve({ ok: false }); }
      const chunks = [];
      let size = 0;
      res.on('data', (d) => {
        size += d.length;
        if (size > 3 * 1024 * 1024) { req.destroy(); resolve({ ok: false }); } else chunks.push(d);
      });
      res.on('end', () => {
        const uri = `data:${type};base64,${Buffer.concat(chunks).toString('base64')}`;
        if (previewCache.size < 400) previewCache.set(url, uri);
        resolve({ ok: true, uri });
      });
    }
    req.on('error', () => resolve({ ok: false }));
    req.setTimeout(8000, () => { req.destroy(); resolve({ ok: false }); });
  });
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

module.exports = { STEAM_APP_ID, status, publish, browse, previewDataUri, workshopPageUrl, listSubscribed, importSubscribed, subscribe };
