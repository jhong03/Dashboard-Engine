'use strict';

// System stats for the dashboard's stats widget. CPU load on Windows can't
// come from os.loadavg() (always 0), so it's measured as the busy fraction
// between two os.cpus() snapshots — the sampler keeps the previous snapshot
// and each call returns load since the last one.

const os = require('os');

function cpuSnapshot() {
  let idle = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    for (const [kind, ms] of Object.entries(cpu.times)) {
      total += ms;
      if (kind === 'idle') idle += ms;
    }
  }
  return { idle, total };
}

function createSampler() {
  let previous = cpuSnapshot();
  return {
    sample() {
      const current = cpuSnapshot();
      const dTotal = current.total - previous.total;
      const dIdle = current.idle - previous.idle;
      previous = current;
      return {
        // First call (or a zero-length window) reports 0 rather than NaN.
        cpuPercent: dTotal > 0 ? Math.round((1 - dIdle / dTotal) * 100) : 0,
        memUsedBytes: os.totalmem() - os.freemem(),
        memTotalBytes: os.totalmem(),
      };
    },
  };
}

module.exports = { createSampler };
