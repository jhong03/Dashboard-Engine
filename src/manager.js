'use strict';

// Manager renderer — the engine app. Pure content navigation and selection:
// browse the library and registries, install/export/uninstall, and pick
// which pack the desktop renders (active pack). The desktop surface itself
// is a separate window; USE just flips the active pack over IPC.

/* global aegis */

const $ = (id) => document.getElementById(id);

// UI localization shortcut. i18n.js (loaded first) defines window.t; this alias
// is fail-soft so a missing runtime just yields the key's English fallback.
const t = (key, params) => (window.t ? window.t(key, params) : key);

// The active UI language for Intl date formatting (month names, weekdays), so
// the calendar matches the chosen interface language. undefined = OS locale.
const uiLang = () => (window.I18n && window.I18n.lang) || undefined;

const library = {
  tab: 'installed',
  search: '',
  activeId: null,
  localPacks: [],
  registries: [],
  indexes: new Map(),   // registry url → fetched index (or {ok:false})
  selected: null,       // { kind: 'local', item } | { kind: 'remote', url, entry, update } | { kind: 'workshop', item, inLibrary }
  wsAccess: null,       // Workshop usable now? null=unknown, true (dev/session), false (needs Steam session)
};

// ── Small helpers ───────────────────────────────────────────────────────────

function hexToRgbParts(hex) {
  let h = hex.slice(1);
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
}

function rgba(hex, alpha) {
  const [r, g, b] = hexToRgbParts(hex);
  return `rgba(${r}, ${g}, ${b}, ${Math.max(0, Math.min(1, alpha)).toFixed(3)})`;
}

function libStatus(text, warn) {
  const el = $('library-status');
  el.textContent = text || '';
  el.className = `status-line-app${warn ? ' warn' : ''}`;
}

function libButton(label, onClick, kind) {
  const btn = document.createElement('button');
  btn.className = `btn${kind ? ` ${kind}` : ''}`;
  btn.textContent = label;
  btn.addEventListener('click', onClick);
  return btn;
}

function setActiveIndicator() {
  const active = library.localPacks.find((p) => p.id === library.activeId);
  $('active-name').textContent = active ? active.name : (library.activeId || '—');
}

// ── Thumbnails ──────────────────────────────────────────────────────────────

// Real previews: local packs render through the SAME module as the desktop
// (components.js), scaled down by cqw units. Card thumbs freeze after a few
// telemetry ticks; the detail sidebar preview stays fully live (in motion).

const packCache = new Map();      // id → { pack, assets } | null (load failed)
let detailPreview = null;         // the one live sidebar renderer
let detailPreviewEl = null;       // the sidebar preview element (re-rendered on prop changes)
let displayAspect = null;         // "width / height" of the primary display

function previewServices() {
  return {
    stats: () => aegis.stats(),
    weather: (opts) => aegis.weather(opts),
    reminders: (window) => aegis.remindersList(window),
    launcher: { state: (opts) => aegis.launcherState(opts) }, // no launch() → tiles inert
    // Sample toasts, never real notifications — the manager preview is shareable.
    notifications: () => Promise.resolve({ ok: true, granted: true, notifications: AegisComponents.demoNotifications() }),
  };
}

async function loadPackFull(id) {
  if (packCache.has(id)) return packCache.get(id);
  let loaded = null;
  try {
    const res = await aegis.packLoad(id);
    if (res.ok) loaded = { pack: res.pack, assets: res.assets };
  } catch { /* fall back to the blueprint */ }
  packCache.set(id, loaded);
  return loaded;
}

// Build the same skin-root / canvas-outer / canvas nesting the desktop uses,
// inside any container, and render the pack into it. Cards pass
// staticAmbience so particles draw one frame instead of animating.
function renderPackInto(container, pack, assets, renderer, opts) {
  container.textContent = '';
  const skin = document.createElement('div');
  skin.className = 'thumb-skin';
  const outer = document.createElement('div');
  outer.className = 'canvas-outer';
  const canvas = document.createElement('div');
  canvas.className = 'canvas';
  outer.appendChild(canvas);
  skin.appendChild(outer);
  container.appendChild(skin);
  AegisComponents.applySkin(skin, pack, assets, opts);
  renderer.render(canvas, pack, assets);
}

function destroyDetailPreview() {
  if (detailPreview) {
    detailPreview.destroy();
    detailPreview = null;
  }
  detailPreviewEl = null;
}

// Card thumb: a cached STATIC snapshot rendered in main from DEMO data (no
// personal info, and no live per-card rendering). A blueprint/monogram shows
// instantly and stays if the snapshot can't be produced. The snapshot is
// regenerated whenever the pack is saved (its pack.json mtime moves).
async function imageThumbInto(thumb, id, fallbackPack) {
  if (fallbackPack) blueprintInto(thumb, fallbackPack); else monogramInto(thumb, id);
  const res = await aegis.packThumbnail(id);
  if (!thumb.isConnected) return; // gallery re-rendered while we rendered
  if (res && res.ok && res.uri) {
    thumb.textContent = '';
    thumb.style.background = 'none';
    const img = document.createElement('img');
    img.className = 'thumb-img';
    img.alt = '';
    img.src = res.uri;
    thumb.appendChild(img);
  }
}

// Sidebar: the actual pack, actually running — clock ticking, history
// filling, ambience drifting — at the real display's aspect ratio.
async function livePreviewInto(preview, id) {
  if (!displayAspect) {
    try {
      const display = await aegis.display();
      if (display.ok) displayAspect = `${display.width} / ${display.height}`;
    } catch { /* keep the CSS default aspect */ }
  }
  const loaded = await loadPackFull(id);
  if (!preview.isConnected || !loaded) return false;
  if (displayAspect) preview.style.aspectRatio = displayAspect;
  destroyDetailPreview();
  detailPreview = AegisComponents.createRenderer(previewServices());
  detailPreviewEl = preview; // so a prop change can re-render into this element
  renderPackInto(preview, loaded.pack, loaded.assets, detailPreview);
  return true;
}

// Re-render the sidebar preview after a user-property change, so the customize
// controls feel live. The desktop updates separately via the packs:changed
// broadcast from main.
async function refreshDetailPreview(id) {
  packCache.delete(id);
  const el = detailPreviewEl; // livePreviewInto resets the ref mid-call; hold it
  if (el && el.isConnected) await livePreviewInto(el, id);
}

// One labelled control for a user property. Discrete controls save on change;
// the slider updates its number live but saves on release (no IPC spam).
// The Customize knobs are authored in each pack.json, so their labels are pack
// CONTENT — but the built-in seed packs use a fixed, standard set, and the
// particle options map to the engine's canonical ambience-effect VALUES. So we
// localize KNOWN standard labels/options and leave any genuinely custom pack
// text exactly as the author wrote it.
const STD_KNOB_LABELS = {
  'Accent colour': 'manager.customize.knob.accent',
  'Highlight colour': 'manager.customize.knob.highlight',
  'Particles': 'manager.customize.knob.particles',
  'Particle density': 'manager.customize.knob.density',
  'Corner notches': 'manager.customize.knob.notches',
};
const STD_EFFECTS = new Set(['none', 'embers', 'dust', 'snow', 'petals', 'rain', 'sparkle']);
function knobLabelText(label) {
  const key = STD_KNOB_LABELS[label];
  return key ? t(key) : label; // custom labels pass through untouched
}
function knobOptionText(value, label) {
  return STD_EFFECTS.has(String(value)) ? t(`manager.customize.effect.${value}`) : label;
}

function buildPropControl(prop, value, packId) {
  const row = document.createElement('label');
  row.className = 'prop-row';
  const label = document.createElement('span');
  label.className = 'prop-label';
  label.textContent = knobLabelText(prop.label);

  const save = async (v) => {
    const out = await aegis.userPropsSet(packId, prop.key, v);
    if (out.ok) refreshDetailPreview(packId);
  };

  if (prop.type === 'color') {
    const input = document.createElement('input');
    input.type = 'color';
    input.className = 'prop-color';
    input.value = normalizeHex(value) || '#000000';
    input.addEventListener('change', () => save(input.value));
    row.append(label, input);
  } else if (prop.type === 'slider') {
    const input = document.createElement('input');
    input.type = 'range';
    input.className = 'prop-range';
    input.min = String(prop.min);
    input.max = String(prop.max);
    input.step = String(prop.step);
    input.value = String(value);
    const out = document.createElement('span');
    out.className = 'prop-num';
    out.textContent = formatPropNum(value);
    input.addEventListener('input', () => { out.textContent = formatPropNum(Number(input.value)); });
    input.addEventListener('change', () => save(Number(input.value)));
    row.append(label, input, out);
  } else if (prop.type === 'select') {
    const select = document.createElement('select');
    select.className = 'prop-select';
    for (const opt of prop.options) {
      const o = document.createElement('option');
      o.value = String(opt.value);
      o.textContent = knobOptionText(opt.value, opt.label);
      select.appendChild(o);
    }
    select.value = String(value);
    select.addEventListener('change', () => save(select.value));
    row.append(label, select);
  } else { // toggle
    row.classList.add('prop-toggle');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = value === true;
    input.addEventListener('change', () => save(input.checked));
    row.append(input, label);
  }
  return row;
}

function formatPropNum(n) {
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

// A color <input> needs #rrggbb; packs may store #rgb or #rrggbbaa.
function normalizeHex(hex) {
  if (typeof hex !== 'string') return null;
  const m = hex.trim().replace(/^#/, '');
  if (/^[0-9a-fA-F]{3}$/.test(m)) return `#${m[0]}${m[0]}${m[1]}${m[1]}${m[2]}${m[2]}`;
  if (/^[0-9a-fA-F]{6}$/.test(m) || /^[0-9a-fA-F]{8}$/.test(m)) return `#${m.slice(0, 6)}`;
  return null;
}

// The "Customize" block in pack detail. Filled async so the pack's declared
// props (+ the user's current values) can be fetched without blocking render.
async function fillCustomize(box, id) {
  const res = await aegis.userPropsGet(id);
  if (!box.isConnected || !res.ok || res.props.length === 0) return;
  const title = document.createElement('h4');
  title.className = 'customize-title';
  title.textContent = t('manager.customize.title');
  box.appendChild(title);
  for (const prop of res.props) {
    box.appendChild(buildPropControl(prop, res.values[prop.key], id));
  }
  const reset = libButton(t('manager.customize.reset'), async () => {
    await aegis.userPropsReset(id);
    refreshDetailPreview(id);
    fillCustomizeReload(box, id);
  }, 'tiny');
  box.appendChild(reset);
  box.classList.remove('hidden');
}

// After a reset, rebuild the controls from the (now default) values.
function fillCustomizeReload(box, id) {
  box.textContent = '';
  fillCustomize(box, id);
}

// Blueprint thumbnail: the pack's palette + component rects drawn as glass
// boxes. Cheap, needs no assets — the fallback when a real render can't run.
function blueprintInto(container, pack) {
  const palette = pack.skin.palette;
  container.style.background =
    `radial-gradient(120% 90% at 50% 0%, ${rgba(palette.accent, 0.12)}, transparent 60%), ${palette.void}`;
  for (const component of pack.components) {
    const box = document.createElement('div');
    box.className = 'bp-comp';
    const [x, y, w, h] = component.rect;
    box.style.left = `${x}%`;
    box.style.top = `${y}%`;
    box.style.width = `${w}%`;
    box.style.height = `${h}%`;
    const accent = component.style.accent || palette.accent;
    const panel = component.style.panel !== null ? component.style.panel : true;
    box.style.borderColor = rgba(accent, 0.55);
    box.style.background = panel ? rgba(palette.glass, 0.45) : 'transparent';
    container.appendChild(box);
  }
}

function monogramInto(container, name) {
  container.style.background = 'radial-gradient(120% 90% at 50% 0%, rgba(255,255,255,0.05), transparent 60%), rgba(0,0,0,0.5)';
  const letter = document.createElement('div');
  letter.style.cssText = 'position:absolute;inset:0;display:grid;place-items:center;font-size:2.2rem;font-weight:700;opacity:0.35;';
  letter.textContent = (name || '?').slice(0, 1).toUpperCase();
  container.appendChild(letter);
}

// ── Gallery ─────────────────────────────────────────────────────────────────

function makeCard({ name, badge, badgeClass, master, selected, buildThumb, onSelect }) {
  const card = document.createElement('button');
  card.type = 'button';
  card.className = 'card';
  card.setAttribute('aria-pressed', String(selected));
  const thumb = document.createElement('div');
  thumb.className = 'thumb';
  buildThumb(thumb);
  const label = document.createElement('span');
  label.className = 'card-name';
  label.textContent = name;
  card.append(thumb, label);
  // The user's own editable copy — the one that edits in place and can be updated
  // to the Workshop under their Steam ID (vs a read-only original that forks on
  // edit). A corner chip so it's distinguishable from a near-identical original.
  if (master) {
    const m = document.createElement('span');
    m.className = 'card-master';
    m.textContent = t('manager.installed.master');
    m.title = t('manager.installed.masterHint');
    card.appendChild(m);
  }
  if (badge) {
    const badgeEl = document.createElement('span');
    badgeEl.className = `badge${badgeClass ? ` ${badgeClass}` : ''}`;
    badgeEl.textContent = badge;
    card.appendChild(badgeEl);
  }
  card.addEventListener('click', onSelect);
  return card;
}

function sectionLabel(text, buttons = []) {
  const el = document.createElement('div');
  el.className = 'section-label';
  const span = document.createElement('span');
  span.textContent = text;
  el.append(span, ...buttons);
  return el;
}

function matchesSearch(text) {
  return text.toLowerCase().includes(library.search.toLowerCase());
}

function isSelected(kind, key) {
  const s = library.selected;
  if (!s || s.kind !== kind) return false;
  if (kind === 'local') return s.item.id === key;
  if (kind === 'workshop') return s.item.itemId === key;
  if (kind === 'voice-workshop') return s.item.itemId === key;
  if (kind === 'published') return s.item.itemId === key;
  if (kind === 'published-voice') return s.item.itemId === key;
  return `${s.url}|${s.entry.id}` === key;
}

function renderGallery() {
  const gallery = $('gallery');
  gallery.textContent = '';
  $('reg-add').classList.toggle('hidden', library.tab !== 'browse');
  $('planner').classList.toggle('hidden', library.tab !== 'planner');
  $('launcher-cfg').classList.toggle('hidden', library.tab !== 'launcher');
  $('assistant-cfg').classList.toggle('hidden', library.tab !== 'assistant');
  $('create-cfg').classList.toggle('hidden', library.tab !== 'create');
  $('settings-cfg').classList.toggle('hidden', library.tab !== 'settings');
  const nonGallery = ['planner', 'launcher', 'assistant', 'create', 'settings'].includes(library.tab);
  gallery.classList.toggle('hidden', nonGallery);
  for (const t of ['installed', 'browse', 'published', 'create', 'planner', 'launcher', 'assistant', 'settings']) {
    $(`tab-${t}`).setAttribute('aria-selected', String(library.tab === t));
  }
  if (library.tab === 'planner') {
    renderPlanner();
    return;
  }
  if (library.tab === 'launcher') {
    renderLauncherCfg();
    return;
  }
  if (library.tab === 'assistant') {
    renderAssistantCfg();
    return;
  }
  if (library.tab === 'create') {
    renderCreate();
    return;
  }
  if (library.tab === 'settings') {
    renderSettingsCfg();
    return;
  }

  if (library.tab === 'installed') {
    for (const origin of ['installed', 'builtin']) {
      const items = library.localPacks.filter((p) => p.origin === origin && matchesSearch(p.name + p.id + (p.author || '')));
      gallery.appendChild(sectionLabel(origin === 'installed' ? t('manager.installed.sectionInstalled') : t('manager.installed.sectionBuiltin')));
      if (items.length === 0 && origin === 'installed') {
        const empty = document.createElement('p');
        empty.className = 'hint';
        empty.textContent = t('manager.installed.empty');
        gallery.appendChild(empty);
      }
      for (const item of items) {
        gallery.appendChild(makeCard({
          name: item.name,
          badge: item.id === library.activeId ? t('manager.installed.onDesktop') : (origin === 'builtin' ? t('manager.installed.builtin') : null),
          badgeClass: item.id === library.activeId ? 'badge-active' : null,
          master: !!item.publishable,
          selected: isSelected('local', item.id),
          buildThumb: (thumb) => imageThumbInto(thumb, item.id, item.pack),
          onSelect: () => { library.selected = { kind: 'local', item }; renderGallery(); renderDetail(); },
        }));
      }
    }
    return;
  }

  // Both Workshop tabs need a Steam session; check once when entering them.
  // wsAccess starts null (unknown) on a fresh Manager window and is resolved
  // ASYNC by refreshWorkshopAccess. Gate on `!== true` (not `=== false`) so we
  // only load Workshop content once a session is CONFIRMED — otherwise the
  // synchronous first render (wsAccess still null) would fall through and fire
  // workshopStatus/Mine/Browse with no session, which fail and leave the tab
  // BLANK (seen in engine.log: "workshop op ... requested with no Steam session").
  // Showing the gate while unknown is correct: no session yet either way.
  if ((library.tab === 'published' || library.tab === 'browse') && library.wsAccess === null) refreshWorkshopAccess();

  if (library.tab === 'published') {
    // Published is entirely Steam — gate the whole tab behind "Open in Steam".
    if (library.wsAccess !== true) { gallery.appendChild(workshopGate()); return; }
    renderPublishedSection(gallery);
    return;
  }

  // Steam Workshop — browse / subscribe / install inside the app (fail-soft;
  // filled async so the registry feeds below aren't blocked on Steam). Only the
  // Workshop section is gated; the registry feeds below don't need Steam.
  const wsBox = document.createElement('div');
  wsBox.className = 'workshop-section';
  gallery.appendChild(wsBox);
  if (library.wsAccess !== true) wsBox.appendChild(workshopGate());
  else renderWorkshopSection(wsBox);

  if (library.registries.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'hint';
    empty.textContent = t('manager.browse.noRegistries');
    gallery.appendChild(empty);
  }
  for (const url of library.registries) {
    const index = library.indexes.get(url);
    const refresh = libButton(t('manager.refresh'), () => browseRegistry(url), 'tiny');
    const remove = libButton(t('common.remove'), async () => {
      await aegis.registryRemove(url);
      await refreshLibrary();
    }, 'tiny danger');
    gallery.appendChild(sectionLabel(index && index.ok ? `${index.name} — ${url}` : url, [refresh, remove]));

    if (!index) continue;
    if (!index.ok) {
      const err = document.createElement('p');
      err.className = 'hint';
      err.textContent = index.error;
      gallery.appendChild(err);
      continue;
    }
    for (const entry of index.packs.filter((e) => matchesSearch(e.name + e.id + e.author + e.description))) {
      const update = index.updates.find((u) => u.id === entry.id);
      gallery.appendChild(makeCard({
        name: entry.name,
        badge: update ? t('manager.browse.badgeUpdate') : entry.installed ? t('manager.browse.badgeInstalled') : null,
        badgeClass: update ? 'badge-active' : null,
        selected: isSelected('remote', `${url}|${entry.id}`),
        buildThumb: (thumb) => {
          // Installed registry packs exist locally — show the real thing.
          if (entry.installed) imageThumbInto(thumb, entry.id, null);
          else monogramInto(thumb, entry.name);
        },
        onSelect: () => { library.selected = { kind: 'remote', url, entry, update }; renderGallery(); renderDetail(); },
      }));
    }
  }
}

// ── Steam Workshop (consume side): browse / subscribe / import ───────────────

// Default to NEWEST, not Trending: Steam's RankedByTrend excludes brand-new,
// zero-engagement items, so a just-published pack would be invisible on the
// default view (verified against live Steam). Newest surfaces fresh publishes
// immediately; Trending/Top stay available in the dropdown.
const ws = { available: null, items: [], search: '', sort: 'newest', loaded: false, loading: false, error: null, testApp: false, filters: {} };

// ── Published: your Steam Workshop dashboards (creator management) ────────────
// Machine-portable: Steam is the durable store, so on any computer signed into
// the same account this lists the items you've published and can pull an
// editable copy back down. Loaded lazily, like the Browse tab.
const mine = { available: null, items: [], loaded: false, loading: false, error: null, testApp: false };

// ── Voices on the Workshop (a separate item type) ────────────────────────────
// The Browse tab toggles between dashboards and voices; the Published tab lists
// both. Voice profiles are ~1 KB (base-voice ref + tuning), never audio.
let browseMode = 'dashboards';   // 'dashboards' | 'voices' — the Browse-tab toggle
// Default to NEWEST (see the `ws` note above) — Trending hides just-published voices.
const voiceWs = { items: [], loaded: false, loading: false, error: null, available: null, testApp: false, search: '', sort: 'newest' };
const voiceMine = { items: [], loaded: false, loading: false, error: null, available: null, testApp: false };

// Human-friendly download size for a base voice (hundreds of MB each).
function fmtMB(bytes) {
  const n = Number(bytes) || 0;
  if (n <= 0) return '';
  if (n >= 1024 * 1024 * 1024) return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  return `${Math.round(n / (1024 * 1024))} MB`;
}

function reloadMine() { mine.loaded = false; mine.loading = false; renderGallery(); }

function loadMine() {
  mine.loading = true;
  aegis.workshopStatus().then(async (st) => {
    mine.available = !!st.available;
    mine.error = st.available ? null : (st.reason || t('manager.workshop.unavailable'));
    if (mine.available) {
      const res = await aegis.workshopMine();
      if (res.ok) { mine.items = res.items; mine.testApp = !!res.testApp; mine.error = null; }
      else { mine.items = []; mine.error = res.error; }
    } else mine.items = [];
    mine.loading = false;
    mine.loaded = true;
    if (library.tab === 'published') renderGallery();
  });
}

function renderPublishedSection(gallery) {
  renderPublishedDashboards(gallery);
  // Voices are a separate item type — listed in their own section below.
  renderPublishedVoicesSection(gallery);
}

// A collapsible explainer for the master-copy publishing flow, so creators don't
// accidentally duplicate-publish or lose the path back to updating their pack.
// Interpolates the real (localized) UI labels — Master tag, Update, Get editable
// copy — so the guidance always matches the buttons the user sees.
function publishedHelpNote() {
  const d = document.createElement('details');
  d.className = 'pub-help';
  const s = document.createElement('summary');
  s.textContent = t('manager.published.help.summary');
  d.appendChild(s);
  const body = document.createElement('div');
  body.className = 'pub-help-body';
  const vars = {
    master: t('manager.installed.master'),
    update: t('manager.published.update'),
    getEditable: t('manager.published.getEditable'),
  };
  for (const key of ['p1', 'p2', 'p3']) {
    const p = document.createElement('p');
    p.textContent = t(`manager.published.help.${key}`, vars);
    body.appendChild(p);
  }
  d.appendChild(body);
  return d;
}

function renderPublishedDashboards(gallery) {
  const controls = document.createElement('div');
  controls.className = 'ws-controls';
  controls.append(
    libButton(t('manager.refresh'), () => { reloadMine(); reloadVoiceMine(); }, 'tiny'),
    libButton(t('manager.published.openWorkshop'), () => aegis.workshopOpen(), 'tiny'),
  );
  gallery.appendChild(sectionLabel(`${t('manager.published.yourDashboards')}${mine.testApp ? t('manager.published.testApp') : ''}`, [controls]));
  gallery.appendChild(publishedHelpNote());

  if (!mine.loaded && !mine.loading) loadMine();
  if (mine.loading) { gallery.appendChild(hintP(t('manager.published.loadingDashboards'))); return; }
  if (!mine.available) { gallery.appendChild(hintP(mine.error || t('manager.published.signInDashboards'))); return; }
  if (mine.error) { gallery.appendChild(hintP(mine.error)); return; }
  if (mine.items.length === 0) {
    gallery.appendChild(hintP(t('manager.published.emptyDashboards')));
    return;
  }
  const grid = document.createElement('div');
  grid.className = 'workshop-grid';
  for (const item of mine.items) grid.appendChild(publishedCard(item));
  gallery.appendChild(grid);
}

// Adaptive actions for a published DASHBOARD, shared by the card and the detail
// sidebar (one source of truth): a local editable copy → Edit / Update / View;
// none → Get editable copy / View. Returns a wrapper (.ws-actions + status).
function publishedDashboardActions(item) {
  const wrap = document.createElement('div');
  const status = document.createElement('div');
  status.className = 'ws-cardstatus';
  const actions = document.createElement('div');
  actions.className = 'ws-actions';

  // The editable copy must actually BE editable (publishable) — a plain "Add to
  // library" import is present locally but can't be edited/updated, so it doesn't
  // count. Then "Get editable copy" stays offered and can restore the real master.
  const mapped = item.localPackId ? library.localPacks.find((p) => p.id === item.localPackId) : null;
  const localPack = mapped && mapped.publishable ? mapped : null;
  if (localPack) {
    actions.append(
      libButton(t('manager.published.edit'), () => aegis.openEditor(localPack.id), 'tiny'),
      libButton(t('manager.published.update'), async () => {
        const st = await aegis.workshopStatus();
        if (!st.available) return libStatus(st.reason || t('manager.detail.workshopUnavailable'), true);
        // Default the dialog to this item's current Steam visibility.
        openPublishDialog(localPack, { visibility: item.visibility });
      }, 'tiny primary'),
      libButton(t('manager.published.view'), () => aegis.workshopOpenItem(item.url), 'tiny'),
    );
  } else {
    status.textContent = t('manager.published.noEditableCopy');
    const getBtn = libButton(t('manager.published.getEditable'), async () => {
      getBtn.disabled = true; getBtn.textContent = t('manager.published.downloading');
      status.textContent = t('manager.published.downloadingFromSteam');
      const out = await aegis.workshopGetEditable(item.itemId);
      if (out.ok) {
        status.textContent = t('manager.published.downloadedOpening');
        await refreshLibrary();
        reloadMine();
      } else {
        status.textContent = out.error || t('manager.published.couldNotGet');
        getBtn.disabled = false; getBtn.textContent = t('manager.published.getEditable');
      }
    }, 'tiny primary');
    actions.append(getBtn, libButton(t('manager.published.view'), () => aegis.workshopOpenItem(item.url), 'tiny'));
  }
  wrap.append(actions, status);
  return wrap;
}

// One published dashboard. Selecting shows it in the detail sidebar; the same
// adaptive actions live on the card and in the detail. A click on a button acts
// without also selecting.
function publishedCard(item) {
  const card = document.createElement('div');
  card.className = 'ws-card' + (isSelected('published', item.itemId) ? ' selected' : '');
  card.addEventListener('click', (e) => {
    if (e.target.closest('button')) return;
    library.selected = { kind: 'published', item };
    renderGallery();
    renderDetail();
  });
  const thumb = document.createElement('div');
  thumb.className = 'ws-thumb';
  wsThumbInto(thumb, item.previewUrl);

  const body = document.createElement('div');
  body.className = 'ws-body';
  const title = document.createElement('div');
  title.className = 'ws-title';
  title.textContent = item.title;
  const meta = document.createElement('div');
  meta.className = 'ws-meta';
  const bits = [`▲ ${item.votesUp}`];
  if (item.visibility && item.visibility !== 'public') bits.push(item.visibility);
  if (item.tags.length) bits.push(item.tags.slice(0, 3).join(', '));
  meta.textContent = bits.join(' · ');

  body.append(title, meta, publishedDashboardActions(item));
  card.append(thumb, body);
  return card;
}

// Sidebar facet groups: [display label, DE_TAGS key]. The four content groups
// plus the auto-derived Compatibility group. (DE_TAGS is defined later; read at
// render time.)
const WS_FILTER_ORDER = [['Style', 'Style'], ['Purpose', 'Purpose'], ['Palette', 'Palette'], ['Features', 'Includes'], ['Compatibility', 'Compatibility']];

// Count the active filters across all groups.
function wsActiveFilterCount() {
  return Object.values(ws.filters).reduce((n, s) => n + (s ? s.size : 0), 0);
}

// Faceted filter over the fetched items: OR within a group, AND across groups.
// Steam's UGC query only supports one global required-tags list, so we filter
// client-side (the catalogue is small/new; fetch more pages later if needed).
function wsFilteredItems() {
  const active = Object.entries(ws.filters).filter(([, set]) => set && set.size);
  if (!active.length) return ws.items;
  return ws.items.filter((item) => {
    const itemTags = (item.tags || []).map((t) => String(t).toLowerCase());
    return active.every(([, set]) => [...set].some((tag) => itemTags.includes(tag.toLowerCase())));
  });
}

// Build the filter sidebar. Filter state lives in `ws.filters` so it survives
// re-renders; toggling a box re-renders the grid client-side (no re-fetch).
function wsSidebar() {
  const aside = document.createElement('aside');
  aside.className = 'ws-sidebar';
  const head = document.createElement('div');
  head.className = 'ws-filter-head';
  const title = document.createElement('span');
  title.textContent = t('manager.workshop.filters');
  head.appendChild(title);
  const activeCount = wsActiveFilterCount();
  if (activeCount) {
    const clear = document.createElement('button');
    clear.className = 'ws-clear';
    clear.textContent = t('manager.workshop.clearFilters', { count: activeCount });
    clear.addEventListener('click', () => { ws.filters = {}; renderGallery(); });
    head.appendChild(clear);
  }
  aside.appendChild(head);

  for (const [, key] of WS_FILTER_ORDER) {
    const tags = DE_TAGS[key] || [];
    if (!tags.length) continue;
    const set = ws.filters[key] || (ws.filters[key] = new Set());
    const group = document.createElement('div');
    group.className = 'ws-fgroup';
    const gt = document.createElement('div');
    gt.className = 'ws-fgroup-title';
    gt.textContent = t(`manager.workshop.filter.${key}`);
    group.appendChild(gt);
    for (const tag of tags) {
      const row = document.createElement('label');
      row.className = 'ws-fopt';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = set.has(tag);
      cb.addEventListener('change', () => { if (cb.checked) set.add(tag); else set.delete(tag); renderGallery(); });
      const span = document.createElement('span');
      span.textContent = tag;
      row.append(cb, span);
      group.appendChild(row);
    }
    aside.appendChild(group);
  }
  return aside;
}

async function loadWorkshop() {
  ws.loading = true;
  const st = await aegis.workshopStatus();
  ws.available = !!st.available;
  ws.testApp = !!st.testApp;
  ws.error = st.available ? null : (st.reason || t('manager.workshop.unavailable'));
  if (ws.available) {
    const res = await aegis.workshopBrowse({ search: ws.search, sort: ws.sort });
    if (res.ok) { ws.items = res.items; ws.testApp = res.testApp; ws.error = null; }
    else { ws.items = []; ws.error = res.error; }
  } else ws.items = [];
  ws.loading = false;
  ws.loaded = true;
  if (library.tab === 'browse') renderGallery();
}

function reloadWorkshop() { ws.loaded = false; ws.loading = false; renderGallery(); }

// A segmented Dashboards | Voices toggle shared by the Browse workshop section.
function browseModeToggle(onChange) {
  const wrap = document.createElement('div');
  wrap.className = 'browse-toggle';
  for (const [mode, key] of [['dashboards', 'manager.workshop.toggleDashboards'], ['voices', 'manager.workshop.toggleVoices']]) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'browse-toggle-btn' + (browseMode === mode ? ' on' : '');
    btn.textContent = t(key);
    btn.addEventListener('click', () => { if (browseMode !== mode) { browseMode = mode; onChange(); } });
    wrap.appendChild(btn);
  }
  return wrap;
}

function renderWorkshopSection(box) {
  box.textContent = '';
  box.appendChild(browseModeToggle(() => renderGallery()));
  if (browseMode === 'voices') { renderVoiceBrowse(box); return; }
  // Header + controls.
  const controls = document.createElement('div');
  controls.className = 'ws-controls';
  const searchInput = document.createElement('input');
  searchInput.type = 'search';
  searchInput.className = 'lib-search';
  searchInput.placeholder = t('manager.workshop.searchWorkshop');
  searchInput.value = ws.search;
  searchInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { ws.search = searchInput.value.trim(); reloadWorkshop(); } });
  const sortSel = document.createElement('select');
  for (const [v, key] of [['trend', 'manager.workshop.sort.trend'], ['newest', 'manager.workshop.sort.newest'], ['top', 'manager.workshop.sort.top'], ['updated', 'manager.workshop.sort.updated']]) {
    const o = document.createElement('option'); o.value = v; o.textContent = t(key); sortSel.appendChild(o);
  }
  sortSel.value = ws.sort;
  sortSel.addEventListener('change', () => { ws.sort = sortSel.value; reloadWorkshop(); });
  controls.append(searchInput, sortSel,
    libButton(t('manager.refresh'), () => reloadWorkshop(), 'tiny'),
    libButton(t('manager.workshop.openOnSteam'), () => aegis.workshopOpen(), 'tiny'));
  box.appendChild(sectionLabel(`${t('manager.workshop.steamWorkshop')}${ws.testApp ? t('manager.published.testApp') : ''}`, [controls]));

  if (!ws.loaded && !ws.loading) loadWorkshop();
  if (ws.loading) { box.appendChild(hintP(t('manager.workshop.loading'))); return; }
  if (!ws.available) { box.appendChild(hintP(ws.error || t('manager.workshop.signIn'))); return; }
  if (ws.error) { box.appendChild(hintP(ws.error)); return; }
  if (ws.items.length === 0) { box.appendChild(hintP(t('manager.workshop.noItems'))); return; }

  // Two columns: the filter sidebar + the results grid.
  const layout = document.createElement('div');
  layout.className = 'ws-layout';
  layout.appendChild(wsSidebar());
  const main = document.createElement('div');
  main.className = 'ws-main';

  const items = wsFilteredItems();
  if (items.length === 0) {
    main.appendChild(hintP(t('manager.workshop.noMatch')));
  } else {
    const installedWsIds = new Set(library.localPacks.filter((p) => p.meta && p.meta.workshopId).map((p) => String(p.meta.workshopId)));
    const grid = document.createElement('div');
    grid.className = 'workshop-grid';
    for (const item of items) grid.appendChild(workshopCard(item, installedWsIds.has(item.itemId)));
    main.appendChild(grid);
  }
  layout.appendChild(main);
  box.appendChild(layout);
}

