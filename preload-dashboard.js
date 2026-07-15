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
  packLoad: (id) => ipcRenderer.invoke('aegis:packs:load', String(id)),
  onPackChanged: subscription('aegis:packs:changed'),      // hot reload (file edits)
  activeGet: () => ipcRenderer.invoke('aegis:active:get'),
  onActiveChanged: subscription('aegis:active:changed'),   // manager picked a pack
  onPower: subscription('aegis:desktop:power'),            // fps cap / freeze (perf citizenship)
  stats: () => ipcRenderer.invoke('aegis:stats'),
  weather: (opts) => ipcRenderer.invoke('aegis:weather', { lat: Number(opts.lat), lon: Number(opts.lon) }),
  remindersList: (window) => ipcRenderer.invoke('aegis:reminders:list',   // read-only here
    window && window.from && window.to ? { from: String(window.from), to: String(window.to) } : undefined),
  onRemindersChanged: subscription('aegis:reminders:changed'),
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
  assistantReset: () => ipcRenderer.invoke('aegis:assistant:reset'),
};

if (window.top === window) contextBridge.exposeInMainWorld('aegis', bridge);
