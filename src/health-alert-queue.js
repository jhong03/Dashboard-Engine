'use strict';

// One queue for the desktop, independent of pack/component lifetimes.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AegisHealthAlerts = api;
})(typeof window === 'undefined' ? globalThis : window, function () {
  function createQueue({ request, play, stop = () => {}, cooldownMs = 2000, now = Date.now,
    wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
    let tail = Promise.resolve();
    let epoch = 0;
    let enabled = true;
    let nextAt = 0;
    const versions = new Map();
    const pending = new Set();
    function enqueue(payload) {
      const metric = payload.metric;
      if (payload.severity === 0) {
        versions.set(metric, (versions.get(metric) || 0) + 1);
        // Re-arm main immediately, even if a different metric is still speaking.
        return Promise.resolve().then(() => request(payload)).catch(() => {});
      }
      if (!enabled) return Promise.resolve();
      const version = versions.get(metric) || 0;
      const acceptedEpoch = epoch;
      const key = `${epoch}:${metric}:${version}:${payload.severity}`;
      if (pending.has(key)) return tail;
      pending.add(key);
      const current = () => enabled && epoch === acceptedEpoch && (versions.get(metric) || 0) === version;
      tail = tail.then(async () => {
        if (!current()) return;
        const remaining = nextAt - now();
        if (remaining > 0) await wait(remaining);
        if (!current()) return;
        const out = await request(payload);
        if (!current() || !out || !out.ok || !out.pcm) return;
        // The promise resolves on AudioBufferSourceNode.onended, not src.start().
        const played = await play(out.pcm, out.sampleRate);
        if (played !== false && epoch === acceptedEpoch) nextAt = now() + cooldownMs;
      }).catch(() => { /* a failed clip must not block subsequent alerts */ })
        .finally(() => pending.delete(key));
      return tail;
    }
    function setEnabled(value) {
      enabled = Boolean(value);
      epoch += 1; // invalidate queued work and any synthesis still in flight
      nextAt = 0;
      pending.clear();
      stop();
    }
    return { enqueue, setEnabled, idle: () => tail };
  }

  function createPlayer(makeContext = () => new AudioContext()) {
    let context = null;
    let stopCurrent = null;
    function stop() { if (stopCurrent) stopCurrent(); }
    function play(pcm, sampleRate) {
      return new Promise((resolve) => {
        let source = null;
        let done = false;
        let timer = null;
        const finish = (played) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          if (source) {
            source.onended = null;
            try { source.stop(); } catch (_) { /* already ended */ }
            source.disconnect();
          }
          stopCurrent = null;
          resolve(played);
        };
        stopCurrent = () => finish(false);
        (async () => {
          const rate = Number(sampleRate) || 22050;
          const samples = pcm.byteLength >> 1;
          if (!samples || rate <= 0) return finish(false);
          // Bound a broken/suspended audio device; stop the source before advancing.
          timer = setTimeout(() => finish(false), Math.ceil(samples / rate * 1000) + 5000);
          if (!context || context.state === 'closed') context = makeContext();
          if (context.state === 'suspended') await context.resume();
          if (done) return;
          const view = new DataView(pcm.buffer, pcm.byteOffset, samples * 2);
          const floats = new Float32Array(samples);
          for (let i = 0; i < samples; i++) floats[i] = view.getInt16(i * 2, true) / 32768;
          const buffer = context.createBuffer(1, samples, rate);
          buffer.copyToChannel(floats, 0);
          source = context.createBufferSource();
          source.buffer = buffer;
          source.connect(context.destination);
          source.onended = () => finish(true);
          source.start();
        })().catch(() => finish(false));
      });
    }
    return { play, stop };
  }
  return { createQueue, createPlayer };
});