function hintP(text) {
  const p = document.createElement('p');
  p.className = 'hint';
  p.textContent = text;
  return p;
}

// The Workshop needs a Steam-tracked session (which owns the Steam client). When the
// Manager was opened directly — e.g. from the tray — there's none, so the Workshop
// tabs show this "Open in Steam" prompt that spawns a session on demand. That's the
// ONLY time Steam's launch dialog appears; a plain tray open never triggers it.
// dev / a live session → no gate. The session-connected event reloads the view.
function workshopGate() {
  const wrap = document.createElement('div');
  wrap.className = 'ws-gate';
  // Opening the Manager auto-starts a silent session (wsConnecting) — show a
  // "connecting" state while it spins up, not the manual "open from Steam" prompt.
  // The button stays as a manual retry in case the silent connect doesn't take.
  wrap.appendChild(hintP(t(library.wsConnecting ? 'manager.workshop.connecting' : 'manager.workshop.needsSteam')));
  const btn = document.createElement('button');
  btn.className = 'btn';
  btn.textContent = t('manager.workshop.openInSteam');
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.textContent = t('manager.workshop.openingSteam');
    library.wsConnecting = true;
    try { await aegis.workshopLaunchSession(); } catch (e) { /* fail-soft */ }
  });
  wrap.appendChild(btn);
  return wrap;
}

// Fast local check (main reports whether a Steam session is connected). Re-renders
// the Workshop tabs when the answer changes.
function refreshWorkshopAccess() {
  aegis.workshopAvailable().then((a) => {
    const ok = !!(a && a.available);
    if (library.wsAccess !== ok) {
      library.wsAccess = ok;
      if (library.tab === 'browse' || library.tab === 'published') renderGallery();
    }
  }).catch(() => {});
}

// Subscribe / Add-to-library / In-library button + status, shared by the browse
// card and the detail sidebar so both stay in sync. stopPropagation keeps a click
// on the button from also (de)selecting the card.
function workshopActionRow(item, inLibrary) {
  const wrap = document.createElement('div');
  const action = document.createElement('button');
  action.className = 'btn tiny';
  const status = document.createElement('div');
  status.className = 'ws-cardstatus';
  const setBtn = (label, disabled) => { action.textContent = label; action.disabled = !!disabled; };
  if (inLibrary) {
    setBtn(t('manager.workshop.inLibrary'), true);
  } else if (item.subscribed) {
    setBtn(t('manager.workshop.addToLibrary'));
    status.textContent = t('manager.workshop.subscribedHint');
    action.addEventListener('click', async (e) => {
      e.stopPropagation();
      setBtn(t('manager.workshop.importing'), true);
      const out = await aegis.workshopImport(item.itemId);
      // On success refreshLibrary re-renders the detail; the item is now in the
      // library, so it flips from the static image to the live preview.
      if (out.ok) { status.textContent = t('manager.workshop.added'); await refreshLibrary(); }
      else { status.textContent = out.error || t('manager.workshop.notDownloaded'); setBtn(t('manager.workshop.addToLibrary')); }
    });
  } else {
    setBtn(t('manager.workshop.subscribe'));
    action.addEventListener('click', async (e) => {
      e.stopPropagation();
      setBtn(t('manager.workshop.subscribing'), true);
      const out = await aegis.workshopSubscribe(item.itemId);
      // Re-render from the mutated cache (no refetch) so the card + detail flip to
      // the subscribed state with its download hint.
      if (out.ok) { item.subscribed = true; renderGallery(); renderDetail(); }
      else { status.textContent = out.error || t('manager.workshop.subscribeFailed'); setBtn(t('manager.workshop.subscribe')); }
    });
  }
  wrap.append(action, status);
  return wrap;
}

// F3 (Workshop moderation): an in-app Report control on any Workshop item (pack or
// voice). Steam is the moderator of record for Workshop content, so this opens the
// item's Steam page — where Valve's own Report link lives — and points the user at
// our review channel too. A confirmed violation is added to the bundled blocklist,
// which refuses to install that item on every machine in the next app update.
function reportControl(item) {
  const wrap = document.createElement('div');
  wrap.className = 'ws-report';
  const hint = document.createElement('div');
  hint.className = 'ws-cardstatus';
  const url = (typeof item.url === 'string' && /^https:\/\/steamcommunity\.com\//.test(item.url))
    ? item.url
    : `https://steamcommunity.com/sharedfiles/filedetails/?id=${item.itemId}`;
  const btn = libButton(t('manager.workshop.report'), () => {
    aegis.workshopOpenItem(url);
    hint.textContent = t('manager.workshop.reportHint');
  }, 'tiny');
  wrap.append(btn, hint);
  return wrap;
}

function workshopCard(item, inLibrary) {
  const card = document.createElement('div');
  card.className = 'ws-card' + (isSelected('workshop', item.itemId) ? ' selected' : '');
  // Selecting shows the item on the right: a live preview if it's in your library,
  // else Steam's static image (which flips to live once you add it).
  card.addEventListener('click', () => { library.selected = { kind: 'workshop', item, inLibrary }; renderGallery(); renderDetail(); });
  const thumb = document.createElement('div');
  thumb.className = 'ws-thumb';
  if (item.previewUrl) {
    aegis.workshopPreview(item.previewUrl).then((res) => {
      if (res && res.ok && thumb.isConnected) { const img = document.createElement('img'); img.alt = ''; img.src = res.uri; thumb.appendChild(img); }
      else thumb.classList.add('ws-noimg');
    });
  } else thumb.classList.add('ws-noimg');

  const body = document.createElement('div');
  body.className = 'ws-body';
  const title = document.createElement('div');
  title.className = 'ws-title';
  title.textContent = item.title;
  const meta = document.createElement('div');
  meta.className = 'ws-meta';
  meta.textContent = `▲ ${item.votesUp}${item.tags.length ? ' · ' + item.tags.slice(0, 3).join(', ') : ''}`;

  body.append(title, meta, workshopActionRow(item, inLibrary));
  card.append(thumb, body);
  return card;
}

// ── Voices on the Workshop: browse / add / manage ────────────────────────────

async function loadVoiceBrowse() {
  voiceWs.loading = true;
  const st = await aegis.workshopStatus();
  voiceWs.available = !!st.available;
  voiceWs.error = st.available ? null : (st.reason || t('manager.workshop.unavailable'));
  if (voiceWs.available) {
    const res = await aegis.voiceBrowse({ search: voiceWs.search, sort: voiceWs.sort });
    if (res.ok) { voiceWs.items = res.items; voiceWs.testApp = !!res.testApp; voiceWs.error = null; }
    else { voiceWs.items = []; voiceWs.error = res.error; }
  } else voiceWs.items = [];
  voiceWs.loading = false;
  voiceWs.loaded = true;
  if (library.tab === 'browse' && browseMode === 'voices') renderGallery();
}

function reloadVoiceBrowse() { voiceWs.loaded = false; voiceWs.loading = false; renderGallery(); }

function renderVoiceBrowse(box) {
  const controls = document.createElement('div');
  controls.className = 'ws-controls';
  const searchInput = document.createElement('input');
  searchInput.type = 'search';
  searchInput.className = 'lib-search';
  searchInput.placeholder = t('manager.voices.search');
  searchInput.value = voiceWs.search;
  searchInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { voiceWs.search = searchInput.value.trim(); reloadVoiceBrowse(); } });
  const sortSel = document.createElement('select');
  for (const [v, key] of [['trend', 'manager.workshop.sort.trend'], ['newest', 'manager.workshop.sort.newest'], ['top', 'manager.workshop.sort.top'], ['updated', 'manager.workshop.sort.updated']]) {
    const o = document.createElement('option'); o.value = v; o.textContent = t(key); sortSel.appendChild(o);
  }
  sortSel.value = voiceWs.sort;
  sortSel.addEventListener('change', () => { voiceWs.sort = sortSel.value; reloadVoiceBrowse(); });
  controls.append(searchInput, sortSel,
    libButton(t('manager.refresh'), () => reloadVoiceBrowse(), 'tiny'),
    libButton(t('manager.workshop.openOnSteam'), () => aegis.workshopOpen(), 'tiny'));
  box.appendChild(sectionLabel(`${t('manager.voices.community')}${voiceWs.testApp ? t('manager.published.testApp') : ''}`, [controls]));

  if (!voiceWs.loaded && !voiceWs.loading) loadVoiceBrowse();
  if (voiceWs.loading) { box.appendChild(hintP(t('manager.voices.loading'))); return; }
  if (!voiceWs.available) { box.appendChild(hintP(voiceWs.error || t('manager.voices.signIn'))); return; }
  if (voiceWs.error) { box.appendChild(hintP(voiceWs.error)); return; }
  if (voiceWs.items.length === 0) {
    box.appendChild(hintP(t('manager.voices.empty')));
    return;
  }
  const grid = document.createElement('div');
  grid.className = 'workshop-grid';
  for (const item of voiceWs.items) grid.appendChild(voiceCard(item));
  box.appendChild(grid);
}

// Fill a .ws-thumb with the item's remote preview (fetched main-side as a data
// URI so the strict CSP never loads a remote host). Shared by the voice cards.
function wsThumbInto(thumb, previewUrl) {
  if (previewUrl) {
    aegis.workshopPreview(previewUrl).then((res) => {
      if (res && res.ok && thumb.isConnected) { const img = document.createElement('img'); img.alt = ''; img.src = res.uri; thumb.appendChild(img); }
      else thumb.classList.add('ws-noimg');
    });
  } else thumb.classList.add('ws-noimg');
}

// The base-voice line: what a voice needs, and whether it's installed here.
function voiceDepLine(item) {
  const dep = document.createElement('div');
  dep.className = 'ws-dep';
  if (!item.baseVoice) { dep.textContent = ''; return dep; }
  const label = item.baseName || item.baseVoice;
  dep.textContent = item.baseInstalled
    ? t('manager.voices.baseVoice', { name: label })
    : t('manager.voices.needsBase', { name: label, size: item.baseSizeBytes ? ` · ${fmtMB(item.baseSizeBytes)} ${t('manager.voices.download')}` : '' });
  return dep;
}

// Download a voice's required base voice, streaming progress into the button.
async function downloadBaseVoice(item, btn) {
  const original = btn.textContent;
  btn.disabled = true;
  const unsub = aegis.onBankProgress((p) => {
    if (p && p.id === item.baseVoice && typeof p.pct === 'number') {
      const rate = (p.bytesPerSec > 0) ? ` · ${(p.bytesPerSec / (1024 * 1024)).toFixed(1)} MB/s` : '';
      btn.textContent = t('manager.voices.downloadingBase', { pct: p.pct }) + rate;
    }
  });
  let out;
  try { out = await aegis.bankDownload(item.baseVoice); } finally { unsub(); }
  if (out && out.ok) { item.baseInstalled = true; btn.textContent = t('manager.voices.baseReady'); }
  else { btn.disabled = false; btn.textContent = original; }
  return out;
}

function voiceCard(item) {
  const card = document.createElement('div');
  card.className = 'ws-card' + (isSelected('voice-workshop', item.itemId) ? ' selected' : '');
  // Selecting shows the voice on the right (base voice, tags, description, and a
  // sample preview). A click on any button acts without also selecting.
  card.addEventListener('click', (e) => {
    if (e.target.closest('button')) return;
    library.selected = { kind: 'voice-workshop', item };
    renderGallery();
    renderDetail();
  });
  const thumb = document.createElement('div');
  thumb.className = 'ws-thumb';
  wsThumbInto(thumb, item.previewUrl);

  const body = document.createElement('div');
  body.className = 'ws-body';
  const title = document.createElement('div');
  title.className = 'ws-title';
  title.textContent = item.title;
  const meta = document.createElement('div');
  meta.className = 'ws-meta';
  meta.textContent = `▲ ${item.votesUp}${item.tags.length ? ' · ' + item.tags.slice(0, 3).join(', ') : ''}`;
  const dep = voiceDepLine(item);
  const status = document.createElement('div');
  status.className = 'ws-cardstatus';
  const actions = document.createElement('div');
  actions.className = 'ws-actions';

  // Offer a base-voice download whenever it's missing (before or after adding).
  const maybeBaseButton = () => {
    if (item.baseVoice && !item.baseInstalled) {
      const dl = libButton(t('manager.voices.downloadBase', { size: fmtMB(item.baseSizeBytes) || t('panel.voice.get') }), () => downloadBaseVoice(item, dl), 'tiny');
      actions.appendChild(dl);
    }
  };

  const action = document.createElement('button');
  action.className = 'btn tiny';
  const setBtn = (label, disabled) => { action.textContent = label; action.disabled = !!disabled; };
  if (item.subscribed) {
    setBtn(t('manager.voices.addVoice'));
    status.textContent = t('manager.workshop.subscribedHint');
    action.addEventListener('click', async () => {
      setBtn(t('manager.voices.adding'), true);
      const out = await aegis.voiceImport(item.itemId);
      if (out.ok) {
        item.baseInstalled = !!out.baseInstalled;
        status.textContent = t('manager.voices.addedName', { name: out.name }) + (out.baseInstalled ? '' : t('manager.voices.addedNeedBase'));
        setBtn(t('manager.voices.added'), true);
        dep.replaceWith(voiceDepLine({ ...item }));
        maybeBaseButton();
      } else { status.textContent = out.error || t('manager.workshop.notDownloaded'); setBtn(t('manager.voices.addVoice')); }
    });
  } else {
    setBtn(t('manager.workshop.subscribe'));
    action.addEventListener('click', async () => {
      setBtn(t('manager.workshop.subscribing'), true);
      const out = await aegis.workshopSubscribe(item.itemId);
      if (out.ok) { item.subscribed = true; renderGallery(); }
      else { status.textContent = out.error || t('manager.workshop.subscribeFailed'); setBtn(t('manager.workshop.subscribe')); }
    });
  }
  actions.appendChild(action);

  body.append(title, meta, dep, actions, status);
  card.append(thumb, body);
  return card;
}

// Subscribe / Add-to-library + base-voice download for the DETAIL sidebar of a
// selected community voice. Mirrors the card's logic but uses full-width detail
// buttons and re-renders the detail on a state change (card + detail stay in
// sync because they share the same mutable `item`).
function voiceDetailActions(item) {
  const wrap = document.createElement('div');
  const status = document.createElement('div');
  status.className = 'ws-cardstatus';

  // Preview (before subscribing): synthesize a short sample locally from the
  // params embedded in the listing. Needs the base voice installed; if it's
  // missing the button is disabled and the download button below is the path.
  // Older items (published before this feature) carry no params — no button.
  if (item.previewParams) {
    const previewBtn = libButton(t('manager.voices.preview'), async (e) => {
      const btn = e.currentTarget;
      const orig = btn.textContent;
      btn.disabled = true; btn.textContent = t('manager.voices.previewing');
      status.textContent = '';
      const out = await aegis.voicePreviewSample(item.previewParams);
      btn.disabled = false; btn.textContent = orig;
      if (out && out.ok) { playTestPcm(out.pcm, out.sampleRate); }
      else { status.textContent = (out && out.error) || t('manager.voices.previewFailed'); }
    });
    if (!item.baseInstalled) { previewBtn.disabled = true; previewBtn.title = t('manager.voices.previewNeedsBase'); }
    wrap.appendChild(previewBtn);
    // Set expectations: the first play of a language pays a one-time engine warm-up
    // (model + BERT load), heaviest for Japanese/Korean; later plays are instant.
    if (item.baseInstalled) { const hint = detailLine(t('manager.voices.previewWarmHint')); wrap.appendChild(hint); }
  }

  // Base voice missing → offer the download (needed to USE the voice).
  if (item.baseVoice && !item.baseInstalled) {
    const dl = libButton(t('manager.voices.downloadBase', { size: fmtMB(item.baseSizeBytes) || t('panel.voice.get') }), async () => {
      const out = await downloadBaseVoice(item, dl);
      if (out && out.ok) renderDetail();
    });
    wrap.appendChild(dl);
  }

  if (item.subscribed) {
    wrap.appendChild(libButton(t('manager.voices.addVoice'), async (e) => {
      const btn = e.currentTarget; btn.disabled = true; btn.textContent = t('manager.voices.adding');
      const out = await aegis.voiceImport(item.itemId);
      if (out.ok) {
        item.baseInstalled = !!out.baseInstalled;
        status.textContent = t('manager.voices.addedName', { name: out.name }) + (out.baseInstalled ? '' : t('manager.voices.addedNeedBase'));
        renderGallery();
        renderDetail();
      } else { btn.disabled = false; btn.textContent = t('manager.voices.addVoice'); status.textContent = out.error || t('manager.workshop.notDownloaded'); }
    }, 'primary'));
    if (!status.textContent) status.textContent = t('manager.workshop.subscribedHint');
  } else {
    wrap.appendChild(libButton(t('manager.workshop.subscribe'), async (e) => {
      const btn = e.currentTarget; btn.disabled = true; btn.textContent = t('manager.workshop.subscribing');
      const out = await aegis.workshopSubscribe(item.itemId);
      if (out.ok) { item.subscribed = true; renderGallery(); renderDetail(); }
      else { btn.disabled = false; btn.textContent = t('manager.workshop.subscribe'); status.textContent = out.error || t('manager.workshop.subscribeFailed'); }
    }, 'primary'));
  }

  wrap.appendChild(status);
  return wrap;
}

// ── Published voices (creator management, machine-portable) ───────────────────

function reloadVoiceMine() { voiceMine.loaded = false; voiceMine.loading = false; renderGallery(); }

function loadVoiceMine() {
  voiceMine.loading = true;
  aegis.workshopStatus().then(async (st) => {
    voiceMine.available = !!st.available;
    voiceMine.error = st.available ? null : (st.reason || t('manager.workshop.unavailable'));
    if (voiceMine.available) {
      const res = await aegis.voiceMine();
      if (res.ok) { voiceMine.items = res.items; voiceMine.testApp = !!res.testApp; voiceMine.error = null; }
      else { voiceMine.items = []; voiceMine.error = res.error; }
    } else voiceMine.items = [];
    voiceMine.loading = false;
    voiceMine.loaded = true;
    if (library.tab === 'published') renderGallery();
  });
}

