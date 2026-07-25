'use strict';

// System stats for the dashboard's stats widget. CPU load on Windows can't
// come from os.loadavg() (always 0), so it's measured as the busy fraction
// between two os.cpus() snapshots — the sampler keeps the previous snapshot
// and each call returns load since the last one. Per-core loads use the same
// delta trick per core (the cores component). Disk is the system drive via
// fs.statfs (Node 18.15+); battery lives in the renderer (Battery API).

const os = require('os');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

// The drive the OS lives on — the one users mean by "disk".
const SYSTEM_ROOT = path.parse(process.env.SystemRoot || os.homedir()).root || '/';

// Whether this machine physically has a battery. The web Battery API can't
// tell a batteryless desktop from a fully-charged plugged-in laptop (both read
// 100% / charging), so the renderer can't decide alone — a desktop would show
// a bogus "100%". We settle it authoritatively once via WMI (a machine doesn't
// gain or lose a battery while running). Values: true / false / null(unknown).
// Fail-soft: non-Windows or any spawn error stays null and the renderer falls
// back to its Battery-API reading. The command is a fixed constant with zero
// user input, passed as argv (no shell) — safe per the no-shell-injection rule.
let batteryPresent = null;

function detectBatteryPresence() {
  if (process.platform !== 'win32') return; // unknown elsewhere; leave null
  try {
    execFile('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', '@(Get-CimInstance Win32_Battery).Count'],
      { timeout: 5000, windowsHide: true },
      (err, stdout) => {
        if (err) return; // stays null → renderer uses the Battery API
        const count = parseInt(String(stdout).trim(), 10);
        if (Number.isFinite(count)) batteryPresent = count > 0;
      });
  } catch {
    /* spawn threw — stays null, fail-soft */
  }
}

function cpuSnapshot() {
  let idle = 0;
  let total = 0;
  const cores = [];
  for (const cpu of os.cpus()) {
    let coreIdle = 0;
    let coreTotal = 0;
    for (const [kind, ms] of Object.entries(cpu.times)) {
      coreTotal += ms;
      if (kind === 'idle') coreIdle += ms;
    }
    cores.push({ idle: coreIdle, total: coreTotal });
    idle += coreIdle;
    total += coreTotal;
  }
  return { idle, total, cores };
}

function diskSnapshot() {
  try {
    const stat = fs.statfsSync(SYSTEM_ROOT);
    const total = stat.blocks * stat.bsize;
    return { diskUsedBytes: total - stat.bavail * stat.bsize, diskTotalBytes: total };
  } catch {
    return { diskUsedBytes: 0, diskTotalBytes: 0 }; // renderer shows "—"
  }
}

function corePercents(previous, current) {
  const out = [];
  const n = Math.min(previous.cores.length, current.cores.length);
  for (let i = 0; i < n; i++) {
    const dTotal = current.cores[i].total - previous.cores[i].total;
    const dIdle = current.cores[i].idle - previous.cores[i].idle;
    out.push(dTotal > 0 ? Math.round((1 - dIdle / dTotal) * 100) : 0);
  }
  return out;
}

function createSampler() {
  let previous = cpuSnapshot();
  detectBatteryPresence(); // one-shot; result lands async and rides every sample
  return {
    sample() {
      const current = cpuSnapshot();
      const dTotal = current.total - previous.total;
      const dIdle = current.idle - previous.idle;
      const cores = corePercents(previous, current);
      previous = current;
      return {
        // First call (or a zero-length window) reports 0 rather than NaN.
        cpuPercent: dTotal > 0 ? Math.round((1 - dIdle / dTotal) * 100) : 0,
        coresPercent: cores,
        memUsedBytes: os.totalmem() - os.freemem(),
        memTotalBytes: os.totalmem(),
        uptimeSec: Math.round(os.uptime()),
        hostname: os.hostname(),
        hasBattery: batteryPresent,
        ...diskSnapshot(),
      };
    },
  };
}

module.exports = { createSampler };
