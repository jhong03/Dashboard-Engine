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
const profiles = require('./profiles');

// A reserved Steam tag that marks a Workshop item as a VOICE PROFILE rather than
// a dashboard pack. Voice browse REQUIRES it; dashboard browse EXCLUDES it, so
// the two item types never bleed into each other's listings. Kept short (Steam
// caps tag length) and stable — changing it would orphan already-published
// voices. A companion `base:<voiceId>` tag records the required base voice so a
// browse card can show the dependency without downloading the item.
const VOICE_TAG = 'voice-profile';

// The Steam app that owns our Workshop items: Dashboard Engine, AppID 5066330
// (Steam Direct app created 2026-08-05). Baked as the default so the shipped,
// Steam-launched build needs no env var — Steam supplies the appid at launch.
// Overridable via DE_STEAM_APPID to point at a different app (e.g. 480 Spacewar).
//
// DEV/testing OUTSIDE Steam: keep steam_appid.txt = 5066330 next to the app so
// the Steam client knows which app we are (you must own the app on that account).
// The shipped build ships NO steam_appid.txt (it's excluded from the package) —
// Steam provides the appid when it launches us.
function resolveAppId() {
  const raw = process.env.DE_STEAM_APPID || process.env.AEGIS_STEAM_APPID;
  const n = raw != null ? Number(raw) : NaN;
  return Number.isInteger(n) && n > 0 ? n : 5066330;
}
const STEAM_APP_ID = resolveAppId();

// Workshop item visibility, by ISteamUGC's ERemoteStoragePublishedFileVisibility.
const VISIBILITY = { public: 0, friends: 1, private: 2, unlisted: 3 };
const VISIBILITY_NAME = { 0: 'public', 1: 'friends', 2: 'private', 3: 'unlisted' };

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

  // STRICT publish gate (owner directive): only original work reaches Workshop —
  // from-scratch builder packs and your own re-downloaded items. Built-in seeds,
  // forks of them, and packs imported from other creators are refused. This is
  // the authoritative check (the UI also hides the button, but the renderer is
  // assumed hostile — CLAUDE.md).
  if (!packstore.isPublishable(appRoot, userDir, id)) {
    return { ok: false, error: 'Only dashboards you built from scratch — or your own re-downloaded Workshop items — can be published. Forks of built-in packs and dashboards imported from other creators can’t be republished as your own.' };
  }

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
      else { clearPublishedItem(userDir, id); } // stale mapping to a deleted item — start fresh
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
      if (isLimitExceeded(err)) return rateLimited;
      // "a file was not found" is almost always the preview — retry once without
      // it so the pack CONTENT still uploads (the item just won't get an image).
      if (/not found/i.test(emsg) && update.previewPath) {
        previewSkipped = true;
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
    // Steam's k_EResultBusy on CreateItem. This is EXPECTED on a brand-new AppID:
    // after you enable Community Workshop, Steam's backend takes a while to
    // provision it before the first item can be created — commonly minutes, but
    // sometimes hours, occasionally up to a day. Not a pack/code problem.
    if (/busy/i.test(msg)) {
      return { ok: false, error: 'Steam returned “busy”. This is normal for a brand-new AppID — after enabling Community Workshop, Steam needs time to set it up (often minutes, sometimes up to a day) before the first item can be created. Make sure Workshop is ENABLED and the app’s Steamworks config is PUBLISHED, then try again later. The pack is fine — the same publish works on an established app.' };
    }
    return { ok: false, error: `Workshop upload failed: ${msg}` };
  }
}

// ── creator: my published dashboards ─────────────────────────────────────────
//
// A place to SEE and MANAGE the Workshop items you've published — machine-
// portable because Steam (not local state) is the durable store. On any machine
// signed into the same Steam account, listMine() enumerates your items and
// getEditableCopy() re-downloads one and restores the packId→itemId mapping so
// "Update" targets the SAME item. Both paths are gated to items Steam certifies
// you own; Steam also rejects updateItem SERVER-SIDE on items you don't own.

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Does a local, editable pack still exist on THIS machine for a mapped id?
// (The item mapping can outlive the local pack — e.g. after uninstall.)
function localPackExists(userDir, id) {
  try { return fs.existsSync(path.join(userDir, 'packs', String(id), 'pack.json')); }
  catch (e) { return false; }
}