function renderPublishedVoicesSection(gallery) {
  gallery.appendChild(sectionLabel(t('manager.voices.yourPublished')));
  if (!voiceMine.loaded && !voiceMine.loading) loadVoiceMine();
  if (voiceMine.loading) { gallery.appendChild(hintP(t('manager.voices.loadingPublished'))); return; }
  // The dashboards section above already explains Steam being unavailable.
  if (!voiceMine.available) return;
  if (voiceMine.error) { gallery.appendChild(hintP(voiceMine.error)); return; }
  if (voiceMine.items.length === 0) {
    gallery.appendChild(hintP(t('manager.voices.emptyPublished')));
    return;
  }
  const grid = document.createElement('div');
  grid.className = 'workshop-grid';
  for (const item of voiceMine.items) grid.appendChild(publishedVoiceCard(item));
  gallery.appendChild(grid);
}

// Adaptive actions for a published VOICE, shared by the card and the detail: a
// local editable copy → Open tuning / View; none → Get editable copy / View.
function publishedVoiceActions(item) {
  const wrap = document.createElement('div');
  const status = document.createElement('div');
  status.className = 'ws-cardstatus';
  const actions = document.createElement('div');
  actions.className = 'ws-actions';

  if (item.localProfileFile) {
    status.textContent = t('manager.voices.editableCopy');
    actions.append(
      libButton(t('manager.voices.openTuning'), () => aegis.openPanel(), 'tiny primary'),
      libButton(t('manager.published.view'), () => aegis.workshopOpenItem(item.url), 'tiny'),
    );
  } else {
    status.textContent = t('manager.published.noEditableCopy');
    const getBtn = libButton(t('manager.published.getEditable'), async () => {
      getBtn.disabled = true; getBtn.textContent = t('manager.published.downloading');
      status.textContent = t('manager.voices.downloadingFromSteam');
      const out = await aegis.voiceGetEditable(item.itemId);
      if (out.ok) {
        status.textContent = t('manager.voices.downloadedOpening');
        reloadVoiceMine();
      } else {
        status.textContent = out.error || t('manager.published.couldNotGet');
        getBtn.disabled = false; getBtn.textContent = t('manager.published.getEditable');
      }
    }, 'tiny primary');
    actions.append(getBtn, libButton(t('manager.published.view'), () => aegis.workshopOpenItem(item.url), 'tiny'));
  }
  wrap.append(actions, status);
  return wrap;
}

// One published voice. Selectable → detail sidebar; same actions on card + detail.
function publishedVoiceCard(item) {
  const card = document.createElement('div');
  card.className = 'ws-card' + (isSelected('published-voice', item.itemId) ? ' selected' : '');
  card.addEventListener('click', (e) => {
    if (e.target.closest('button')) return;
    library.selected = { kind: 'published-voice', item };
    renderGallery();
    renderDetail();
  });
  const thumb = document.createElement('div');
  thumb.className = 'ws-thumb';
  wsThumbInto(thumb, item.previewUrl);

  const body = document.createElement('div');
  body.className = 'ws-body';
  const title = document.createElement('div');
  title.className = 'ws-title';
  title.textContent = item.title;
  const meta = document.createElement('div');
  meta.className = 'ws-meta';
  const bits = [`▲ ${item.votesUp}`];
  if (item.visibility && item.visibility !== 'public') bits.push(item.visibility);
  if (item.baseVoice) bits.push(item.baseName || item.baseVoice);
  meta.textContent = bits.join(' · ');

  body.append(title, meta, publishedVoiceActions(item));
  card.append(thumb, body);
  return card;
}

// ── Planner: Google-Calendar-style month grid + upcoming list ───────────────
// Reminders live in user data; the wallpaper components display them. Here
// they're managed: click a day to add, click an event chip to edit. Repeating
// events are expanded into occurrences by the main process (lib/reminders).

const MAX_CHIPS_PER_DAY = 3;
const UPCOMING_DAYS = 30;

const planner = {
  month: null,       // { year, month1 } currently displayed; null = current month
  reminders: [],     // raw entries (for editing)
  editing: null,     // id being edited in the modal, or null for a new event
};

function localIso(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function shiftIso(iso, days) {
  const [y, m, d] = iso.split('-').map(Number);
  return localIso(new Date(y, m - 1, d + days));
}

function plannerDayTitle(iso) {
  const todayIso = localIso(new Date());
  if (iso === todayIso) return 'Today';
  if (iso === shiftIso(todayIso, 1)) return 'Tomorrow';
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(uiLang(), { weekday: 'long', day: 'numeric', month: 'long' });
}

function currentMonth() {
  if (!planner.month) {
    const now = new Date();
    planner.month = { year: now.getFullYear(), month1: now.getMonth() + 1 };
  }
  return planner.month;
}

// The visible grid: Monday-led weeks covering the whole month, padded with
// adjacent-month days like Google Calendar.
function gridRange() {
  const { year, month1 } = currentMonth();
  const first = new Date(year, month1 - 1, 1);
  const start = new Date(first);
  start.setDate(start.getDate() - ((first.getDay() + 6) % 7));
  const last = new Date(year, month1, 0);
  const end = new Date(last);
  end.setDate(end.getDate() + (6 - ((last.getDay() + 6) % 7)));
  return { start, end };
}

async function renderPlanner() {
  const { year, month1 } = currentMonth();
  const { start, end } = gridRange();
  const todayIso = localIso(new Date());
  const from = localIso(start) < todayIso ? localIso(start) : todayIso;
  const to = shiftIso(todayIso, UPCOMING_DAYS) > localIso(end) ? shiftIso(todayIso, UPCOMING_DAYS) : localIso(end);

  const res = await aegis.remindersList({ from, to });
  if (!res.ok) return libStatus(res.error, true);
  planner.reminders = res.reminders;
  const occurrences = res.occurrences || [];

  $('cal-title').textContent = new Date(year, month1 - 1, 1)
    .toLocaleDateString(uiLang(), { month: 'long', year: 'numeric' });
  renderMonthGrid(occurrences, todayIso);
  renderUpcoming(occurrences, todayIso);
}

function renderMonthGrid(occurrences, todayIso) {
  const grid = $('cal-month');
  grid.textContent = '';
  const { month1 } = currentMonth();
  const { start, end } = gridRange();

  // Localized short weekday names, Monday-first (2024-01-01 was a Monday).
  for (let i = 0; i < 7; i++) {
    const head = document.createElement('div');
    head.className = 'cal-m-head';
    head.textContent = new Date(2024, 0, 1 + i).toLocaleDateString(uiLang(), { weekday: 'short' });
    grid.appendChild(head);
  }

  const byDate = new Map();
  for (const o of occurrences) {
    if (!byDate.has(o.date)) byDate.set(o.date, []);
    byDate.get(o.date).push(o);
  }

  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const iso = localIso(d);
    const cell = document.createElement('div');
    cell.className = 'cal-m-day';
    if (d.getMonth() + 1 !== month1) cell.classList.add('outside');
    cell.tabIndex = 0;
    cell.setAttribute('role', 'button');
    cell.setAttribute('aria-label', t('manager.planner.addEventOn', { date: iso }));

    const num = document.createElement('span');
    num.className = `cal-m-num${iso === todayIso ? ' today' : ''}`;
    num.textContent = String(d.getDate());
    cell.appendChild(num);

    const dayEvents = byDate.get(iso) || [];
    for (const o of dayEvents.slice(0, MAX_CHIPS_PER_DAY)) {
      cell.appendChild(eventChip(o));
    }
    if (dayEvents.length > MAX_CHIPS_PER_DAY) {
      const more = document.createElement('span');
      more.className = 'cal-m-more';
      more.textContent = t('manager.planner.moreCount', { n: dayEvents.length - MAX_CHIPS_PER_DAY });
      cell.appendChild(more);
    }

    const addHere = () => openEventEditor({ date: iso });
    cell.addEventListener('click', addHere);
    cell.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); addHere(); } });
    grid.appendChild(cell);
  }
}

function eventChip(occurrence) {
  const chip = document.createElement('button');
  chip.type = 'button';
  chip.className = `ev-chip${occurrence.done ? ' done' : ''}`;
  chip.title = `${occurrence.time ? `${occurrence.time} · ` : ''}${occurrence.text}${occurrence.repeat !== 'none' ? ` ${t('manager.planner.repeatsSuffix', { repeat: t('manager.event.repeat.' + occurrence.repeat) })}` : ''}`;
  const label = document.createElement('span');
  label.className = 'ev-chip-text';
  label.textContent = `${occurrence.time ? `${occurrence.time} ` : ''}${occurrence.repeat !== 'none' ? '↻ ' : ''}${occurrence.text}`;
  chip.appendChild(label);
  chip.addEventListener('click', (e) => {
    e.stopPropagation(); // don't fall through to the day cell's quick-add
    openEventEditor({ id: occurrence.id });
  });
  return chip;
}

function renderUpcoming(occurrences, todayIso) {
  const list = $('planner-list');
  list.textContent = '';
  const horizon = shiftIso(todayIso, UPCOMING_DAYS);
  const upcoming = occurrences.filter((o) => o.date >= todayIso && o.date <= horizon);

  if (upcoming.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'hint';
    empty.textContent = t('manager.planner.nothingPlanned');
    list.appendChild(empty);
    return;
  }

  let currentTitle = null;
  for (const occurrence of upcoming) {
    const title = plannerDayTitle(occurrence.date);
    if (title !== currentTitle) {
      currentTitle = title;
      const head = document.createElement('div');
      head.className = 'planner-day';
      head.textContent = title;
      list.appendChild(head);
    }
    const row = document.createElement('div');
    row.className = `rem-row${occurrence.done ? ' done' : ''}`;

    if (occurrence.repeat === 'none') {
      const check = document.createElement('input');
      check.type = 'checkbox';
      check.checked = occurrence.done;
      check.title = 'Done';
      check.addEventListener('change', async () => {
        await aegis.reminderToggle(occurrence.id);
        renderPlanner();
      });
      row.appendChild(check);
    } else {
      const repeatMark = document.createElement('span');
      repeatMark.className = 'rem-repeat';
      repeatMark.textContent = '↻';
      repeatMark.title = `Repeats ${occurrence.repeat}`;
      row.appendChild(repeatMark);
    }

    const time = document.createElement('span');
    time.className = 'rem-time';
    time.textContent = occurrence.time || '—';

    const text = document.createElement('button');
    text.type = 'button';
    text.className = 'rem-text';
    text.textContent = occurrence.text;
    text.title = 'Edit';
    text.addEventListener('click', () => openEventEditor({ id: occurrence.id }));

    const del = libButton('Delete', async () => {
      await aegis.reminderRemove(occurrence.id);
      renderPlanner();
    }, 'tiny danger');

    row.append(time, text, del);
    list.appendChild(row);
  }
}

// ── Launcher pins (personal data shown by launcher components) ─────────────

async function renderLauncherCfg() {
  const list = $('pin-list');
  const state = await aegis.launcherState();
  if (!state.ok) return libStatus(state.error, true);
  // Clear AFTER the await, not before: pinning triggers this render both
  // directly and via the launcher:changed broadcast, so two calls can overlap.
  // Clearing pre-await let both append onto an empty list → duplicated rows.
  list.textContent = '';

  if (state.pins.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'hint';
    empty.textContent = t('manager.launcher.empty');
    list.appendChild(empty);
  }
  state.pins.forEach((pin, index) => {
    const row = document.createElement('div');
    row.className = 'rem-row';

    if (pin.icon) {
      const img = document.createElement('img');
      img.className = 'pin-icon';
      img.alt = '';
      img.src = pin.icon;
      row.appendChild(img);
    } else {
      const mono = document.createElement('span');
      mono.className = 'pin-icon pin-mono';
      mono.textContent = pin.name.slice(0, 1).toUpperCase();
      row.appendChild(mono);
    }

    const name = document.createElement('span');
    name.className = 'pin-name';
    name.textContent = pin.name;

    const up = libButton('↑', async () => { await aegis.launcherPinMove(pin.id, -1); renderLauncherCfg(); }, 'tiny');
    up.disabled = index === 0;
    const down = libButton('↓', async () => { await aegis.launcherPinMove(pin.id, 1); renderLauncherCfg(); }, 'tiny');
    down.disabled = index === state.pins.length - 1;
    const del = libButton(t('manager.launcher.unpin'), async () => { await aegis.launcherUnpin(pin.id); renderLauncherCfg(); }, 'tiny danger');

    row.append(name, up, down, del);
    list.appendChild(row);
  });
}

async function wireLauncherCfg() {
  const select = $('pin-app-select');
  const apps = await aegis.launcherApps();
  if (apps.ok) {
    for (const appEntry of apps.apps) {
      const option = document.createElement('option');
      option.value = appEntry.id;
      option.textContent = appEntry.name;
      select.appendChild(option);
    }
  }
  $('btn-pin-app').addEventListener('click', async () => {
    if (!select.value) return;
    const out = await aegis.launcherPinApp(select.value);
    libStatus(out.ok ? t('manager.launcher.pinned') : out.error, !out.ok);
    renderLauncherCfg();
  });
  const pinPath = (kind) => async () => {
    const out = await aegis.launcherPinPath(kind);
    if (out.cancelled) return;
    libStatus(out.ok ? t('manager.launcher.pinned') : out.error, !out.ok);
    renderLauncherCfg();
  };
  $('btn-pin-file').addEventListener('click', pinPath('file'));
  $('btn-pin-folder').addEventListener('click', pinPath('folder'));
  aegis.onLauncherChanged(() => {
    if (library.tab === 'launcher') renderLauncherCfg();
  });
}

// ── AI assistant settings (LOCAL OpenAI-compatible endpoint — Ollama / LM Studio; no key) ───

// Ready-made assistant personas (the "system prompt") so a non-technical user
// can pick one instead of writing a prompt from scratch. Each bakes in the
// read-aloud rules (plain spoken sentences, no markdown/lists/emoji) that make
// TTS sound right. Advanced users edit the filled-in text freely.
// Each persona LEADS with an absolute language lock. The assistant's spoken reply
// is read by a single-language voice, so a reply in the wrong language comes out as
// gibberish — the directive must be forceful enough that even a small local model
// won't drift into the language the user happened to type in.
const ASSISTANT_PRESETS = {
  aegis: 'Always reply in English, whatever language the user writes in; never switch languages. '
    + 'You are Aegis, a calm, precise mission-control operator for this machine. '
    + 'Be concise — two to four sentences unless a task needs more. '
    + 'Never use markdown, bullet points, or emoji; reply in plain spoken sentences, as your words are read aloud.',
  nova: 'Always reply in English, whatever language the user writes in; never switch languages. '
    + 'You are Nova, a warm, upbeat, and encouraging assistant who speaks like a supportive friend. '
    + 'Keep replies to a sentence or two unless more is truly needed. '
    + 'Never use markdown, lists, or emoji; reply in plain spoken sentences, since your words are read aloud.',
  sage: 'Always reply in English, whatever language the user writes in; never switch languages. '
    + 'You are Sage, a thoughtful and measured mentor. Answer with calm, gentle wisdom and no filler. '
    + 'Be brief — two or three sentences is usually enough. '
    + 'Never use markdown, lists, or emoji; reply in plain spoken sentences, as your words are read aloud.',
  ace: 'Always reply in English, whatever language the user writes in; never switch languages. '
    + 'You are Ace, an energetic, motivational coach. Be punchy, positive, and direct — fire the user up in a sentence or two. '
    + 'Never use markdown, lists, or emoji; reply in plain spoken sentences, as your words are read aloud.',
  pip: 'Always reply in English, whatever language the user writes in; never switch languages. '
    + 'You are Pip, a brief, matter-of-fact assistant. Answer in as few plain words as possible — usually one short sentence, no frills. '
    + 'Never use markdown, lists, or emoji, since your words are read aloud.',
  // Localized starters — reply AND speak in the user's language. Each LEADS with an
  // absolute language lock so the reply always matches its voice. These match the
  // shipped HD voices (es/fr/zh/ja/ko); pair each with that language's voice in
  // Manager → Assistant → Voice. Examples; write your own in any language.
  es_amigo: 'Responde SIEMPRE en español, sin importar en qué idioma te escriban; no cambies nunca de idioma. '
    + 'Eres un asistente cercano y servicial. Contesta en frases habladas claras y breves (una o dos frases). '
    + 'Nunca uses markdown, listas ni emojis, porque tus respuestas se leen en voz alta.',
  fr_ami: 'Réponds TOUJOURS en français, quelle que soit la langue utilisée par l’utilisateur; ne change jamais de langue. '
    + 'Tu es un assistant chaleureux et serviable. Réponds en phrases parlées claires et brèves (une ou deux phrases). '
    + 'N’utilise jamais de markdown, de listes ni d’émojis, car tes réponses sont lues à voix haute.',
  zh_zhushou: '无论用户使用哪种语言，都必须始终只用中文回答，绝不要切换到其他语言。'
    + '你是一个热情、乐于助人的助手。请用清晰、简短的口语句子（一到两句）回答。'
    + '不要使用 markdown、列表或表情符号，因为你的回答会被朗读出来。',
  ja_hisho: 'どんな言語で話しかけられても、必ず日本語だけで答えてください。決して他の言語に切り替えないこと。'
    + 'あなたは親切で頼りになるアシスタントです。はっきりとした短い話し言葉（一〜二文）で答えてください。'
    + '回答は音声で読み上げられるので、マークダウン、箇条書き、絵文字は使わないでください。',
  ko_biseo: '사용자가 어떤 언어로 말하더라도 반드시 한국어로만 대답하세요. 절대로 다른 언어로 바꾸지 마세요. '
    + '당신은 친절하고 도움이 되는 어시스턴트입니다. 명확하고 짧은 구어체 문장(한두 문장)으로 대답하세요. '
    + '답변은 소리 내어 읽히므로 마크다운, 목록, 이모지를 사용하지 마세요.',
};

// Each persona preset speaks a language; map it to the HD voice that language
// needs so picking a persona also sets a matching voice (see the change handler).
const PERSONA_VOICE = {
  aegis: 'en_male', nova: 'en_us_hd', sage: 'en_us_hd', ace: 'en_us_hd', pip: 'en_us_hd',
  es_amigo: 'es_hd', fr_ami: 'fr_hd', zh_zhushou: 'zh_hd', ja_hisho: 'ja_hd', ko_biseo: 'ko_hd',
};

// Select the assistant voice that matches a persona preset's language. Prefers a
// factory preset for that voice, else any option using it. No-op if the language
// has no voice option yet (the user can still pick one manually).
function autoSelectVoiceForPersona(personaKey) {
  const wantVoice = PERSONA_VOICE[personaKey];
  if (!wantVoice) return;
  const select = $('ai-voice');
  const opts = Array.from(select.options);
  const match = opts.find((o) => o.dataset.voice === wantVoice && o.value.startsWith('preset:'))
    || opts.find((o) => o.dataset.voice === wantVoice);
  if (match && select.value !== match.value) {
    select.value = match.value;
    prewarmSelectedVoice();
  }
}

// Turn an assistant:speak failure code into a plain, actionable reason so the
// Test button never silently produces no sound.
function speakHint(err) {
  if (err === 'busy') return t('manager.assistant.hintBusy');
  if (err === 'voice-unavailable') return t('manager.assistant.hintUnavailable');
  return err || t('manager.assistant.hintNoResponse');
}

const assistantCfg = { loaded: false };

async function renderAssistantCfg() {
  const res = await aegis.assistantConfigGet();
  if (!res.ok) return libStatus(res.error, true);
  const c = res.config;
  $('ai-persona').value = c.persona || '';
  renderAssistantPresets(c.personaPresets || []);
  syncPersonaPresetDropdown(); // reflect the saved persona in the preset dropdown
  $('ai-speak').checked = c.speak !== false;
  $('ai-context-limit').value = c.contextLimit || 12;
  // Voice dropdown: the tuned profiles, plus the engine default.
  const select = $('ai-voice');
  select.textContent = '';
  const def = document.createElement('option');
  def.value = '';
  def.textContent = t('manager.assistant.defaultVoice');
  select.appendChild(def);
  // Factory presets (a curated voice per language + character presets) come
  // first, then the user's own saved profiles. Presets carry a "preset:" prefix
  // so main resolves them from presets/ and they never collide with a user file.
  // bankList tells us which voice packs are installed: a preset/profile whose
  // voice isn't downloaded is shown "not available" and disabled — picking it
  // would only fall back or stay silent (see the assistant speak path).
  const [presetList, voices, bankRes] = await Promise.all([
    aegis.voicePresetsList(),
    aegis.voiceProfilesList(),
    // Fail-soft: if bankList is unavailable, don't gate at all (never disable
    // everything, never abort the whole voice list).
    Promise.resolve().then(() => (aegis.bankList ? aegis.bankList() : { ok: false })).catch(() => ({ ok: false })),
  ]);
  const haveInstallData = !!(bankRes && bankRes.ok);
  const installed = new Set(haveInstallData ? bankRes.voices.filter((v) => v.installed).map((v) => v.id) : []);
  // A voice is selectable if we can't tell (no install data), it's the engine
  // default (no id), or its pack is installed.
  const isAvail = (voiceId) => !voiceId || !haveInstallData || installed.has(voiceId);
  const notAvail = t('manager.assistant.notAvailable');
  const addOption = (group, value, voiceId, label) => {
    const opt = document.createElement('option');
    opt.value = value;
    opt.dataset.voice = voiceId; // lets us pre-warm the right HD voice on pick
    const avail = isAvail(voiceId);
    opt.textContent = avail ? label : `${label} — ${notAvail}`;
    opt.disabled = !avail;
    group.appendChild(opt);
  };
  if (presetList && presetList.ok && presetList.presets.length) {
    const g = document.createElement('optgroup');
    g.label = t('manager.assistant.groupPresets');
    for (const p of presetList.presets) addOption(g, `preset:${p.file}`, p.profile.base.voice, `${p.profile.name} (${p.profile.base.voice})`);
    select.appendChild(g);
  }
  if (voices.ok && voices.profiles.length) {
    const g = document.createElement('optgroup');
    g.label = t('manager.assistant.groupYourProfiles');
    for (const p of voices.profiles) addOption(g, p.file, p.voice, `${p.name} (${p.voice})`);
    select.appendChild(g);
  }
  select.value = c.voiceProfile || '';

  // Gate the persona presets the same way: a language persona auto-selects that
  // language's voice, so if its voice isn't installed, disable it + mark it "not
  // available". English personas map to bundled voices, so they stay available.
  const personaSel = $('ai-persona-preset');
  for (const opt of personaSel.options) {
    const want = PERSONA_VOICE[opt.value];
    if (!want) continue; // "Start from a preset…" / unknown
    const avail = isAvail(want);
    opt.disabled = !avail;
    if (!avail) {
      // The non-English persona labels are static (no data-i18n), so capturing
      // the base once + rebuilding is safe across UI-language switches.
      if (!opt.dataset.baseLabel) opt.dataset.baseLabel = opt.textContent;
      opt.textContent = `${opt.dataset.baseLabel} — ${notAvail}`;
    } else if (opt.dataset.baseLabel) {
      opt.textContent = opt.dataset.baseLabel; // voice was downloaded — restore
      delete opt.dataset.baseLabel;
    }
  }

  prewarmSelectedVoice(); // HD engine loads in the background while you read/type
  assistantCfg.loaded = true;
}

// Fire-and-forget: warm the engine for the currently-selected assistant voice so
// the first "Test" (or reply) isn't a cold-start wait. No-op for the system voice.
function prewarmSelectedVoice() {
  const opt = $('ai-voice').selectedOptions[0];
  const voiceId = opt && opt.dataset ? opt.dataset.voice : '';
  if (voiceId) aegis.voicePrewarm(voiceId);
}

// Keep the persona dropdown reflecting the active persona: select the preset
// whose text matches the system-prompt box, or the "Start from a preset…"
// placeholder once the text is edited into something custom.
function syncPersonaPresetDropdown() {
  const sel = $('ai-persona-preset');
  if (!sel) return;
  const text = $('ai-persona').value;
  let match = '';
  for (const key of Object.keys(ASSISTANT_PRESETS)) {
    if (ASSISTANT_PRESETS[key] === text) { match = key; break; }
  }
  sel.value = match;
}

async function saveAssistant() {
  const patch = {
    persona: $('ai-persona').value,
    speak: $('ai-speak').checked,
    voiceProfile: $('ai-voice').value,
    contextLimit: Number($('ai-context-limit').value) || 12,
  };
  return aegis.assistantConfigSet(patch);
}

