'use strict';

// Manager renderer — the engine app. Pure content navigation and selection:
// browse the library and registries, install/export/uninstall, and pick
// which pack the desktop renders (active pack). The desktop surface itself
// is a separate window; USE just flips the active pack over IPC.

/* global aegis */

const $ = (id) => document.getElementById(id);

const library = {
  tab: 'installed',
  search: '',
  activeId: null,
  localPacks: [],
  registries: [],
  indexes: new Map(),   // registry url → fetched index (or {ok:false})
  selected: null,       // { kind: 'local', item } | { kind: 'remote', url, entry, update }
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
const cardPreviews = [];          // frozen-card renderers awaiting cleanup
let detailPreview = null;         // the one live sidebar renderer
let displayAspect = null;         // "width / height" of the primary display
const CARD_FREEZE_MS = 3500;      // enough ticks for bars/sparklines to fill

function previewServices() {
  return {
    stats: () => aegis.stats(),
    weather: (opts) => aegis.weather(opts),
    reminders: (window) => aegis.remindersList(window),
    launcher: { state: (opts) => aegis.launcherState(opts) }, // no launch() → tiles inert
    notifications: () => aegis.notifications(),
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

function destroyCardPreviews() {
  for (const entry of cardPreviews) {
    clearTimeout(entry.freezeTimer);
    entry.renderer.destroy();
  }
  cardPreviews.length = 0;
}

function destroyDetailPreview() {
  if (detailPreview) {
    detailPreview.destroy();
    detailPreview = null;
  }
}

// Card thumb: real render, frozen shortly after so N cards don't each keep
// polling telemetry forever. Ambience keeps drifting — it self-terminates
// with the DOM. Falls back to the blueprint if the pack can't load.
async function realThumbInto(thumb, id, fallbackPack) {
  const loaded = await loadPackFull(id);
  if (!thumb.isConnected) return; // gallery re-rendered while we loaded
  if (!loaded) {
    if (fallbackPack) blueprintInto(thumb, fallbackPack);
    return;
  }
  const renderer = AegisComponents.createRenderer(previewServices());
  renderPackInto(thumb, loaded.pack, loaded.assets, renderer, { staticAmbience: true });
  cardPreviews.push({ renderer, freezeTimer: setTimeout(() => renderer.destroy(), CARD_FREEZE_MS) });
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
  renderPackInto(preview, loaded.pack, loaded.assets, detailPreview);
  return true;
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

function makeCard({ name, badge, badgeClass, selected, buildThumb, onSelect }) {
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
  return kind === 'local' ? s.item.id === key : `${s.url}|${s.entry.id}` === key;
}

function renderGallery() {
  const gallery = $('gallery');
  destroyCardPreviews(); // the DOM below is about to be discarded
  gallery.textContent = '';
  $('reg-add').classList.toggle('hidden', library.tab !== 'browse');
  $('planner').classList.toggle('hidden', library.tab !== 'planner');
  $('launcher-cfg').classList.toggle('hidden', library.tab !== 'launcher');
  $('assistant-cfg').classList.toggle('hidden', library.tab !== 'assistant');
  const nonGallery = ['planner', 'launcher', 'assistant'].includes(library.tab);
  gallery.classList.toggle('hidden', nonGallery);
  for (const t of ['installed', 'browse', 'planner', 'launcher', 'assistant']) {
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

  if (library.tab === 'installed') {
    for (const origin of ['installed', 'builtin']) {
      const items = library.localPacks.filter((p) => p.origin === origin && matchesSearch(p.name + p.id + (p.author || '')));
      gallery.appendChild(sectionLabel(origin === 'installed' ? 'Installed' : 'Built-in'));
      if (items.length === 0 && origin === 'installed') {
        const empty = document.createElement('p');
        empty.className = 'hint';
        empty.textContent = 'Nothing installed yet. Browse a registry or install a pack from file.';
        gallery.appendChild(empty);
      }
      for (const item of items) {
        gallery.appendChild(makeCard({
          name: item.name,
          badge: item.id === library.activeId ? 'On desktop' : (origin === 'builtin' ? 'Built-in' : null),
          badgeClass: item.id === library.activeId ? 'badge-active' : null,
          selected: isSelected('local', item.id),
          buildThumb: (thumb) => realThumbInto(thumb, item.id, item.pack),
          onSelect: () => { library.selected = { kind: 'local', item }; renderGallery(); renderDetail(); },
        }));
      }
    }
    return;
  }

  if (library.registries.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'hint';
    empty.textContent = 'No registries yet. Anyone can host one — it’s a static index.json on any https server (see PACKS.md).';
    gallery.appendChild(empty);
  }
  for (const url of library.registries) {
    const index = library.indexes.get(url);
    const refresh = libButton('Refresh', () => browseRegistry(url), 'tiny');
    const remove = libButton('Remove', async () => {
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
        badge: update ? 'Update' : entry.installed ? 'Installed' : null,
        badgeClass: update ? 'badge-active' : null,
        selected: isSelected('remote', `${url}|${entry.id}`),
        buildThumb: (thumb) => {
          // Installed registry packs exist locally — show the real thing.
          if (entry.installed) realThumbInto(thumb, entry.id, null);
          else monogramInto(thumb, entry.name);
        },
        onSelect: () => { library.selected = { kind: 'remote', url, entry, update }; renderGallery(); renderDetail(); },
      }));
    }
  }
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
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
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
    .toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  renderMonthGrid(occurrences, todayIso);
  renderUpcoming(occurrences, todayIso);
}

function renderMonthGrid(occurrences, todayIso) {
  const grid = $('cal-month');
  grid.textContent = '';
  const { month1 } = currentMonth();
  const { start, end } = gridRange();

  for (const name of ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']) {
    const head = document.createElement('div');
    head.className = 'cal-m-head';
    head.textContent = name;
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
    cell.setAttribute('aria-label', `Add event on ${iso}`);

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
      more.textContent = `+${dayEvents.length - MAX_CHIPS_PER_DAY} more`;
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
  chip.title = `${occurrence.time ? `${occurrence.time} · ` : ''}${occurrence.text}${occurrence.repeat !== 'none' ? ` (repeats ${occurrence.repeat})` : ''}`;
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
    empty.textContent = 'Nothing planned. Click a day on the calendar to add an event — timed events raise a desktop notification.';
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
  list.textContent = '';
  const state = await aegis.launcherState();
  if (!state.ok) return libStatus(state.error, true);

  if (state.pins.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'hint';
    empty.textContent = 'Nothing pinned yet. Pick an app above, or pin a file or folder.';
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
    const del = libButton('Unpin', async () => { await aegis.launcherUnpin(pin.id); renderLauncherCfg(); }, 'tiny danger');

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
    libStatus(out.ok ? 'Pinned.' : out.error, !out.ok);
    renderLauncherCfg();
  });
  const pinPath = (kind) => async () => {
    const out = await aegis.launcherPinPath(kind);
    if (out.cancelled) return;
    libStatus(out.ok ? 'Pinned.' : out.error, !out.ok);
    renderLauncherCfg();
  };
  $('btn-pin-file').addEventListener('click', pinPath('file'));
  $('btn-pin-folder').addEventListener('click', pinPath('folder'));
  aegis.onLauncherChanged(() => {
    if (library.tab === 'launcher') renderLauncherCfg();
  });
}

// ── AI assistant settings (BYO key; key stays encrypted in main) ───────────

const assistantCfg = { loaded: false, freeModels: null };

function syncProviderFields() {
  const openai = $('ai-provider').value === 'openai';
  $('ai-freemodel-field').classList.toggle('hidden', openai);
  $('ai-baseurl-field').classList.toggle('hidden', !openai);
  $('ai-key-field').classList.toggle('hidden', !openai);
  $('ai-model-field').classList.toggle('hidden', !openai);
}

async function populateFreeModels(selected) {
  const select = $('ai-freemodel');
  if (!assistantCfg.freeModels) {
    const res = await aegis.assistantModels();
    assistantCfg.freeModels = res.ok ? res.models : [];
  }
  select.textContent = '';
  const models = assistantCfg.freeModels.length ? assistantCfg.freeModels : [{ id: 'openai', label: 'Default free model' }];
  for (const m of models) {
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = m.label || m.id;
    select.appendChild(opt);
  }
  // Keep the saved model even if it isn't in the current live list.
  if (selected && !models.some((m) => m.id === selected)) {
    const opt = document.createElement('option');
    opt.value = selected;
    opt.textContent = selected;
    select.appendChild(opt);
  }
  select.value = selected || (models[0] && models[0].id) || '';
}

async function renderAssistantCfg() {
  const res = await aegis.assistantConfigGet();
  if (!res.ok) return libStatus(res.error, true);
  const c = res.config;
  $('ai-provider').value = c.provider;
  $('ai-baseurl').value = c.baseUrl || '';
  $('ai-model').value = c.provider === 'openai' ? (c.model || '') : '';
  $('ai-persona').value = c.persona || '';
  $('ai-speak').checked = c.speak !== false;
  $('ai-key').value = '';
  $('ai-key-state').textContent = c.hasKey ? 'A key is saved (encrypted). Blank keeps it; type to replace; clear + save to remove.' : 'No key — fine for the free model and local servers.';
  syncProviderFields();
  await populateFreeModels(c.provider === 'free' ? (c.model || 'openai') : null);

  // Voice dropdown: the tuned profiles, plus the engine default.
  const select = $('ai-voice');
  select.textContent = '';
  const def = document.createElement('option');
  def.value = '';
  def.textContent = 'Default voice';
  select.appendChild(def);
  const voices = await aegis.voiceProfilesList();
  if (voices.ok) {
    for (const p of voices.profiles) {
      const opt = document.createElement('option');
      opt.value = p.file;
      opt.textContent = `${p.name} (${p.voice})`;
      select.appendChild(opt);
    }
  }
  select.value = c.voiceProfile || '';
  assistantCfg.loaded = true;
}

async function saveAssistant() {
  const provider = $('ai-provider').value;
  const patch = {
    provider,
    baseUrl: $('ai-baseurl').value,
    model: provider === 'free' ? $('ai-freemodel').value : $('ai-model').value,
    persona: $('ai-persona').value,
    speak: $('ai-speak').checked,
    voiceProfile: $('ai-voice').value,
  };
  const key = $('ai-key').value;
  if (key.trim() !== '') patch.apiKey = key; // only set when the user typed one
  return aegis.assistantConfigSet(patch);
}

function wireAssistantCfg() {
  $('ai-provider').addEventListener('change', async () => {
    syncProviderFields();
    if ($('ai-provider').value === 'free') await populateFreeModels($('ai-freemodel').value);
  });

  $('ai-save').addEventListener('click', async () => {
    const out = await saveAssistant();
    if (!out.ok) { $('ai-status').textContent = out.error; return; }
    $('ai-status').textContent = 'Saved.';
    renderAssistantCfg();
  });

  $('ai-test').addEventListener('click', async () => {
    const saved = await saveAssistant(); // test uses the current fields
    if (!saved.ok) { $('ai-status').textContent = saved.error; return; }
    $('ai-status').textContent = 'Contacting the model…';
    const out = await aegis.assistantAsk('Reply with one short sentence confirming you are online.');
    $('ai-status').textContent = out.ok ? `✓ ${out.text}` : `✗ ${out.error}`;
    await aegis.assistantReset(); // don't leave the test in the real conversation
    renderAssistantCfg();
  });
}

// ── Event editor modal ──────────────────────────────────────────────────────

function openEventEditor({ id, date }) {
  const entry = id ? planner.reminders.find((r) => r.id === id) : null;
  planner.editing = entry ? entry.id : null;
  $('event-heading').textContent = entry ? 'Edit event' : 'New event';
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
    ? 'A desktop notification fires at the alert time (the engine runs in the tray).'
    : 'Give the event a time to get a desktop notification.');
  if (repeating) parts.push('Repeating events edit as a whole series.');
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
    empty.textContent = 'Select a pack to see its details.';
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
    name.textContent = item.name;
    detail.append(preview, name);
    const meta = item.meta || {};
    detail.appendChild(detailLine(`${item.id}${meta.version ? ' · v' + meta.version : ''} · ${item.origin === 'builtin' ? 'built-in reference' : meta.source === 'file' ? 'installed from file' : meta.source || 'installed'}`));
    detail.appendChild(detailLine(`${item.pack.components.length} components · ${item.pack.persona.name}`));

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

    if (item.id === library.activeId) {
      detail.appendChild(detailLine('Currently on your desktop'));
    } else {
      detail.appendChild(libButton('Use on desktop', async () => {
        const out = await aegis.activeSet(item.id);
        if (!out.ok) return libStatus(out.error, true);
        library.activeId = item.id;
        setActiveIndicator();
        libStatus(`${item.name} is now on your desktop.`);
        renderGallery();
        renderDetail();
      }, 'primary'));
    }
    detail.appendChild(libButton('Open in editor', () => aegis.openEditor(item.id)));
    detail.appendChild(libButton('Export pack…', async () => {
      const out = await aegis.exportPack(item.id);
      libStatus(out.ok ? `Exported to ${out.file}` : out.error || '', !out.ok && out.error);
    }));
    if (item.origin === 'installed') {
      detail.appendChild(libButton('Uninstall', async () => {
        const out = await aegis.uninstallPack(item.id);
        libStatus(out.ok ? `Uninstalled ${item.id}.` : out.error, !out.ok);
        library.selected = null;
        await refreshLibrary();
      }, 'danger'));
    }
    return;
  }

  const { url, entry, update } = s;
  monogramInto(preview, entry.name);
  if (entry.installed) livePreviewInto(preview, entry.id);
  name.textContent = entry.name;
  detail.append(preview, name);
  detail.appendChild(detailLine(`${entry.id} · v${entry.version} · by ${entry.author || 'unknown'}`));
  detail.appendChild(detailLine(`${(entry.sizeBytes / 1024).toFixed(0)} KB · ${url}`));
  if (entry.description) {
    const desc = document.createElement('p');
    desc.className = 'detail-desc';
    desc.textContent = entry.description;
    detail.appendChild(desc);
  }
  const label = update ? `Update to v${update.to}` : entry.installed ? 'Reinstall' : 'Install';
  detail.appendChild(libButton(label, async () => {
    libStatus(`Installing ${entry.name}…`);
    const out = await aegis.registryInstall(url, entry.id);
    libStatus(out.ok ? `Installed ${entry.name} v${entry.version} (checksum verified).` : out.error, !out.ok);
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
  libStatus('Fetching registry…');
  const index = await aegis.registryBrowse(url);
  library.indexes.set(url, index);
  if (index.ok) {
    const updates = index.updates.length ? `, ${index.updates.length} update${index.updates.length > 1 ? 's' : ''} available` : '';
    libStatus(`${index.name}: ${index.packs.length} pack${index.packs.length === 1 ? '' : 's'}${updates}.`);
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

async function init() {
  const active = await aegis.activeGet();
  library.activeId = active.id || 'jarvis';

  // The tray can switch packs too — keep the indicator and badges honest.
  aegis.onActiveChanged((data) => {
    library.activeId = data.id;
    setActiveIndicator();
    renderGallery();
    renderDetail();
  });

  $('btn-panel').addEventListener('click', () => aegis.openPanel());
  $('tab-installed').addEventListener('click', () => { library.tab = 'installed'; renderGallery(); });
  $('tab-browse').addEventListener('click', () => { library.tab = 'browse'; renderGallery(); });
  $('tab-planner').addEventListener('click', () => { library.tab = 'planner'; renderGallery(); });
  $('tab-launcher').addEventListener('click', () => { library.tab = 'launcher'; renderGallery(); });
  $('tab-assistant').addEventListener('click', () => { library.tab = 'assistant'; renderGallery(); });
  wirePlanner();
  wireAssistantCfg();
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

  const view = new URLSearchParams(location.search).get('view');
  if (['browse', 'planner', 'launcher', 'assistant'].includes(view)) library.tab = view;
  await refreshLibrary();
}

init().catch((err) => libStatus(`The manager failed to start: ${err.message}`, true));