// Is this Workshop item published by the signed-in Steam account? Primary check:
// the item's own owner record. Fallback: Steam's authoritative list of items
// THIS account published (getUserItems / Published). Either positive → owned;
// if both are inconclusive we REFUSE (fail closed) — this is the gate that stops
// one user from pulling down and editing another creator's item locally.
async function ownsItem(c, itemId) {
  let myAccount;
  try { myAccount = Number(c.localplayer.getSteamId().accountId); } catch (e) { return false; }
  try {
    const item = await c.workshop.getItem(itemId);
    if (item && item.owner && Number(item.owner.accountId) === myAccount) return true;
  } catch (e) { /* fall through to the authoritative list check */ }
  try {
    const want = itemId.toString();
    let seen = 0;
    for (let page = 1; page <= 10; page++) {
      const res = await c.workshop.getUserItems(page, myAccount, 0, 0, 1, { creator: STEAM_APP_ID, consumer: STEAM_APP_ID });
      const items = (res && res.items) || [];
      for (const it of items) {
        if (it && it.publishedFileId != null && it.publishedFileId.toString() === want) return true;
      }
      seen += items.length;
      if (items.length === 0 || seen >= ((res && res.totalResults) || 0)) break;
    }
  } catch (e) { /* fall through */ }
  return false;
}

// Current visibility of a published item ('public' | 'friends' | 'private' |
// 'unlisted'), or null if it can't be determined (Steam down, deleted item).
// Used so the publish dialog defaults an UPDATE to the item's existing
// visibility rather than a fixed default — no accidental re-publish as the wrong
// audience. getItem first (one call); fall back to the authoritative user-items
// scan (same source listMine reads) if getItem omits the field.
async function getItemVisibility(itemId) {
  const c = ensureClient();
  if (!c) return null;
  const want = String(itemId || '');
  if (!/^[0-9]+$/.test(want)) return null;
  try {
    const info = await c.workshop.getItem(want);
    if (info && info.visibility != null && VISIBILITY_NAME[info.visibility]) return VISIBILITY_NAME[info.visibility];
  } catch (e) { /* fall through to the authoritative list */ }
  try {
    const myAccount = Number(c.localplayer.getSteamId().accountId);
    let seen = 0;
    for (let page = 1; page <= 10; page++) {
      const res = await c.workshop.getUserItems(page, myAccount, 0, 0, 1, { creator: STEAM_APP_ID, consumer: STEAM_APP_ID });
      const items = (res && res.items) || [];
      for (const it of items) {
        if (it && it.publishedFileId != null && it.publishedFileId.toString() === want && it.visibility != null) {
          return VISIBILITY_NAME[it.visibility] || null;
        }
      }
      seen += items.length;
      if (items.length === 0 || seen >= ((res && res.totalResults) || 0)) break;
    }
  } catch (e) { /* fail-soft — the dialog keeps its default */ }
  return null;
}