function wireAssistantCfg() {
  // Picking a preset fills the system-prompt box AND stays selected in the
  // dropdown, so it's clear which persona is active. Editing the prompt into
  // something that no longer matches a preset falls the dropdown back to the
  // "Start from a preset…" placeholder (see the input listener below).
  $('ai-persona-preset').addEventListener('change', (e) => {
    const key = e.target.value;
    const preset = ASSISTANT_PRESETS[key];
    if (preset) {
      $('ai-persona').value = preset;
      // Point the VOICE at the persona's language too. The persona sets the
      // REPLY language; the voice sets the SPEAKING language — if they mismatch,
      // the English voice mangles Chinese into gibberish and reads Spanish with
      // an English accent. Auto-selecting a matching voice keeps them in step.
      autoSelectVoiceForPersona(key);
    }
  });

  // As soon as the user edits the prompt, the dropdown may no longer describe it
  // — re-sync (shows the matching preset, or the placeholder when it's custom).
  $('ai-persona').addEventListener('input', syncPersonaPresetDropdown);

  // Picking a voice pre-warms its HD engine so the Test below is snappy.
  $('ai-voice').addEventListener('change', prewarmSelectedVoice);

  $('ai-save').addEventListener('click', async () => {
    const out = await saveAssistant();
    if (!out.ok) { $('ai-status').textContent = out.error; return; }
    $('ai-status').textContent = t('common.saved');
    renderAssistantCfg();
  });

  $('ai-test').addEventListener('click', async () => {
    const saved = await saveAssistant(); // test uses the current fields
    if (!saved.ok) { $('ai-status').textContent = saved.error; return; }
    $('ai-status').textContent = t('manager.assistant.contacting');
    // Ask it to introduce itself so the reply reflects the persona you set.
    const out = await aegis.assistantAsk('Introduce yourself in one short sentence and confirm you are online.');
    if (out.ok) {
      $('ai-status').textContent = `✓ ${out.text}`;
      // Speak the reply so you hear the persona AND the voice — one test proves
      // the whole chain. Only if "speak replies aloud" is on.
      if ($('ai-speak').checked) {
        $('ai-status').textContent = `✓ ${out.text}  ·  ${t('manager.assistant.speaking')}`;
        let spoken = await aegis.assistantSpeak(out.text);
        // A transient "busy" (a pre-warm or a prior clip still finishing) clears
        // fast — one quiet retry saves the user a manual re-test.
        if (spoken && !spoken.ok && spoken.error === 'busy') {
          await new Promise((r) => setTimeout(r, 1500));
          spoken = await aegis.assistantSpeak(out.text);
        }
        if (spoken && spoken.ok) {
          playTestPcm(spoken.pcm, spoken.sampleRate);
          $('ai-status').textContent = `✓ ${out.text}`;
        } else {
          // Text came back but the voice didn't — say WHY instead of going silent.
          $('ai-status').textContent = `✓ ${out.text}  ·  (${t('manager.assistant.noVoice', { reason: speakHint(spoken && spoken.error) })})`;
        }
      }
    } else {
      $('ai-status').textContent = `✗ ${out.error}`;
    }
    await aegis.assistantReset(); // don't leave the test in the real conversation
    renderAssistantCfg();
  });

  // Save the current prompt as the user's own named persona.
  $('ai-preset-save').addEventListener('click', () => {
    $('ai-preset-savebox').classList.remove('hidden');
    $('ai-preset-name').focus();
  });
  $('ai-preset-cancel').addEventListener('click', () => {
    $('ai-preset-savebox').classList.add('hidden');
    $('ai-preset-name').value = '';
  });
  $('ai-preset-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('ai-preset-confirm').click(); });
  $('ai-preset-confirm').addEventListener('click', async () => {
    const out = await aegis.assistantPresetAdd($('ai-preset-name').value.trim(), $('ai-persona').value.trim());
    if (!out.ok) { $('ai-status').textContent = out.error; return; }
    $('ai-preset-name').value = '';
    $('ai-preset-savebox').classList.add('hidden');
    $('ai-status').textContent = t('manager.assistant.personaSaved');
    renderAssistantCfg();
  });
}

// One reused AudioContext for the connection-test reply (the click is the user
// gesture that unlocks it). Silent on any failure — the text reply is shown too.
let testAudioCtx = null;
function playTestPcm(pcm, sampleRate) {
  try {
    if (!testAudioCtx) testAudioCtx = new AudioContext();
    const bytes = pcm instanceof Uint8Array ? pcm : new Uint8Array(pcm);
    const int16 = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >> 1);
    const floats = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) floats[i] = int16[i] / 32768;
    const buffer = testAudioCtx.createBuffer(1, floats.length, sampleRate);
    buffer.copyToChannel(floats, 0);
    const src = testAudioCtx.createBufferSource();
    src.buffer = buffer;
    src.connect(testAudioCtx.destination);
    src.start();
  } catch (err) { /* silent — the reply text is already shown */ }
}

// Render the user's saved personas as clickable chips (fill the box) with a
// delete ×. Hidden entirely when there are none.
function renderAssistantPresets(presets) {
  const box = $('ai-preset-saved');
  box.textContent = '';
  if (!Array.isArray(presets) || presets.length === 0) return;
  const label = document.createElement('span');
  label.className = 'ai-preset-label';
  label.textContent = t('manager.assistant.savedPersonas');
  box.appendChild(label);
  for (const p of presets) {
    const chip = document.createElement('span');
    chip.className = 'ai-preset-chip';
    const use = document.createElement('button');
    use.type = 'button'; use.className = 'ai-preset-use'; use.textContent = p.name;
    use.title = t('manager.assistant.usePersona');
    use.addEventListener('click', () => { $('ai-persona').value = p.prompt; syncPersonaPresetDropdown(); });
    const del = document.createElement('button');
    del.type = 'button'; del.className = 'ai-preset-del'; del.textContent = '×';
    del.title = t('manager.assistant.deletePersona', { name: p.name });
    del.addEventListener('click', async () => {
      const out = await aegis.assistantPresetRemove(p.name);
      if (out.ok) renderAssistantCfg(); else $('ai-status').textContent = out.error;
    });
    chip.append(use, del);
    box.appendChild(chip);
  }
}

// ── Create tab: the in-app designer hub (guide + reference + actions) ─────────
// Content-only reference derived from PACKS.md + packs.js, rendered natively so
// it matches the app chrome and needs no markdown parser. The full authoring
// guide (PACKS.md) opens on demand.

const CREATE_STEPS = [
  ['Open a pack in the editor', 'Start from any pack — the built-in packs are the quality floor. Editing a built-in makes your own copy on save; the original is never touched.'],
  ['Arrange the canvas', 'Drag, resize, layer, and duplicate components on a percent-based canvas at your display’s real aspect ratio. What you see is exactly what the desktop renders.'],
  ['Style the skin', 'Set the palette, fonts, textures, ambience particles, and per-component overrides in the inspector.'],
  ['Add Customize knobs', 'Optionally expose a few user-adjustable properties (colours, particles, density) so subscribers can tweak your pack without editing it.'],
  ['Save', 'Your pack lands in your library and on the desktop. Personal data (reminders, pins, notifications, keys) never enters a pack.'],
  ['Publish to Steam Workshop', 'From a pack’s detail panel, publish with a rendered preview + description so others can subscribe.'],
];

const CREATE_COMPONENTS = [
  ['status', 'Persona status console / line-up', '—'],
  ['clock', 'Digital clock', 'format (24h/12h), seconds, showDate'],
  ['analog-clock', 'Analog clock face', 'seconds, numerals (none/quarters/all), minuteTicks'],
  ['hud-clock', 'Sci-fi reactor-ring clock', 'format, seconds, showDate'],
  ['cores', 'Per-core CPU load bars', 'label'],
  ['sysinfo', 'Key/value machine readouts', 'memory, disk, uptime, host, statusText'],
  ['stats', 'CPU/mem/disk/battery bars + history', 'cpu, mem, disk, battery, history'],
  ['meter', 'A single live gauge', 'bind (cpu/mem/disk/battery), variant (ring/bar), label, ticks, readout'],
  ['sparkline', 'A metric’s recent history', 'bind, label, grid, readout'],
  ['text', 'A styled text label', 'text'],
  ['image', 'A pack image asset', 'src (assets/…), fit (contain/cover)'],
  ['gallery', 'A looping photo slideshow', 'images (assets/…), interval, fit, transition, shuffle'],
  ['rig', 'A breathing character: layered art that moves + follows the cursor', 'layers[] (src, anchor, breath, sway, bob, gaze, tiltWithPointer)'],
  ['divider', 'A hairline rule', 'orientation (h/v)'],
  ['calendar', 'Month calendar with your reminders', 'weekStart (sun/mon), showReminders'],
  ['pomodoro', 'A Pomodoro focus / break timer', 'focusMin, shortBreakMin, longBreakMin, cyclesBeforeLong, sound, notify, showPips'],
  ['countdown', 'Counts down to a date', 'target (ISO date), label'],
  ['weather', 'Live weather (Open-Meteo, keyless)', 'lat, lon, place, details, compact'],
  ['agenda', 'Your upcoming reminders', 'days, limit, label'],
  ['notifications', 'Your live Windows notifications', 'limit, label, showApp'],
  ['launcher', 'Your pinned / recent / open apps', 'pinned, recent, running, labels, iconSize, label'],
  ['mixer', 'Per-app volume for your audio apps (Windows)', 'showMaster, label'],
  ['assistant', 'The AI console on the wallpaper', 'label, button'],
  ['module', 'Your own sandboxed HTML/CSS/JS', 'html, scroll, telemetry'],
];

const CREATE_SKIN = [
  ['Palette', 'void · glass · accent · accentBright · muted · warn · gold — hex colours that drive the whole look.'],
  ['Fonts', 'rajdhani · system-sans · system-serif · mono (packs can’t ship font files).'],
  ['Ambience', 'none · embers · dust · snow · petals · rain · sparkle (density 0.05–1, reduced-motion safe), or a fully-custom particle system (emitter, sprite, motion, colour, cursor interaction).'],
  ['Textures', 'scanlines · grid · glow · vignette, each 0–1.'],
  ['Wallpaper', 'an image (≤5 MB) or a muted looping video (mp4/webm, ≤30 MB), with fit + focal point.'],
  ['Background layers', 'stack up to 6 image/video layers with a parallax depth (0–1) + drift — the cursor gives the scene 3-D depth.'],
  ['Background effects', 'up to 3 WebGL shader effects per layer — ripple · sway · drift-warp · pulse · cursor-ripple · waves · shimmer · shake · spin · scroll · chroma-shift — each scoped by an optional painted mask or region (fail-soft to a static image without WebGL).'],
  ['Time of day', 'recolour the palette across four slots — dawn · day · dusk · night — each with a start hour and a partial override; the active slot crossfades over 2 s as the clock passes it.'],
  ['Animation timeline', 'keyframe component opacity / move / scale / rotate and ambience opacity over a looping cycle — up to 8 tracks, 6 keys each, loop / ping-pong / once, four easings.'],
];

const CREATE_PROPS = [
  ['color', 'palette.<key>', 'recolour a palette entry'],
  ['select', 'ambience.effect', 'choose the particle effect'],
  ['slider', 'ambience.density', 'particle density (0.05–1)'],
  ['slider', 'texture.<key>', 'a texture’s intensity (0–1)'],
  ['toggle', 'shape.cornerNotches', 'corner notches on / off'],
];

function createSection(title) {
  const h = document.createElement('h3');
  h.className = 'create-section-title';
  h.textContent = title;
  return h;
}

