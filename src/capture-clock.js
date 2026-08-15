'use strict';

// Deterministic capture clock — ACTIVE ONLY with ?capture=1 (the trailer
// recorder). It replaces requestAnimationFrame + performance.now + Date with a
// VIRTUAL clock the recorder advances one fixed step per captured frame, so the
// animation renders at a perfect 30fps regardless of how slowly the off-screen
// compositor actually paints. Without ?capture=1 this is a no-op, so normal
// Workshop-preview / screenshot renders are completely unaffected.
//
// Loaded FIRST (before gl-background.js / components.js) so every rAF and clock
// read in the renderer goes through the virtual clock.

(function () {
  var params = new URLSearchParams(location.search);
  if (params.get('capture') !== '1') return;

  var vt = 0;            // virtual time, ms
  var callbacks = [];    // pending rAF callbacks
  var seq = 0;

  window.requestAnimationFrame = function (cb) { callbacks.push(cb); return ++seq; };
  window.cancelAnimationFrame = function () { /* one-shot queue; ignore */ };

  // performance.now → virtual.
  try { window.performance.now = function () { return vt; }; }
  catch (e) { try { Object.defineProperty(window.performance, 'now', { value: function () { return vt; }, configurable: true }); } catch (_) {} }

  // Date → virtual, so a clock component ticks smoothly with the animation
  // rather than jumping in real wall-clock time during the slow capture.
  var RealDate = Date;
  var base = RealDate.now();
  // A timelapse capture (the "It shifts through your day" beat) sets an ABSOLUTE
  // now here so the clock fast-forwards independently of the animation clock (vt),
  // keeping the ambience smooth while the hours fly by. null → follow base + vt.
  var clockOverride = null;
  function curMs() { return clockOverride != null ? clockOverride : base + vt; }
  function VDate(a, b, c, d, e, f, g) {
    if (arguments.length === 0) return new RealDate(curMs());
    switch (arguments.length) {
      case 1: return new RealDate(a);
      case 2: return new RealDate(a, b);
      case 3: return new RealDate(a, b, c);
      case 4: return new RealDate(a, b, c, d);
      case 5: return new RealDate(a, b, c, d, e);
      case 6: return new RealDate(a, b, c, d, e, f);
      default: return new RealDate(a, b, c, d, e, f, g);
    }
  }
  VDate.now = function () { return curMs(); };
  VDate.parse = RealDate.parse;
  VDate.UTC = RealDate.UTC;
  VDate.prototype = RealDate.prototype;
  window.Date = VDate;

  function dispatchPointer(x, y) {
    var types = ['pointermove', 'mousemove'];
    for (var i = 0; i < types.length; i++) {
      var ev;
      try { ev = new MouseEvent(types[i], { clientX: x, clientY: y, bubbles: true, cancelable: true, view: window }); }
      catch (e) { continue; }
      window.dispatchEvent(ev);
      document.dispatchEvent(ev);
      if (document.body) document.body.dispatchEvent(ev);
    }
  }

  // The recorder calls this once per frame: set virtual time, move the pointer
  // (drives parallax + cursor-ripple), then flush all pending rAF callbacks.
  window.__cap = {
    step: function (virtualMs, px, py) {
      vt = virtualMs;
      if (px != null && py != null) dispatchPointer(px, py);
      var run = callbacks;
      callbacks = [];
      for (var i = 0; i < run.length; i++) { try { run[i](vt); } catch (e) { /* keep going */ } }
    },
    // Timelapse: set the clock's absolute "now" (ms); null clears it.
    setClockMs: function (ms) { clockOverride = (ms == null ? null : ms); },
  };
})();
