'use strict';

// Desktop-surface preload: the NARROWEST bridge in the app. The desktop
// window only renders the active pack — it can read packs, stats, and the
// active-pack id, and hear about changes. No library, no installs, no
// registries, no voice pipeline.

const { contextBridge, ipcRenderer } = require('electron');

function subscription(channel) {
  return (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  };
}

// SECURITY: preload scripts execute in EVERY frame of a webContents, including
// the sandboxed <iframe> that renders a pack's `module` component. That frame
// runs untrusted, designer-authored code. Only the top frame is the trusted
// desktop surface, so the IPC bridge is exposed there and NOWHERE else — a
// module's frame must never be able to reach packLoad, stats, the launcher, or
// anything else on this object. (The iframe is also sandboxed to an opaque
// origin with no network, so this is defence in depth, not the only wall.)
const bridge = {
  version: '0.4.0',
  // withProps: the desktop shows the user's customized pack (per-pack knobs).
  packLoad: (id) => ipcRenderer.invoke('aegis:packs:load', String(id), { withProps: true }),
  // shared: a PUBLIC preview render — the author's content is replaced with
  // placeholders (weather location, countdown, text, labels…). Used by shot.js.
  packLoadShared: (id) => ipcRenderer.invoke('aegis:packs:load', String(id), { shared: true }),
  onPackChanged: subscription('aegis:packs:changed'),      // hot reload (file edits + prop changes)
  activeGet: () => ipcRenderer.invoke('aegis:active:get'),
  onActiveChanged: subscription('aegis:active:changed'),   // manager picked a pack
  onPower: subscription('aegis:desktop:power'),            // fps cap / freeze (perf citizenship)
  backgroundMotion: () => ipcRenderer.invoke('aegis:settings:backgroundMotion:get'),
  onBackgroundMotion: subscription('aegis:desktop:backgroundMotion'), // global parallax multiplier
  stats: () => ipcRenderer.invoke('aegis:stats'),
  weather: (opts) => ipcRenderer.invoke('aegis:weather', { lat: Number(opts.lat), lon: Number(opts.lon) }),
  remindersList: (window) => ipcRenderer.invoke('aegis:reminders:list',
    window && window.from && window.to ? { from: String(window.from), to: String(window.to) } : undefined),
  // The desktop calendar is INTERACTIVE: a user adds/removes/toggles their own
  // reminders straight from the wallpaper (their own personal data — same trust
  // level as the launcher, which already launches apps from here). Top-frame
  // only; a module iframe never sees this bridge. Main validates every field.
  remindersAdd: (r) => ipcRenderer.invoke('aegis:reminders:add', {
    date: String(r.date),
    time: r.time ? String(r.time) : null,
    text: String(r.text),
    repeat: r.repeat ? String(r.repeat) : 'none',
    lead: Number(r.lead) || 0,
  }),
  remindersRemove: (id) => ipcRenderer.invoke('aegis:reminders:remove', String(id)),
  remindersToggle: (id) => ipcRenderer.invoke('aegis:reminders:toggle', String(id)),
  onRemindersChanged: subscription('aegis:reminders:changed'),
  // Pomodoro / focus timer. The timer runs in MAIN (survives the perf freeze);
  // the desktop only reads it, sends control actions, and hears phase changes.
  // The component's editor options ride along as `cfg` so durations follow the
  // pack. Top-frame only — a module iframe never sees this bridge.
  pomodoroGet: () => ipcRenderer.invoke('aegis:pomodoro:get'),
  pomodoroControl: (action, cfg, breakMin) => ipcRenderer.invoke('aegis:pomodoro:control', {
    action: String(action),
    cfg: (cfg && typeof cfg === 'object') ? cfg : undefined,
    breakMin: breakMin === undefined ? undefined : Number(breakMin),
  }),
  onPomodoroChanged: subscription('aegis:pomodoro:changed'),
  // Launcher: tiles resolve to opaque ids; main holds the real paths.
  launcherState: (opts) => ipcRenderer.invoke('aegis:launcher:state', { running: Boolean(opts && opts.running) }),
  launcherLaunch: (id) => ipcRenderer.invoke('aegis:launcher:launch', String(id)),
  launcherFocus: (hwnd) => ipcRenderer.invoke('aegis:launcher:focus', Number(hwnd)),
  onLauncherChanged: subscription('aegis:launcher:changed'),
  // Live Windows notifications (read-only; personal data).
  notifications: () => ipcRenderer.invoke('aegis:notifications'),
  // AI assistant — the `assistant` component is a real console on the desktop.
  assistantAsk: (prompt) => ipcRenderer.invoke('aegis:assistant:ask', String(prompt)),
  assistantSpeak: (text) => ipcRenderer.invoke('aegis:assistant:speak', String(text)),
  assistantConfig: () => ipcRenderer.invoke('aegis:assistant:config:get'),
  assistantHistory: () => ipcRenderer.invoke('aegis:assistant:history'),
  assistantReset: () => ipcRenderer.invoke('aegis:assistant:reset'),
  onAssistantStream: subscription('aegis:assistant:stream'), // live reply tokens
  // Spoken system-health alerts. Main gates on the opt-in setting
  // + rate-limits, and returns PCM to play (or a skipped result).
  healthAlert: (payload) => ipcRenderer.invoke('aegis:health:alert', {
    metric: String(payload.metric || ''),
    severity: Number(payload.severity) || 1,
    value: Number(payload.value) || 0,
  }),

  // Background music (configured in Manager → Settings; played here). The
  // desktop only READS the library and hears about changes — it works in opaque
  // track ids, streamed by main over demusic://. Main holds the real paths.
  musicList: () => ipcRenderer.invoke('aegis:music:list'),
  onMusicChanged: subscription('aegis:music:changed'),
  // Now playing (Windows media session — Spotify / browser / any player).
  // Read-only telemetry + transport control; personal data, never in a pack.
  mediaState: () => ipcRenderer.invoke('aegis:media:state'),
  mediaControl: (action) => ipcRenderer.invoke('aegis:media:control', String(action)),
  onMediaChanged: subscription('aegis:media:changed'),
  // Per-app volume mixer (Windows Core Audio). Read the sessions, set a per-app
  // (or master) volume/mute. Personal data (running apps), never in a pack.
  audioState: () => ipcRenderer.invoke('aegis:audio:state'),
  audioSet: (id, patch) => ipcRenderer.invoke('aegis:audio:set', {
    id: String(id),
    volume: (patch && patch.volume !== undefined) ? Number(patch.volume) : undefined,
    muted: (patch && patch.muted !== undefined) ? Boolean(patch.muted) : undefined,
  }),
  onAudioChanged: subscription('aegis:audio:changed'),
};

if (window.top === window) contextBridge.exposeInMainWorld('aegis', bridge);