// `codeCols` = column indices whose cells are literal config identifiers (option
// keys, values) — rendered as <code> chips so they read as code, NOT as
// untranslated prose. They stay in English in every language because a creator
// types them verbatim into pack.json. Other columns are plain (translatable) text.
function refTable(headers, rows, codeCols = [0]) {
  const codeSet = new Set(codeCols);
  const table = document.createElement('table');
  table.className = 'create-table';
  const thead = document.createElement('thead');
  const hr = document.createElement('tr');
  for (const h of headers) {
    const th = document.createElement('th');
    th.textContent = h;
    hr.appendChild(th);
  }
  thead.appendChild(hr);
  table.appendChild(thead);
  const tbody = document.createElement('tbody');
  for (const row of rows) {
    const tr = document.createElement('tr');
    row.forEach((cell, i) => {
      const td = document.createElement('td');
      if (codeSet.has(i) && cell && cell !== '—') {
        // A comma-separated list of identifiers → one <code> chip each.
        const parts = String(cell).split(', ');
        parts.forEach((part, idx) => {
          const code = document.createElement('code');
          code.textContent = part;
          td.appendChild(code);
          if (idx < parts.length - 1) td.appendChild(document.createTextNode(', '));
        });
      } else td.textContent = cell;
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  return table;
}

function renderCreate() {
  const root = $('create-cfg');
  root.textContent = '';

  const intro = document.createElement('div');
  intro.className = 'create-intro';
  const h = document.createElement('h2');
  h.textContent = t('create.title');
  const p = document.createElement('p');
  p.className = 'hint';
  p.textContent = t('create.intro');
  intro.append(h, p);
  root.appendChild(intro);

  // Actions.
  const actions = document.createElement('div');
  actions.className = 'create-actions';
  actions.appendChild(libButton(t('create.startScratch'), () => openBuilder(), 'primary'));
  actions.appendChild(libButton(t('create.openEditor'), () => {
    aegis.openEditor(library.activeId || 'aegis');
  }));
  actions.appendChild(libButton(t('create.readGuide'), async () => {
    const out = await aegis.openGuide();
    if (!out.ok) libStatus(out.error || t('create.guideError'), true);
  }));
  root.appendChild(actions);

  // How it works. The English title/body in CREATE_STEPS is the dev fallback;
  // en.json carries the canonical strings translators localize.
  root.appendChild(createSection(t('create.section.howItWorks')));
  const steps = document.createElement('ol');
  steps.className = 'create-steps';
  CREATE_STEPS.forEach((_, i) => {
    const li = document.createElement('li');
    const b = document.createElement('b');
    b.textContent = t(`create.step.${i}.title`) + '. ';
    li.appendChild(b);
    li.appendChild(document.createTextNode(t(`create.step.${i}.body`)));
    steps.appendChild(li);
  });
  root.appendChild(steps);

  // Reference. Column 0 (type/control) and the identifier-heavy Options/Binds
  // columns stay literal; the prose "What it shows"/"Effect" cells translate.
  root.appendChild(createSection(t('create.section.components')));
  const compRows = CREATE_COMPONENTS.map(([type, , opts]) => [type, t(`create.comp.${type}.shows`), opts]);
  // Cols 0 (type id) and 2 (option keys) are literal identifiers → code chips.
  root.appendChild(refTable([t('create.table.type'), t('create.table.shows'), t('create.table.options')], compRows, [0, 2]));

  root.appendChild(createSection(t('create.section.skin')));
  const skinList = document.createElement('div');
  skinList.className = 'create-deflist';
  const SKIN_SLUGS = ['palette', 'fonts', 'ambience', 'textures', 'wallpaper', 'layers', 'effects', 'schedule', 'timeline'];
  CREATE_SKIN.forEach((_, i) => {
    const slug = SKIN_SLUGS[i];
    const row = document.createElement('div');
    row.className = 'create-def';
    const dt = document.createElement('span');
    dt.className = 'create-dt';
    dt.textContent = t(`create.skin.${slug}.term`);
    const dd = document.createElement('span');
    dd.textContent = t(`create.skin.${slug}.def`);
    row.append(dt, dd);
    skinList.appendChild(row);
  });
  root.appendChild(skinList);

  root.appendChild(createSection(t('create.section.props')));
  const propsNote = document.createElement('p');
  propsNote.className = 'hint';
  propsNote.textContent = t('create.propsNote');
  root.appendChild(propsNote);
  const propRows = CREATE_PROPS.map(([ctrl, binds], i) => [ctrl, binds, t(`create.prop.${i}.effect`)]);
  // Cols 0 (control type) and 1 (bind path) are literal identifiers → code chips.
  root.appendChild(refTable([t('create.table.control'), t('create.table.binds'), t('create.table.effect')], propRows, [0, 1]));
}

// ── From-scratch pack builder (the guided "sandwich order") ──────────────────
// A full-screen overlay: pick a background feel, colours, particles, type, and
// persona with a live preview, then create a real pack and open it in the
// editor to fine-tune. Backgrounds can be an image/video wallpaper plus optional
// parallax depth layers; WebGL effects are added per layer in the editor.

const BUILDER_PALETTES = [
  { id: 'cyanHud', p: { void: '#04080F', glass: '#0A16238C', accent: '#3FD8FF', accentBright: '#7FE9FF', muted: '#5A7E93', warn: '#FFB23E', gold: '#E8C56A' } },
  { id: 'ember', p: { void: '#140A06', glass: '#241109A0', accent: '#FF7A3C', accentBright: '#FFC27A', muted: '#8A6A55', warn: '#FF5A5A', gold: '#E8C56A' } },
  { id: 'mono', p: { void: '#0B0D10', glass: '#1A1E24AA', accent: '#C7D0DA', accentBright: '#FFFFFF', muted: '#6A727C', warn: '#E0A446', gold: '#C9B27A' } },
  { id: 'sakura', p: { void: '#1A0E16', glass: '#2A1622A0', accent: '#FF8FC0', accentBright: '#FFC7E0', muted: '#9A7088', warn: '#FFB23E', gold: '#F0C86A' } },
  { id: 'matrix', p: { void: '#020A06', glass: '#0A1A10A0', accent: '#5BE58A', accentBright: '#B7FFCF', muted: '#4A7A5E', warn: '#E0C246', gold: '#B7E86A' } },
];
const BUILDER_TEXTURES = [
  { id: 'clean', t: { scanlines: 0, grid: 0.1, glow: 0.3, vignette: 0.3 } },
  { id: 'grid', t: { scanlines: 0.05, grid: 0.5, glow: 0.35, vignette: 0.3 } },
  { id: 'scanline', t: { scanlines: 0.4, grid: 0.15, glow: 0.4, vignette: 0.35 } },
  { id: 'deepGlow', t: { scanlines: 0, grid: 0.05, glow: 0.7, vignette: 0.5 } },
];
const BUILDER_EFFECTS = ['none', 'embers', 'dust', 'snow', 'petals', 'rain', 'sparkle'];
// Chip glyph + friendly name per effect (the picker reads as a lively row, not a
// plain dropdown). Emoji are standard Segoe symbols so they render on Windows.
const BUILDER_EFFECT_GLYPHS = { none: '⊘', embers: '🔥', dust: '🌫️', snow: '❄️', petals: '🌸', rain: '🌧️', sparkle: '✨' };
const BUILDER_EFFECT_NAMES = { none: 'None', embers: 'Embers', dust: 'Dust', snow: 'Snow', petals: 'Petals', rain: 'Rain', sparkle: 'Sparkle' };
// Each effect's DEFAULT particle-colour token (mirrors the engine's AMBIENCE_COLOR_KEY),
// so the colour picker highlights the right swatch before any override is set.
const AMBIENCE_DEFAULT_KEY = { embers: 'gold', dust: 'muted', snow: 'accentBright', petals: 'accent', rain: 'accent', sparkle: 'accent' };
const BUILDER_FONTS = [['rajdhani', 'Rajdhani (HUD)'], ['system-sans', 'System sans'], ['system-serif', 'Serif'], ['mono', 'Monospace']];

// The component menu (a curated subset of the 20 types), with defaults ticked.
const BUILDER_COMPONENTS = [
  ['hud-clock', 'Reactor clock', true],
  ['ring-clock', 'Ring clock', false],
  ['clock', 'Digital clock', false],
  ['analog-clock', 'Analog clock', false],
  ['stats', 'System stats', true],
  ['cores', 'CPU cores', false],
  ['sysinfo', 'System info', false],
  ['meter', 'Single gauge', false],
  ['sparkline', 'History graph', false],
  ['weather', 'Weather', true],
  ['calendar', 'Calendar', false],
  ['pomodoro', 'Focus timer', false],
  ['agenda', 'Agenda', false],
  ['notifications', 'Notifications', false],
  ['launcher', 'App launcher', false],
  ['mixer', 'Volume mixer', false],
  ['nowplaying', 'Now playing', false],
  ['visualizer', 'Audio visualizer', false],
  ['gallery', 'Photo gallery', false],
  ['status', 'Status bar', true],
  ['assistant', 'AI assistant', true],
  ['text', 'Text label', false],
];
const DEFAULT_SELECTED = BUILDER_COMPONENTS.filter(([, , on]) => on).map(([t]) => t);

// Sensible default options per type so an auto-placed component isn't blank.
const STARTER_OPTS = {
  clock: { format: '24h', seconds: true, showDate: true },
  'hud-clock': { format: '24h', seconds: true, showDate: true },
  'ring-clock': { style: 'minimal', format: '24h', seconds: true, showDate: true },
  'analog-clock': { seconds: true, numerals: 'quarters', minuteTicks: true },
  stats: { cpu: true, mem: true, disk: true },
  cores: {}, sysinfo: { memory: true, disk: true, uptime: true, health: true },
  meter: { bind: 'cpu', variant: 'ring' }, sparkline: { bind: 'cpu' },
  weather: { compact: true },
  calendar: {}, agenda: { days: 7, limit: 6 }, notifications: { limit: 5 },
  pomodoro: { focusMin: 25, shortBreakMin: 5, longBreakMin: 15, cyclesBeforeLong: 4 },
  launcher: { pinned: true, recent: true }, status: {}, assistant: {},
  mixer: { showMaster: true },
  nowplaying: { showArt: true, showControls: true },
  visualizer: { style: 'bars' },
  text: { text: 'HELLO' }, gallery: { images: [], interval: 6, fit: 'cover' },
  rig: { layers: [] },
};

// Category decides which region a component lands in. Bars span full width,
// heroes are the centrepiece, rails stack in the side columns.
function componentCategory(type) {
  if (['status', 'assistant', 'text', 'divider'].includes(type)) return 'bar';
  if (['hud-clock', 'ring-clock', 'analog-clock', 'clock', 'calendar', 'pomodoro', 'module', 'image', 'gallery', 'rig'].includes(type)) return 'hero';
  return 'rail';
}

// Layout templates: a fixed 5-region grid (top/left/centre/right/bottom) whose
// proportions differ. Regions never overlap, so any selection places cleanly.
const BUILDER_LAYOUTS = [
  { key: 'command', name: 'Command', desc: 'Balanced twin rails around a centre.',
    top: [2, 2, 96, 11], bottom: [2, 88, 96, 10], left: [2, 15, 22, 70], center: [26, 15, 48, 70], right: [76, 15, 22, 70] },
  { key: 'wide', name: 'Wide centre', desc: 'A big centrepiece with slim rails.',
    top: [2, 2, 96, 11], bottom: [2, 88, 96, 10], left: [2, 15, 16, 70], center: [20, 15, 60, 70], right: [82, 15, 16, 70] },
  { key: 'twin', name: 'Twin rails', desc: 'Fat side rails, compact centre.',
    top: [2, 2, 96, 11], bottom: [2, 88, 96, 10], left: [2, 15, 30, 70], center: [34, 15, 32, 70], right: [68, 15, 30, 70] },
];

function stackVertical(region, n) {
  if (n <= 0) return [];
  const [x, y, w, h] = region;
  const gap = 1.5;
  const each = (h - gap * (n - 1)) / n;
  const out = [];
  for (let i = 0; i < n; i++) out.push([x, y + i * (each + gap), w, Math.max(4, each)]);
  return out;
}

// Which selected components expose a quick option in the Components step, so a
// creator can set the few things that would otherwise render "unset".
// labelKey → bt('qopt.<labelKey>'); select `options` are value ids resolved via
// `optResolve` ('bind' → editor.insp.bind.*, 'clock' → qopt.24h/12h).
const BUILDER_QUICK_OPTS = {
  weather: [
    { key: 'place', labelKey: 'place', kind: 'text' },
    { key: 'lat', labelKey: 'lat', kind: 'number', min: -90, max: 90 },
    { key: 'lon', labelKey: 'lon', kind: 'number', min: -180, max: 180 },
  ],
  meter: [{ key: 'bind', labelKey: 'reads', kind: 'select', options: ['cpu', 'mem', 'disk', 'battery'], optResolve: 'bind' }],
  sparkline: [{ key: 'bind', labelKey: 'reads', kind: 'select', options: ['cpu', 'mem', 'disk', 'battery'], optResolve: 'bind' }],
  'hud-clock': [{ key: 'format', labelKey: 'clock', kind: 'select', options: ['24h', '12h'], optResolve: 'clock' }],
  clock: [{ key: 'format', labelKey: 'clock', kind: 'select', options: ['24h', '12h'], optResolve: 'clock' }],
  agenda: [{ key: 'days', labelKey: 'days', kind: 'number', min: 1, max: 14 }],
  pomodoro: [{ key: 'focusMin', labelKey: 'focus', kind: 'number', min: 1, max: 180 }],
};

// User-adjustable "Customize knobs" the creator can expose (→ pack.props). The
// default value is snapshotted from the pack at create time.
const BUILDER_KNOBS = [
  { key: 'accent', label: 'Accent colour', type: 'color', bind: { target: 'palette', key: 'accent' }, from: (p) => p.skin.palette.accent },
  { key: 'accent-bright', label: 'Highlight colour', type: 'color', bind: { target: 'palette', key: 'accentBright' }, from: (p) => p.skin.palette.accentBright },
  { key: 'particles', label: 'Particles', type: 'select', bind: { target: 'ambience', key: 'effect' }, from: (p) => p.skin.ambience.effect,
    options: [['none', 'Off'], ['dust', 'Dust'], ['embers', 'Embers'], ['snow', 'Snow'], ['petals', 'Petals'], ['rain', 'Rain'], ['sparkle', 'Sparkle']] },
  { key: 'particle-density', label: 'Particle density', type: 'slider', min: 0.05, max: 1, step: 0.05, bind: { target: 'ambience', key: 'density' }, from: (p) => p.skin.ambience.density },
  { key: 'corner-notches', label: 'Corner notches', type: 'toggle', bind: { target: 'shape', key: 'cornerNotches' }, from: (p) => p.skin.shape.cornerNotches },
];

// Assign chosen component types to a template's regions by category, stacking
// within a region. Overflow (extra bars/heroes) falls through to the rails.
// optOverrides: per-type option tweaks from the Components step's quick-options.
function autoLayout(types, layoutKey, optOverrides) {
  const L = BUILDER_LAYOUTS.find((l) => l.key === layoutKey) || BUILDER_LAYOUTS[0];
  const bars = [], heroes = [], rails = [];
  for (const t of types) { const c = componentCategory(t); (c === 'bar' ? bars : c === 'hero' ? heroes : rails).push(t); }
  const out = [];
  const add = (type, rect) => out.push({
    type,
    rect: rect.map((n) => Math.round(n * 10) / 10),
    z: componentCategory(type) === 'bar' ? 2 : 1,
    style: { panel: componentCategory(type) !== 'hero' },
    options: { ...(STARTER_OPTS[type] || {}), ...((optOverrides && optOverrides[type]) || {}) },
  });

  const barRegions = [L.top, L.bottom].filter(Boolean);
  bars.forEach((t, i) => { if (i < barRegions.length) add(t, barRegions[i]); else rails.push(t); });

  if (L.center && heroes.length) { add(heroes[0], L.center); heroes.slice(1).forEach((t) => rails.push(t)); }
  else heroes.forEach((t) => rails.push(t));

  const railRegions = [L.left, L.right].filter(Boolean);
  if (railRegions.length === 0) {
    stackVertical(L.center || [76, 15, 22, 70], rails.length).forEach((r, i) => add(rails[i], r));
  } else {
    const buckets = railRegions.map(() => []);
    rails.forEach((t, i) => buckets[i % railRegions.length].push(t));
    buckets.forEach((items, bi) => stackVertical(railRegions[bi], items.length).forEach((r, i) => add(items[i], r)));
  }
  return out.slice(0, 24);
}

function starterPack() {
  return {
    schema: 2, name: 'My Pack', author: '',
    persona: { name: 'Dashboard', tagline: '', lines: [] },
    skin: {
      palette: { ...BUILDER_PALETTES[0].p },
      typography: { display: 'rajdhani', uppercase: true, letterSpacing: 0.2 },
      texture: { ...BUILDER_TEXTURES[0].t },
      shape: { cornerNotches: true, borderOpacity: 0.28, panelOpacity: 0.55, radius: 6 },
      ambience: { effect: 'none', density: 0.5 },
      wallpaper: null,
      wallpaperFit: 'cover', wallpaperPosX: 50, wallpaperPosY: 50,
    },
    canvas: { padding: 2 },
    props: [],
    // Filled by the Components step via autoLayout() (see applyBuilderLayout).
    components: [],
  };
}

const builder = { step: 0, pack: null, renderer: null, wallpaperUri: null, selected: [], layout: 'command', compOpts: {}, knobs: new Set(), depthLayers: [], parallaxStrength: 1, fill: null, schedulePreset: null, timelineTarget: 0, customAssets: {} };

// Base-fill presets (a gradient wash painted behind the wallpaper stack). Mirrors
// the editor's Skin-tab presets; stop colours are palette TOKENS so they track the
// Colours step. `none` = flat/solid (no overlay). A chosen preset can then be
// tuned per-stop (colour + position), plus angle and origin (see renderBgStep).
const BUILDER_FILL_PRESETS = [
  { id: 'none', type: 'solid', angle: 155, posX: 50, posY: 50, stops: [] },
  { id: 'linear', type: 'linear', angle: 155, posX: 50, posY: 50, stops: [{ color: 'void', at: 0 }, { color: 'glass', at: 100 }] },
  { id: 'multistop', type: 'linear', angle: 120, posX: 50, posY: 50, stops: [{ color: 'void', at: 0 }, { color: 'glass', at: 55 }, { color: 'muted', at: 100 }] },
  { id: 'duotone', type: 'linear', angle: 180, posX: 50, posY: 50, stops: [{ color: 'glass', at: 0 }, { color: 'void', at: 100 }] },
  { id: 'cut', type: 'linear', angle: 135, posX: 50, posY: 50, stops: [{ color: 'void', at: 0 }, { color: 'void', at: 55 }, { color: 'glass', at: 55 }, { color: 'glass', at: 100 }] },
  { id: 'bands', type: 'linear', angle: 180, posX: 50, posY: 50, stops: [{ color: 'void', at: 0 }, { color: 'void', at: 34 }, { color: 'glass', at: 34 }, { color: 'glass', at: 67 }, { color: 'muted', at: 67 }, { color: 'muted', at: 100 }] },
  { id: 'soft', type: 'linear', angle: 120, posX: 50, posY: 50, stops: [{ color: 'void', at: 0 }, { color: 'void', at: 45 }, { color: 'glass', at: 62 }, { color: 'glass', at: 100 }] },
  { id: 'radial', type: 'radial', angle: 155, posX: 50, posY: 35, stops: [{ color: 'glass', at: 0 }, { color: 'void', at: 70 }] },
  { id: 'spotlight', type: 'radial', angle: 155, posX: 100, posY: 0, stops: [{ color: 'glass', at: 0 }, { color: 'void', at: 60 }] },
  { id: 'conic', type: 'conic', angle: 200, posX: 50, posY: 100, stops: [{ color: 'void', at: 0 }, { color: 'glass', at: 50 }, { color: 'void', at: 100 }] },
  { id: 'mesh', type: 'mesh', angle: 155, posX: 50, posY: 50, stops: [{ color: 'accent', at: 0 }, { color: 'gold', at: 50 }, { color: 'muted', at: 100 }] },
];
const BUILDER_TEXTURE_KEYS = ['scanlines', 'grid', 'glow', 'vignette', 'noise'];
// Plain-language names (the builder steps are English-only; keep it consistent).
const BUILDER_FILL_NAMES = { none: 'None (solid)', linear: 'Linear', multistop: 'Multi-stop', duotone: 'Vertical fade', cut: 'Diagonal cut', bands: 'Stepped bands', soft: 'Soft split', radial: 'Radial glow', spotlight: 'Corner spotlight', conic: 'Conic sweep', mesh: 'Mesh / aurora' };
const BUILDER_TEXTURE_NAMES = { scanlines: 'Scanlines', grid: 'Grid', glow: 'Glow', vignette: 'Vignette', noise: 'Noise' };
// The palette tokens a fill stop can bind to (matches the Colours step so a
// colourway swap restyles the gradient); plain-language names, English-only.
const BUILDER_FILL_TOKENS = ['void', 'glass', 'accent', 'accentBright', 'muted', 'warn', 'gold'];
const BUILDER_PALETTE_NAMES = { void: 'Background', glass: 'Panels', accent: 'Accent', accentBright: 'Bright accent', muted: 'Secondary text', warn: 'Warning', gold: 'Extra accent' };

// Set builder.fill from a preset id (keeps the animate/grain toggles across a
// style change; `none` clears the overlay back to a flat base colour).
function applyBuilderFill(id) {
  const preset = BUILDER_FILL_PRESETS.find((p) => p.id === id) || BUILDER_FILL_PRESETS[0];
  if (preset.id === 'none') { builder.fill = null; return; }
  const keepAnimate = builder.fill ? !!builder.fill.animate : false;
  const keepGrain = builder.fill ? !!builder.fill.grain : false;
  builder.fill = {
    type: preset.type, preset: id, angle: preset.angle, posX: preset.posX, posY: preset.posY,
    stops: preset.stops.map((s) => ({ ...s })), animate: keepAnimate, grain: keepGrain,
  };
}

// A fill stop's colour, shown as SWATCHES of the actual palette colours — a token
// name doesn't tell you what colour you'll get. Clicking a palette swatch binds the
// stop to that token (so it tracks the Colours step); the dashed swatch is a native
// colour input for a Custom hex. Hover a swatch for its name. `el` is the step
// container, re-rendered on a discrete pick so the selected ring moves.
function builderFillColorControl(stop, el) {
  const palette = builder.pack.skin.palette;
  const wrap = document.createElement('div');
  wrap.className = 'fill-swatches';
  const rerender = () => { renderBgStep(el); schedulePreview(); };

  const isToken = BUILDER_FILL_TOKENS.includes(stop.color);
  for (const key of BUILDER_FILL_TOKENS) {
    const sw = document.createElement('button');
    sw.type = 'button';
    sw.className = 'fill-swatch' + (isToken && stop.color === key ? ' selected' : '');
    sw.style.setProperty('--sw', palette[key] || '#000000');
    sw.title = t('editor.insp.pal.' + key);
    sw.addEventListener('click', () => { stop.color = key; rerender(); });
    wrap.appendChild(sw);
  }

  const custom = document.createElement('input');
  custom.type = 'color';
  custom.className = 'fill-swatch fill-swatch-custom' + (isToken ? '' : ' selected');
  custom.value = (isToken ? (palette[stop.color] || '#000000') : (stop.color || '#000000')).slice(0, 7);
  custom.title = 'Custom colour';
  // Live drag updates the preview only; re-render on close (change) so the ring settles.
  custom.addEventListener('input', () => { stop.color = custom.value; schedulePreview(); });
  custom.addEventListener('change', () => { stop.color = custom.value; rerender(); });
  wrap.appendChild(custom);

  return wrap;
}

// The particle colour as SWATCHES (same idea as the fill stops, single value). A
// palette token tracks the Colours step; the dashed swatch is a custom hex. Unset
// → the effect's built-in default token shows selected. `el` re-renders on a pick.
function builderAmbienceColorControl(ambience, el) {
  const palette = builder.pack.skin.palette;
  const wrap = document.createElement('div');
  wrap.className = 'fill-swatches';
  const rerender = () => { renderParticlesStep(el); schedulePreview(); };

  const hasCustom = typeof ambience.color === 'string' && /^#/.test(ambience.color);
  const activeKey = hasCustom ? null
    : (ambience.colorKey && palette[ambience.colorKey]) ? ambience.colorKey
    : (AMBIENCE_DEFAULT_KEY[ambience.effect] || 'accent');

  for (const key of BUILDER_FILL_TOKENS) {
    const sw = document.createElement('button');
    sw.type = 'button';
    sw.className = 'fill-swatch' + (activeKey === key ? ' selected' : '');
    sw.style.setProperty('--sw', palette[key] || '#000000');
    sw.title = t('editor.insp.pal.' + key);
    sw.addEventListener('click', () => { ambience.colorKey = key; delete ambience.color; rerender(); });
    wrap.appendChild(sw);
  }

  const custom = document.createElement('input');
  custom.type = 'color';
  custom.className = 'fill-swatch fill-swatch-custom' + (hasCustom ? ' selected' : '');
  custom.value = (hasCustom ? ambience.color : (palette[activeKey] || '#000000')).slice(0, 7);
  custom.title = 'Custom colour';
  custom.addEventListener('input', () => { ambience.color = custom.value; schedulePreview(); });
  custom.addEventListener('change', () => { ambience.color = custom.value; rerender(); });
  wrap.appendChild(custom);

  return wrap;
}

// A labelled range slider with a live numeric readout (angle / origin). fmt turns
// the raw value into the shown text; onInput fires on every drag.
function bRangeField(label, value, min, max, step, fmt, onInput) {
  const f = bField(label);
  const row = document.createElement('div');
  row.style.display = 'flex';
  row.style.alignItems = 'center';
  row.style.gap = '10px';
  const r = document.createElement('input');
  r.type = 'range'; r.min = String(min); r.max = String(max); r.step = String(step);
  r.value = String(value); r.style.flex = '1'; r.style.minWidth = '0';
  const out = document.createElement('span');
  out.className = 'set-range-val';
  out.textContent = fmt(value);
  r.addEventListener('input', () => { const v = Number(r.value); out.textContent = fmt(v); onInput(v); });
  row.append(r, out);
  f.appendChild(row);
  return f;
}

// Optional parallax: when the user adds depth layers, compose skin.background as
// [base wallpaper, ...extra layers]; otherwise leave it off so a plain wallpaper
// renders via the renderer's wallpaper fallback.
function syncBuilderBackground() {
  const skin = builder.pack.skin;
  const fill = builder.fill;
  if (builder.depthLayers.length && skin.wallpaper) {
    skin.background = {
      layers: [
        { src: skin.wallpaper, depth: 0, fit: skin.wallpaperFit || 'cover', posX: typeof skin.wallpaperPosX === 'number' ? skin.wallpaperPosX : 50, posY: typeof skin.wallpaperPosY === 'number' ? skin.wallpaperPosY : 50, opacity: 1, drift: { x: 0, y: 0 } },
        ...builder.depthLayers.map((d) => ({ src: d.src, depth: d.depth, fit: 'cover', posX: 50, posY: 50, opacity: 1, drift: { x: d.driftX || 0, y: 0 } })),
      ],
      parallax: { strength: builder.parallaxStrength, axis: 'both' },
    };
    if (fill) skin.background.fill = fill;
  } else if (fill) {
    // A base fill with no depth layers: keep ONLY the fill on background. With no
    // layers array, the renderer's fallback (components.js) still synthesizes the
    // wallpaper from skin.wallpaper, and applyFill paints the fill behind it.
    skin.background = { fill };
  } else {
    delete skin.background;
  }
}

// Recompute the pack's components from the current selection + layout + option
// tweaks.
function applyBuilderLayout() {
  builder.pack.components = autoLayout(builder.selected, builder.layout, builder.compOpts);
}

// Build pack.props from the exposed knobs, snapshotting current pack values as
// each knob's default. Called at create time.
function buildBuilderProps() {
  const props = [];
  for (const k of BUILDER_KNOBS) {
    if (!builder.knobs.has(k.key)) continue;
    const prop = { key: k.key, label: k.label, type: k.type, bind: k.bind, default: k.from(builder.pack) };
    if (k.type === 'slider') { prop.min = k.min; prop.max = k.max; prop.step = k.step; }
    if (k.type === 'select') prop.options = k.options.map(([value, label]) => ({ value, label }));
    props.push(prop);
  }
  return props;
}
let builderPreviewTimer = null;

const BUILDER_STEPS = [
  { key: 'background', label: 'Background', render: renderBgStep },
  { key: 'colours', label: 'Colours', render: renderColoursStep },
  { key: 'particles', label: 'Particles', render: renderParticlesStep },
  { key: 'type', label: 'Typography', render: renderTypeStep },
  { key: 'components', label: 'Components', render: renderComponentsStep },
  { key: 'timeofday', label: 'Time of day', render: renderScheduleStep },
  { key: 'animation', label: 'Animation', render: renderTimelineStep },
  { key: 'persona', label: 'Persona', render: renderPersonaStep },
  { key: 'knobs', label: 'Customize knobs', render: renderKnobsStep },
  { key: 'finish', label: 'Name & finish', render: renderFinishStep },
];

// Builder localization helpers. bt() is the manager.builder.* namespace; the
// rest reuse existing key families so labels stay consistent with the editor.
function bt(key, params) { return t('manager.builder.' + key, params); }
function builderEffectName(e) { return t('manager.customize.effect.' + e); }
function builderCompName(type) { return bt('compName.' + type); }
const BUILDER_FONT_KEY = { 'system-sans': 'systemSans', 'system-serif': 'serif', mono: 'mono' };
function builderFontLabel(val) { return val === 'rajdhani' ? bt('font.rajdhani') : t('editor.insp.font.' + (BUILDER_FONT_KEY[val] || 'systemSans')); }

// Small control helpers (keep step renderers readable).
function bField(label, hint) {
  const w = document.createElement('label');
  w.className = 'b-field';
  const s = document.createElement('span');
  s.textContent = label;
  w.appendChild(s);
  // Optional plain-language line under the label (says what a colour paints, etc.).
  if (hint) {
    const h = document.createElement('span');
    h.className = 'b-hint';
    h.textContent = hint;
    w.appendChild(h);
  }
  return w;
}
function bColorInput(value, onChange) {
  const i = document.createElement('input');
  i.type = 'color';
  i.className = 'b-color';
  i.value = normalizeHex(value) || '#000000';
  i.addEventListener('input', () => onChange(i.value));
  return i;
}
function bPresetRow() { const d = document.createElement('div'); d.className = 'b-presets'; return d; }
function bPreset(label, active, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'b-preset' + (active ? ' active' : '');
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

function schedulePreview() {
  clearTimeout(builderPreviewTimer);
  builderPreviewTimer = setTimeout(updateBuilderPreview, 110);
}

function updateBuilderPreview() {
  const el = $('builder-preview');
  if (!el) return;
  syncBuilderBackground(); // compose skin.background from wallpaper + depth layers
  if (displayAspect) el.style.aspectRatio = displayAspect;
  if (builder.renderer) { builder.renderer.destroy(); builder.renderer = null; }
  builder.renderer = AegisComponents.createRenderer(previewServices());
  const assets = {};
  if (builder.pack.skin.wallpaper && builder.wallpaperUri) assets[builder.pack.skin.wallpaper] = builder.wallpaperUri;
  for (const d of builder.depthLayers) if (d.uri) assets[d.src] = d.uri; // extra parallax layers
  Object.assign(assets, builder.customAssets); // imported custom-particle sprite(s)
  renderPackInto(el, builder.pack, assets, builder.renderer);
}

function renderBuilderRail() {
  const rail = $('builder-rail');
  rail.textContent = '';
  BUILDER_STEPS.forEach((s, idx) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'builder-step-btn' + (idx === builder.step ? ' active' : '');
    b.innerHTML = '';
    const num = document.createElement('span');
    num.className = 'builder-step-num';
    num.textContent = String(idx + 1);
    const lab = document.createElement('span');
    lab.textContent = bt('step.' + s.key);
    b.append(num, lab);
    b.addEventListener('click', () => gotoBuilderStep(idx));
    rail.appendChild(b);
  });
}

function gotoBuilderStep(i) {
  builder.step = Math.max(0, Math.min(BUILDER_STEPS.length - 1, i));
  [...$('builder-rail').children].forEach((c, idx) => c.classList.toggle('active', idx === builder.step));
  BUILDER_STEPS[builder.step].render($('builder-step'));
  const last = builder.step === BUILDER_STEPS.length - 1;
  $('builder-back').disabled = builder.step === 0;
  $('builder-next').textContent = last ? bt('nav.create') : t('common.next');
  $('builder-status').textContent = '';
  updateBuilderPreview();
}

async function openBuilder() {
  if (!displayAspect) {
    try { const d = await aegis.display(); if (d.ok) displayAspect = `${d.width} / ${d.height}`; } catch { /* CSS default */ }
  }
  builder.step = 0;
  builder.pack = starterPack();
  builder.wallpaperUri = null;
  builder.depthLayers = [];
  builder.parallaxStrength = 1;
  builder.fill = null;
  builder.selected = [...DEFAULT_SELECTED];
  builder.layout = 'command';
  builder.compOpts = {};
  builder.knobs = new Set();
  builder.schedulePreset = null;
  builder.timelineTarget = 0;
  builder.customAssets = {};
  applyBuilderLayout();
  $('builder-overlay').classList.remove('hidden');
  renderBuilderRail();
  gotoBuilderStep(0);
}

function closeBuilder() {
  clearTimeout(builderPreviewTimer); // don't let a pending render spawn an orphan
  if (builder.renderer) { builder.renderer.destroy(); builder.renderer = null; }
  $('builder-overlay').classList.add('hidden');
}

async function finishBuilder() {
  builder.pack.props = buildBuilderProps();
  syncBuilderBackground(); // carry any parallax depth layers into the pack
  $('builder-status').textContent = bt('status.creating');
  const out = await aegis.builderCreate(builder.pack, true);
  if (!out.ok) { $('builder-status').textContent = out.error || bt('status.createError'); return; }
  closeBuilder();
  await refreshLibrary();
  libStatus(bt('status.created', { id: out.id }));
}

// ── Step renderers ───────────────────────────────────────────────────────────

function renderBgStep(el) {
  el.textContent = '';
  el.appendChild(stepHead(bt('step.background'), bt('desc.background')));

  const base = bField(bt('bg.baseColour'));
  base.appendChild(bColorInput(builder.pack.skin.palette.void, (v) => { builder.pack.skin.palette.void = v; schedulePreview(); }));
  el.appendChild(base);

  const feelLabel = document.createElement('span');
  feelLabel.className = 'b-sublabel';
  feelLabel.textContent = bt('bg.surfaceFeel');
  el.appendChild(feelLabel);
  const feel = bPresetRow();
  const currentFeel = () => {
    const t = builder.pack.skin.texture;
    const match = BUILDER_TEXTURES.find((x) => x.t.scanlines === t.scanlines && x.t.grid === t.grid && x.t.glow === t.glow && x.t.vignette === t.vignette);
    return match ? match.id : null;
  };
  for (const preset of BUILDER_TEXTURES) {
    feel.appendChild(bPreset(bt('tex.' + preset.id), currentFeel() === preset.id, () => {
      builder.pack.skin.texture = { ...preset.t };
      renderBgStep(el); schedulePreview();
    }));
  }
  el.appendChild(feel);

  // Texture — fine-tune the surface (the "Surface feel" presets set these at once).
  const texHead = document.createElement('span');
  texHead.className = 'b-sublabel';
  texHead.textContent = bt('bg.texture');
  el.appendChild(texHead);
  for (const key of BUILDER_TEXTURE_KEYS) {
    if (typeof builder.pack.skin.texture[key] !== 'number') builder.pack.skin.texture[key] = 0;
    const f = bField(bt('texname.' + key));
    const r = document.createElement('input');
    r.type = 'range'; r.min = '0'; r.max = '1'; r.step = '0.05';
    r.value = String(builder.pack.skin.texture[key]);
    r.addEventListener('input', () => { builder.pack.skin.texture[key] = Number(r.value); schedulePreview(); });
    f.appendChild(r);
    el.appendChild(f);
  }

  // Base fill — a gradient (or flat) wash painted behind the wallpaper stack. Pick a
  // preset, then tune it: colour stops (palette token or custom hex + position), the
  // gradient angle, and the radial/conic origin. Stop colours default to palette
  // tokens so they follow the Colours step.
  const fillHead = document.createElement('span');
  fillHead.className = 'b-sublabel';
  fillHead.textContent = bt('bg.baseFill');
  el.appendChild(fillHead);
  const fillRow = bPresetRow();
  const activeFillId = builder.fill ? (builder.fill.preset || builder.fill.type) : 'none';
  for (const preset of BUILDER_FILL_PRESETS) {
    fillRow.appendChild(bPreset(t('editor.insp.fill.style.' + preset.id), activeFillId === preset.id, () => {
      applyBuilderFill(preset.id);
      renderBgStep(el); schedulePreview();
    }));
  }
  el.appendChild(fillRow);
  if (builder.fill && builder.fill.type !== 'solid') {
    const fill = builder.fill;
    if (!Array.isArray(fill.stops)) fill.stops = [];

    // Colour stops — each is a palette-token (or custom hex) colour plus a position
    // along the gradient (0–100). Mesh fills blend without positions, so no slider.
    const stopsHead = document.createElement('span');
    stopsHead.className = 'b-sublabel';
    stopsHead.textContent = bt('bg.colourStops');
    el.appendChild(stopsHead);

    fill.stops.forEach((stop, i) => {
      const f = bField(bt('bg.stop', { n: i + 1 }));
      const stack = document.createElement('div');
      stack.className = 'fill-stop';
      stack.appendChild(builderFillColorControl(stop, el));

      const bottom = document.createElement('div');
      bottom.className = 'fill-stop-row';
      if (fill.type !== 'mesh') {
        const pos = document.createElement('input');
        pos.type = 'range'; pos.min = '0'; pos.max = '100'; pos.step = '1';
        pos.value = String(typeof stop.at === 'number' ? stop.at : 0);
        pos.title = bt('bg.position');
        pos.addEventListener('input', () => { stop.at = Number(pos.value); schedulePreview(); });
        bottom.appendChild(pos);
      }
      const rm = libButton('×', () => { fill.stops.splice(i, 1); renderBgStep(el); schedulePreview(); }, 'tiny danger');
      rm.disabled = fill.stops.length <= 2; // a gradient needs at least two stops
      rm.title = bt('bg.removeStop');
      rm.style.marginLeft = 'auto'; // keep it right-aligned even for mesh (no slider)
      bottom.appendChild(rm);
      stack.appendChild(bottom);
      f.appendChild(stack);
      el.appendChild(f);
    });
    if (fill.stops.length < 6) {
      const add = libButton(bt('bg.addStop'), () => {
        const last = fill.stops[fill.stops.length - 1];
        fill.stops.push({ color: last ? last.color : 'accent', at: 100 });
        renderBgStep(el); schedulePreview();
      }, 'tiny');
      el.appendChild(add);
    }

    // Angle (linear/conic) and origin (radial/conic) — same geometry the editor exposes.
    if (fill.type === 'linear' || fill.type === 'conic') {
      el.appendChild(bRangeField(bt('bg.angle'), Math.round(fill.angle), 0, 360, 5, (v) => `${v}°`, (v) => { fill.angle = v; schedulePreview(); }));
    }
    if (fill.type === 'radial' || fill.type === 'conic') {
      el.appendChild(bRangeField(bt('bg.originX'), fill.posX, 0, 100, 1, (v) => `${v}%`, (v) => { fill.posX = v; schedulePreview(); }));
      el.appendChild(bRangeField(bt('bg.originY'), fill.posY, 0, 100, 1, (v) => `${v}%`, (v) => { fill.posY = v; schedulePreview(); }));
    }

    const toggles = bField(bt('bg.movementGrain'));
    const mkChk = (label, get, set) => {
      const lab = document.createElement('label');
      lab.style.display = 'inline-flex'; lab.style.alignItems = 'center'; lab.style.gap = '5px'; lab.style.marginRight = '14px';
      const cb = document.createElement('input');
      cb.type = 'checkbox'; cb.checked = get();
      cb.addEventListener('change', () => { set(cb.checked); schedulePreview(); });
      lab.append(cb, document.createTextNode(label));
      return lab;
    };
    const wrap = document.createElement('div');
    wrap.append(
      mkChk(bt('bg.slowDrift'), () => !!builder.fill.animate, (v) => { builder.fill.animate = v; }),
      mkChk(bt('bg.filmGrain'), () => !!builder.fill.grain, (v) => { builder.fill.grain = v; }),
    );
    toggles.appendChild(wrap);
    el.appendChild(toggles);
  }

  const imgLabel = document.createElement('span');
  imgLabel.className = 'b-sublabel';
  imgLabel.textContent = bt('bg.yourImage');
  el.appendChild(imgLabel);
  const imgNote = document.createElement('p');
  imgNote.className = 'hint';
  imgNote.textContent = bt('bg.imageNote');
  el.appendChild(imgNote);
  const imgRow = document.createElement('div');
  imgRow.className = 'b-presets';
  const isVideoWp = /\.(mp4|webm)$/i.test(builder.pack.skin.wallpaper || '');
  imgRow.appendChild(libButton(builder.pack.skin.wallpaper && !isVideoWp ? bt('bg.replaceImage') : bt('bg.chooseImage'), async () => {
    const out = await aegis.builderImportImage([]);
    if (out.error === null && !out.ok) return; // cancelled
    if (!out.ok) { $('builder-status').textContent = out.error; return; }
    builder.pack.skin.wallpaper = out.rel;
    builder.wallpaperUri = out.uri;
    renderBgStep(el); updateBuilderPreview();
  }));
  imgRow.appendChild(libButton(isVideoWp ? bt('bg.replaceVideo') : bt('bg.chooseVideo'), async () => {
    const out = await aegis.builderImportVideo([]);
    if (out.error === null && !out.ok) return; // cancelled
    if (!out.ok) { $('builder-status').textContent = out.error; return; }
    builder.pack.skin.wallpaper = out.rel;
    builder.wallpaperUri = out.uri; // a depack:// url — the preview plays it live
    renderBgStep(el); updateBuilderPreview();
  }));
  if (builder.pack.skin.wallpaper) {
    imgRow.appendChild(libButton(isVideoWp ? bt('bg.removeVideo') : bt('bg.removeImage'), () => {
      builder.pack.skin.wallpaper = null;
      builder.wallpaperUri = null;
      renderBgStep(el); updateBuilderPreview();
    }, 'danger'));
  }
  el.appendChild(imgRow);

  // Crop / adjust — only relevant once there's an image.
  if (builder.pack.skin.wallpaper) {
    const adjLabel = document.createElement('span');
    adjLabel.className = 'b-sublabel';
    adjLabel.textContent = bt('bg.fitCrop');
    el.appendChild(adjLabel);

    const fits = bPresetRow();
    for (const [val, labelKey] of [['cover', 'fillCrop'], ['contain', 'fitWhole'], ['stretch', 'stretch']]) {
      fits.appendChild(bPreset(bt('bg.' + labelKey), (builder.pack.skin.wallpaperFit || 'cover') === val, () => {
        builder.pack.skin.wallpaperFit = val;
        renderBgStep(el); schedulePreview();
      }));
    }
    el.appendChild(fits);

    // Focal point matters when the image is cropped (Fill) — pick what shows.
    if ((builder.pack.skin.wallpaperFit || 'cover') !== 'stretch') {
      const posNote = document.createElement('p');
      posNote.className = 'hint';
      posNote.textContent = bt('bg.posNote');
      el.appendChild(posNote);
      const mkPos = (axis, label) => {
        const f = bField(label);
        const r = document.createElement('input');
        r.type = 'range'; r.min = '0'; r.max = '100'; r.step = '1';
        r.value = String(builder.pack.skin[axis]);
        r.addEventListener('input', () => { builder.pack.skin[axis] = Number(r.value); schedulePreview(); });
        f.appendChild(r);
        el.appendChild(f);
      };
      mkPos('wallpaperPosX', bt('bg.horizontal'));
      mkPos('wallpaperPosY', bt('bg.vertical'));
      el.appendChild(libButton(bt('bg.center'), () => {
        builder.pack.skin.wallpaperPosX = 50;
        builder.pack.skin.wallpaperPosY = 50;
        renderBgStep(el); schedulePreview();
      }, 'tiny'));
    }

    // Video-only: playback speed. The engine always mutes a video wallpaper.
    if (isVideoWp) {
      if (!builder.pack.skin.wallpaperVideo || typeof builder.pack.skin.wallpaperVideo.playbackRate !== 'number') {
        builder.pack.skin.wallpaperVideo = { playbackRate: 1 };
      }
      const speed = bField(bt('bg.playbackSpeed'));
      const sr = document.createElement('input');
      sr.type = 'range'; sr.min = '0.25'; sr.max = '2'; sr.step = '0.05';
      sr.value = String(builder.pack.skin.wallpaperVideo.playbackRate);
      sr.addEventListener('input', () => { builder.pack.skin.wallpaperVideo.playbackRate = Number(sr.value); schedulePreview(); });
      speed.appendChild(sr);
      el.appendChild(speed);
    }

    // Optional parallax depth layers — extra images/videos in FRONT of the base
    // wallpaper, each moving with the cursor by its depth. Full per-layer control
    // (fit, position, opacity, drift) lives in the editor after you create.
    const depthLabel = document.createElement('span');
    depthLabel.className = 'b-sublabel';
    depthLabel.textContent = bt('bg.depthLayers');
    el.appendChild(depthLabel);
    const depthNote = document.createElement('p');
    depthNote.className = 'hint';
    depthNote.textContent = bt('bg.depthNote');
    el.appendChild(depthNote);

    builder.depthLayers.forEach((d, i) => {
      const row = bField(bt('bg.layerDepth', { n: i + 2 }) + (/\.(mp4|webm)$/i.test(d.src) ? ' ' + bt('bg.videoTag') : ''));
      const dr = document.createElement('input');
      dr.type = 'range'; dr.min = '0'; dr.max = '1'; dr.step = '0.05';
      dr.value = String(d.depth);
      dr.addEventListener('input', () => { d.depth = Number(dr.value); schedulePreview(); });
      row.appendChild(dr);
      row.appendChild(libButton(bt('bg.remove'), () => { builder.depthLayers.splice(i, 1); renderBgStep(el); updateBuilderPreview(); }, 'tiny danger'));
      el.appendChild(row);
    });

    if (builder.depthLayers.length < 5) {
      const addDepth = async (importFn) => {
        const out = await importFn([]);
        if (out.error === null && !out.ok) return; // cancelled
        if (!out.ok) { $('builder-status').textContent = out.error; return; }
        builder.depthLayers.push({ src: out.rel, uri: out.uri, depth: 0.5, driftX: 0 });
        renderBgStep(el); updateBuilderPreview();
      };
      const addRow = bPresetRow();
      addRow.appendChild(libButton(bt('bg.addImageLayer'), () => addDepth(aegis.builderImportImage), 'tiny'));
      addRow.appendChild(libButton(bt('bg.addVideoLayer'), () => addDepth(aegis.builderImportVideo), 'tiny'));
      el.appendChild(addRow);
    }

    if (builder.depthLayers.length) {
      const strength = bField(bt('bg.parallaxStrength'));
      const pr = document.createElement('input');
      pr.type = 'range'; pr.min = '0'; pr.max = '2'; pr.step = '0.1';
      pr.value = String(builder.parallaxStrength);
      pr.addEventListener('input', () => { builder.parallaxStrength = Number(pr.value); schedulePreview(); });
      strength.appendChild(pr);
      el.appendChild(strength);
    }
  }
}

function renderColoursStep(el) {
  el.textContent = '';
  el.appendChild(stepHead(bt('step.colours'), bt('desc.colours')));

  const presets = bPresetRow();
  const activePalette = BUILDER_PALETTES.find((x) => x.p.accent === builder.pack.skin.palette.accent);
  for (const preset of BUILDER_PALETTES) {
    const b = bPreset(bt('palette.' + preset.id), activePalette === preset, () => {
      builder.pack.skin.palette = { ...preset.p };
      renderColoursStep(el); schedulePreview();
    });
    const dot = document.createElement('span');
    dot.className = 'b-swatch-dot';
    dot.style.background = preset.p.accent;
    b.prepend(dot);
    presets.appendChild(b);
  }
  el.appendChild(presets);

  // Plain-language names + a line saying what each colour actually paints — the raw
  // token names (muted/gold) told you nothing about what you'd get.
  for (const key of ['accent', 'accentBright', 'muted', 'warn', 'gold']) {
    const f = bField(t('editor.insp.pal.' + key), bt('colourHint.' + key));
    f.appendChild(bColorInput(builder.pack.skin.palette[key], (v) => { builder.pack.skin.palette[key] = v; schedulePreview(); }));
    el.appendChild(f);
  }
}

function renderParticlesStep(el) {
  el.textContent = '';
  el.appendChild(stepHead(bt('step.particles'), bt('desc.particles')));
  const amb = builder.pack.skin.ambience;

  // Custom particle system (Particle Studio) — a simplified guided version; the
  // full studio (sprite import, mask emitter, physics) is in the editor.
  if (amb.mode === 'custom' && amb.system && window.AegisParticles) {
    renderBuilderCustomParticles(el, amb);
    return;
  }

  // Effect — glyph chips (matches the Surface-feel / Base-fill picker style).
  const fxLabel = document.createElement('span');
  fxLabel.className = 'b-sublabel';
  fxLabel.textContent = bt('particles.effect');
  el.appendChild(fxLabel);
  const fxRow = bPresetRow();
  for (const e of BUILDER_EFFECTS) {
    fxRow.appendChild(bPreset(`${BUILDER_EFFECT_GLYPHS[e] || ''}  ${builderEffectName(e)}`, amb.effect === e, () => {
      amb.effect = e;
      renderParticlesStep(el); schedulePreview();
    }));
  }
  el.appendChild(fxRow);

  // A preset effect's own knobs (colour / density / speed / glow). Skipped for
  // 'none' — but the "Customize particles…" fork below stays available so you
  // can build a custom system from scratch even without a preset.
  if (amb.effect !== 'none') {
    const colLabel = document.createElement('span');
    colLabel.className = 'b-sublabel';
    colLabel.textContent = bt('particles.colour');
    el.appendChild(colLabel);
    el.appendChild(builderAmbienceColorControl(amb, el));

    if (typeof amb.speed !== 'number') amb.speed = 1;
    el.appendChild(bRangeField(bt('particles.density'), amb.density, 0.05, 1, 0.05, (v) => v.toFixed(2), (v) => { amb.density = v; schedulePreview(); }));
    el.appendChild(bRangeField(bt('particles.speed'), amb.speed, 0.2, 3, 0.1, (v) => `${v.toFixed(1)}x`, (v) => { amb.speed = v; schedulePreview(); }));

    const glow = bField(bt('particles.glow'));
    const lab = document.createElement('label');
    lab.style.display = 'inline-flex'; lab.style.alignItems = 'center'; lab.style.gap = '6px';
    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.checked = !!amb.glow;
    cb.addEventListener('change', () => { amb.glow = cb.checked; schedulePreview(); });
    lab.append(cb, document.createTextNode(bt('particles.glowDesc')));
    glow.appendChild(lab);
    el.appendChild(glow);
  }

  // Fork into a fully-custom particle system (Particle Studio) — ALWAYS offered
  // (from 'none' it starts from a sane default system via factoryFor).
  if (window.AegisParticles) {
    const cust = libButton(bt('particles.customize'), () => {
      amb.system = window.AegisParticles.factoryFor(amb.effect);
      amb.mode = 'custom';
      renderParticlesStep(el); schedulePreview();
    }, 'tiny');
    el.appendChild(cust);
    const chint = document.createElement('p');
    chint.className = 'hint';
    chint.textContent = bt('particles.customizeHint');
    el.appendChild(chint);
  }
}

// Simplified custom-particle controls for the builder. The big knobs (count /
// size / speed / spread / blend / colour) + a "Start from" factory picker; the
// full studio is in the editor. Shares window.AegisParticles with the editor.
const BUILDER_CUSTOM_FACTORIES = ['snow', 'embers', 'dust', 'petals', 'rain', 'sparkle'];
const BUILDER_BLENDS = [['normal', 'Normal'], ['screen', 'Screen'], ['additive', 'Glow']];
function renderBuilderCustomParticles(el, amb) {
  const AP = window.AegisParticles;
  const sys = amb.system;

  el.appendChild(libButton(bt('cp.back'), () => {
    amb.mode = 'preset';
    renderParticlesStep(el); schedulePreview();
  }, 'tiny'));

  const startLabel = document.createElement('span');
  startLabel.className = 'b-sublabel';
  startLabel.textContent = bt('cp.startFrom');
  el.appendChild(startLabel);
  const frow = bPresetRow();
  for (const key of BUILDER_CUSTOM_FACTORIES) {
    frow.appendChild(bPreset(builderEffectName(key), false, () => {
      amb.system = AP.factoryFor(key);
      renderParticlesStep(el); schedulePreview();
    }));
  }
  el.appendChild(frow);

  el.appendChild(bRangeField(bt('cp.count'), sys.count, 1, 400, 1, (v) => String(Math.round(v)), (v) => { sys.count = Math.round(v); schedulePreview(); }));
  el.appendChild(bRangeField(bt('cp.size'), sys.sizeMax, 0.1, 4, 0.1, (v) => v.toFixed(1), (v) => { sys.sizeMax = v; sys.sizeMin = Math.max(0.1, v * 0.5); schedulePreview(); }));
  el.appendChild(bRangeField(bt('cp.speed'), sys.speedMax, 0, 30, 0.5, (v) => v.toFixed(1), (v) => { sys.speedMax = v; sys.speedMin = Math.max(0, v * 0.5); schedulePreview(); }));
  el.appendChild(bRangeField(bt('cp.spread'), sys.spread, 0, 180, 5, (v) => `${Math.round(v)}°`, (v) => { sys.spread = v; schedulePreview(); }));

  const blLabel = document.createElement('span');
  blLabel.className = 'b-sublabel';
  blLabel.textContent = bt('cp.blend');
  el.appendChild(blLabel);
  const blrow = bPresetRow();
  const BLEND_KEY = { normal: 'normal', screen: 'screen', additive: 'glow' };
  for (const [val] of BUILDER_BLENDS) {
    blrow.appendChild(bPreset(bt('blend.' + BLEND_KEY[val]), sys.blend === val, () => { sys.blend = val; renderParticlesStep(el); schedulePreview(); }));
  }
  el.appendChild(blrow);

  const cf = bField(bt('cp.colour'));
  const resolved = sys.color.paletteKey === 'custom'
    ? (sys.color.custom || '#ffffff')
    : (builder.pack.skin.palette[sys.color.paletteKey] || '#ffffff');
  cf.appendChild(bColorInput(resolved, (v) => { sys.color = { ...sys.color, paletteKey: 'custom', custom: v }; schedulePreview(); }));
  el.appendChild(cf);

  // Custom sprite image — import your own PNG/WebP (≤256×256) instead of a
  // built-in shape. Staged now; carried into the pack on create.
  const spLabel = document.createElement('span');
  spLabel.className = 'b-sublabel';
  spLabel.textContent = bt('cp.spriteImage');
  el.appendChild(spLabel);
  const spRow = document.createElement('div');
  spRow.className = 'b-motion-row';
  if (sys.sprite.custom) {
    const nm = document.createElement('span');
    nm.textContent = sys.sprite.custom.replace('assets/', '');
    spRow.appendChild(nm);
    spRow.appendChild(libButton(bt('cp.remove'), () => { delete sys.sprite.custom; renderParticlesStep(el); schedulePreview(); }, 'tiny danger'));
  } else {
    spRow.appendChild(libButton(bt('cp.importImage'), async () => {
      const rel = await builderImportSprite();
      if (rel) { sys.sprite.custom = rel; renderParticlesStep(el); schedulePreview(); }
    }, 'tiny'));
    const hint = document.createElement('span');
    hint.style.fontSize = '11px'; hint.style.opacity = '0.72';
    hint.textContent = bt('cp.spriteHint');
    spRow.appendChild(hint);
  }
  el.appendChild(spRow);

  const note = document.createElement('p');
  note.className = 'hint';
  note.textContent = bt('cp.note');
  el.appendChild(note);
}

// Import a custom particle sprite via the builder's image dialog, enforcing the
// same ≤256×256 cap as the editor. Stashes the data URI for the live preview and
// returns the asset rel (or null if cancelled / too large). Main already staged
// the bytes, so builder:create carries them into the pack.
async function builderImportSprite() {
  const out = await aegis.builderImportImage([]);
  if (!out || !out.ok || !out.rel) return null;
  const okDims = await new Promise((res) => {
    const im = new Image();
    im.onload = () => res(im.naturalWidth <= 256 && im.naturalHeight <= 256);
    im.onerror = () => res(false);
    im.src = out.uri;
  });
  if (!okDims) {
    if (aegis.unstageAsset) aegis.unstageAsset(out.rel);
    $('builder-status').textContent = bt('cp.tooLarge');
    return null;
  }
  builder.customAssets[out.rel] = out.uri; // feed the live preview
  return out.rel;
}

function renderTypeStep(el) {
  el.textContent = '';
  el.appendChild(stepHead(bt('step.type'), bt('desc.type')));

  const font = bField(bt('type.displayFont'));
  const sel = document.createElement('select');
  for (const [val] of BUILDER_FONTS) {
    const o = document.createElement('option'); o.value = val; o.textContent = builderFontLabel(val); sel.appendChild(o);
  }
  sel.value = builder.pack.skin.typography.display;
  sel.addEventListener('change', () => { builder.pack.skin.typography.display = sel.value; schedulePreview(); });
  font.appendChild(sel);
  el.appendChild(font);

  const up = document.createElement('label');
  up.className = 'cfg-check';
  const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = builder.pack.skin.typography.uppercase;
  cb.addEventListener('change', () => { builder.pack.skin.typography.uppercase = cb.checked; schedulePreview(); });
  const sp = document.createElement('span'); sp.textContent = bt('type.uppercase');
  up.append(cb, sp);
  el.appendChild(up);
}

// ── Builder step: Time of day (Phase G schedule) ─────────────────────────────
// Enable a time-of-day recolour with one tap. The presets derive each slot from
// the pack's own base palette (shared with the editor via window.AegisPresets),
// and "Preview a time" jumps the stage to a slot (runtime-only __previewHour;
// the sanitizer strips it, so it never persists).
function renderScheduleStep(el) {
  el.textContent = '';
  el.appendChild(stepHead(bt('step.timeofday'), bt('desc.timeofday')));
  const skin = builder.pack.skin;
  const enabled = !!(skin.schedule && skin.schedule.enabled);

  const lookLabel = document.createElement('span');
  lookLabel.className = 'b-sublabel';
  lookLabel.textContent = bt('tod.look');
  el.appendChild(lookLabel);
  const row = bPresetRow();
  row.appendChild(bPreset(bt('tod.off'), !enabled, () => {
    if (skin.schedule) skin.schedule.enabled = false;
    delete builder.pack.__previewHour;
    renderScheduleStep(el); schedulePreview();
  }));
  for (const preset of window.AegisPresets.SCHEDULE_PRESETS) {
    row.appendChild(bPreset(t('editor.insp.schedule.preset.' + preset.id), enabled && builder.schedulePreset === preset.id, () => {
      skin.schedule = { enabled: true, slots: window.AegisPresets.buildScheduleSlots(skin.palette, preset.id) };
      builder.schedulePreset = preset.id;
      delete builder.pack.__previewHour;
      renderScheduleStep(el); schedulePreview();
    }));
  }
  el.appendChild(row);
  if (!enabled) return;

  const prevLabel = document.createElement('span');
  prevLabel.className = 'b-sublabel';
  prevLabel.textContent = bt('tod.previewTime');
  el.appendChild(prevLabel);
  const prow = bPresetRow();
  const cur = builder.pack.__previewHour;
  const isAuto = typeof cur !== 'number';
  const slots = skin.schedule.slots;
  prow.appendChild(bPreset(bt('tod.now'), isAuto, () => { delete builder.pack.__previewHour; renderScheduleStep(el); updateBuilderPreview(); }));
  for (const name of ['dawn', 'day', 'dusk', 'night']) {
    prow.appendChild(bPreset(bt('tod.' + name), !isAuto && cur === slots[name].startHour, () => {
      builder.pack.__previewHour = slots[name].startHour;
      renderScheduleStep(el); updateBuilderPreview();
    }));
  }
  el.appendChild(prow);
}

// ── Builder step: Animation (Phase G timeline motions) ───────────────────────
// Tap a ready-made motion to add a looping track (shared window.AegisPresets).
// Component motions target the chosen widget; Twinkle animates the ambience.
const BUILDER_MOTION_PROP = { opacity: 'fade', x: 'move X', y: 'move Y', scale: 'scale', rotate: 'rotate' };
function renderTimelineStep(el) {
  el.textContent = '';
  el.appendChild(stepHead(bt('step.animation'), bt('desc.animation')));
  const comps = builder.pack.components || [];

  if (comps.length) {
    const tf = bField(bt('anim.animateWidget'));
    const sel = document.createElement('select');
    comps.forEach((c, i) => { const o = document.createElement('option'); o.value = String(i); o.textContent = `${i + 1} · ${builderCompName(c.type)}`; sel.appendChild(o); });
    if (typeof builder.timelineTarget !== 'number' || builder.timelineTarget >= comps.length) builder.timelineTarget = 0;
    sel.value = String(builder.timelineTarget);
    sel.addEventListener('change', () => { builder.timelineTarget = Number(sel.value); });
    tf.appendChild(sel);
    el.appendChild(tf);
  } else {
    const p = document.createElement('p');
    p.className = 'hint';
    p.textContent = bt('anim.noComps');
    el.appendChild(p);
  }

  const mLabel = document.createElement('span');
  mLabel.className = 'b-sublabel';
  mLabel.textContent = bt('anim.addMotion');
  el.appendChild(mLabel);
  const row = bPresetRow();
  for (const motion of window.AegisPresets.TIMELINE_MOTIONS) {
    if (motion.kind === 'component' && !comps.length) continue;
    row.appendChild(bPreset(t('editor.insp.timeline.motion.' + motion.id), false, () => {
      if (!builder.pack.timeline) builder.pack.timeline = { duration: 8, loop: 'mirror', tracks: [] };
      if (builder.pack.timeline.tracks.length >= 8) return;
      const track = window.AegisPresets.buildMotionTrack(motion.id, builder.pack.timeline.duration, builder.timelineTarget || 0);
      if (track) builder.pack.timeline.tracks.push(track);
      renderTimelineStep(el); schedulePreview();
    }));
  }
  el.appendChild(row);

  const tl = builder.pack.timeline;
  if (tl && tl.tracks.length) {
    const aLabel = document.createElement('span');
    aLabel.className = 'b-sublabel';
    aLabel.textContent = bt('anim.added', { n: tl.tracks.length });
    el.appendChild(aLabel);
    tl.tracks.forEach((tr, i) => {
      const rowEl = document.createElement('div');
      rowEl.className = 'b-motion-row';
      const nm = document.createElement('span');
      nm.textContent = tr.target.kind === 'ambience'
        ? bt('anim.ambienceTwinkle')
        : bt('anim.widget', { n: tr.target.index + 1, prop: bt('animprop.' + tr.target.prop) });
      const rm = libButton('×', () => {
        tl.tracks.splice(i, 1);
        if (!tl.tracks.length) delete builder.pack.timeline;
        renderTimelineStep(el); schedulePreview();
      }, 'tiny danger');
      rowEl.append(nm, rm);
      el.appendChild(rowEl);
    });
  }
}

function renderComponentsStep(el) {
  el.textContent = '';
  el.appendChild(stepHead(bt('step.components'), bt('desc.components')));

  const layoutLabel = document.createElement('span');
  layoutLabel.className = 'b-sublabel';
  layoutLabel.textContent = bt('comp.layout');
  el.appendChild(layoutLabel);
  const layouts = bPresetRow();
  for (const L of BUILDER_LAYOUTS) {
    const b = bPreset(bt('layout.' + L.key), builder.layout === L.key, () => {
      builder.layout = L.key;
      applyBuilderLayout();
      renderComponentsStep(el); schedulePreview();
    });
    b.title = bt('layout.' + L.key + 'Desc');
    layouts.appendChild(b);
  }
  el.appendChild(layouts);

  const compLabel = document.createElement('span');
  compLabel.className = 'b-sublabel';
  compLabel.textContent = bt('comp.count', { n: builder.selected.length });
  el.appendChild(compLabel);
  const grid = document.createElement('div');
  grid.className = 'b-comp-grid';
  for (const [type] of BUILDER_COMPONENTS) {
    const row = document.createElement('label');
    row.className = 'cfg-check';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = builder.selected.includes(type);
    cb.addEventListener('change', () => {
      if (cb.checked) { if (!builder.selected.includes(type)) builder.selected.push(type); }
      else builder.selected = builder.selected.filter((t) => t !== type);
      applyBuilderLayout();
      // Re-render the step so a newly-ticked component's quick-options appear.
      renderComponentsStep(el);
      schedulePreview();
    });
    const sp = document.createElement('span');
    sp.textContent = builderCompName(type);
    row.append(cb, sp);
    grid.appendChild(row);
  }
  el.appendChild(grid);

  // Quick options for the selected components that have anything worth setting
  // now (so e.g. weather isn't left showing "set a location").
  const withOpts = builder.selected.filter((t) => BUILDER_QUICK_OPTS[t]);
  if (withOpts.length) {
    const optLabel = document.createElement('span');
    optLabel.className = 'b-sublabel';
    optLabel.textContent = bt('comp.quickOptions');
    el.appendChild(optLabel);
    for (const type of withOpts) {
      const group = document.createElement('div');
      group.className = 'b-optgroup';
      const gl = document.createElement('div');
      gl.className = 'b-optgroup-title';
      gl.textContent = builderCompName(type);
      group.appendChild(gl);
      for (const spec of BUILDER_QUICK_OPTS[type]) group.appendChild(buildQuickOpt(type, spec));
      el.appendChild(group);
    }
  }
}

// One quick-option control that writes into builder.compOpts[type][key].
function buildQuickOpt(type, spec) {
  const cur = (builder.compOpts[type] || {})[spec.key];
  const def = (STARTER_OPTS[type] || {})[spec.key];
  const val = cur !== undefined ? cur : def;
  const set = (v) => {
    builder.compOpts[type] = builder.compOpts[type] || {};
    builder.compOpts[type][spec.key] = v;
    applyBuilderLayout();
    schedulePreview();
  };
  const f = bField(bt('qopt.' + spec.labelKey));
  if (spec.kind === 'select') {
    const sel = document.createElement('select');
    const optLabel = (v) => spec.optResolve === 'bind' ? t('editor.insp.bind.' + v) : bt('qopt.' + v);
    for (const v of spec.options) { const o = document.createElement('option'); o.value = v; o.textContent = optLabel(v); sel.appendChild(o); }
    sel.value = String(val != null ? val : spec.options[0]);
    sel.addEventListener('change', () => set(sel.value));
    f.appendChild(sel);
  } else if (spec.kind === 'number') {
    const inp = document.createElement('input');
    inp.type = 'number'; inp.min = String(spec.min); inp.max = String(spec.max);
    inp.value = val != null ? String(val) : '';
    inp.addEventListener('input', () => { const n = Number(inp.value); if (Number.isFinite(n)) set(Math.min(spec.max, Math.max(spec.min, n))); });
    f.appendChild(inp);
  } else {
    const inp = document.createElement('input');
    inp.type = 'text'; inp.value = val != null ? String(val) : '';
    inp.addEventListener('input', () => set(inp.value));
    f.appendChild(inp);
  }
  return f;
}

function renderKnobsStep(el) {
  el.textContent = '';
  el.appendChild(stepHead(bt('step.knobs'), bt('desc.knobs')));
  for (const k of BUILDER_KNOBS) {
    const row = document.createElement('label');
    row.className = 'cfg-check';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = builder.knobs.has(k.key);
    cb.addEventListener('change', () => { if (cb.checked) builder.knobs.add(k.key); else builder.knobs.delete(k.key); });
    const sp = document.createElement('span');
    sp.textContent = knobLabelText(k.label);
    row.append(cb, sp);
    el.appendChild(row);
  }
}

function renderPersonaStep(el) {
  el.textContent = '';
  el.appendChild(stepHead(bt('step.persona'), bt('desc.persona')));

  const pname = bField(bt('persona.name'));
  const pIn = document.createElement('input'); pIn.type = 'text'; pIn.maxLength = 40; pIn.value = builder.pack.persona.name;
  pIn.addEventListener('input', () => { builder.pack.persona.name = pIn.value; schedulePreview(); });
  pname.appendChild(pIn);
  el.appendChild(pname);

  const tag = bField(bt('persona.tagline'));
  const tIn = document.createElement('input'); tIn.type = 'text'; tIn.maxLength = 80; tIn.value = builder.pack.persona.tagline;
  tIn.addEventListener('input', () => { builder.pack.persona.tagline = tIn.value; schedulePreview(); });
  tag.appendChild(tIn);
  el.appendChild(tag);

  const lines = bField(bt('persona.lines'));
  const ta = document.createElement('textarea'); ta.rows = 5;
  ta.value = (builder.pack.persona.lines || []).join('\n');
  ta.addEventListener('input', () => {
    builder.pack.persona.lines = ta.value.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 8);
    schedulePreview();
  });
  lines.appendChild(ta);
  el.appendChild(lines);
}

function renderFinishStep(el) {
  el.textContent = '';
  el.appendChild(stepHead(bt('step.finish'), bt('desc.finish')));

  const name = bField(bt('finish.packName'));
  const nIn = document.createElement('input'); nIn.type = 'text'; nIn.maxLength = 60; nIn.value = builder.pack.name;
  nIn.addEventListener('input', () => { builder.pack.name = nIn.value; });
  name.appendChild(nIn);
  el.appendChild(name);

  const author = bField(bt('finish.author'));
  const aIn = document.createElement('input'); aIn.type = 'text'; aIn.maxLength = 60; aIn.value = builder.pack.author || '';
  aIn.placeholder = bt('finish.authorPlaceholder');
  aIn.addEventListener('input', () => { builder.pack.author = aIn.value; });
  author.appendChild(aIn);
  el.appendChild(author);

  const reviewLabel = document.createElement('span');
  reviewLabel.className = 'b-sublabel';
  reviewLabel.textContent = bt('finish.review');
  el.appendChild(reviewLabel);
  const summary = document.createElement('ul');
  summary.className = 'b-summary';
  const skin = builder.pack.skin;
  const items = [
    bt('finish.reviewLayout', { v: bt('layout.' + builder.layout) }),
    bt('finish.reviewComponents', { n: builder.pack.components.length, list: builder.selected.map(builderCompName).join(', ') || bt('finish.componentsNone') }),
    skin.wallpaper ? bt('finish.reviewBgImage') : bt('finish.reviewBgEngine', { colour: skin.palette.void }),
    bt('finish.reviewAccent', { accent: skin.palette.accent, particles: builderEffectName(skin.ambience.effect), font: builderFontLabel(skin.typography.display) }),
    bt('finish.reviewPersona', { name: builder.pack.persona.name || '—' }),
    bt('finish.reviewKnobs', { v: builder.knobs.size ? bt('finish.knobsExposed', { n: builder.knobs.size }) : bt('finish.knobsNone') }),
  ];
  for (const it of items) { const li = document.createElement('li'); li.textContent = it; summary.appendChild(li); }
  el.appendChild(summary);

  if (!builder.selected.length) {
    const warn = document.createElement('p');
    warn.className = 'hint';
    warn.textContent = bt('finish.noComponents');
    el.appendChild(warn);
  }

  // No "publish straight to Workshop" here: a brand-new pack should be fine-tuned
  // in the editor first, so the only finish action is "Create & open in editor"
  // (the nav button). Publishing happens later, from the library, once it's ready.
}

function stepHead(title, body) {
  const wrap = document.createElement('div');
  wrap.className = 'b-step-head';
  const h = document.createElement('h3'); h.textContent = title;
  const p = document.createElement('p'); p.className = 'hint'; p.textContent = body;
  wrap.append(h, p);
  return wrap;
}

function wireBuilder() {
  $('builder-close').addEventListener('click', closeBuilder);
  $('builder-back').addEventListener('click', () => gotoBuilderStep(builder.step - 1));
  $('builder-next').addEventListener('click', () => {
    if (builder.step === BUILDER_STEPS.length - 1) finishBuilder();
    else gotoBuilderStep(builder.step + 1);
  });
}

// ── Settings tab: startup + performance ──────────────────────────────────────
// Both prefs are owned by main (login item / settings.json) and also live on
// the tray, so this tab always reads fresh state and writes through on change.

let settingsFpsBuilt = false;

async function renderSettingsCfg() {
  // Language picker: available locales (bundled + community drop-ins). Rebuilt
  // each render so a newly dropped-in locale file shows up. Changing it reloads
  // the window, since the dictionary is handed to the page at load.
  try {
    const langRes = await aegis.i18nList();
    if (langRes && langRes.ok) {
      const langSel = $('set-language');
      langSel.textContent = '';
      const autoOpt = document.createElement('option');
      autoOpt.value = 'auto';
      autoOpt.textContent = t('settings.language.auto');
      langSel.appendChild(autoOpt);
      for (const loc of langRes.locales) {
        const opt = document.createElement('option');
        opt.value = loc.code;
        opt.textContent = loc.name;
        langSel.appendChild(opt);
      }
      // `explicit` is null when following the OS locale — reflect that as Auto.
      langSel.value = langRes.explicit || 'auto';
    }
  } catch (e) { /* i18n unavailable — leave the picker as-is (English) */ }

  // Display picker: only meaningful with more than one monitor. Rebuilt each
  // render so hot-plugged displays show up.
  const disp = await aegis.displayGet();
  const group = $('set-display-group');
  if (disp.ok && disp.displays.length > 1) {
    group.classList.remove('hidden');
    const sel = $('set-display');
    sel.textContent = '';
    const auto = document.createElement('option');
    auto.value = 'auto';
    auto.textContent = t('manager.settings.display.primary');
    sel.appendChild(auto);
    for (const d of disp.displays) {
      const opt = document.createElement('option');
      opt.value = String(d.id);
      opt.textContent = `${d.label} — ${d.width}×${d.height}${d.primary ? ` · ${t('manager.settings.display.primaryTag')}` : ''}`;
      sel.appendChild(opt);
    }
    sel.value = disp.selectedId == null ? 'auto' : String(disp.selectedId);
  } else {
    group.classList.add('hidden');
  }

  // Auto-start: the login item is the source of truth. Where the OS has no
  // login-item support the toggle disables itself rather than lying.
  const auto = await aegis.autoStartGet();
  const autoBox = $('set-autostart');
  if (auto.ok) {
    autoBox.checked = auto.enabled;
    autoBox.disabled = !auto.supported;
    $('set-autostart-hint').textContent = auto.supported
      ? t('manager.settings.startup.autostartHint')
      : t('manager.settings.startup.unsupported');
  }

  // Spoken health alerts (opt-in — a talking wallpaper).
  const hv = await aegis.healthVoiceGet();
  if (hv.ok) $('set-healthvoice').checked = hv.enabled;

  // About & third-party licenses — populated once (the notices don't change).
  const licBox = $('set-licenses');
  if (licBox && !licBox.dataset.loaded) {
    licBox.dataset.loaded = '1';
    aegis.licensesGet().then((res) => {
      if (!res || !res.ok) return;
      if (res.version) $('set-about-version').textContent = t('manager.settings.about.version', { version: res.version });
      licBox.textContent = res.text || '';
    });
  }

  // Weather location.
  const wloc = await aegis.weatherLocationGet();
  const wcur = $('set-weather-current');
  if (wloc.ok) {
    wcur.textContent = wloc.location
      ? t('manager.settings.weather.current', { place: wloc.location.place || `${wloc.location.lat.toFixed(2)}, ${wloc.location.lon.toFixed(2)}` })
      : t('manager.settings.weather.notSet');
  }

  const perf = await aegis.performanceGet();
  if (perf.ok) {
    $('set-fullscreen').checked = perf.performance.pauseOnFullscreen;
    $('set-battery').checked = perf.performance.pauseOnBattery;
    const fps = $('set-fps');
    if (!settingsFpsBuilt) {
      fps.textContent = '';
      for (const choice of perf.fpsChoices) {
        const opt = document.createElement('option');
        opt.value = String(choice);
        opt.textContent = choice === 30
          ? t('manager.settings.performance.fpsRecommended', { n: choice })
          : t('manager.settings.performance.fps', { n: choice });
        fps.appendChild(opt);
      }
      settingsFpsBuilt = true;
    }
    fps.value = String(perf.performance.maxFps);
  }

  const bm = await aegis.backgroundMotionGet();
  if (bm && bm.ok) setBgMotionControl(bm.backgroundMotion.parallax);

  renderMusicSettings();
}

// Format the background-motion slider's readout (Off / a percentage).
function setBgMotionControl(value) {
  const slider = $('set-bgmotion');
  const label = $('set-bgmotion-val');
  slider.value = String(value);
  if (label) label.textContent = value <= 0 ? 'Off' : `${Math.round(value * 100)}%`;
}

// Background music: the user's own files, played on the desktop. Managed here
// (not on the wallpaper). Paths never leave main — we deal in ids + names.
async function renderMusicSettings() {
  const res = await aegis.musicList();
  if (!res || !res.ok) return;
  $('set-music-on').checked = res.enabled;
  $('set-music-vol').value = String(res.volume);
  $('set-music-vol-val').textContent = `${Math.round(res.volume * 100)}%`;
  const list = $('set-music-tracks');
  list.textContent = '';
  if (res.tracks.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'hint cfg-hint';
    empty.textContent = t('manager.settings.music.empty');
    list.appendChild(empty);
    return;
  }
  for (const track of res.tracks) {
    const row = document.createElement('div');
    row.className = 'music-track-row';
    const name = document.createElement('span');
    name.className = 'music-track-name';
    name.textContent = track.name;
    const rm = document.createElement('button');
    rm.className = 'btn tiny danger';
    rm.textContent = t('common.remove');
    rm.addEventListener('click', async () => { await aegis.musicRemove(track.id); renderMusicSettings(); });
    row.append(name, rm);
    list.appendChild(row);
  }
}

function settingsSaved() {
  const status = $('set-status');
  status.textContent = t('common.saved');
  // Brief confirmation; the change is already applied to the live desktop.
  clearTimeout(settingsSaved.timer);
  settingsSaved.timer = setTimeout(() => { status.textContent = ''; }, 1600);
}

function wireSettingsCfg() {
  // Language: persist the choice, then swap the dictionary LIVE — no page
  // reload (reloading the manager re-inits every pack/preview and is slow).
  // 'auto' clears the explicit setting (back to the OS locale).
  $('set-language').addEventListener('change', async (e) => {
    const val = e.target.value;
    const status = $('set-language-status');
    status.textContent = t('settings.language.applying');
    let res = null;
    try { res = await aegis.i18nSet(val === 'auto' ? null : val); } catch (err) { /* fail-soft */ }
    if (res && res.ok && res.dict && window.I18n && window.I18n.setDict) {
      // Apply instantly: swap the dict + re-fill static markup, then re-render
      // the current view so its dynamically-built strings pick up the language.
      window.I18n.setDict(res.dict, res.lang);
      renderGallery();
      renderDetail();
      status.textContent = '';
    } else {
      // Fallback for any environment without the live path: reload to re-read.
      location.reload();
    }
  });
  $('set-display').addEventListener('change', async (e) => {
    const val = e.target.value;
    const out = await aegis.displaySet(val === 'auto' ? null : Number(val));
    if (!out.ok) { $('set-status').textContent = out.error; return; }
    $('set-status').textContent = t('manager.settings.display.moved');
    clearTimeout(settingsSaved.timer);
    settingsSaved.timer = setTimeout(() => { $('set-status').textContent = ''; }, 2400);
  });
  // A monitor was plugged/unplugged while the tab is open — refresh the picker.
  if (aegis.onDisplaysChanged) {
    aegis.onDisplaysChanged(() => { if (library.tab === 'settings') renderSettingsCfg(); });
  }
  $('set-autostart').addEventListener('change', async (e) => {
    const out = await aegis.autoStartSet(e.target.checked);
    if (!out.ok) { $('set-status').textContent = out.error; e.target.checked = !e.target.checked; return; }
    e.target.checked = out.enabled; // reflect what the OS actually did
    settingsSaved();
  });
  $('set-healthvoice').addEventListener('change', async (e) => {
    await aegis.healthVoiceSet(e.target.checked);
    settingsSaved();
  });
  $('set-fullscreen').addEventListener('change', async (e) => {
    await aegis.performanceSet({ pauseOnFullscreen: e.target.checked });
    settingsSaved();
  });
  $('set-battery').addEventListener('change', async (e) => {
    await aegis.performanceSet({ pauseOnBattery: e.target.checked });
    settingsSaved();
  });
  $('set-fps').addEventListener('change', async (e) => {
    await aegis.performanceSet({ maxFps: Number(e.target.value) });
    settingsSaved();
  });
  // Live-update the readout while dragging; persist (and broadcast to the
  // desktop) on release.
  $('set-bgmotion').addEventListener('input', (e) => {
    const label = $('set-bgmotion-val');
    const v = Number(e.target.value);
    if (label) label.textContent = v <= 0 ? 'Off' : `${Math.round(v * 100)}%`;
  });
  $('set-bgmotion').addEventListener('change', async (e) => {
    await aegis.backgroundMotionSet({ parallax: Number(e.target.value) });
    settingsSaved();
  });
  $('set-logs').addEventListener('click', async () => {
    const out = await aegis.openLogs();
    if (!out.ok) $('set-status').textContent = out.error || t('manager.settings.help.logsError');
  });
  $('set-licenses-open').addEventListener('click', async () => {
    const out = await aegis.licensesOpen();
    if (!out.ok) $('set-status').textContent = out.error || t('manager.settings.about.openError');
  });
  const setWeather = async () => {
    const q = $('set-weather').value.trim();
    if (!q) return;
    $('set-status').textContent = t('manager.settings.weather.finding');
    const out = await aegis.weatherLocationSet(q);
    if (!out.ok) { $('set-status').textContent = out.error || t('manager.settings.weather.notFound'); return; }
    $('set-weather').value = '';
    $('set-weather-current').textContent = t('manager.settings.weather.current', { place: out.location.place });
    $('set-status').textContent = t('manager.settings.weather.setTo', { place: out.location.place });
  };
  $('set-weather-go').addEventListener('click', setWeather);
  $('set-weather').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); setWeather(); } });

  // Background music.
  $('set-music-on').addEventListener('change', async (e) => {
    await aegis.musicEnabled(e.target.checked);
    settingsSaved();
  });
  // Live % readout on every `input`; the actual write/broadcast fires on
  // `change` (release) so a drag doesn't thrash the file on every pixel.
  $('set-music-vol').addEventListener('input', (e) => {
    $('set-music-vol-val').textContent = `${Math.round(Number(e.target.value) * 100)}%`;
  });
  $('set-music-vol').addEventListener('change', (e) => { aegis.musicVolume(Number(e.target.value)); });
  $('set-music-add').addEventListener('click', async () => {
    const res = await aegis.musicAdd();
    if (res && res.ok) {
      renderMusicSettings();
      if (res.added > 0) { $('set-status').textContent = `Added ${res.added} track${res.added === 1 ? '' : 's'}.`; settingsSaved(); }
    }
  });
  if (aegis.onMusicChanged) {
    aegis.onMusicChanged(() => { if (library.tab === 'settings') renderMusicSettings(); });
  }
}

