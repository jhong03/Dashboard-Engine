'use strict';

// Data-driven particle engine (Designer Power — Particle Studio, Phase E).
//
// This powers ONLY the ambience "custom" mode. The 7 built-in presets keep their
// own hand-tuned renderers in components.js (byte-identical, zero regression) —
// the defs here are the FACTORY starting points a designer forks when they pick
// "Customize from snow", plus the shape the custom-mode engine consumes.
//
// Split on purpose: the particle MODEL (createParticleSystem: spawn/step, pure
// array math, no canvas, injectable rng) is separate from the DRAW (drawParticles:
// needs a 2D context). So the model is deterministic and node-testable while the
// draw stays browser-only. Same single shared raf + 2D canvas as ambience — no GL.
//
// Units: sizes/speeds/forces are in cqw (container-width %), so a system looks the
// same at any resolution. px = cqw/100 · refWidth. direction is degrees clockwise
// from straight up (0 = up, 90 = right, 180 = down, 270 = left).
//
// Dual export: window.AegisParticles (browser) + module.exports (node test).

(function () {
  const EMITTER_SHAPES = ['screen', 'top', 'bottom', 'left', 'right', 'point', 'mask'];
  const BUILTIN_SPRITES = ['dot', 'streak', 'flake', 'leaf', 'note', 'spark', 'ring'];
  const OPACITY_LIFES = ['fadeInOut', 'fadeOut', 'constant'];
  const BLENDS = ['normal', 'screen', 'additive'];
  const POINTER_MODES = ['none', 'attract', 'repel'];
  const MAX_COUNT = 400; // hard perf cap

  // Factory definitions: tasteful starting points that echo each built-in effect.
  // NOT the preset renderers (those stay in components.js) — just what "Customize
  // from <preset>" seeds, and what the editor's "Reset to <preset>" restores.
  const FACTORY_PRESETS = {
    snow: {
      emitter: { shape: 'top', x: 50, y: 50 }, sprite: { builtin: 'flake' },
      count: 90, sizeMin: 0.15, sizeMax: 0.4, speedMin: 2, speedMax: 5,
      direction: 180, spread: 12, gravity: 1, wind: 0, drag: 0,
      color: { paletteKey: 'accentBright', jitter: 0 }, opacityLife: 'constant',
      rotate: 0, wobble: 1.2, blend: 'normal', pointer: { mode: 'none', radius: 20, strength: 0.5 },
    },
    embers: {
      emitter: { shape: 'bottom', x: 50, y: 50 }, sprite: { builtin: 'spark' },
      count: 60, sizeMin: 0.1, sizeMax: 0.25, speedMin: 1.5, speedMax: 4,
      direction: 0, spread: 25, gravity: -1.5, wind: 0.5, drag: 0.1,
      color: { paletteKey: 'gold', jitter: 0.2 }, opacityLife: 'fadeOut',
      rotate: 0, wobble: 1, blend: 'additive', pointer: { mode: 'none', radius: 20, strength: 0.5 },
    },
    dust: {
      emitter: { shape: 'screen', x: 50, y: 50 }, sprite: { builtin: 'dot' },
      count: 70, sizeMin: 0.08, sizeMax: 0.2, speedMin: 0.3, speedMax: 1.2,
      direction: 90, spread: 180, gravity: 0, wind: 0.2, drag: 0.2,
      color: { paletteKey: 'muted', jitter: 0.1 }, opacityLife: 'fadeInOut',
      rotate: 0, wobble: 0.5, blend: 'normal', pointer: { mode: 'none', radius: 20, strength: 0.5 },
    },
    petals: {
      emitter: { shape: 'top', x: 50, y: 50 }, sprite: { builtin: 'leaf' },
      count: 50, sizeMin: 0.3, sizeMax: 0.6, speedMin: 2, speedMax: 4,
      direction: 180, spread: 25, gravity: 0.8, wind: 1, drag: 0,
      color: { paletteKey: 'accent', jitter: 0.15 }, opacityLife: 'constant',
      rotate: 3, wobble: 2, blend: 'normal', pointer: { mode: 'none', radius: 20, strength: 0.5 },
    },
    rain: {
      emitter: { shape: 'top', x: 50, y: 50 }, sprite: { builtin: 'streak' },
      count: 120, sizeMin: 0.1, sizeMax: 0.2, speedMin: 20, speedMax: 30,
      direction: 178, spread: 3, gravity: 5, wind: 0, drag: 0,
      color: { paletteKey: 'accent', jitter: 0 }, opacityLife: 'constant',
      rotate: 0, wobble: 0, blend: 'normal', pointer: { mode: 'none', radius: 20, strength: 0.5 },
    },
    sparkle: {
      emitter: { shape: 'screen', x: 50, y: 50 }, sprite: { builtin: 'spark' },
      count: 60, sizeMin: 0.15, sizeMax: 0.35, speedMin: 0, speedMax: 0,
      direction: 0, spread: 0, gravity: 0, wind: 0, drag: 0,
      color: { paletteKey: 'accent', jitter: 0 }, opacityLife: 'fadeInOut',
      rotate: 0, wobble: 0, blend: 'additive', pointer: { mode: 'none', radius: 20, strength: 0.5 },
    },
  };

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  // A blank, sane custom system (the "Customize…" default when there's no preset).
  function defaultSystem() {
    return {
      emitter: { shape: 'screen', x: 50, y: 50 }, sprite: { builtin: 'dot' },
      count: 60, sizeMin: 0.15, sizeMax: 0.4, speedMin: 1, speedMax: 4,
      direction: 180, spread: 30, gravity: 0, wind: 0, drag: 0,
      color: { paletteKey: 'accent', jitter: 0 }, opacityLife: 'fadeOut',
      rotate: 0, wobble: 0.5, blend: 'normal', pointer: { mode: 'none', radius: 20, strength: 0.5 },
    };
  }

  // A full system def for a preset name (clone so callers can mutate freely).
  function factoryFor(effect) {
    return FACTORY_PRESETS[effect] ? clone(FACTORY_PRESETS[effect]) : defaultSystem();
  }

  // ── Particle model (pure; no canvas) ────────────────────────────────────────
  // dims: { w, h, spawnPoints? } in CSS px. spawnPoints (mask emitter) is an
  // array of { x, y } in 0..1 precomputed by the caller from a mask's bright
  // pixels. rng defaults to Math.random; the parity test injects a seeded one.
  function createParticleSystem(def, dims, rng) {
    rng = rng || Math.random;
    const W = Math.max(1, dims.w), H = Math.max(1, dims.h);
    const ref = W;                       // cqw reference = surface width
    const cqw = (v) => (v / 100) * ref;
    const count = Math.max(1, Math.min(MAX_COUNT, def.count | 0));
    // Read the mask spawn-point list LIVE (the caller fills it after the mask
    // image decodes) — so a mask emitter self-heals within a respawn cycle.
    const spawnPoints = Array.isArray(dims.spawnPoints) ? dims.spawnPoints : null;
    const marginPx = cqw(def.sizeMax) * 2 + 6;

    function place(p, fresh) {
      const em = def.emitter;
      if (!fresh) { p.x = rng() * W; p.y = rng() * H; return; } // initial scatter
      switch (em.shape) {
        case 'top': p.x = rng() * W; p.y = -marginPx; break;
        case 'bottom': p.x = rng() * W; p.y = H + marginPx; break;
        case 'left': p.x = -marginPx; p.y = rng() * H; break;
        case 'right': p.x = W + marginPx; p.y = rng() * H; break;
        case 'point': p.x = (em.x / 100) * W; p.y = (em.y / 100) * H; break;
        case 'mask':
          if (spawnPoints && spawnPoints.length) { const s = spawnPoints[(rng() * spawnPoints.length) | 0]; p.x = s.x * W; p.y = s.y * H; }
          else { p.x = rng() * W; p.y = rng() * H; }
          break;
        default: p.x = rng() * W; p.y = rng() * H; // screen
      }
    }
    function reset(p, fresh) {
      place(p, fresh);
      const speed = def.speedMin + rng() * (def.speedMax - def.speedMin);
      const ang = (def.direction + (rng() - 0.5) * def.spread) * Math.PI / 180;
      p.vx = Math.sin(ang) * cqw(speed);       // 0deg = up, clockwise
      p.vy = -Math.cos(ang) * cqw(speed);
      p.size = def.sizeMin + rng() * (def.sizeMax - def.sizeMin);
      p.rot = rng() * Math.PI * 2;
      p.vrot = (rng() - 0.5) * def.rotate;
      p.phase = rng() * Math.PI * 2;
      p.wob = 0.5 + rng();
      p.life = 3 + rng() * 4;
      p.age = fresh ? 0 : rng() * p.life;      // stagger fades on first frame
      p.cj = def.color.jitter > 0 ? rng() * 2 - 1 : 0;
    }

    const particles = new Array(count);
    for (let i = 0; i < count; i++) { const p = {}; reset(p, false); particles[i] = p; }

    const pointer = { x: 0.5, y: 0.5, active: false };
    function setPointer(x, y, active) { pointer.x = x; pointer.y = y; pointer.active = active !== false; }

    function step(dt, t) {
      const gy = cqw(def.gravity), wx = cqw(def.wind), drag = def.drag, wob = def.wobble;
      const pmode = def.pointer.mode, prad = cqw(def.pointer.radius), pstr = def.pointer.strength;
      const prad2 = prad * prad, pforce = cqw(30);
      const dragF = drag > 0 ? Math.max(0, 1 - drag * dt) : 1;
      for (let i = 0; i < count; i++) {
        const p = particles[i];
        p.vx += wx * dt;
        p.vy += gy * dt;
        if (drag > 0) { p.vx *= dragF; p.vy *= dragF; }
        if (pmode !== 'none' && pointer.active) {
          const dx = p.x - pointer.x * W, dy = p.y - pointer.y * H;
          const d2 = dx * dx + dy * dy;
          if (d2 < prad2 && d2 > 0.25) { // squared-distance early-out
            const d = Math.sqrt(d2), f = (pmode === 'attract' ? -1 : 1) * (1 - d / prad) * pstr * pforce * dt;
            p.vx += (dx / d) * f; p.vy += (dy / d) * f;
          }
        }
        const sway = wob > 0 ? Math.sin(t * 1.2 * p.wob + p.phase) * cqw(wob) : 0;
        p.x += (p.vx + sway) * dt;
        p.y += p.vy * dt;
        p.rot += p.vrot * dt;
        p.age += dt;
        const off = p.x < -marginPx || p.x > W + marginPx || p.y < -marginPx || p.y > H + marginPx;
        if (off || (def.opacityLife !== 'constant' && p.age > p.life)) reset(p, true);
      }
    }

    // First-frame snapshot for the determinism/parity test (positions + velocities).
    function snapshot() { return particles.map((p) => ({ x: p.x, y: p.y, vx: p.vx, vy: p.vy, size: p.size })); }

    return { particles, count, step, setPointer, snapshot, cqw };
  }

  // ── Draw (browser only; ctx passed in) ──────────────────────────────────────
  function clampC(v) { return v < 0 ? 0 : v > 255 ? 255 : v; }

  function drawBuiltin(ctx, kind, s, p, col) {
    ctx.fillStyle = col; ctx.strokeStyle = col;
    switch (kind) {
      case 'ring':
        ctx.lineWidth = Math.max(0.5, s * 0.35);
        ctx.beginPath(); ctx.arc(0, 0, s, 0, Math.PI * 2); ctx.stroke(); break;
      case 'streak': {
        // A rain-like streak along the velocity direction.
        const ang = Math.atan2(p.vy, p.vx);
        ctx.rotate(ang);
        ctx.lineWidth = Math.max(0.6, s * 0.9);
        ctx.beginPath(); ctx.moveTo(-s * 4, 0); ctx.lineTo(s * 4, 0); ctx.stroke(); break;
      }
      case 'flake': {
        ctx.lineWidth = Math.max(0.5, s * 0.28);
        for (let k = 0; k < 3; k++) { const a = (k / 3) * Math.PI; ctx.beginPath(); ctx.moveTo(-Math.cos(a) * s, -Math.sin(a) * s); ctx.lineTo(Math.cos(a) * s, Math.sin(a) * s); ctx.stroke(); }
        break;
      }
      case 'leaf':
        ctx.rotate(p.rot);
        ctx.beginPath(); ctx.ellipse(0, 0, s, s * 0.58, 0, 0, Math.PI * 2); ctx.fill(); break;
      case 'note':
        ctx.font = `${(s * 2.4).toFixed(1)}px serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText('♪', 0, 0); break;
      case 'spark': {
        // Four-point sparkle (curved concave points).
        ctx.beginPath();
        ctx.moveTo(0, -s); ctx.quadraticCurveTo(0, 0, s, 0);
        ctx.quadraticCurveTo(0, 0, 0, s); ctx.quadraticCurveTo(0, 0, -s, 0);
        ctx.quadraticCurveTo(0, 0, 0, -s); ctx.fill(); break;
      }
      default: // dot
        ctx.beginPath(); ctx.arc(0, 0, s, 0, Math.PI * 2); ctx.fill();
    }
  }

  // sys: from createParticleSystem. opts: { baseColor:[r,g,b], refWidth, spriteImg }.
  function drawParticles(ctx, sys, def, opts) {
    opts = opts || {};
    const base = opts.baseColor || [255, 255, 255];
    const refWidth = opts.refWidth || 1;
    const cqw = (v) => (v / 100) * refWidth;
    ctx.globalCompositeOperation = def.blend === 'additive' ? 'lighter' : def.blend === 'screen' ? 'screen' : 'source-over';
    const life = def.opacityLife, jitter = def.color.jitter;
    const img = opts.spriteImg && opts.spriteImg.complete && opts.spriteImg.naturalWidth ? opts.spriteImg : null;
    for (const p of sys.particles) {
      let a = 1;
      if (life === 'fadeOut') a = 1 - p.age / p.life;
      else if (life === 'fadeInOut') a = Math.sin(Math.PI * Math.min(1, p.age / p.life));
      a = (a < 0 ? 0 : a > 1 ? 1 : a) * 0.9;
      if (a <= 0.01) continue;
      const s = Math.max(0.5, cqw(p.size));
      ctx.save();
      ctx.globalAlpha = a;
      ctx.translate(p.x, p.y);
      if (img) {
        ctx.rotate(p.rot);
        ctx.drawImage(img, -s, -s, s * 2, s * 2);
      } else {
        let r = base[0], g = base[1], b = base[2];
        if (jitter > 0) { const j = p.cj * jitter * 60; r = clampC(r + j); g = clampC(g + j * 0.6); b = clampC(b - j * 0.4); }
        drawBuiltin(ctx, def.sprite.builtin, s, p, `rgb(${r | 0},${g | 0},${b | 0})`);
      }
      ctx.restore();
    }
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
  }

  const API = {
    EMITTER_SHAPES, BUILTIN_SPRITES, OPACITY_LIFES, BLENDS, POINTER_MODES, MAX_COUNT,
    FACTORY_PRESETS, defaultSystem, factoryFor, createParticleSystem, drawParticles,
  };
  if (typeof window !== 'undefined') window.AegisParticles = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})();
