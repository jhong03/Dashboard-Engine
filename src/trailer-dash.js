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

// ── Demo icons/art, drawn at runtime (no bundled assets, no personal data) ──────
function roundRectPath(c, x, y, w, h, r) {
  c.beginPath();
  c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath();
}
function appIcon(glyph, c1, c2) {
  const s = 96, cv = document.createElement('canvas'); cv.width = cv.height = s;
  const c = cv.getContext('2d');
  const g = c.createLinearGradient(0, 0, s, s); g.addColorStop(0, c1); g.addColorStop(1, c2);
  c.fillStyle = g; roundRectPath(c, 5, 5, s - 10, s - 10, 22); c.fill();
  c.fillStyle = 'rgba(255,255,255,.96)'; c.font = '700 50px Segoe UI, Arial, sans-serif';
  c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText(glyph, s / 2, s / 2 + 3);
  return cv.toDataURL('image/png');
}
function albumArt() {
  const s = 256, cv = document.createElement('canvas'); cv.width = cv.height = s;
  const c = cv.getContext('2d');
  const g = c.createLinearGradient(0, 0, s, s);
  g.addColorStop(0, '#FF4D9D'); g.addColorStop(0.5, '#7A5CFF'); g.addColorStop(1, '#3FD8FF');
  c.fillStyle = g; c.fillRect(0, 0, s, s);
  c.globalAlpha = 0.22; c.strokeStyle = '#fff'; c.lineWidth = 3;
  for (let k = 0; k < 7; k++) {
    c.beginPath();
    for (let x = 0; x <= s; x += 6) { const y = s * 0.5 + Math.sin(x / 20 + k) * 26 + k * 9 - 28; x === 0 ? c.moveTo(x, y) : c.lineTo(x, y); }
    c.stroke();
  }
  c.globalAlpha = 1;
  return cv.toDataURL('image/png').split(',')[1]; // base64 only — buildNowPlaying sniffs the PNG header
}

const DEMO_PINS = [
  { id: 'p1', name: 'Spotify', icon: appIcon('♪', '#1ED760', '#0e7a34') },
  { id: 'p2', name: 'Discord', icon: appIcon('D', '#5865F2', '#3b45b5') },
  { id: 'p3', name: 'Chrome', icon: appIcon('C', '#4F9BF4', '#1a63c4') },
  { id: 'p4', name: 'Figma', icon: appIcon('F', '#A259FF', '#6a2fc0') },
  { id: 'p5', name: 'Code', icon: appIcon('V', '#39A0ED', '#1668a8') },
  { id: 'p6', name: 'Steam', icon: appIcon('S', '#3a6a8f', '#1b2838') },
  { id: 'p7', name: 'Photoshop', icon: appIcon('P', '#31A8FF', '#0a3d66') },
  { id: 'p8', name: 'Notion', icon: appIcon('N', '#4a4a4a', '#141414') },
];
const DEMO_RECENT = [
  { id: 'r1', name: 'Blender', icon: appIcon('B', '#E87D0D', '#a9560a') },
  { id: 'r2', name: 'Word', icon: appIcon('W', '#3b7ad4', '#2B579A') },
  { id: 'r3', name: 'Files', icon: appIcon('E', '#FDB94E', '#c98a1e') },
];
const DEMO_RUNNING = [
  { hwnd: 1, name: 'Terminal', title: 'Terminal', icon: appIcon('›', '#2b2b2b', '#0b0b0b') },
  { hwnd: 2, name: 'Slack', title: 'Slack', icon: appIcon('#', '#E01E5A', '#611f69') },
];
const DEMO_MEDIA = {
  has: true, title: 'Neon Skyline', artist: 'Midnight Drive', art: albumArt(),
  status: 'playing', posMs: 71000, durMs: 214000, updated: Date.now(),
  canPrev: true, canNext: true, canPause: true,
};
const DEMO_AUDIO = {
  ok: true, master: { volume: 78, muted: false }, sessions: [
    { id: 's1', name: 'Spotify', icon: appIcon('♪', '#1ED760', '#0e7a34'), system: false, volume: 66, muted: false },
    { id: 's2', name: 'Discord', icon: appIcon('D', '#5865F2', '#3b45b5'), system: false, volume: 40, muted: false },
    { id: 's3', name: 'Chrome', icon: appIcon('C', '#4F9BF4', '#1a63c4'), system: false, volume: 52, muted: false },
    { id: 'system', name: 'System sounds', icon: null, system: true, volume: 100, muted: false },
  ],
};

const services = {
  stats: async () => DEMO_STATS,
  weather: async () => DEMO_WEATHER,
  // A few planned days in the current month so the calendar shows planner markers.
  reminders: async () => {
    const now = new Date();
    const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const occ = [4, 9, 15, 18, 24, 27].map((d) => ({ date: `${ym}-${String(d).padStart(2, '0')}`, done: false, title: 'Event' }));
    return { ok: true, reminders: occ, occurrences: occ };
  },
  launcher: { state: async () => ({ ok: true, pins: DEMO_PINS, recent: DEMO_RECENT, running: DEMO_RUNNING }) },
  notifications: async () => ({ ok: true, granted: true, notifications: window.AegisComponents.demoNotifications() }),
  // A "now playing" track so the nowplaying widget + (synthetic) visualizer light up.
  media: {
    state: async () => ({ ok: true, media: DEMO_MEDIA }),
    onChange: () => () => {},
    control: () => {},
  },
  // A populated per-app mixer (interactive-looking; set is a no-op in capture).
  audio: {
    state: async () => DEMO_AUDIO,
    onChange: () => () => {},
    set: () => {},
  },
};
// Drive the audio visualizer with synthetic "music" (no live system audio offscreen).
window.__vizSynthetic = true;

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