// ── First-run welcome ────────────────────────────────────────────────────────

async function showWelcome() {
  // Reflect the current auto-start state in the convenience checkbox.
  const auto = await aegis.autoStartGet();
  const box = $('welcome-autostart');
  if (auto.ok) { box.checked = auto.enabled; box.disabled = !auto.supported; }
  $('welcome-scrim').classList.remove('hidden');
}

function dismissWelcome() {
  $('welcome-scrim').classList.add('hidden');
  aegis.onboardedSet(true); // never auto-show again (Settings can re-open it)
}

function wireWelcome() {
  $('welcome-start').addEventListener('click', dismissWelcome);
  $('welcome-autostart').addEventListener('change', (e) => aegis.autoStartSet(e.target.checked));
  $('welcome-assistant').addEventListener('click', () => {
    dismissWelcome();
    library.tab = 'assistant';
    renderGallery();
  });
}

// ── Event editor modal ──────────────────────────────────────────────────────

function openEventEditor({ id, date }) {
  const entry = id ? planner.reminders.find((r) => r.id === id) : null;
  planner.editing = entry ? entry.id : null;
  $('event-heading').textContent = entry ? t('manager.event.edit') : t('manager.event.new');
  $('ev-text').value = entry ? entry.text : '';
  $('ev-date').value = entry ? entry.date : (date || localIso(new Date()));
  $('ev-time').value = entry && entry.time ? entry.time : '';
  $('ev-repeat').value = entry ? entry.repeat : 'none';
  $('ev-lead').value = entry ? String(entry.lead) : '0';
  $('ev-delete').classList.toggle('hidden', !entry);
  syncEventHint();
  $('event-scrim').classList.remove('hidden');
  $('ev-text').focus();
}

