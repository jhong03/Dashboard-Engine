'use strict';

// Marketing tooling: render an AD-HOC pack full-frame for the editor trailer's
// payoff beats. main.js injects window.__trailerSpec = { pack, assets, transparent }
// after load, then captures frames in REAL time (so the gallery's setInterval
// cycling and the clock animate naturally). With transparent:true the base is
// neutralised so capturePage().toPNG() keeps alpha and ffmpeg can composite a
// looping video behind the glass dashboard. Feeds DEMO data only — never the
// user's real stats/apps/notifications — exactly like shot.js. No-op with no spec.

/* global AegisComponents */

const DEMO_STATS = {
  ok: true,
  cpuPercent: 34,
  coresPercent: [30, 22, 40, 18, 26, 34, 20, 28],
  memUsedBytes: 9.3 * 2 ** 30,
  memTotalBytes: 16 * 2 ** 30,
  diskUsedBytes: 470 * 2 ** 30,
  diskTotalBytes: 1000 * 2 ** 30,
  uptimeSec: 2 * 86400 + 4 * 3600 + 12 * 60,
  hostname: 'DASHBOARD',
};
const DEMO_WEATHER = { ok: true, tempC: 21, description: 'Partly cloudy', windKmh: 8, code: 2 };

const services = {
  stats: async () => DEMO_STATS,
  weather: async () => DEMO_WEATHER,
  reminders: async () => ({ ok: true, reminders: [], occurrences: [] }),
  launcher: { state: async () => ({ ok: true, pins: [], recent: [], running: [] }) },
  notifications: async () => ({ ok: true, granted: true, notifications: window.AegisComponents.demoNotifications() }),
};

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function waitSpec() {
  for (let i = 0; i < 240; i++) {
    if (window.__trailerSpec && window.__trailerSpec.pack) return window.__trailerSpec;
    await sleep(50);
  }
  return null;
}

// Strip the pack's own base paint (void fill, scanline/grid textures) so the
// only pixels are the glass panels + text — clean alpha for compositing.
function neutraliseBase(root) {
  root.style.background = 'transparent';
  root.style.backgroundColor = 'transparent';
  root.style.backgroundImage = 'none';
  root.style.setProperty('--scan-ink', 'rgba(0,0,0,0)');
  root.style.setProperty('--grid-ink', 'rgba(0,0,0,0)');
}

async function run() {
  const spec = await waitSpec();
  if (!spec) { window.__shotReady = true; return; }
  const renderer = AegisComponents.createRenderer(services);
  AegisComponents.applySkin(document.body, spec.pack, spec.assets || {}, { maxFps: 60 });
  renderer.render(document.getElementById('canvas'), spec.pack, spec.assets || {});
  if (spec.transparent) neutraliseBase(document.body);
  // Let fonts + first paints settle before the recorder starts grabbing.
  setTimeout(() => { window.__shotReady = true; }, 700);
}

run().catch(() => { window.__shotReady = true; });
