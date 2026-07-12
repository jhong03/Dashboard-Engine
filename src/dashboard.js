'use strict';

// Desktop surface: renders the ACTIVE pack via the shared component
// renderer (components.js) — the same code the editor uses, so what you
// edit is exactly what your desktop shows. No chrome, no input; selection
// happens in the manager/tray and arrives over IPC.

/* global aegis, AegisComponents */

const renderer = AegisComponents.createRenderer({
  stats: () => aegis.stats(),
  weather: (opts) => aegis.weather(opts),
});

const state = { packId: null };

async function loadPack(id) {
  const res = await aegis.packLoad(id);
  if (!res.ok) {
    console.warn(`[dashboard] ${res.error}`);
    return;
  }
  state.packId = res.pack.id;
  AegisComponents.applySkin(document.body, res.pack, res.assets);
  renderer.render(document.getElementById('canvas'), res.pack, res.assets);
  document.title = `${res.pack.persona.name} — ${res.pack.name}`;
  for (const w of res.warnings) console.warn(`[pack] ${w}`);
}

async function init() {
  // Precedence: dev override (AEGIS_PACK) → persisted active pack → default.
  const requested = new URLSearchParams(location.search).get('pack');
  const active = await aegis.activeGet();
  await loadPack(requested || active.id || 'aegis-holo');

  // Hot reload: the active pack's directory changed on disk (author editing,
  // or the editor saving).
  aegis.onPackChanged((data) => {
    if (data.id === state.packId) loadPack(state.packId);
  });
  // The manager or tray picked a different pack.
  aegis.onActiveChanged((data) => loadPack(data.id));
}

init().catch((err) => console.error(`[dashboard] failed to initialise: ${err.message}`));