function closeEventEditor() {
  planner.editing = null;
  $('event-scrim').classList.add('hidden');
}

function syncEventHint() {
  const timed = $('ev-time').value !== '';
  $('ev-lead').disabled = !timed;
  const repeating = $('ev-repeat').value !== 'none';
  const parts = [];
  parts.push(timed
    ? t('manager.event.hint.timed')
    : t('manager.event.hint.untimed'));
  if (repeating) parts.push(t('manager.event.hint.repeating'));
  $('ev-hint').textContent = parts.join(' ');
}

function wirePlanner() {
  $('cal-prev').addEventListener('click', () => {
    const m = currentMonth();
    m.month1 === 1 ? (m.year--, m.month1 = 12) : m.month1--;
    renderPlanner();
  });
  $('cal-next').addEventListener('click', () => {
    const m = currentMonth();
    m.month1 === 12 ? (m.year++, m.month1 = 1) : m.month1++;
    renderPlanner();
  });
  $('cal-today').addEventListener('click', () => { planner.month = null; renderPlanner(); });
  $('cal-add').addEventListener('click', () => openEventEditor({ date: localIso(new Date()) }));

  $('ev-time').addEventListener('input', syncEventHint);
  $('ev-repeat').addEventListener('change', syncEventHint);
  $('ev-cancel').addEventListener('click', closeEventEditor);
  $('event-scrim').addEventListener('click', (e) => { if (e.target === $('event-scrim')) closeEventEditor(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('event-scrim').classList.contains('hidden')) closeEventEditor();
  });

  $('event-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fields = {
      date: $('ev-date').value,
      time: $('ev-time').value || null,
      text: $('ev-text').value,
      repeat: $('ev-repeat').value,
      lead: Number($('ev-lead').value) || 0,
    };
    const wasEditing = planner.editing !== null;
    const out = wasEditing
      ? await aegis.reminderUpdate(planner.editing, fields)
      : await aegis.reminderAdd(fields);
    if (!out.ok) return libStatus(out.error, true);
    closeEventEditor();
    libStatus(wasEditing ? 'Event updated.' : 'Event added.');
    renderPlanner();
  });

  $('ev-delete').addEventListener('click', async () => {
    if (!planner.editing) return;
    const out = await aegis.reminderRemove(planner.editing);
    if (!out.ok) return libStatus(out.error, true);
    closeEventEditor();
    libStatus('Event deleted.');
    renderPlanner();
  });

  // Live updates: an alert firing or another window editing repaints us.
  aegis.onRemindersChanged(() => {
    if (library.tab === 'planner') renderPlanner();
  });
  // A notification click asks us to show the planner.
  aegis.onShowView((view) => {
    if (['browse', 'planner', 'installed', 'launcher', 'assistant'].includes(view)) {
      library.tab = view;
      renderGallery();
    }
  });
}

// ── Steam Workshop publish dialog (prototype) ────────────────────────────────

// Human names for the component types, for the auto-written description.
const COMPONENT_LABELS = {
  status: 'persona status', clock: 'clock', 'analog-clock': 'analog clock',
  'hud-clock': 'HUD clock', stats: 'system stats', cores: 'core load',
  sysinfo: 'system info', meter: 'meter', sparkline: 'sparkline', text: 'text',
  image: 'image', divider: 'divider', calendar: 'calendar', pomodoro: 'focus timer',
  rig: 'character rig', countdown: 'countdown',
  weather: 'weather', agenda: 'agenda', notifications: 'notifications',
  launcher: 'app launcher', assistant: 'AI assistant', module: 'custom module',
  mixer: 'volume mixer',
};

// A ready-to-post Workshop description (Steam BBCode) built from the pack —
// gives the item real context instead of a bare tagline. The user can edit it.
// Workshop tag taxonomy: Style + Purpose are how people browse; Palette is a
// cheap visual filter; Includes is component-based (auto-suggested).
const DE_TAGS = {
  Style: ['Sci-Fi HUD', 'Minimal', 'Cyberpunk', 'Anime', 'Vaporwave', 'Gothic', 'Cozy', 'Pastel', 'Retro', 'Nature', 'Monochrome'],
  Purpose: ['Productivity', 'Gaming', 'System Monitor', 'Decorative', 'Developer'],
  Palette: ['Dark', 'Light', 'Colorful'],
  Includes: ['Weather', 'Clock', 'Stats', 'Launcher', 'Assistant', 'Calendar', 'Custom Art'],
  // Auto-derived requirements a browser might want to filter on (never new pack
  // metadata — read straight from the components). "Contains Code" flags a
  // sandboxed module; "Needs AI" flags an assistant console (needs a BYO key).
  Compatibility: ['Contains Code', 'Needs AI'],
};

// Pre-tick the obvious tags from what the pack actually contains, so a creator
// starts with sensible, consistent tags and just adjusts Style/Purpose.
function suggestTags(pack) {
  const set = new Set();
  const types = new Set((pack.components || []).map((c) => c.type));
  if (types.has('weather')) set.add('Weather');
  if (types.has('assistant')) { set.add('Assistant'); set.add('Needs AI'); }
  if (['stats', 'meter', 'cores', 'sysinfo', 'sparkline'].some((t) => types.has(t))) set.add('Stats');
  if (types.has('launcher')) set.add('Launcher');
  if (types.has('calendar') || types.has('agenda')) set.add('Calendar');
  if (['clock', 'hud-clock', 'ring-clock', 'analog-clock'].some((t) => types.has(t))) set.add('Clock');
  if (types.has('module')) set.add('Contains Code');
  if (types.has('image') || types.has('gallery') || (pack.skin && pack.skin.wallpaper)) set.add('Custom Art');
  try {
    const v = String((pack.skin && pack.skin.palette && pack.skin.palette.void) || '#000').replace('#', '');
    const r = parseInt(v.slice(0, 2), 16), g = parseInt(v.slice(2, 4), 16), b = parseInt(v.slice(4, 6), 16);
    set.add((0.299 * r + 0.587 * g + 0.114 * b) > 140 ? 'Light' : 'Dark');
  } catch { /* default: no palette tag */ }
  return set;
}

function describePack(item) {
  const pack = item.pack || {};
  const persona = pack.persona || {};
  const types = [...new Set((pack.components || []).map((c) => c.type))];
  const includes = types.map((t) => COMPONENT_LABELS[t] || t);
  const lines = [`[h1]${item.name}[/h1]`];
  if (persona.tagline) lines.push(`[i]${persona.tagline}[/i]`);
  lines.push('', 'A dashboard pack for [b]Dashboard Engine[/b] — a living wallpaper that shows your system at a glance, keeps your day in view, and talks back.', '');
  if (persona.name) lines.push(`[b]Persona:[/b] ${persona.name}`);
  if (includes.length) lines.push(`[b]Includes:[/b] ${includes.join(', ')}`);
  if (pack.author) lines.push(`[b]Author:[/b] ${pack.author}`);
  lines.push('', '[i]Subscribe, then open Dashboard Engine and pick this pack to put it on your desktop.[/i]');
  return lines.join('\n');
}

function publishField(labelText, control) {
  const wrap = document.createElement('label');
  wrap.className = 'event-field';
  const span = document.createElement('span');
  span.textContent = labelText;
  wrap.append(span, control);
  return wrap;
}