// Enumerate the Workshop items this Steam account has published for our app.
// Each item is tagged with a localPackId when an editable copy exists here.
async function listMine(userDir) {
  const c = ensureClient();
  if (!c) return { ok: false, error: lastReason || 'Steam is not available.', items: [] };
  let myAccount;
  try { myAccount = Number(c.localplayer.getSteamId().accountId); }
  catch (e) { return { ok: false, error: 'Could not read your Steam account.', items: [] }; }

  // Reverse the local packId→itemId mapping so each item can show whether a
  // local, editable copy exists on THIS machine.
  const published = loadPublished(userDir);
  const itemToPack = new Map();
  for (const [packId, itemId] of Object.entries(published)) {
    if (typeof itemId === 'string' && /^[0-9]+$/.test(itemId)) itemToPack.set(itemId, packId);
  }

  try {
    const out = [];
    const seenIds = new Set();
    let seen = 0;
    for (let page = 1; page <= 10; page++) {
      const res = await c.workshop.getUserItems(page, myAccount, 0, 0, 1, { creator: STEAM_APP_ID, consumer: STEAM_APP_ID });
      const items = (res && res.items) || [];
      for (const it of items) {
        if (!it || it.publishedFileId == null) continue;
        // Voices are a separate item type — keep them out of the dashboards list.
        if (Array.isArray(it.tags) && it.tags.some((t) => String(t).toLowerCase() === VOICE_TAG)) continue;
        const idStr = it.publishedFileId.toString();
        if (seenIds.has(idStr)) continue;
        seenIds.add(idStr);
        const mapped = itemToPack.get(idStr) || null;
        out.push({
          itemId: idStr,
          title: String(it.title || 'Untitled').slice(0, 120),
          description: String(it.description || '').replace(/\[[^\]]*\]/g, '').slice(0, 200),
          tags: Array.isArray(it.tags) ? it.tags.slice(0, 8) : [],
          votesUp: Number(it.numUpvotes) || 0,
          visibility: VISIBILITY_NAME[it.visibility] || null,
          url: it.url || `https://steamcommunity.com/sharedfiles/filedetails/?id=${idStr}`,
          previewUrl: typeof it.previewUrl === 'string' ? it.previewUrl : null,
          // Only surface a local id whose pack still exists on disk here.
          localPackId: mapped && localPackExists(userDir, mapped) ? mapped : null,
        });
      }
      seen += items.length;
      if (items.length === 0 || seen >= ((res && res.totalResults) || 0)) break;
    }
    return { ok: true, items: out, testApp: STEAM_APP_ID === 480 };
  } catch (err) {
    return { ok: false, error: err.message, items: [] };
  }
}

// Download YOUR published item and import it as a local, editable pack, then
// restore the packId→itemId mapping so a later publish UPDATES that same item.
// Gated to items you own — this is how a creator moves to a new machine and
// keeps editing their own dashboards.
async function getEditableCopy(appRoot, userDir, itemId) {
  const c = ensureClient();
  if (!c) return { ok: false, error: lastReason || 'Steam is not available.' };
  let id;
  try { id = BigInt(String(itemId)); } catch (e) { return { ok: false, error: 'Invalid item id.' }; }

  if (!(await ownsItem(c, id))) {
    return { ok: false, error: 'That Workshop item isn’t published by your Steam account, so it can’t be edited here.' };
  }

  // Make sure Steam has the content on disk: reuse an existing install, else
  // subscribe (keeps it in your library) + kick a high-priority download and
  // wait for it. await delay yields, so main stays responsive.
  let folder = null;
  try {
    const have = c.workshop.installInfo(id);
    if (have && have.folder && fs.existsSync(path.join(have.folder, 'pack.json'))) folder = have.folder;
  } catch (e) { /* not installed yet */ }
  if (!folder) {
    try { await c.workshop.subscribe(id); } catch (e) { /* possibly already subscribed */ }
    try { c.workshop.download(id, true); } catch (e) { /* best-effort */ }
    for (let i = 0; i < 40 && !folder; i++) {
      await delay(750);
      try {
        const info = c.workshop.installInfo(id);
        if (info && info.folder && fs.existsSync(path.join(info.folder, 'pack.json'))) folder = info.folder;
      } catch (e) { /* keep waiting */ }
    }
  }
  if (!folder) {
    return { ok: false, error: 'Steam is still downloading this item — give it a moment, then try “Get editable copy” again.' };
  }

  const exported = packstore.exportPack(folder);
  if (!exported.ok) return exported;
  // source:'editor' → edits save IN PLACE, so the pack id stays stable and the
  // update mapping keeps pointing at the right item. origin:'own-workshop' →
  // passes the strict publish gate (it's your own work).
  const installed = packstore.installFromBuffer(appRoot, userDir, exported.buffer, {
    source: 'editor', origin: 'own-workshop', workshopId: id.toString(),
  });
  if (!installed.ok) return installed;
  setPublishedItem(userDir, installed.id, id.toString());
  return { ok: true, packId: installed.id, warnings: installed.warnings || [] };
}

