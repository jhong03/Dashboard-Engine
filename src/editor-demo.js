'use strict';

// Editor trailer CHOREOGRAPHY engine — ACTIVE ONLY with ?demo=1 (paired with
// ?capture=1). It plays a scripted timeline of editor actions — add a component,
// drag it (firing the REAL smart-alignment guides), resize it, swap the
// background, fill a gallery — synchronized to the deterministic capture clock,
// so the trailer recorder gets a perfectly smooth 30fps take of the editor being
// used. Without ?demo=1 this file does nothing.
//
// It drives the genuine editor code: drags/resizes are synthesized pointer events
// dispatched on the real hitboxes/handles (so alignmentTargets/drawGuides run for
// real), and adds go through addComponent(). editor.js exposes what we need on
// window.__editorDemoApi; the recorder advances us via window.__demo.step(vt).
//
// A drawn cursor sprite stands in for the OS cursor (not captured off-screen).

(function () {
  if (new URLSearchParams(location.search).get('demo') !== '1') return;

  // Synthetic pointer drags call setPointerCapture with a fake pointerId, which
  // Chromium rejects ("no active pointer"). No-op it for the demo so the real
  // beginDrag/beginResize handlers run cleanly.
  try {
    Element.prototype.setPointerCapture = function () {};
    Element.prototype.releasePointerCapture = function () {};
  } catch (e) { /* best effort */ }

  const CURSOR_SIZE = 30;
  let cursor = null;
  function ensureCursor() {
    if (cursor) return cursor;
    cursor = document.createElement('div');
    cursor.id = 'demo-cursor';
    // A crisp arrow via CSS (no external asset). Sits above everything.
    Object.assign(cursor.style, {
      position: 'fixed', left: '0', top: '0', width: CURSOR_SIZE + 'px', height: CURSOR_SIZE + 'px',
      zIndex: '999999', pointerEvents: 'none', transform: 'translate(-2px,-2px)',
      background: 'no-repeat center/contain',
      backgroundImage: "url(\"data:image/svg+xml;utf8," + encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M4 2 L4 20 L9 15 L12 22 L15 21 L12 14 L19 14 Z" fill="white" stroke="black" stroke-width="1.2" stroke-linejoin="round"/></svg>'
      ) + "\")",
      filter: 'drop-shadow(0 1px 2px rgba(0,0,0,.5))',
    });
    document.body.appendChild(cursor);
    return cursor;
  }
  function moveCursor(x, y) {
    const c = ensureCursor();
    c.style.left = x + 'px';
    c.style.top = y + 'px';
  }

  // ── Synthetic pointer helpers ──────────────────────────────────────────────
  function firePointer(el, type, x, y) {
    if (!el) return;
    let ev;
    try {
      ev = new PointerEvent(type, {
        pointerId: 1, isPrimary: true, button: type === 'pointerup' ? 0 : 0,
        buttons: type === 'pointerup' ? 0 : 1, clientX: x, clientY: y,
        bubbles: true, cancelable: true, view: window,
      });
    } catch (e) {
      ev = new MouseEvent(type.replace('pointer', 'mouse'), { clientX: x, clientY: y, bubbles: true, cancelable: true, view: window });
    }
    el.dispatchEvent(ev);
  }

  const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
  const lerp = (a, b, t) => a + (b - a) * t;

  // ── The timeline ────────────────────────────────────────────────────────────
  // Each action has { at, dur } in ms (dur 0 = instant). Actions are built by the
  // caller-provided script against window.__editorDemoApi. We keep per-action
  // runtime state (started/ended, cached elements) so step() is idempotent.
  let timeline = [];
  let api = null;
  let lastAdded = -1; // resolves an action's index:'last' to the most-recent add

  // Drag a component from wherever it is toward a target CLIENT point over dur ms,
  // firing pointerdown → moves → pointerup on its real hitbox so the alignment
  // guides light up. `to` is a function(bounds) → {x,y} client coords (so targets
  // can be expressed relative to the stage).
  function idxOf(a) { return a.index === 'last' ? lastAdded : a.index; }

  function runDrag(a, localT) {
    const idx = idxOf(a);
    const b = api.stageBounds();
    const start = a._start || (a._start = centerOf(api.rectPx(idx)));
    const target = a._target || (a._target = a.to(b, api));
    if (!a._down) { a._down = true; api.select(idx); firePointer(api.hitEl(idx), 'pointerdown', start.x, start.y); }
    // Reach the aligned target at ~70% of dur, then HOLD there — so the smart-guide
    // snap is visible for a beat before the drop, instead of a one-frame flash.
    const p = easeInOut(Math.min(1, localT / (a.dur * 0.7)));
    const x = lerp(start.x, target.x, p), y = lerp(start.y, target.y, p);
    moveCursor(x, y);
    firePointer(api.hitEl(idx), 'pointermove', x, y);
    if (localT >= a.dur && !a._up) { a._up = true; firePointer(api.hitEl(idx), 'pointerup', x, y); }
  }

  function runResize(a, localT) {
    const idx = idxOf(a);
    const start = a._start || (a._start = handleCenter(api.rectPx(idx), a.dir));
    const target = a._target || (a._target = a.to(api.stageBounds(), api));
    if (!a._down) { a._down = true; api.select(idx); firePointer(api.handleEl(idx, a.dir), 'pointerdown', start.x, start.y); }
    const p = easeInOut(Math.min(1, localT / a.dur));
    const x = lerp(start.x, target.x, p), y = lerp(start.y, target.y, p);
    moveCursor(x, y);
    firePointer(api.handleEl(idx, a.dir), 'pointermove', x, y);
    if (localT >= a.dur && !a._up) { a._up = true; firePointer(api.handleEl(idx, a.dir), 'pointerup', x, y); }
  }

  function centerOf(r) { return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }
  function handleCenter(r, dir) {
    let x = r.left + r.width / 2, y = r.top + r.height / 2;
    if (dir.includes('e')) x = r.left + r.width; if (dir.includes('w')) x = r.left;
    if (dir.includes('s')) y = r.top + r.height; if (dir.includes('n')) y = r.top;
    return { x, y };
  }

  // Advance the whole timeline to virtual time vt.
  function step(vt) {
    if (!api) api = window.__editorDemoApi || null;
    if (!api) return;
    for (const a of timeline) {
      if (vt < a.at) continue;
      const localT = vt - a.at;
      if (a.done) continue;
      try {
        if (a.type === 'cursor') { const p = a.to(api.stageBounds(), api); moveCursor(p.x, p.y); a.done = true; }
        else if (a.type === 'clear') { api.clearComponents(); a.done = true; }
        else if (a.type === 'add') { a.index = api.addComponent(a.comp, a.x, a.y); lastAdded = a.index; a.done = true; }
        else if (a.type === 'select') { api.select(a.index); a.done = true; }
        else if (a.type === 'background') { api.setBackground(a.bg); a.done = true; }
        else if (a.type === 'gallery') { api.setGallery(a.images); a.done = true; }
        else if (a.type === 'call') { a.fn(api); a.done = true; }
        else if (a.type === 'drag') { runDrag(a, localT); if (localT >= a.dur) a.done = true; }
        else if (a.type === 'resize') { runResize(a, localT); if (localT >= a.dur) a.done = true; }
        else a.done = true;
      } catch (e) { a.done = true; /* never wedge the capture */ }
    }
  }

  window.__demo = {
    setTimeline(t) { timeline = (t || []).map((a) => ({ ...a })); },
    step,
    // Total scripted length (ms), so the recorder knows how many frames to grab.
    duration() { return timeline.reduce((m, a) => Math.max(m, a.at + (a.dur || 0)), 0); },
  };
})();
