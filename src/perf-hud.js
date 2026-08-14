'use strict';

// Dev-only performance HUD (Designer Power program — the standing perf
// instrument). INERT unless the surface was launched with ?perf=1 (from the
// DE_PERF env flag, mirroring DE_NO_GL → ?nogl=1). When off it defines nothing
// and installs no wrappers, so it is exactly zero cost in a normal run.
//
// What it measures, and why each number matters to the published budget:
//   fps / p95   — display frame-rate + 95th-percentile frame time (jank spikes).
//   loops       — concurrent app requestAnimationFrame loops per surface. The
//                 invariant is ≤1: ambience + background + timeline + rig all
//                 ride the ONE shared raf. 2 here means someone started a second
//                 loop. (The HUD's own sampling raf uses the saved original, so
//                 it is NOT counted — loops shows the APP's loops only, and reads
//                 0 when the wallpaper is frozen even though the HUD keeps
//                 sampling.)
//   iv / to     — live setInterval count + pending setTimeout count. On a frozen
//                 wallpaper this must fall to ~0 (nothing firing).
//   heap        — JS heap in MB (Chromium performance.memory). Watch it return
//                 to baseline after pack switches — a climbing heap = a leak.
//   gl-tex/vram — live GL texture count + estimated VRAM (Σ w·h·4). Budget: 1 GL
//                 context per surface; textures released on pack switch.
//   parts       — live ambience particle count (hard cap 400 in Particle Studio).
//
// The renderer feeds gl-tex/vram/parts through the guarded hooks below; when the
// HUD is off, window.AegisPerf is undefined so those `if (window.AegisPerf)`
// guards are a single falsey check.

(function () {
  var ON = false;
  try { ON = new URLSearchParams(location.search).get('perf') === '1'; } catch (e) { ON = false; }
  if (!ON) return; // zero footprint when disabled

  // Saved originals — the HUD's own timing loop rides these so it never inflates
  // the app-loop counters it reports.
  var _raf = window.requestAnimationFrame.bind(window);
  var _si = window.setInterval.bind(window);
  var _ci = window.clearInterval.bind(window);
  var _st = window.setTimeout.bind(window);
  var _ct = window.clearTimeout.bind(window);

  // ── Instrument the app's timers/rafs ──────────────────────────────────────
  var appRaf = 0;                 // app rAF calls in the current 1 s window
  var ivSet = new Set();          // live intervals
  var pendingTo = new Set();      // pending (not-yet-fired) timeouts

  window.requestAnimationFrame = function (cb) { appRaf++; return _raf(cb); };

  window.setInterval = function (cb, ms) {
    var args = Array.prototype.slice.call(arguments, 2);
    var id = _si.apply(null, [cb, ms].concat(args));
    ivSet.add(id);
    return id;
  };
  window.clearInterval = function (id) { ivSet.delete(id); return _ci(id); };

  window.setTimeout = function (cb, ms) {
    if (typeof cb !== 'function') return _st(cb, ms);
    var args = Array.prototype.slice.call(arguments, 2);
    var id;
    var wrapped = function () { pendingTo.delete(id); return cb.apply(this, arguments); };
    id = _st.apply(null, [wrapped, ms].concat(args));
    pendingTo.add(id);
    return id;
  };
  window.clearTimeout = function (id) { pendingTo.delete(id); return _ct(id); };

  // ── Renderer-reported counters ────────────────────────────────────────────
  var glTex = 0, glBytes = 0, parts = 0;
  window.AegisPerf = {
    reportGL: function (count, bytes) { glTex = count | 0; glBytes = bytes | 0; },
    setParticles: function (n) { parts = n | 0; },
  };

  // ── Overlay ───────────────────────────────────────────────────────────────
  var box = document.createElement('div');
  box.setAttribute('aria-hidden', 'true');
  box.style.cssText = [
    'position:fixed', 'top:8px', 'right:8px', 'z-index:2147483647',
    'font:11px/1.45 Consolas,ui-monospace,monospace', 'color:#9fe9c0',
    'background:rgba(6,10,16,.82)', 'border:1px solid rgba(120,180,160,.35)',
    'border-radius:6px', 'padding:6px 8px', 'white-space:pre', 'pointer-events:none',
    'text-shadow:0 1px 2px #000', 'min-width:150px',
  ].join(';');
  var mount = function () { (document.body || document.documentElement).appendChild(box); };
  if (document.body) mount(); else document.addEventListener('DOMContentLoaded', mount);

  // ── Sampling loop (rides the ORIGINAL raf; excluded from `loops`) ──────────
  var frames = 0;
  var intervals = [];        // recent frame intervals (ms), for p95
  var prev = 0;
  var winStart = 0;
  var shown = { fps: 0, p95: 0, loops: 0 };

  function percentile(arr, p) {
    if (!arr.length) return 0;
    var s = arr.slice().sort(function (a, b) { return a - b; });
    var idx = Math.min(s.length - 1, Math.floor(p * s.length));
    return s[idx];
  }

  function heapMB() {
    var m = performance && performance.memory;
    return m ? (m.usedJSHeapSize / 1048576) : -1;
  }

  function paint() {
    var heap = heapMB();
    var lines = [
      'fps ' + shown.fps + '   p95 ' + shown.p95.toFixed(1) + 'ms',
      'loops ' + shown.loops + '   iv ' + ivSet.size + '  to ' + pendingTo.size,
      (heap >= 0 ? 'heap ' + heap.toFixed(1) + 'MB' : 'heap n/a'),
      'gl-tex ' + glTex + '   vram ' + (glBytes / 1048576).toFixed(1) + 'MB',
      'parts ' + parts,
    ];
    box.textContent = lines.join('\n');
  }

  function sample(now) {
    _raf(sample);
    if (!prev) { prev = now; winStart = now; return; }
    var dt = now - prev; prev = now;
    frames++;
    intervals.push(dt);
    if (intervals.length > 240) intervals.shift();
    if (now - winStart >= 1000) {
      var secs = (now - winStart) / 1000;
      shown.fps = Math.round(frames / secs);
      shown.p95 = percentile(intervals, 0.95);
      // One capped app loop calls rAF at display rate (it re-arms every frame,
      // then early-returns under its fps interval), so appRaf/fps ≈ loop count.
      shown.loops = shown.fps > 0 ? Math.round((appRaf / secs) / shown.fps) : 0;
      frames = 0; appRaf = 0; winStart = now;
      paint();
    }
  }
  _raf(sample);
  paint();
})();