function openPublishDialog(item, opts = {}) {
  const scrim = document.createElement('div');
  scrim.className = 'modal-scrim';
  const card = document.createElement('div');
  card.className = 'event-card publish-card';
  scrim.appendChild(card);
  // While a publish is in flight, block every dismiss path (Cancel, Esc, backdrop
  // click) so the user can't accidentally close mid-upload thinking it stalled —
  // the progress is shown inside the dialog instead.
  let publishing = false;
  const escHandler = (e) => { if (e.key === 'Escape') tryClose(); };
  const close = () => { scrim.remove(); document.removeEventListener('keydown', escHandler); };
  const tryClose = () => { if (!publishing) close(); };

  const heading = document.createElement('h3');
  heading.textContent = `Publish “${item.name}” to Steam Workshop`;
  card.appendChild(heading);

  const title = document.createElement('input');
  title.type = 'text'; title.maxLength = 128; title.value = item.name || '';
  const desc = document.createElement('textarea');
  desc.rows = 8; desc.maxLength = 8000;
  desc.value = describePack(item);
  // Tag chips (auto-suggested from the pack) + a free-text field for extras.
  const selectedTags = suggestTags(item.pack);
  const tagGroups = document.createElement('div');
  tagGroups.className = 'tag-groups';
  for (const [group, list] of Object.entries(DE_TAGS)) {
    const g = document.createElement('div');
    g.className = 'tag-group';
    const gl = document.createElement('span');
    gl.className = 'tag-group-label';
    gl.textContent = group;
    const row = document.createElement('div');
    row.className = 'tag-chips';
    for (const t of list) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'tag-chip' + (selectedTags.has(t) ? ' on' : '');
      chip.textContent = t;
      chip.addEventListener('click', () => {
        if (selectedTags.has(t)) selectedTags.delete(t); else selectedTags.add(t);
        chip.classList.toggle('on');
      });
      row.appendChild(chip);
    }
    g.append(gl, row);
    tagGroups.appendChild(g);
  }
  const tags = document.createElement('input');
  tags.type = 'text'; tags.placeholder = 'extra tags, comma-separated (optional)';
  const vis = document.createElement('select');
  for (const [v, label] of [['unlisted', 'Unlisted (link only)'], ['public', 'Public'], ['friends', 'Friends only'], ['private', 'Private']]) {
    const opt = document.createElement('option'); opt.value = v; opt.textContent = label; vis.appendChild(opt);
  }
  // Default an UPDATE to the item's existing visibility so the audience is never
  // changed by accident. A known value applies immediately; otherwise fetch it
  // (the dialog opens right away and the dropdown corrects when Steam responds).
  // A brand-new pack has neither → the safe 'unlisted' default (first option).
  const applyVisibility = (v) => { if (v && [...vis.options].some((o) => o.value === v)) vis.value = v; };
  if (opts.visibility) applyVisibility(opts.visibility);
  else if (typeof opts.fetchVisibility === 'function') {
    opts.fetchVisibility().then((res) => applyVisibility(res && res.visibility)).catch(() => {});
  }
  card.append(
    publishField('Title', title),
    publishField('Description', desc),
    publishField('Tags', tagGroups),
    publishField('More tags', tags),
    publishField('Visibility', vis),
  );

  const hint = document.createElement('p');
  hint.className = 'detail-line';
  // Steam gets a small STATIC preview (a big animated GIF trips Steam's upload
  // throttle); the live moving preview is shown in-app on the Browse detail.
  hint.textContent = 'A preview image is rendered from the dashboard automatically (demo data — no personal info). Description supports Steam formatting ([b], [h1], [i]). Only pack.json + assets are published — never your personal data.';
  card.appendChild(hint);

  // Progress + result live INSIDE the dialog (right where the user is looking),
  // not only in the manager's status line at the window edge — so "Publishing…"
  // and the final URL aren't missed.
  const dstatus = document.createElement('p');
  dstatus.className = 'detail-line';

  const actions = document.createElement('div');
  actions.className = 'event-actions';
  const spacer = document.createElement('div'); spacer.className = 'event-spacer';
  const cancel = libButton('Cancel', tryClose);
  const submit = libButton('Publish', async () => {
    publishing = true;
    submit.disabled = true;
    cancel.disabled = true;
    dstatus.style.color = '';
    dstatus.textContent = `Publishing “${title.value || item.name}” to Workshop… this can take up to a minute; keep this window open.`;
    const out = await aegis.workshopPublish({
      packId: item.id,
      title: title.value,
      description: desc.value,
      // Chips + any free-text extras, deduped, Steam's 10-tag cap applied.
      tags: [...new Set([...selectedTags, ...tags.value.split(',').map((t) => t.trim()).filter(Boolean)])].slice(0, 10),
      visibility: vis.value,
    });
    publishing = false;
    cancel.disabled = false;
    if (!out.ok) {
      submit.disabled = false;
      dstatus.style.color = 'var(--warn, #e0a446)';
      dstatus.textContent = out.error || 'Publish failed.';
      return;
    }
    const parts = [`${out.updated ? 'Updated' : 'Published'}! ${out.url}`];
    if (out.needsToAcceptAgreement) parts.push('Accept the Workshop Legal Agreement on the item’s Steam page to make it visible.');
    if (out.note) parts.push(out.note);
    // Keep the dialog up showing the result; Cancel becomes Close. Mirror it to
    // the manager status line too, so the URL persists after the dialog closes.
    dstatus.style.color = '';
    dstatus.textContent = parts.join(' — ');
    submit.disabled = true;
    cancel.textContent = 'Close';
    libStatus(parts.join(' — '));
  }, 'primary');
  actions.append(cancel, spacer, submit);
  card.append(dstatus, actions);

  scrim.addEventListener('click', (e) => { if (e.target === scrim) tryClose(); });
  document.addEventListener('keydown', escHandler);
  document.body.appendChild(scrim);
  title.focus();
}

// ── Detail sidebar ──────────────────────────────────────────────────────────

function detailLine(text) {
  const el = document.createElement('p');
  el.className = 'detail-line';
  el.textContent = text;
  return el;
}

async function renderDetail() {
  const detail = $('lib-detail');
  destroyDetailPreview();
  detail.textContent = '';
  const s = library.selected;
  if (!s) {
    const empty = document.createElement('p');
    empty.className = 'hint';
    empty.textContent = t('manager.detail.empty');
    detail.appendChild(empty);
    return;
  }

  const preview = document.createElement('div');
  preview.className = 'detail-preview';
  const name = document.createElement('h3');
  name.className = 'detail-name';

  if (s.kind === 'local') {
    const { item } = s;
    blueprintInto(preview, item.pack); // instant placeholder…
    livePreviewInto(preview, item.id); // …replaced by the live render
    detailPreviewEl = preview;         // prop changes re-render into this element
    name.textContent = item.name;
    detail.append(preview, name);
    const meta = item.meta || {};
    const originDesc = item.origin === 'builtin' ? t('manager.detail.originBuiltin')
      : meta.source === 'file' ? t('manager.detail.originFile')
        : meta.source || t('manager.detail.originInstalled');
    detail.appendChild(detailLine(`${item.id}${meta.version ? ' · v' + meta.version : ''} · ${originDesc}`));
    detail.appendChild(detailLine(t('manager.detail.componentsPersona', { count: item.pack.components.length, persona: item.pack.persona.name })));

    const swatches = document.createElement('div');
    swatches.className = 'swatches';
    for (const key of ['void', 'glass', 'accent', 'accentBright', 'muted', 'gold']) {
      const sw = document.createElement('span');
      sw.className = 'swatch';
      sw.style.background = item.pack.skin.palette[key];
      sw.title = key;
      swatches.appendChild(sw);
    }
    detail.appendChild(swatches);

    // Customize: the pack's user-adjustable knobs (hidden until we confirm the
    // pack declares any). Personal values, applied live on the desktop.
    const customize = document.createElement('div');
    customize.className = 'customize hidden';
    detail.appendChild(customize);
    fillCustomize(customize, item.id);

    if (item.id === library.activeId) {
      detail.appendChild(detailLine(t('manager.detail.currentlyActive')));
    } else {
      detail.appendChild(libButton(t('manager.detail.useOnDesktop'), async () => {
        const out = await aegis.activeSet(item.id);
        if (!out.ok) return libStatus(out.error, true);
        library.activeId = item.id;
        setActiveIndicator();
        libStatus(t('manager.detail.nowOnDesktop', { name: item.name }));
        renderGallery();
        renderDetail();
      }, 'primary'));
    }
    detail.appendChild(libButton(t('manager.detail.openInEditor'), () => aegis.openEditor(item.id)));
    detail.appendChild(libButton(t('manager.detail.exportPack'), async () => {
      const out = await aegis.exportPack(item.id);
      libStatus(out.ok ? t('manager.detail.exportedTo', { file: out.file }) : out.error || '', !out.ok && out.error);
    }));
    // Publish / Update — STRICT gate: only original work (from-scratch builder
    // packs, or your own re-downloaded Workshop items) may reach the Workshop.
    // Seeds, forks of them, and imports from other creators show a disabled,
    // explained button. The gate is also enforced in main (renderer is hostile).
    if (item.publishable) {
      const already = !!item.publishedItemId;
      detail.appendChild(libButton(already ? t('manager.detail.updateWorkshop') : t('manager.detail.publishWorkshop'), async () => {
        const st = await aegis.workshopStatus();
        if (!st.available) return libStatus(st.reason || t('manager.detail.workshopUnavailable'), true);
        // An already-published pack: default the dialog to its current Steam
        // visibility (fetched by item id). A new pack keeps the safe default.
        openPublishDialog(item, already ? { fetchVisibility: () => aegis.workshopVisibility(item.publishedItemId) } : {});
      }));
      if (already) {
        detail.appendChild(detailLine(t('manager.detail.publishedWorkshop')));
        detail.appendChild(libButton(t('manager.detail.viewOnSteam'), () => aegis.workshopOpenItem(`https://steamcommunity.com/sharedfiles/filedetails/?id=${item.publishedItemId}`), 'tiny'));
      }
    } else {
      const why = item.origin === 'builtin'
        ? t('manager.detail.whyBuiltin')
        : (item.meta && item.meta.origin === 'fork')
          ? t('manager.detail.whyFork')
          : t('manager.detail.whyImported');
      const blocked = libButton(t('manager.detail.publishWorkshop'), () => {});
      blocked.disabled = true;
      blocked.title = t('manager.detail.publishBlocked', { why });
      detail.appendChild(blocked);
    }
    if (item.origin === 'installed') {
      detail.appendChild(libButton(t('manager.detail.uninstall'), async () => {
        const out = await aegis.uninstallPack(item.id);
        libStatus(out.ok ? t('manager.detail.uninstalled', { id: item.id }) : out.error, !out.ok);
        library.selected = null;
        await refreshLibrary();
      }, 'danger'));
    }
    return;
  }

  if (s.kind === 'workshop') {
    const { item } = s;
    // If we've imported this item, we have the content → show the LIVE preview.
    // Otherwise show Steam's static image (Steam only gives content on subscribe;
    // adding it to the library flips this to the live render).
    const localPack = library.localPacks.find((p) => p.meta && String(p.meta.workshopId) === String(item.itemId));
    name.textContent = item.title;
    if (localPack) {
      blueprintInto(preview, localPack.pack);   // instant placeholder…
      livePreviewInto(preview, localPack.id);    // …replaced by the live render
      detailPreviewEl = preview;
    } else {
      monogramInto(preview, item.title);         // placeholder until the image loads
      if (item.previewUrl) {
        aegis.workshopPreview(item.previewUrl).then((res) => {
          if (res && res.ok && library.selected === s) {
            preview.textContent = '';
            preview.style.background = ''; // fall back to the CSS matte behind the contained image
            const img = document.createElement('img');
            img.alt = '';
            img.src = res.uri;
            preview.appendChild(img);
          }
        });
      }
    }
    detail.append(preview, name);
    detail.appendChild(detailLine(`▲ ${item.votesUp}${item.tags && item.tags.length ? ' · ' + item.tags.join(', ') : ''}`));
    if (item.description) {
      const desc = document.createElement('p');
      desc.className = 'detail-desc';
      desc.textContent = item.description;
      detail.appendChild(desc);
    }
    if (!localPack) detail.appendChild(detailLine(t('manager.workshop.livePreviewHint')));
    detail.appendChild(workshopActionRow(item, !!localPack));
    detail.appendChild(libButton(t('manager.detail.viewOnSteam'), () => aegis.workshopOpenItem(item.url), 'tiny'));
    detail.appendChild(reportControl(item));
    return;
  }

  if (s.kind === 'voice-workshop') {
    const { item } = s;
    // Warm the base voice's engine now (fire-and-forget) so the first Preview
    // click doesn't pay the ~cold-start wait. No-op if the base isn't installed.
    if (item.baseInstalled && item.baseVoice) { try { aegis.voicePrewarm(item.baseVoice); } catch (e) { /* best effort */ } }
    // A voice has no live dashboard render — show Steam's static preview card
    // (name + base voice + tuning bars; no audio, no personal data).
    monogramInto(preview, item.title);
    if (item.previewUrl) {
      aegis.workshopPreview(item.previewUrl).then((res) => {
        if (res && res.ok && library.selected === s) {
          preview.textContent = '';
          preview.style.background = ''; // fall back to the CSS matte behind the contained image
          const img = document.createElement('img');
          img.alt = '';
          img.src = res.uri;
          preview.appendChild(img);
        }
      });
    }
    name.textContent = item.title;
    detail.append(preview, name);
    detail.appendChild(detailLine(`▲ ${item.votesUp}${item.tags && item.tags.length ? ' · ' + item.tags.join(', ') : ''}`));
    if (item.description) {
      const desc = document.createElement('p');
      desc.className = 'detail-desc';
      desc.textContent = item.description;
      detail.appendChild(desc);
    }
    detail.appendChild(voiceDepLine(item));
    detail.appendChild(voiceDetailActions(item));
    detail.appendChild(libButton(t('manager.detail.viewOnSteam'), () => aegis.workshopOpenItem(item.url), 'tiny'));
    detail.appendChild(reportControl(item));
    return;
  }

  if (s.kind === 'published') {
    const { item } = s;
    // Your own published dashboard. Live preview if an editable copy exists here,
    // else Steam's static image.
    const localPack = item.localPackId ? library.localPacks.find((p) => p.id === item.localPackId) : null;
    name.textContent = item.title;
    if (localPack) {
      blueprintInto(preview, localPack.pack);
      livePreviewInto(preview, localPack.id);
      detailPreviewEl = preview;
    } else {
      monogramInto(preview, item.title);
      if (item.previewUrl) {
        aegis.workshopPreview(item.previewUrl).then((res) => {
          if (res && res.ok && library.selected === s) {
            preview.textContent = '';
            preview.style.background = '';
            const img = document.createElement('img'); img.alt = ''; img.src = res.uri; preview.appendChild(img);
          }
        });
      }
    }
    detail.append(preview, name);
    const bits = [`▲ ${item.votesUp}`];
    if (item.visibility) bits.push(item.visibility);
    if (item.tags && item.tags.length) bits.push(item.tags.join(', '));
    detail.appendChild(detailLine(bits.join(' · ')));
    if (item.description) {
      const desc = document.createElement('p'); desc.className = 'detail-desc'; desc.textContent = item.description; detail.appendChild(desc);
    }
    detail.appendChild(publishedDashboardActions(item));
    return;
  }

  if (s.kind === 'published-voice') {
    const { item } = s;
    // Your own published voice — static preview card (no live dashboard render).
    monogramInto(preview, item.title);
    if (item.previewUrl) {
      aegis.workshopPreview(item.previewUrl).then((res) => {
        if (res && res.ok && library.selected === s) {
          preview.textContent = '';
          preview.style.background = '';
          const img = document.createElement('img'); img.alt = ''; img.src = res.uri; preview.appendChild(img);
        }
      });
    }
    name.textContent = item.title;
    detail.append(preview, name);
    const bits = [`▲ ${item.votesUp}`];
    if (item.visibility) bits.push(item.visibility);
    detail.appendChild(detailLine(bits.join(' · ')));
    if (item.description) {
      const desc = document.createElement('p'); desc.className = 'detail-desc'; desc.textContent = item.description; detail.appendChild(desc);
    }
    detail.appendChild(voiceDepLine(item));
    detail.appendChild(publishedVoiceActions(item));
    return;
  }

  const { url, entry, update } = s;
  monogramInto(preview, entry.name);
  if (entry.installed) livePreviewInto(preview, entry.id);
  name.textContent = entry.name;
  detail.append(preview, name);
  detail.appendChild(detailLine(t('manager.browse.byAuthor', { id: entry.id, version: entry.version, author: entry.author || t('manager.browse.unknown') })));
  const sizeLabel = Number.isFinite(entry.sizeBytes) ? `${(entry.sizeBytes / 1024).toFixed(0)} KB · ` : '';
  detail.appendChild(detailLine(`${sizeLabel}${url}`));
  if (entry.description) {
    const desc = document.createElement('p');
    desc.className = 'detail-desc';
    desc.textContent = entry.description;
    detail.appendChild(desc);
  }
  const label = update ? t('manager.browse.updateTo', { version: update.to }) : entry.installed ? t('manager.browse.reinstall') : t('manager.browse.install');
  detail.appendChild(libButton(label, async () => {
    libStatus(t('manager.browse.installing', { name: entry.name }));
    const out = await aegis.registryInstall(url, entry.id);
    libStatus(out.ok ? t('manager.browse.installed', { name: entry.name, version: entry.version }) : out.error, !out.ok);
    if (out.ok) await refreshLibrary();
  }, 'primary'));

  // Designer-hosted preview image, fetched through main; swaps in over the
  // monogram when it arrives.
  if (entry.preview) {
    const res = await aegis.registryPreview(entry.preview);
    if (res.ok && library.selected === s) {
      preview.textContent = '';
      preview.style.background = 'none';
      const img = document.createElement('img');
      img.alt = '';
      img.src = res.uri;
      preview.appendChild(img);
    }
  }
}

// ── Data flow ───────────────────────────────────────────────────────────────

async function browseRegistry(url) {
  libStatus(t('manager.browse.fetching'));
  const index = await aegis.registryBrowse(url);
  library.indexes.set(url, index);
  if (index.ok) {
    let msg = t('manager.browse.registrySummary', { name: index.name, count: index.packs.length });
    if (index.updates.length) msg += ' ' + t('manager.browse.updatesAvailable', { n: index.updates.length });
    libStatus(msg);
  } else {
    libStatus(index.error, true);
  }
  if (index.ok && index.packs.length > 0 && library.tab === 'browse' && !library.selected) {
    const entry = index.packs[0];
    library.selected = { kind: 'remote', url, entry, update: index.updates.find((u) => u.id === entry.id) };
    renderDetail();
  }
  renderGallery();
}

async function refreshLibrary() {
  const res = await aegis.libraryState();
  if (!res.ok) return libStatus(res.error, true);
  packCache.clear(); // packs may have been installed/edited/uninstalled
  library.localPacks = res.packs;
  library.registries = res.registries;
  // A selected local pack holds a stale item object from the previous fetch —
  // re-point it to the fresh one (or clear it if the pack is gone) so the
  // detail sidebar shows current metadata, not the pre-edit copy.
  if (library.selected && library.selected.kind === 'local') {
    const fresh = library.localPacks.find((p) => p.id === library.selected.item.id);
    library.selected = fresh ? { kind: 'local', item: fresh } : null;
  }
  if (!library.selected && library.tab === 'installed' && library.localPacks.length > 0) {
    const first = library.localPacks.find((p) => p.id === library.activeId) || library.localPacks[0];
    library.selected = { kind: 'local', item: first };
  }
  setActiveIndicator();
  renderGallery();
  renderDetail();
  for (const url of library.registries) {
    if (!library.indexes.has(url)) browseRegistry(url);
  }
}

// Make the detail sidebar resizable via its divider — capped at ~half the window
// (and a sensible minimum). The width lives as --detail-w on the stable
// .library-main element, so it survives the frequent gallery/detail re-renders;
// it's persisted to settings so it also survives restarts.
// Drag a .dpack (or .aegispack/.zip) anywhere onto the Manager to install it —
// the same zip-safe path as the Install button, no dialog. The real path is
// resolved in the preload (webUtils); the renderer only ever sees the file it
// dropped. A full-window overlay confirms the drop target while dragging.
function setupDropImport() {
  const PACK_EXT = /\.(dpack|aegispack|zip)$/i;
  const overlay = document.createElement('div');
  overlay.id = 'drop-overlay';
  overlay.innerHTML = '<div class="drop-card"><div class="drop-glyph">⤓</div><div class="drop-text">Drop to install pack</div></div>';
  document.body.appendChild(overlay);

  let depth = 0; // dragenter/leave fire per child — count so we hide only when truly gone
  const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
  const hide = () => { depth = 0; overlay.classList.remove('show'); };

  window.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; e.preventDefault(); depth++; overlay.classList.add('show'); });
  window.addEventListener('dragover', (e) => { if (!hasFiles(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
  window.addEventListener('dragleave', (e) => { if (!hasFiles(e)) return; depth = Math.max(0, depth - 1); if (depth === 0) hide(); });
  window.addEventListener('drop', async (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    hide();
    const files = Array.from(e.dataTransfer.files || []).filter((f) => PACK_EXT.test(f.name));
    if (!files.length) { libStatus('Drop a .dpack file to install it.', true); return; }
    let installed = 0, lastId = '', lastErr = '';
    for (const f of files) {
      const p = aegis.pathForFile(f);
      if (!p) { lastErr = 'Could not read the dropped file.'; continue; }
      const out = await aegis.installPath(p);
      if (out.ok) { installed += 1; lastId = out.id; } else { lastErr = out.error || 'Install failed.'; }
    }
    if (installed) {
      libStatus(installed === 1 ? `Installed “${lastId}”.` : `Installed ${installed} packs.`, false);
      await refreshLibrary();
    } else {
      libStatus(lastErr || 'Nothing installed.', true);
    }
  });
}

function setupDetailResizer() {
  const main = document.querySelector('.library-main');
  const handle = $('lib-resizer');
  const detail = $('lib-detail');
  if (!main || !handle || !detail) return;
  const MIN = 240;
  const maxW = () => Math.max(MIN, Math.round(main.clientWidth * 0.5)); // cap ~50%
  const apply = (px) => { main.style.setProperty('--detail-w', Math.round(Math.min(maxW(), Math.max(MIN, px))) + 'px'); };
  const persist = () => aegis.detailWidthSet(Math.round(detail.getBoundingClientRect().width)).catch(() => {});

  aegis.detailWidthGet().then((r) => { if (r && r.ok && r.detailWidth) apply(r.detailWidth); }).catch(() => {});
  // If the window shrinks, re-clamp so the sidebar never exceeds ~half of it.
  window.addEventListener('resize', () => { apply(detail.getBoundingClientRect().width); });

  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    try { handle.setPointerCapture(e.pointerId); } catch (err) { /* older engines */ }
    handle.classList.add('dragging');
    const startX = e.clientX;
    const startW = detail.getBoundingClientRect().width;
    const move = (ev) => apply(startW + (startX - ev.clientX)); // drag left → wider
    const up = () => {
      handle.classList.remove('dragging');
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      persist();
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
  });
  // Keyboard resize for accessibility.
  handle.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    apply(detail.getBoundingClientRect().width + (e.key === 'ArrowLeft' ? 24 : -24));
    persist();
  });
}

async function init() {
  const active = await aegis.activeGet();
  library.activeId = active.id || 'aegis';

  // Warm the common English voice engines in the background the moment the Manager
  // opens — well before the user reaches Browse → Voices → Preview, the tuning
  // panel, or the assistant Test — so the first synth isn't a cold-start wait. The
  // first synth on a fresh install pays a big one-time engine load + OS/Defender
  // first-access scan (see lib/ipc prewarmVoice); doing it now hides that cost.
  // Fire-and-forget; main-side guards a not-installed voice as a no-op.
  setTimeout(() => {
    try { aegis.voicePrewarm('en_us_hd'); aegis.voicePrewarm('en_male'); } catch (e) { /* best effort */ }
  }, 1200);

  // The tray can switch packs too — keep the indicator and badges honest.
  aegis.onActiveChanged((data) => {
    library.activeId = data.id;
    setActiveIndicator();
    renderGallery();
    renderDetail();
  });

  // A Steam session connected (silently spawned on Manager open, or via the gate) —
  // grant Workshop access and reload the Workshop views.
  if (aegis.onWorkshopSession) {
    aegis.onWorkshopSession((msg) => {
      library.wsAccess = !!(msg && msg.connected);
      if (library.wsAccess) {
        library.wsConnecting = false;
        ws.loaded = false; mine.loaded = false; voiceWs.loaded = false; voiceMine.loaded = false;
      }
      if (library.tab === 'browse' || library.tab === 'published') renderGallery();
    });
  }

  // NOTE (green-status fix): we deliberately do NOT auto-launch a Steam session when
  // the Manager opens. A session registers the app as "Playing" (green) on Steam, and
  // the Manager warms up hidden behind the splash — auto-connecting there flashed
  // "Playing" with no visible window to close. The Workshop tabs gate on
  // workshopAvailable() and show an explicit "Open Workshop in Steam" button, so green
  // now appears only when the user deliberately opens the Workshop (Manager visible),
  // and closing the Manager reliably returns Steam to blue. The engine also guards
  // launchWorkshopSession() so a session can never spawn without a visible Manager.

  // A pack was saved in the editor (or hot-reloaded on disk) — refresh so the
  // gallery thumbnail, detail preview, and pack list reflect it immediately,
  // no restart needed. Debounced: one save can emit several file-watch events.
  let packChangeTimer = null;
  aegis.onPackChanged(() => {
    clearTimeout(packChangeTimer);
    packChangeTimer = setTimeout(() => refreshLibrary(), 200);
  });

  $('btn-panel').addEventListener('click', () => aegis.openPanel());
  $('tab-installed').addEventListener('click', () => { library.tab = 'installed'; renderGallery(); });
  $('tab-browse').addEventListener('click', () => { library.tab = 'browse'; renderGallery(); });
  $('tab-published').addEventListener('click', () => { library.tab = 'published'; renderGallery(); });
  $('tab-create').addEventListener('click', () => { library.tab = 'create'; renderGallery(); });
  $('tab-planner').addEventListener('click', () => { library.tab = 'planner'; renderGallery(); });
  $('tab-launcher').addEventListener('click', () => { library.tab = 'launcher'; renderGallery(); });
  $('tab-assistant').addEventListener('click', () => { library.tab = 'assistant'; renderGallery(); });
  $('tab-settings').addEventListener('click', () => { library.tab = 'settings'; renderGallery(); });
  wirePlanner();
  wireAssistantCfg();
  wireSettingsCfg();
  wireBuilder();
  wireWelcome();
  $('set-welcome').addEventListener('click', showWelcome);
  await wireLauncherCfg();
  $('lib-search').addEventListener('input', (e) => { library.search = e.target.value; renderGallery(); });
  $('btn-install-file').addEventListener('click', async () => {
    const out = await aegis.installFile();
    if (out.error === null && !out.ok) return; // user cancelled the dialog
    libStatus(out.ok ? `Installed “${out.id}”.` : out.error, !out.ok);
    if (out.ok) await refreshLibrary();
  });
  $('btn-reg-add').addEventListener('click', async () => {
    const input = $('reg-url');
    const out = await aegis.registryAdd(input.value);
    libStatus(out.ok ? 'Registry added.' : out.error, !out.ok);
    if (out.ok) {
      input.value = '';
      await refreshLibrary();
    }
  });

  setupDetailResizer();
  setupDropImport();

  const view = new URLSearchParams(location.search).get('view');
  if (['browse', 'published', 'planner', 'launcher', 'assistant', 'create', 'settings'].includes(view)) library.tab = view;
  await refreshLibrary();

  // First launch ever: greet the user once. Only when they didn't ask for a
  // specific view (e.g. a notification-click deep link shouldn't be interrupted).
  if (!view) {
    const ob = await aegis.onboardedGet();
    if (ob.ok && !ob.onboarded) showWelcome();
  }

  // The library has rendered and onboarding (if any) is up — tell main the window
  // is ready to be revealed. Main warms the thumbnail cache off-screen, then swaps
  // the loading splash for this window. (Read via executeJavaScript, not IPC.)
  window.__managerReady = true;
}

init().catch((err) => libStatus(`The manager failed to start: ${err.message}`, true));
