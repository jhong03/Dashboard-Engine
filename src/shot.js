'use strict';

// Off-screen pack render for a Steam Workshop preview image. CRITICAL: it feeds
// the renderer DEMO data only — never the user's real system stats, pinned
// apps, notifications, or reminders — so nothing personal is ever captured into
// a public upload. Main loads this in a hidden window and captures the page
// once window.__shotReady is true.

/* global aegis, AegisComponents */

// Plausible-but-fake telemetry so meters/bars/clocks look alive (same values
// the module SDK preview uses). Shapes match the real services.
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

// Personal components render empty (clean placeholder state), so no user data
// appears. Shapes match what the builders read: pins/recent/running,
// occurrences/reminders, notifications.
const services = {
  stats: async () => DEMO_STATS,
  weather: async () => DEMO_WEATHER,
  reminders: async () => ({ ok: true, reminders: [], occurrences: [] }),
  launcher: { state: async () => ({ ok: true, pins: [], recent: [], running: [] }) },
  notifications: async () => ({ ok: true, granted: true, notifications: [] }),
};

async function run() {
  const id = new URLSearchParams(location.search).get('pack') || 'jarvis';
  const res = await aegis.packLoad(id);
  if (!res.ok) { window.__shotReady = true; return; }
  const renderer = AegisComponents.createRenderer(services);
  AegisComponents.applySkin(document.body, res.pack, res.assets, { maxFps: 60 });
  renderer.render(document.getElementById('canvas'), res.pack, res.assets);
  // Let fonts load and a few animation frames settle before the capture.
  setTimeout(() => { window.__shotReady = true; }, 900);
}

run().catch(() => { window.__shotReady = true; });