// ── voices: publish / manage / consume sharable voice profiles ───────────────
//
// A published "voice" is the ~1 KB profile JSON only — a base-voice id plus
// tuning parameters, NEVER audio (the project's hard legal boundary). It rides
// Workshop as its OWN item type, split from dashboards by VOICE_TAG. The base
// voice itself is never shipped; a subscriber who lacks it downloads it from the
// voice bank on demand. The `base:<voiceId>` tag lets a browse card show that
// dependency up front without downloading the item.

// profileFile → itemId, so re-publishing a voice UPDATES its item (parallel to
// workshop-items.json for packs; kept separate so the two never collide).
const VOICE_PUBLISHED_FILE = 'voice-items.json';

function voicePublishedFile(userDir) {
  return path.join(userDir, VOICE_PUBLISHED_FILE);
}

function loadVoicePublished(userDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(voicePublishedFile(userDir), 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch (err) {
    return {};
  }
}

function getPublishedVoiceItem(userDir, profileFile) {
  const value = loadVoicePublished(userDir)[profileFile];
  return typeof value === 'string' && /^[0-9]+$/.test(value) ? value : null;
}

function setPublishedVoiceItem(userDir, profileFile, itemId) {
  const map = loadVoicePublished(userDir);
  map[profileFile] = String(itemId);
  try {
    fs.mkdirSync(userDir, { recursive: true });
    fs.writeFileSync(voicePublishedFile(userDir), JSON.stringify(map, null, 2));
  } catch (err) { /* best-effort — a lost mapping just means a new item next time */ }
}

function clearPublishedVoiceItem(userDir, profileFile) {
  const map = loadVoicePublished(userDir);
  if (Object.prototype.hasOwnProperty.call(map, profileFile)) {
    delete map[profileFile];
    try { fs.writeFileSync(voicePublishedFile(userDir), JSON.stringify(map, null, 2)); } catch (err) { /* best-effort */ }
  }
}

// Does this item carry our voice marker tag? (getUserItems / getAllItems items
// expose `tags`.) Used to keep voice queries from matching dashboard items.
function isVoiceItem(it) {
  return !!(it && Array.isArray(it.tags) && it.tags.some((t) => String(t).toLowerCase() === VOICE_TAG));
}

// Extract the required base voice id from an item's `base:<id>` tag, if present.
function baseVoiceFromTags(tags) {
  if (!Array.isArray(tags)) return null;
  for (const t of tags) {
    const m = /^base:([a-z0-9_-]{1,32})$/i.exec(String(t));
    if (m) return m[1];
  }
  return null;
}

// Find one of our already-published VOICE items with this title (a voice
// published before the local mapping existed), so re-publishing UPDATES it
// instead of piling up duplicates. Best-effort — a bigint id or null.
async function findExistingVoiceByTitle(c, title) {
  const want = String(title || '').trim().toLowerCase();
  if (!want) return null;
  try {
    const me = c.localplayer.getSteamId();
    let seen = 0;
    for (let page = 1; page <= 8; page++) {
      const res = await c.workshop.getUserItems(page, me.accountId, 0, 0, 1, { creator: STEAM_APP_ID, consumer: STEAM_APP_ID });
      const items = (res && res.items) || [];
      for (const it of items) {
        if (isVoiceItem(it) && it.title && String(it.title).trim().toLowerCase() === want) return it.publishedFileId;
      }
      seen += items.length;
      if (items.length === 0 || seen >= ((res && res.totalResults) || 0)) break;
    }
  } catch (err) { /* fall through — create a new item */ }
  return null;
}

// Stage a voice for upload: a content folder holding ONLY voice.json (the
// sanitized profile, stripped of the publisher's own mapping/provenance) plus a
// sibling preview image. Same stable-folder approach as packs (Steam reads the
// content asynchronously after updateItem resolves).
function stageVoiceContent(userDir, profileFile, profile, previewPath) {
  const safeId = String(profileFile).replace(/[^a-z0-9_-]/gi, '_') || 'voice';
  const root = stagingRoot(userDir);
  const stageDir = path.join(root, `voice__${safeId}`);
  fs.rmSync(stageDir, { recursive: true, force: true });
  fs.mkdirSync(stageDir, { recursive: true });
  // Publish a clean profile: keep name/author/base/tuning; drop the publisher's
  // own workshop mapping + provenance (the downloader stamps its own on import).
  const shared = profiles.sanitizeProfile(profile);
  delete shared.origin;
  delete shared.workshopId;
  fs.writeFileSync(path.join(stageDir, 'voice.json'), JSON.stringify(shared, null, 2) + '\n', 'utf8');

  let stagedPreview = null;
  if (previewPath && fs.existsSync(previewPath)) {
    const ext = (path.extname(previewPath) || '.png').toLowerCase();
    const dest = path.join(root, `voice__${safeId}__preview${PREVIEW_EXTS.includes(ext) ? ext : '.png'}`);
    try { fs.rmSync(dest, { force: true }); fs.copyFileSync(previewPath, dest); stagedPreview = dest; } catch (e) { stagedPreview = null; }
  }
  return { stageDir, stagedPreview };
}

// Publish (or update) a voice profile to the Workshop. Gated to the user's own
// tuned voices — a factory preset or an imported voice is refused, both here
// (authoritative) and in the UI.
async function publishVoice(appRoot, userDir, opts) {
  const c = ensureClient();
  if (!c) return { ok: false, error: lastReason || 'Steam is not available.' };

  const profileFile = String(opts && opts.profileFile || '');
  if (!profiles.PROFILE_FILE_PATTERN.test(profileFile)) return { ok: false, error: 'Invalid voice profile.' };
  const full = path.join(profiles.profilesDir(appRoot), profileFile);
  if (!fs.existsSync(full)) return { ok: false, error: 'That voice profile no longer exists — save it first.' };

  // STRICT gate: only original, user-tuned voices reach the Workshop.
  if (!profiles.isPublishable(appRoot, profileFile)) {
    return { ok: false, error: 'Only voices you tuned yourself can be published. Factory presets and voices imported from other creators can’t be republished as your own.' };
  }

  const { profile } = profiles.loadProfile(full);
  const baseVoice = String(profile.base && profile.base.voice || '').slice(0, 32);

  try {
    let preview = opts && opts.previewPath && fs.existsSync(opts.previewPath) ? opts.previewPath : null;
    const { stageDir, stagedPreview } = stageVoiceContent(userDir, profileFile, profile, preview);
    const visibility = VISIBILITY[opts && opts.visibility] != null ? VISIBILITY[opts.visibility] : VISIBILITY.unlisted;

    // Resolve which item to update (same ladder as packs, but voice-scoped):
    // stored mapping (if it still exists) → our voice item with this title →
    // a fresh createItem.
    let itemId = null;
    let reused = false;
    const stored = getPublishedVoiceItem(userDir, profileFile);
    if (stored) {
      if (await itemExists(c, BigInt(stored))) { itemId = BigInt(stored); reused = true; }
      else { clearPublishedVoiceItem(userDir, profileFile); }
    }
    // An own-workshop re-download carries its item id INSIDE the profile, so a
    // later publish targets the same item even if the file was renamed (which
    // would break the filename→id map). Steam still gates updateItem server-side
    // on ownership, so trusting this id can never let you write someone else's item.
    if (!itemId && profile.workshopId && /^[0-9]+$/.test(String(profile.workshopId))) {
      if (await itemExists(c, BigInt(profile.workshopId))) { itemId = BigInt(profile.workshopId); reused = true; setPublishedVoiceItem(userDir, profileFile, itemId.toString()); }
    }
    if (!itemId) {
      const found = await findExistingVoiceByTitle(c, (opts && opts.title) || profile.name);
      if (found) { itemId = found; reused = true; setPublishedVoiceItem(userDir, profileFile, itemId.toString()); }
    }
    if (!itemId) {
      const created = await c.workshop.createItem(STEAM_APP_ID);
      itemId = created.itemId;
      setPublishedVoiceItem(userDir, profileFile, itemId.toString());
    }

    // Tags: the reserved marker + the base-voice dependency + any user tags,
    // deduped, Steam's per-tag length + count caps applied.
    const userTags = Array.isArray(opts && opts.tags) ? opts.tags.map((t) => String(t).slice(0, 24)) : [];
    const tags = [...new Set([VOICE_TAG, `base:${baseVoice}`, ...userTags].filter(Boolean))].slice(0, 10);

    const update = {
      title: String(opts && opts.title || profile.name || 'Untitled voice').slice(0, 128),
      description: String(opts && opts.description || '').slice(0, 8000),
      changeNote: 'Published from Dashboard Engine.',
      contentPath: stageDir,
      tags,
      visibility,
    };
    if (stagedPreview) update.previewPath = stagedPreview;

    const rateLimited = {
      ok: false,
      error: 'Steam is rate-limiting Workshop uploads — too many publishes in a short time. Wait ~15–30 minutes, then publish once. Your voice is valid; only Steam’s upload throttle is blocking.',
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
      if (isLimitExceeded(err)) return rateLimited;
      if (/not found/i.test(String((err && err.message) || err)) && update.previewPath) {
        previewSkipped = true;
        try { result = await submit(false); }
        catch (err2) { if (isLimitExceeded(err2)) return rateLimited; throw err2; }
      } else {
        throw err;
      }
    }
    setPublishedVoiceItem(userDir, profileFile, itemId.toString());
    return {
      ok: true,
      itemId: itemId.toString(),
      updated: reused,
      note: previewSkipped ? 'Steam wouldn’t accept the preview image, so the voice was published without one.' : null,
      needsToAcceptAgreement: !!result.needsToAcceptAgreement,
      url: `https://steamcommunity.com/sharedfiles/filedetails/?id=${itemId.toString()}`,
    };
  } catch (err) {
    const msg = String((err && err.message) || err);
    if (isLimitExceeded(err)) {
      return { ok: false, error: 'You’ve reached this app’s Workshop item limit. Delete some at steamcommunity.com → your Workshop files, then retry.' };
    }
    if (/busy/i.test(msg)) {
      return { ok: false, error: 'Steam returned “busy”. This is normal for a brand-new AppID — Workshop needs time to provision after you enable it. Try again later.' };
    }
    return { ok: false, error: `Voice upload failed: ${msg}` };
  }
}

// Browse the app's Workshop for VOICE items. Same shape as browse(), but each
// card also carries the required base voice id (from the base: tag) so the UI
// can show + resolve the dependency.
async function browseVoices(opts) {
  const c = ensureClient();
  if (!c) return { ok: false, error: lastReason || 'Steam is not available.', items: [] };
  const page = Math.max(1, Math.min(50, Number(opts && opts.page) || 1));
  const search = String((opts && opts.search) || '').trim().slice(0, 120);
  const queryType = SORT_QUERY[(opts && opts.sort)] != null ? SORT_QUERY[opts.sort] : SORT_QUERY.trend;
  try {
    const subs = new Set(((c.workshop.getSubscribedItems && c.workshop.getSubscribedItems()) || []).map((x) => x.toString()));
    const res = await c.workshop.getAllItems(
      page, queryType, 0 /* UGCType.Items */, STEAM_APP_ID, STEAM_APP_ID,
      { searchText: search || undefined, includeLongDescription: false, requiredTags: [VOICE_TAG] },
    );
    // Client-side require the tag too, in case this binding ignores requiredTags.
    const items = ((res && res.items) || []).filter(isVoiceItem).map((it) => {
      const id = it.publishedFileId.toString();
      let downloaded = false;
      if (subs.has(id)) { try { const info = c.workshop.installInfo(it.publishedFileId); downloaded = !!(info && info.folder); } catch (e) { downloaded = false; } }
      return {
        itemId: id,
        title: String(it.title || 'Untitled voice').slice(0, 120),
        description: String(it.description || '').replace(/\[[^\]]*\]/g, '').slice(0, 200),
        tags: Array.isArray(it.tags) ? it.tags.filter((t) => String(t).toLowerCase() !== VOICE_TAG && !/^base:/i.test(String(t))).slice(0, 8) : [],
        baseVoice: baseVoiceFromTags(it.tags),
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

// The VOICE items this Steam account has published, each tagged with a
// localProfileFile when an editable copy exists on THIS machine.
async function listMineVoices(appRoot, userDir) {
  const c = ensureClient();
  if (!c) return { ok: false, error: lastReason || 'Steam is not available.', items: [] };
  let myAccount;
  try { myAccount = Number(c.localplayer.getSteamId().accountId); }
  catch (e) { return { ok: false, error: 'Could not read your Steam account.', items: [] }; }

  // Reverse the profileFile→itemId map, and note which local profiles still exist.
  const published = loadVoicePublished(userDir);
  const itemToProfile = new Map();
  for (const [file, itemId] of Object.entries(published)) {
    if (typeof itemId === 'string' && /^[0-9]+$/.test(itemId)) itemToProfile.set(itemId, file);
  }
  const localFiles = new Set(profiles.listProfiles(appRoot).map((p) => p.file));

  try {
    const out = [];
    const seenIds = new Set();
    let seen = 0;
    for (let page = 1; page <= 10; page++) {
      const res = await c.workshop.getUserItems(page, myAccount, 0, 0, 1, { creator: STEAM_APP_ID, consumer: STEAM_APP_ID });
      const items = (res && res.items) || [];
      for (const it of items) {
        if (!isVoiceItem(it) || it.publishedFileId == null) continue;
        const idStr = it.publishedFileId.toString();
        if (seenIds.has(idStr)) continue;
        seenIds.add(idStr);
        const mappedFile = itemToProfile.get(idStr) || null;
        out.push({
          itemId: idStr,
          title: String(it.title || 'Untitled voice').slice(0, 120),
          description: String(it.description || '').replace(/\[[^\]]*\]/g, '').slice(0, 200),
          tags: Array.isArray(it.tags) ? it.tags.filter((t) => String(t).toLowerCase() !== VOICE_TAG && !/^base:/i.test(String(t))).slice(0, 8) : [],
          baseVoice: baseVoiceFromTags(it.tags),
          votesUp: Number(it.numUpvotes) || 0,
          visibility: VISIBILITY_NAME[it.visibility] || null,
          url: it.url || `https://steamcommunity.com/sharedfiles/filedetails/?id=${idStr}`,
          previewUrl: typeof it.previewUrl === 'string' ? it.previewUrl : null,
          localProfileFile: mappedFile && localFiles.has(mappedFile) ? mappedFile : null,
        });
      }
      seen += items.length;
      if (items.length === 0 || seen >= ((res && res.totalResults) || 0)) break;
    }
    return { ok: true, items: out, testApp: STEAM_APP_ID === 480 };
  } catch (err) {
    return { ok: false, error: err.message, items: [] };
  }
}

// Read a downloaded voice item's voice.json → { ok, profile } or { ok:false }.
// The content marker (voice.json vs pack.json) is the authoritative type check.
function readVoiceJson(folder) {
  try {
    const file = path.join(folder, 'voice.json');
    if (!fs.existsSync(file)) return { ok: false, error: 'That Workshop item isn’t a voice profile.' };
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { ok: true, profile: raw };
  } catch (err) {
    return { ok: false, error: `Could not read the voice: ${err.message}` };
  }
}

// Make sure Steam has an item's content on disk (reuse install, else subscribe +
// download and wait). Returns the folder or null. Shared by getEditable/import.
async function ensureItemFolder(c, id, marker) {
  let folder = null;
  try {
    const have = c.workshop.installInfo(id);
    if (have && have.folder && fs.existsSync(path.join(have.folder, marker))) folder = have.folder;
  } catch (e) { /* not installed yet */ }
  if (!folder) {
    try { await c.workshop.subscribe(id); } catch (e) { /* maybe already subscribed */ }
    try { c.workshop.download(id, true); } catch (e) { /* best-effort */ }
    for (let i = 0; i < 40 && !folder; i++) {
      await delay(750);
      try {
        const info = c.workshop.installInfo(id);
        if (info && info.folder && fs.existsSync(path.join(info.folder, marker))) folder = info.folder;
      } catch (e) { /* keep waiting */ }
    }
  }
  return folder;
}

// Download YOUR published voice and import it as a local, editable profile, then
// restore the profileFile→itemId mapping so a later publish UPDATES that item.
// Gated to items you own — this is how a creator moves machines and keeps
// editing their own voices.
async function getEditableVoice(appRoot, userDir, itemId) {
  const c = ensureClient();
  if (!c) return { ok: false, error: lastReason || 'Steam is not available.' };
  let id;
  try { id = BigInt(String(itemId)); } catch (e) { return { ok: false, error: 'Invalid item id.' }; }

  if (!(await ownsItem(c, id))) {
    return { ok: false, error: 'That Workshop voice isn’t published by your Steam account, so it can’t be edited here.' };
  }
  const folder = await ensureItemFolder(c, id, 'voice.json');
  if (!folder) return { ok: false, error: 'Steam is still downloading this voice — give it a moment, then try again.' };

  const read = readVoiceJson(folder);
  if (!read.ok) return read;
  // origin:'own-workshop' → passes the publish gate (it's your own work) and the
  // mapping keeps a later publish pointed at the same item.
  const imported = profiles.importVoiceProfile(appRoot, read.profile, { origin: 'own-workshop', workshopId: id.toString() });
  if (!imported.ok) return imported;
  setPublishedVoiceItem(userDir, imported.file, id.toString());
  return { ok: true, file: imported.file, name: imported.profile.name, baseVoice: imported.profile.base.voice };
}

// Bring a subscribed Workshop voice into the local profile list. Stamped
// 'imported' → it can be used + tuned, but not republished as the user's own.
async function importVoice(appRoot, userDir, itemId) {
  const c = ensureClient();
  if (!c) return { ok: false, error: lastReason || 'Steam is not available.' };
  let id;
  try { id = BigInt(String(itemId)); } catch (e) { return { ok: false, error: 'Invalid item id.' }; }
  const folder = await ensureItemFolder(c, id, 'voice.json');
  if (!folder) return { ok: false, error: 'That voice isn’t downloaded yet — let Steam finish, then retry.' };
  const read = readVoiceJson(folder);
  if (!read.ok) return read;
  // No workshopId mapping — this is someone else's item, not one this user can
  // update. (getEditableVoice, for YOUR own item, is what records a mapping.)
  const imported = profiles.importVoiceProfile(appRoot, read.profile, { origin: 'imported' });
  if (!imported.ok) return imported;
  return { ok: true, file: imported.file, name: imported.profile.name, baseVoice: imported.profile.base.voice };
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
      { searchText: search || undefined, includeLongDescription: false, excludedTags: [VOICE_TAG] },
    );
    // Belt-and-braces: also drop voice items client-side in case this binding
    // build ignores excludedTags, so the Dashboards browse never shows a voice.
    const items = ((res && res.items) || []).filter(Boolean)
      .filter((it) => !(Array.isArray(it.tags) && it.tags.some((t) => String(t).toLowerCase() === VOICE_TAG)))
      .map((it) => {
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
  let id;
  try { id = BigInt(String(itemId)); } catch (e) { return Promise.resolve({ ok: false, error: 'Invalid item id.' }); }
  return c.workshop.subscribe(id)
    .then(() => ({ ok: true }))
    .catch((err) => ({ ok: false, error: err.message }));
}

module.exports = {
  // getClient exposes the single, fail-soft Steam client (ensureClient) so other
  // main-side modules — e.g. lib/achievements — reuse it instead of re-init'ing.
  STEAM_APP_ID, status, getClient: ensureClient, publish, browse, previewDataUri, workshopPageUrl,
  listSubscribed, importSubscribed, subscribe, listMine, getEditableCopy, getPublishedItem, getItemVisibility,
  // Voice profiles (separate Workshop item type).
  VOICE_TAG, publishVoice, browseVoices, listMineVoices, getEditableVoice, importVoice, getPublishedVoiceItem,
};
