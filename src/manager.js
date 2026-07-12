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

// Blueprint thumbnail: the pack's palette + component rects drawn as glass
// boxes. Cheap, needs no assets, and honestly previews the layout.
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
  gallery.textContent = '';
  $('reg-add').classList.toggle('hidden', library.tab !== 'browse');
  $('planner').classList.toggle('hidden', library.tab !== 'planner');
  gallery.classList.toggle('hidden', library.tab === 'planner');
  $('tab-installed').setAttribute('aria-selected', String(library.tab === 'installed'));
  $('tab-browse').setAttribute('aria-selected', String(library.tab === 'browse'));
  $('tab-planner').setAttribute('aria-selected', String(library.tab === 'planner'));
  if (library.tab === 'planner') {
    renderPlanner();
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
          buildThumb: (thumb) => blueprintInto(thumb, item.pack),
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
        buildThumb: (thumb) => monogramInto(thumb, entry.name),
        onSelect: () => { library.selected = { kind: 'remote', url, entry, update }; renderGallery(); renderDetail(); },
      }));
    }
  }
}

// ── Planner (reminders live in user data; components display them) ─────────

function localIso(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function plannerDayTitle(iso) {
  const todayIso = localIso(new Date());
  const tomorrowIso = localIso(new Date(Date.now() + 86400000));
  if (iso < todayIso) return 'Earlier';
  if (iso === todayIso) return 'Today';
  if (iso === tomorrowIso) return 'Tomorrow';
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
}

async function renderPlanner() {
  const list = $('planner-list');
  list.textContent = '';
  const res = await aegis.remindersList();
  if (!res.ok) return libStatus(res.error, true);

  if (res.reminders.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'hint';
    empty.textContent = 'Nothing planned yet. Reminders show up on calendar and agenda components on your desktop.';
    list.appendChild(empty);
    return;
  }

  let currentTitle = null;
  for (const reminder of res.reminders) {
    const title = plannerDayTitle(reminder.date);
    if (title !== currentTitle) {
      currentTitle = title;
      const head = document.createElement('div');
      head.className = 'planner-day';
      head.textContent = title;
      list.appendChild(head);
    }
    const row = document.createElement('div');
    row.className = `rem-row${reminder.done ? ' done' : ''}`;

    const check = document.createElement('input');
    check.type = 'checkbox';
    check.checked = reminder.done;
    check.title = 'Done';
    check.addEventListener('change', async () => {
      await aegis.reminderToggle(reminder.id);
      renderPlanner();
    });

    const time = document.createElement('span');
    time.className = 'rem-time';
    time.textContent = reminder.time || '—';

    const text = document.createElement('span');
    text.className = 'rem-text';
    text.textContent = reminder.text;

    const del = libButton('Delete', async () => {
      await aegis.reminderRemove(reminder.id);
      renderPlanner();
    }, 'tiny danger');

    row.append(check, time, text, del);
    list.appendChild(row);
  }
}

function wirePlanner() {
  $('rem-date').value = localIso(new Date());
  $('planner-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const out = await aegis.reminderAdd({
      date: $('rem-date').value,
      time: $('rem-time').value || null,
      text: $('rem-text').value,
    });
    if (!out.ok) return libStatus(out.error, true);
    $('rem-text').value = '';
    libStatus('Reminder added.');
    renderPlanner();
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
    blueprintInto(preview, item.pack);
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
  library.activeId = active.id || 'aegis-holo';

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
  wirePlanner();
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
  if (view === 'browse' || view === 'planner') library.tab = view;
  await refreshLibrary();
}

init().catch((err) => libStatus(`The manager failed to start: ${err.message}`, true));
