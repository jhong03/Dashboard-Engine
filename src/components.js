'use strict';

// Shared component renderer — loaded as a plain script by BOTH the desktop
// surface (dashboard.html) and the pack editor (editor.html), so a pack
// looks pixel-identical in the editor and on the desktop. No build step:
// this file defines window.AegisComponents and nothing else.
//
// Pages provide `services` so this module stays page-agnostic:
//   services.stats()        → { ok, cpuPercent, memUsedBytes, memTotalBytes,
//                               diskUsedBytes, diskTotalBytes }
//   services.weather(opts)  → { ok, tempC, description, windKmh } (cached in main)

(() => {

const FONT_STACKS = {
  'rajdhani': "'Rajdhani', 'Segoe UI', sans-serif",
  'system-sans': "'Segoe UI', system-ui, sans-serif",
  'system-serif': "Georgia, 'Times New Roman', serif",
  'mono': "'Share Tech Mono', Consolas, monospace",
};

const HISTORY_LENGTH = 90;         // sparkline: 90 samples at 2 s = 3 minutes
const TELEMETRY_INTERVAL_MS = 2000;
const WEATHER_REFRESH_MS = 10 * 60 * 1000;

// Weather condition glyphs — engine-drawn line icons (fixed strings, no pack
// data ever goes through innerHTML). Keyed by Open-Meteo weather-code group.
const GLYPH_ATTRS = 'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"';
const CLOUD_PATH = 'M7.5 15.5h9.3a3.6 3.6 0 0 0 .5-7.2 5.2 5.2 0 0 0-10-1.3 4 4 0 0 0 .2 8.5z';
const WEATHER_GLYPHS = {
  sun: `<svg ${GLYPH_ATTRS}><circle cx="12" cy="12" r="4.2"/><path d="M12 2.6v2.5M12 18.9v2.5M2.6 12h2.5M18.9 12h2.5M5.3 5.3l1.8 1.8M16.9 16.9l1.8 1.8M18.7 5.3l-1.8 1.8M7.1 16.9l-1.8 1.8"/></svg>`,
  partly: `<svg ${GLYPH_ATTRS}><circle cx="8.2" cy="7.6" r="3"/><path d="M8.2 2.7v1.4M3.3 7.6h1.4M4.7 4.1l1 1M11.7 4.1l-1 1"/><path d="M10.4 19.4h6.8a3.1 3.1 0 0 0 .4-6.2 4.4 4.4 0 0 0-8.4-1.1 3.4 3.4 0 0 0 1.2 7.3z"/></svg>`,
  cloud: `<svg ${GLYPH_ATTRS}><path d="${CLOUD_PATH}"/></svg>`,
  fog: `<svg ${GLYPH_ATTRS}><path d="M4.5 9.5h13.5M6.5 13h13M4.5 16.5h10.5"/></svg>`,
  rain: `<svg ${GLYPH_ATTRS}><path d="${CLOUD_PATH}"/><path d="M8.7 18l-1.1 2.8M12.7 18l-1.1 2.8M16.7 18l-1.1 2.8"/></svg>`,
  snow: `<svg ${GLYPH_ATTRS}><path d="${CLOUD_PATH}"/><circle cx="8.3" cy="19.2" r="0.4" fill="currentColor"/><circle cx="12.3" cy="19.2" r="0.4" fill="currentColor"/><circle cx="16.3" cy="19.2" r="0.4" fill="currentColor"/></svg>`,
  storm: `<svg ${GLYPH_ATTRS}><path d="${CLOUD_PATH}"/><path d="M13 16.5l-2.3 3.3h2.8l-1.8 2.7"/></svg>`,
};

// Open-Meteo weather code → glyph key.
function weatherGlyphKey(code) {
  if (code === 0 || code === 1) return 'sun';
  if (code === 2) return 'partly';
  if (code === 3) return 'cloud';
  if (code === 45 || code === 48) return 'fog';
  if (code >= 95) return 'storm';
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return 'snow';
  if (code >= 51) return 'rain';
  return 'cloud';
}

// ── Colour helpers ──────────────────────────────────────────────────────────

function hexToRgbParts(hex) {
  let h = hex.slice(1);
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
}

function rgba(hex, alpha) {
  const [r, g, b] = hexToRgbParts(hex);
  return `rgba(${r}, ${g}, ${b}, ${Math.max(0, Math.min(1, alpha)).toFixed(3)})`;
}

const PALETTE_KEYS = ['void', 'glass', 'accent', 'accentBright', 'muted', 'warn', 'gold'];

// Dev override for the time-of-day schedule: DE_FAKE_HOUR → ?fakeHour=<0-23> on
// the desktop/editor URL forces the schedule to a given hour (null = real clock).
let QUERY_FAKE_HOUR = null;
try {
  const rawHour = new URLSearchParams(location.search).get('fakeHour');
  if (rawHour !== null && rawHour !== '') {
    const n = parseInt(rawHour, 10);
    if (Number.isFinite(n)) QUERY_FAKE_HOUR = ((n % 24) + 24) % 24;
  }
} catch (e) { /* no location (node harness) → real clock */ }

// Linear-interpolate two hex colours (alpha ignored — the palette pipeline feeds
// every colour through rgba() with its OWN opacity, never the hex's 4th byte, so
// hexToRgbParts dropping an 8-digit alpha is exactly right here). f in [0,1].
function lerpColor(a, b, f) {
  const ca = hexToRgbParts(a), cb = hexToRgbParts(b);
  const to2 = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
  return `#${to2(ca[0] + (cb[0] - ca[0]) * f)}${to2(ca[1] + (cb[1] - ca[1]) * f)}${to2(ca[2] + (cb[2] - ca[2]) * f)}`;
}

// ── Skin application ────────────────────────────────────────────────────────
// `root` is the element acting as the skin surface (the desktop's <body>, or
// the editor's canvas div). Vars cascade from it; textures/wallpaper attach
// to it via the .skin-root CSS hooks.

// Paint the palette-derived CSS custom properties. Extracted from applySkin so
// the time-of-day schedule (Phase G) can re-paint them each frame during a slot
// crossfade, feeding a lerped palette through the exact same derivations.
function setPaletteVars(root, palette, texture, shape) {
  const s = root.style;
  s.setProperty('--void', palette.void);
  s.setProperty('--accent', palette.accent);
  s.setProperty('--accent-bright', palette.accentBright);
  s.setProperty('--muted', palette.muted);
  s.setProperty('--warn', palette.warn);
  s.setProperty('--gold', palette.gold);

  s.setProperty('--panel-bg', rgba(palette.glass, shape.panelOpacity));
  s.setProperty('--hairline', rgba(palette.accent, shape.borderOpacity));
  s.setProperty('--hairline-dim', rgba(palette.accent, shape.borderOpacity * 0.5));
  s.setProperty('--glow', rgba(palette.accent, 0.45 * texture.glow));
  s.setProperty('--glow-wash', rgba(palette.accent, 0.14 * texture.glow));
  s.setProperty('--scan-ink', rgba('#000000', 0.5 * texture.scanlines));
  s.setProperty('--grid-ink', rgba(palette.accent, 0.12 * texture.grid));
  s.setProperty('--vignette-ink', rgba('#000000', 0.85 * texture.vignette));
  s.backgroundColor = palette.void;
}

function applySkin(root, pack, assets, opts) {
  const { palette, typography, texture, shape } = pack.skin;
  const s = root.style;

  // Time-of-day (Phase G): paint the current slot's palette immediately so the
  // first frame is already correct; applySchedule crossfades on slot changes.
  setPaletteVars(root, effectiveScheduledPalette(pack, opts) || palette, texture, shape);

  s.setProperty('--radius', `${shape.radius}px`);
  s.setProperty('--ls', `${typography.letterSpacing}em`);
  s.setProperty('--font-display', FONT_STACKS[typography.display]);

  root.classList.add('skin-root');
  root.classList.toggle('uppercase', typography.uppercase);
  root.classList.toggle('notches', shape.cornerNotches);
  applyFill(root, pack, opts);          // gradient base fill (or plain void)
  applyBackground(root, pack, assets, opts); // the layer stack owns the wallpaper

  applyAmbience(root, pack, assets, opts);
  applySchedule(root, pack, opts);      // time-of-day palette crossfade (Phase G)
}

// ── Base surface fill ─────────────────────────────────────────────────────────
// A CSS gradient painted on the surface's own background, behind the wallpaper
// layer stack (which is a child at z-index 0). A stop colour is either a palette
// token — so it tracks the colourway — or a literal hex. 'solid' / fewer than two
// stops falls through to the flat void colour set in applySkin.

const FILL_TOKEN_KEYS = ['void', 'glass', 'accent', 'accentBright', 'muted', 'warn', 'gold'];
// Tiling film-grain (SVG turbulence, ~5% opacity) layered over the gradient.
const GRAIN_URI = "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='150' height='150'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='0.05'/%3E%3C/svg%3E\")";

function resolveFillColor(c, palette) {
  return FILL_TOKEN_KEYS.includes(c) ? (palette[c] || '#000000') : c;
}

// Build the CSS background-image for a fill, or null when it should stay solid.
function buildFillImage(fill, palette) {
  if (!fill || fill.type === 'solid') return null;
  const stops = Array.isArray(fill.stops) ? fill.stops.filter((s) => s && s.color) : [];
  const clampPct = (v) => Math.max(0, Math.min(100, Number(v) || 0));

  if (fill.type === 'mesh') {
    if (!stops.length) return null;
    // Soft alpha blobs at spread anchor points over the void ground.
    const spots = [[20, 25], [80, 20], [65, 85], [28, 78], [50, 48], [88, 62]];
    const blobs = stops.map((s, i) => {
      const [x, y] = spots[i % spots.length];
      return `radial-gradient(46% 56% at ${x}% ${y}%, ${rgba(resolveFillColor(s.color, palette), 0.55)}, transparent 62%)`;
    });
    return `${blobs.join(', ')}, ${palette.void || '#05070d'}`;
  }

  if (stops.length < 2) return null;
  const list = stops.slice().sort((a, b) => (a.at || 0) - (b.at || 0))
    .map((s) => `${resolveFillColor(s.color, palette)} ${clampPct(s.at)}%`).join(', ');
  const angle = Math.max(0, Math.min(360, Number(fill.angle) || 0));
  const px = clampPct(fill.posX), py = clampPct(fill.posY);
  if (fill.type === 'linear') return `linear-gradient(${angle}deg, ${list})`;
  if (fill.type === 'radial') return `radial-gradient(circle at ${px}% ${py}%, ${list})`;
  if (fill.type === 'conic') return `conic-gradient(from ${angle}deg at ${px}% ${py}%, ${list})`;
  return null;
}

function applyFill(root, pack, opts) {
  const s = root.style;
  const fill = pack.skin.background && pack.skin.background.fill;
  const image = buildFillImage(fill, pack.skin.palette);
  root.classList.remove('bg-fill-animate', 'bg-fill-animate-grain');
  s.animationPlayState = ''; // clear any freeze-pause from a prior render
  if (!image) {
    s.backgroundImage = 'none';
    s.backgroundSize = ''; s.backgroundPosition = ''; s.backgroundRepeat = '';
    return;
  }
  const still = (opts && opts.staticAmbience === true)
    || !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const grain = !!fill.grain;
  const animate = !!fill.animate && !still;
  const gradSize = animate ? '300% 300%' : (fill.type === 'mesh' ? '150% 150%' : '100% 100%');
  if (grain) {
    s.backgroundImage = `${GRAIN_URI}, ${image}`;
    s.backgroundRepeat = 'repeat, no-repeat';
    s.backgroundSize = `150px 150px, ${gradSize}`;
    s.backgroundPosition = '0 0, center';
  } else {
    s.backgroundImage = image;
    s.backgroundRepeat = 'no-repeat';
    s.backgroundSize = gradSize;
    s.backgroundPosition = 'center';
  }
  // The drift itself is a CSS keyframe (compositor-cheap); the class picks the
  // keyframe that pins the grain layer while moving the gradient.
  if (animate) root.classList.add(grain ? 'bg-fill-animate-grain' : 'bg-fill-animate');
}

// ── Layered parallax background ──────────────────────────────────────────────
// The wallpaper is now a STACK of up to 6 layers (images and/or videos), each
// with a parallax `depth` and optional `drift`. A legacy single wallpaper is one
// depth-0 layer (the sanitizer normalizes it), so it renders pixel-identically:
// a depth-0 layer with no drift gets no scale and no transform.
//
// The stack sits in the wallpaper slot (z-index:0, behind textures/ambience/
// components) and clips its overscanned layers. Parallax follows the pointer;
// drift is a slow bounded oscillation. Both are advanced by the SHARED ambience
// raf (stepBackgroundMotion), so they honour the fps cap and freeze exactly like
// ambience — and a moving layer is scaled up just enough that its translation
// never exposes an edge. Video layers are ALWAYS muted (pack audio is out of
// scope) and stream over depack:// (never a filesystem path in the renderer).

const BG_VIDEO_EXTS = ['.mp4', '.webm'];
const PARALLAX_MAX_PCT = 4;   // pointer shift (% of surface) at depth 1 · strength 1
const DRIFT_MAX_PCT = 3;      // drift oscillation amplitude (% of surface) at |drift| 20
const DRIFT_REF = 20;         // schema drift magnitude that maps to the max amplitude
const DRIFT_BASE_FREQ = 0.32; // rad/s at |drift| 20 (~20 s period); scales with |drift|
const BG_OVERSCAN_MARGIN = 0.5; // % safety so rounding never reveals an edge

function isBgVideo(relPath) {
  if (typeof relPath !== 'string') return false;
  const dot = relPath.lastIndexOf('.');
  return dot >= 0 && BG_VIDEO_EXTS.includes(relPath.slice(dot).toLowerCase());
}

function objectFitFor(fit) {
  return fit === 'stretch' ? 'fill' : fit === 'contain' ? 'contain' : 'cover';
}
function backgroundSizeFor(fit) {
  return fit === 'contain' ? 'contain' : fit === 'stretch' ? '100% 100%' : 'cover';
}

// Build (or reuse) the layer stack and compute per-layer motion parameters.
// Reuses the existing elements when the set of sources is unchanged, so a
// re-render (prop tweak, resume from freeze, fps change) never restarts a video.
function applyBackground(root, pack, assets, opts) {
  // Normally the sanitizer has already normalized wallpaper → layers. But render
  // defensively: an UNSANITIZED pack (e.g. the from-scratch builder's live
  // preview) may carry only skin.wallpaper, so synthesize a single depth-0 layer
  // from it rather than showing nothing.
  const parallaxDefault = (pack.skin.background && pack.skin.background.parallax) || { strength: 1, axis: 'both' };
  let spec;
  if (pack.skin.background && Array.isArray(pack.skin.background.layers) && pack.skin.background.layers.length) {
    spec = pack.skin.background;
  } else if (pack.skin.wallpaper) {
    spec = {
      layers: [{
        src: pack.skin.wallpaper, depth: 0, fit: pack.skin.wallpaperFit || 'cover',
        posX: typeof pack.skin.wallpaperPosX === 'number' ? pack.skin.wallpaperPosX : 50,
        posY: typeof pack.skin.wallpaperPosY === 'number' ? pack.skin.wallpaperPosY : 50,
        opacity: 1, drift: { x: 0, y: 0 },
      }],
      parallax: parallaxDefault,
    };
  } else {
    spec = { layers: [], parallax: parallaxDefault };
  }
  const still = (opts && opts.staticAmbience === true)
    || !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  // Effective parallax strength = pack strength × the user's global multiplier
  // (0 disables it). Reduced motion / a static thumbnail freezes everything.
  const userMult = opts && typeof opts.parallaxMultiplier === 'number' ? Math.max(0, Math.min(1, opts.parallaxMultiplier)) : 1;
  const strength = still ? 0 : Math.max(0, Math.min(2, spec.parallax.strength)) * userMult;
  const axis = spec.parallax.axis || 'both';

  // Only the resolvable layers (an asset that failed to load is skipped so the
  // void shows through rather than a broken element).
  const layers = spec.layers.filter((l) => l && l.src && assets[l.src]);

  // GL mode: any layer declares effects AND WebGL is available (and hasn't been
  // disabled for this surface after a lost context). Otherwise the DOM path runs
  // — zero new cost for effect-less packs.
  const wantEffects = layers.some((l) => Array.isArray(l.effects) && l.effects.length);
  // opts.noGL forces the DOM path — gallery mini-render cards use it so N cards
  // never allocate N live GL contexts (the browser caps them).
  const useGL = wantEffects && !(opts && opts.noGL) && !root.__aegisGlDisabled && window.AegisGL && window.AegisGL.supported();
  const mode = useGL ? 'gl' : 'dom';
  // The GL sig captures only what changes the SHADER or the baked motion params
  // (effect types, region shape, mask, pulse-tint on/off; still + strength). Plain
  // param values (speed/scale/…) are live uniforms read each tick from the shared
  // layer object, so tweaking a slider updates live WITHOUT a costly rebuild.
  const fxSig = (l) => (l.effects || []).map((e) => `${e.type}${e.region ? 'r' + e.region.shape : ''}${e.mask ? 'm' + e.mask : ''}${e.type === 'pulse' && e.paletteKey ? 't' : ''}`).join(',');
  const glMeta = useGL ? `#g${still ? 's' : ''}${Math.round(strength * 10)}` : '';
  const sig = `${mode}::${layers.map((l) => `${l.src}#${useGL ? fxSig(l) : ''}`).join('|')}${glMeta}`;

  let bg = root.__aegisBg;
  if (!bg || bg.sig !== sig || !bg.stack || !bg.stack.isConnected) {
    if (bg) teardownBackground(root);
    const stack = document.createElement('div');
    stack.className = 'bg-stack';
    root.insertBefore(stack, root.firstChild); // behind textures/ambience/components
    bg = root.__aegisBg = {
      stack, mode, sig, layers: [], els: [], gl: null,
      pointer: { x: 0, y: 0 }, target: { x: 0, y: 0 },
      pointerRaw: { x: 0.5, y: 0.5 }, pointerDown: false, pointerCleanup: null,
    };

    if (mode === 'gl') {
      // Hidden source videos for texturing (images load inside the GL module).
      const videos = {};
      bg.els = layers.map((layer, i) => {
        if (!isBgVideo(layer.src)) return null;
        const v = makeBgVideo(assets[layer.src], still, pack);
        v.classList.add('bg-gl-src'); // invisible; the GL canvas draws the pixels
        stack.appendChild(v);
        videos[i] = v;
        return v;
      });
      const handle = window.AegisGL.create(stack, layers, assets, {
        videos, strength, axisX: axis !== 'y', axisY: axis !== 'x', reduced: still,
        palette: pack.skin.palette,
        onLost: () => { root.__aegisGlDisabled = true; applyBackground(root, pack, assets, opts); },
      });
      if (!handle) { // GL init/shader failed → fall back to DOM for this surface
        root.__aegisGlDisabled = true;
        teardownBackground(root);
        return applyBackground(root, pack, assets, opts);
      }
      bg.gl = handle;
    } else {
      bg.els = layers.map((layer) => {
        if (isBgVideo(layer.src)) {
          const v = makeBgVideo(assets[layer.src], still, pack);
          v.className = 'bg-layer bg-layer-video';
          v.addEventListener('error', () => { v.style.display = 'none'; }); // one layer drops, never black
          return v;
        }
        const d = document.createElement('div');
        d.className = 'bg-layer';
        d.style.backgroundImage = `url(${assets[layer.src]})`;
        d.style.backgroundRepeat = 'no-repeat';
        return d;
      });
      bg.els.forEach((el) => stack.appendChild(el)); // DOM order = back-to-front
    }
  }
  bg.mode = mode;

  if (mode === 'gl') {
    // The GL handle owns rendering; the shared loop just drives it (effects
    // animate unless reduced, when create() already drew one frame → no loop).
    bg.needsMotion = !still;
    setupBackgroundPointer(root, bg, !still);
  } else {
    // (Re)apply per-layer look + motion parameters (cheap, idempotent).
    bg.layers = layers.map((layer, i) => {
      const el = bg.els[i];
      const fit = layer.fit || 'cover';
      const posX = typeof layer.posX === 'number' ? layer.posX : 50;
      const posY = typeof layer.posY === 'number' ? layer.posY : 50;
      el.style.opacity = String(typeof layer.opacity === 'number' ? layer.opacity : 1);
      if (el.tagName === 'VIDEO') {
        el.style.objectFit = objectFitFor(fit);
        el.style.objectPosition = `${posX}% ${posY}%`;
      } else {
        el.style.backgroundSize = backgroundSizeFor(fit);
        el.style.backgroundPosition = `${posX}% ${posY}%`;
      }
      const depth = typeof layer.depth === 'number' ? layer.depth : 0;
      const driftX = layer.drift ? layer.drift.x || 0 : 0;
      const driftY = layer.drift ? layer.drift.y || 0 : 0;
      const parallaxAmp = PARALLAX_MAX_PCT * depth * strength;
      const driftAmpX = still ? 0 : DRIFT_MAX_PCT * Math.min(1, Math.abs(driftX) / DRIFT_REF);
      const driftAmpY = still ? 0 : DRIFT_MAX_PCT * Math.min(1, Math.abs(driftY) / DRIFT_REF);
      const moving = parallaxAmp > 0 || driftAmpX > 0 || driftAmpY > 0;
      const overscan = parallaxAmp + Math.max(driftAmpX, driftAmpY) + BG_OVERSCAN_MARGIN;
      const scale = moving ? 1 + (2 * overscan) / 100 : 1;
      const rec = {
        el, depth, scale, moving, parallaxAmp, driftAmpX, driftAmpY,
        driftSpeedX: (Math.sign(driftX) || 1) * (Math.abs(driftX) / DRIFT_REF) * DRIFT_BASE_FREQ,
        driftSpeedY: (Math.sign(driftY) || 1) * (Math.abs(driftY) / DRIFT_REF) * DRIFT_BASE_FREQ,
        driftPhaseX: 0, driftPhaseY: 0,
      };
      el.style.transform = moving ? `scale(${scale.toFixed(4)})` : 'none';
      return rec;
    });
    bg.axisX = axis !== 'y';
    bg.axisY = axis !== 'x';
    bg.needsMotion = !still && bg.layers.some((l) => l.moving);
    setupBackgroundPointer(root, bg, !still && bg.layers.some((l) => l.parallaxAmp > 0));
  }

  setWallpaperPlayback(root, true); // start/refresh video layers (source or visible)
}

// Create a muted, looping background <video> (a visible DOM layer OR a hidden GL
// texture source). Always muted — pack audio is out of scope. `still` shows the
// first frame paused (reduced motion / static thumbnail).
function makeBgVideo(uri, still, pack) {
  const v = document.createElement('video');
  v.muted = true; v.defaultMuted = true; v.loop = true; v.playsInline = true;
  v.setAttribute('playsinline', ''); v.setAttribute('muted', '');
  v.disablePictureInPicture = true; v.setAttribute('disablepictureinpicture', '');
  v.setAttribute('preload', still ? 'metadata' : 'auto');
  v.setAttribute('src', uri);
  v.__still = still;
  const rate = pack && pack.skin.wallpaperVideo && pack.skin.wallpaperVideo.playbackRate;
  v.__rate = typeof rate === 'number' ? rate : 1;
  if (still) v.addEventListener('loadeddata', () => { try { v.currentTime = 0; v.pause(); } catch (e) {} }, { once: true });
  return v;
}

// Advance parallax (lerp toward the pointer) + drift for every moving layer.
// Called once per frame by the shared ambience raf. In GL mode it just drives
// the GL handle (which owns parallax/drift/effects); in DOM mode it sets each
// layer's transform.
function stepBackgroundMotion(bg, dt, t) {
  bg.pointer.x += (bg.target.x - bg.pointer.x) * 0.08;
  bg.pointer.y += (bg.target.y - bg.pointer.y) * 0.08;
  if (bg.gl) {
    bg.gl.setParallax(bg.pointer.x, bg.pointer.y);
    bg.gl.setPointer(bg.pointerRaw.x, bg.pointerRaw.y, bg.pointerDown);
    bg.gl.tick(t);
    return;
  }
  for (const l of bg.layers) {
    if (!l.moving) continue;
    let tx = 0, ty = 0;
    if (l.parallaxAmp > 0) {
      // Background shifts OPPOSITE the cursor for a natural parallax feel.
      if (bg.axisX) tx += -bg.pointer.x * l.parallaxAmp;
      if (bg.axisY) ty += -bg.pointer.y * l.parallaxAmp;
    }
    if (l.driftAmpX > 0) { l.driftPhaseX += l.driftSpeedX * dt; tx += Math.sin(l.driftPhaseX) * l.driftAmpX; }
    if (l.driftAmpY > 0) { l.driftPhaseY += l.driftSpeedY * dt; ty += Math.sin(l.driftPhaseY) * l.driftAmpY; }
    l.el.style.transform = `translate(${tx.toFixed(3)}%, ${ty.toFixed(3)}%) scale(${l.scale.toFixed(4)})`;
  }
}

// One pointer listener per surface, on the surface's own document. Target is the
// cursor position normalized to [-1, 1] from the viewport centre; the loop lerps
// toward it. Removed when the surface has no parallax (or on teardown).
function setupBackgroundPointer(root, bg, wanted) {
  if (wanted && !bg.pointerCleanup) {
    const doc = root.ownerDocument || document;
    const win = doc.defaultView || window;
    const onMove = (e) => {
      const w = win.innerWidth || 1;
      const h = win.innerHeight || 1;
      const nx = e.clientX / w, ny = e.clientY / h;
      bg.target.x = Math.max(-1, Math.min(1, (nx - 0.5) * 2));
      bg.target.y = Math.max(-1, Math.min(1, (ny - 0.5) * 2));
      bg.pointerRaw.x = nx; bg.pointerRaw.y = ny; // raw 0..1 for GL cursor-ripple
    };
    const onDown = () => { bg.pointerDown = true; };
    const onUp = () => { bg.pointerDown = false; };
    doc.addEventListener('pointermove', onMove, { passive: true });
    doc.addEventListener('pointerdown', onDown, { passive: true });
    doc.addEventListener('pointerup', onUp, { passive: true });
    bg.pointerCleanup = () => {
      doc.removeEventListener('pointermove', onMove);
      doc.removeEventListener('pointerdown', onDown);
      doc.removeEventListener('pointerup', onUp);
    };
  } else if (!wanted && bg.pointerCleanup) {
    bg.pointerCleanup();
    bg.pointerCleanup = null;
    bg.target.x = 0; bg.target.y = 0;
  }
}

function teardownBackground(root) {
  const bg = root && root.__aegisBg;
  if (!bg) return;
  if (bg.pointerCleanup) bg.pointerCleanup();
  if (bg.gl) { try { bg.gl.destroy(); } catch (e) {} bg.gl = null; } // release GL context (1-per-surface budget)
  for (const el of bg.els || []) {
    if (el && el.tagName === 'VIDEO') { try { el.pause(); el.removeAttribute('src'); el.load(); } catch (e) {} }
  }
  if (bg.stack) bg.stack.remove();
  root.__aegisBg = null;
}

// Pause/resume every video LAYER with the ambience. applyBackground calls it
// (play) and freezeAmbience calls it (pause), so dashboard.js's freeze/resume
// drives playback with no new wiring. Never plays a still surface.
function setWallpaperPlayback(root, playing) {
  const bg = root && root.__aegisBg;
  if (!bg) return;
  for (const el of bg.els || []) {
    if (!el || el.tagName !== 'VIDEO') continue; // GL image layers have no element
    if (playing && !el.__still) {
      if (typeof el.__rate === 'number') el.playbackRate = el.__rate;
      const p = el.play();
      if (p && typeof p.catch === 'function') p.catch(() => {}); // autoplay guard
    } else {
      try { el.pause(); } catch (e) {}
    }
  }
}

// ── Ambience ────────────────────────────────────────────────────────────────
// A declarative particle layer behind the components (embers / dust / snow).
// Packs pick an effect + density from tokens; the engine owns the animation —
// packs never ship code. Reduced motion gets one static scatter, no loop.

const AMBIENCE_COLOR_KEY = {
  embers: 'gold', dust: 'muted', snow: 'accentBright',
  petals: 'accent', rain: 'accent', sparkle: 'accent',
};

// Build the ambience particle layer (canvas + spawn/step/draw). Returns a handle
// { canvas, observer, step, draw } that the shared motion loop ticks, or null
// when the pack has no ambience effect. Does NOT own a raf — applyAmbience runs
// the single loop that also drives background parallax/drift.
function setupAmbienceParticles(root, pack, assets, opts, reduced) {
  const ambience = pack.skin.ambience || { effect: 'none', density: 0.5 };
  // Particle Studio (Phase E): a fully-custom particle system runs through the
  // separate data-driven engine. The 7 built-in presets below are UNTOUCHED.
  if (ambience.mode === 'custom' && ambience.system && window.AegisParticles) {
    return setupCustomParticles(root, pack, ambience, assets, reduced);
  }
  const effect = ambience.effect;
  const defKey = AMBIENCE_COLOR_KEY[effect];
  if (!defKey) return null;

  const canvas = document.createElement('canvas');
  canvas.className = 'ambience-layer';
  root.appendChild(canvas);
  // Particle colour: a custom hex wins; else a palette TOKEN override (colorKey)
  // that names a real palette entry; else the effect's default token. So a pack
  // can recolour any effect and still track the colourway when it uses a token.
  const palette = pack.skin.palette;
  let hex;
  if (typeof ambience.color === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(ambience.color)) hex = ambience.color;
  else hex = palette[(ambience.colorKey && palette[ambience.colorKey]) ? ambience.colorKey : defKey];
  const [r, g, b] = hexToRgbParts(hex);
  // speed scales all motion; glow composites additively (overlaps brighten).
  const speed = Math.min(3, Math.max(0.2, (typeof ambience.speed === 'number' && isFinite(ambience.speed)) ? ambience.speed : 1));
  const glow = ambience.glow === true;
  const count = Math.round(14 + ambience.density * 66);
  const rand = (lo, hi) => lo + Math.random() * (hi - lo);
  let particles = [];
  // Particles live in CSS-pixel space (0..cssW, 0..cssH). The backing store is
  // scaled up by dpr and the draw context is scaled to match, so coverage fills
  // the whole surface no matter the display scaling or how the canvas is sized.
  const dpr = window.devicePixelRatio || 1;
  let cssW = 0, cssH = 0;

  // fresh=true spawns just off the entry edge; false scatters anywhere so the
  // first frame is already populated. Velocities are fractions of the surface
  // per second, so density of motion is resolution-independent.
  const spawn = (fresh) => {
    const w = cssW, h = cssH;
    const p = {
      x: rand(0, w),
      y: rand(0, h),
      vx: 0,
      vy: 0,
      size: rand(0.8, 2.6),
      alpha: rand(0.2, 0.7),
      phase: rand(0, Math.PI * 2),
      sway: rand(0.2, 1),
    };
    if (effect === 'embers') {
      p.vy = -rand(0.015, 0.05);
      if (fresh) p.y = h + p.size * 4;
    } else if (effect === 'snow') {
      p.vy = rand(0.02, 0.06);
      p.size = rand(1, 3);
      if (fresh) p.y = -p.size * 4;
    } else if (effect === 'petals') { // cherry-blossom: fall, sway, tumble
      p.vy = rand(0.03, 0.07);
      p.size = rand(2, 4.2);
      p.alpha = rand(0.4, 0.85);
      p.sway = rand(0.5, 1.4);
      p.rot = rand(0, Math.PI * 2);
      p.vrot = rand(-2.2, 2.2);
      if (fresh) p.y = -p.size * 4;
    } else if (effect === 'rain') { // fast thin streaks (neon city)
      p.vy = rand(0.55, 0.95);
      p.len = rand(8, 20);
      p.size = rand(0.6, 1.2);
      p.alpha = rand(0.2, 0.55);
      if (fresh) p.y = -p.len;
    } else if (effect === 'sparkle') { // fixed twinkling stars
      p.vx = 0; p.vy = 0;
      p.size = rand(1.2, 3);
      p.alpha = rand(0.5, 1);
      p.twSpeed = rand(0.002, 0.006);
    } else { // dust: slow omnidirectional drift, dimmer and smaller
      p.vx = rand(-0.008, 0.008);
      p.vy = rand(-0.008, 0.008);
      p.size = rand(0.6, 1.8);
      p.alpha = rand(0.12, 0.4);
    }
    return p;
  };

  const stepParticles = (dt, t) => {
    const w = cssW, h = cssH;
    dt *= speed; // a global motion multiplier scales fall/drift/rotation/rain uniformly
    for (let i = 0; i < particles.length; i++) {
      const p = particles[i];
      if (effect === 'sparkle') continue; // fixed points; only the twinkle animates
      p.y += p.vy * h * dt;
      if (effect === 'dust') {
        p.x += p.vx * w * dt;
        if (p.x < -8) p.x = w + 8; else if (p.x > w + 8) p.x = -8;
        if (p.y < -8) p.y = h + 8; else if (p.y > h + 8) p.y = -8;
      } else if (effect === 'rain') {
        if (p.y > h + p.len) particles[i] = spawn(true);
      } else if (effect === 'petals') {
        p.x += Math.sin(t * 0.0012 + p.phase) * p.sway * 30 * dt;
        p.rot += p.vrot * dt;
        if (p.y > h + p.size * 4) particles[i] = spawn(true);
      } else {
        p.x += Math.sin(t * 0.001 + p.phase) * p.sway * 20 * dt;
        if (effect === 'embers' && p.y < -p.size * 4) particles[i] = spawn(true);
        if (effect === 'snow' && p.y > h + p.size * 4) particles[i] = spawn(true);
      }
    }
  };

  const draw = (t) => {
    const ctx2 = canvas.getContext('2d');
    // Draw in CSS pixels; the dpr transform maps them onto the backing store.
    ctx2.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx2.clearRect(0, 0, cssW, cssH);
    // Additive blend makes overlapping particles glow; source-over is the flat look.
    ctx2.globalCompositeOperation = glow ? 'lighter' : 'source-over';
    for (const p of particles) {
      let a = p.alpha;
      if (effect === 'embers') {
        a *= 0.65 + 0.35 * Math.sin(t * 0.004 * speed + p.phase); // flicker (speed-scaled)
        a *= Math.min(1, Math.max(0, p.y / (cssH * 0.35)));    // die out near the top
      } else if (effect === 'sparkle') {
        a *= 0.3 + 0.7 * Math.abs(Math.sin(t * p.twSpeed * speed + p.phase)); // twinkle (speed-scaled)
      }
      const colour = `rgba(${r}, ${g}, ${b}, ${Math.max(0, Math.min(1, a)).toFixed(3)})`;
      if (effect === 'rain') {
        ctx2.strokeStyle = colour;
        ctx2.lineWidth = p.size;
        ctx2.beginPath();
        ctx2.moveTo(p.x, p.y);
        ctx2.lineTo(p.x, p.y + p.len);
        ctx2.stroke();
      } else if (effect === 'petals') {
        ctx2.fillStyle = colour;
        ctx2.save();
        ctx2.translate(p.x, p.y);
        ctx2.rotate(p.rot);
        ctx2.beginPath();
        ctx2.ellipse(0, 0, p.size, p.size * 0.58, 0, 0, Math.PI * 2);
        ctx2.fill();
        ctx2.restore();
      } else if (effect === 'sparkle') {
        // Four-point sparkle: points pulled toward the centre with curves.
        ctx2.fillStyle = colour;
        const s = p.size * (0.7 + 0.9 * a);
        ctx2.beginPath();
        ctx2.moveTo(p.x, p.y - s);
        ctx2.quadraticCurveTo(p.x, p.y, p.x + s, p.y);
        ctx2.quadraticCurveTo(p.x, p.y, p.x, p.y + s);
        ctx2.quadraticCurveTo(p.x, p.y, p.x - s, p.y);
        ctx2.quadraticCurveTo(p.x, p.y, p.x, p.y - s);
        ctx2.fill();
      } else {
        ctx2.fillStyle = colour;
        ctx2.beginPath();
        ctx2.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx2.fill();
      }
    }
  };

  // Static thumbnails (gallery cards) + OS reduced-motion get one scattered
  // frame, no loop (`reduced` is decided by the caller for the whole surface).
  const resize = () => {
    const rect = canvas.getBoundingClientRect();
    // Before layout the canvas can measure 0×0 — bail and let the observer
    // re-fire once it has real dimensions, so particles never spawn into a
    // collapsed top-left corner.
    if (rect.width < 1 || rect.height < 1) return;
    cssW = rect.width;
    cssH = rect.height;
    canvas.width = Math.max(1, Math.round(cssW * dpr));
    canvas.height = Math.max(1, Math.round(cssH * dpr));
    particles = Array.from({ length: count }, () => spawn(false));
    if (reduced) draw(0);
  };

  const observer = new ResizeObserver(resize);
  observer.observe(canvas);
  resize(); // draws a static frame when reduced
  return { canvas, observer, step: stepParticles, draw, count };
}

// Particle Studio custom mode: drive the data-driven engine (src/particles.js).
// Same handle shape as the preset path { canvas, observer, step, draw, count },
// so the ONE shared ambience raf ticks it with no extra wiring. The preset
// engine above is untouched.
function setupCustomParticles(root, pack, ambience, assets, reduced) {
  const AP = window.AegisParticles;
  const system = ambience.system;
  const palette = pack.skin.palette;
  const density = Math.min(1, Math.max(0.05, typeof ambience.density === 'number' ? ambience.density : 0.5));

  // Base colour → [r,g,b]: a palette TOKEN (tracks the colourway), a custom hex,
  // or accent as a fallback.
  const ck = system.color.paletteKey;
  let hex;
  if (ck === 'custom' && typeof system.color.custom === 'string') hex = system.color.custom;
  else hex = palette[ck] || palette.accent || '#ffffff';
  const baseColor = hexToRgbParts(hex);

  // Author's count scaled by the user's global density knob (0.5 = as authored),
  // hard-capped at the engine's MAX_COUNT.
  const count = Math.max(1, Math.min(AP.MAX_COUNT, Math.round(system.count * density * 2)));
  const def = Object.assign({}, system, { count });

  const canvas = document.createElement('canvas');
  canvas.className = 'ambience-layer';
  root.appendChild(canvas);
  const dpr = window.devicePixelRatio || 1;
  let cssW = 0, cssH = 0;
  const spawnPoints = []; // mask emitter — filled async, read live by the engine

  // Custom sprite image (async; the engine falls back to the builtin shape until
  // it decodes).
  let spriteImg = null;
  if (system.sprite.custom && assets && assets[system.sprite.custom]) {
    const im = new Image();
    im.onload = () => { spriteImg = im; };
    im.src = assets[system.sprite.custom];
  }

  // Mask emitter: precompute spawn points from the mask's bright pixels ONCE
  // (downsampled grid, not per spawn). Pushed into spawnPoints, which the engine
  // reads live, so it kicks in within a respawn cycle after the mask decodes.
  if (system.emitter.shape === 'mask' && system.emitter.mask && assets && assets[system.emitter.mask]) {
    const im = new Image();
    im.onload = () => {
      const GRID = 128;
      const ar = im.naturalHeight / Math.max(1, im.naturalWidth);
      const oc = document.createElement('canvas');
      oc.width = GRID; oc.height = Math.max(1, Math.round(GRID * ar));
      const octx = oc.getContext('2d');
      octx.drawImage(im, 0, 0, oc.width, oc.height);
      const px = octx.getImageData(0, 0, oc.width, oc.height).data;
      for (let y = 0; y < oc.height; y++) {
        for (let x = 0; x < oc.width; x++) {
          const i = (y * oc.width + x) * 4;
          const lum = (px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114) * (px[i + 3] / 255);
          if (lum > 40) spawnPoints.push({ x: (x + 0.5) / oc.width, y: (y + 0.5) / oc.height });
        }
      }
    };
    im.src = assets[system.emitter.mask];
  }

  let sys = null;
  const rebuild = () => { sys = AP.createParticleSystem(def, { w: cssW, h: cssH, spawnPoints }, Math.random); };

  // Pointer interaction — one listener, only when the system actually reacts.
  const ptr = { x: 0.5, y: 0.5, active: false };
  let ptrCleanup = null;
  if (system.pointer && system.pointer.mode !== 'none' && !reduced) {
    const doc = root.ownerDocument || document;
    const win = doc.defaultView || window;
    const onMove = (e) => { ptr.x = e.clientX / (win.innerWidth || 1); ptr.y = e.clientY / (win.innerHeight || 1); ptr.active = true; };
    doc.addEventListener('pointermove', onMove, { passive: true });
    ptrCleanup = () => doc.removeEventListener('pointermove', onMove);
  }

  const step = (dt, t) => { if (sys) { sys.setPointer(ptr.x, ptr.y, ptr.active); sys.step(dt, t); } };
  const draw = () => {
    if (!sys) return;
    const ctx2 = canvas.getContext('2d');
    ctx2.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx2.clearRect(0, 0, cssW, cssH);
    AP.drawParticles(ctx2, sys, def, { baseColor, refWidth: cssW, spriteImg });
  };

  const resize = () => {
    const rect = canvas.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return; // pre-layout: wait for the observer
    cssW = rect.width; cssH = rect.height;
    canvas.width = Math.max(1, Math.round(cssW * dpr));
    canvas.height = Math.max(1, Math.round(cssH * dpr));
    rebuild();
    if (reduced) draw();
  };
  const observer = new ResizeObserver(resize);
  observer.observe(canvas);
  resize();
  // Drop the pointer listener when the caller disconnects the observer (re-render
  // / teardown), so no listener leaks across pack switches.
  const baseDisconnect = observer.disconnect.bind(observer);
  observer.disconnect = () => { if (ptrCleanup) { ptrCleanup(); ptrCleanup = null; } baseDisconnect(); };

  return { canvas, observer, step, draw, count };
}

// Own the SINGLE motion loop for a surface: ambience particles AND background
// parallax/drift ride the same raf (never a second one), the same fps cap, and
// the same freeze. Called by applySkin AFTER applyBackground has built the layer
// stack (so root.__aegisBg is ready).
function applyAmbience(root, pack, assets, opts) {
  const prev = root.__aegisAmbience;
  if (prev) {
    cancelAnimationFrame(prev.raf);
    if (prev.observer) prev.observer.disconnect();
    if (prev.canvas) prev.canvas.remove();
    root.__aegisAmbience = null;
  }

  const reduced = (opts && opts.staticAmbience === true)
    || (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const particles = setupAmbienceParticles(root, pack, assets, opts, reduced);
  if (window.AegisPerf) window.AegisPerf.setParticles(particles ? particles.count : 0);
  const bg = root.__aegisBg;                       // built by applyBackground
  const bgMoving = !reduced && !!(bg && bg.needsMotion);

  // Frame budget: the engine caps fps to be a good 24/7 citizen (30 default).
  const maxFps = opts && opts.maxFps ? Math.max(1, opts.maxFps) : 30;
  const frameInterval = 1000 / maxFps;
  let last = 0;
  const state = {
    raf: 0, paused: false, reduced,
    canvas: particles ? particles.canvas : null,
    observer: particles ? particles.observer : null,
    // External per-frame subscribers on this ONE loop: breathing rigs (Phase F),
    // and later the timeline (Phase G) — never a second raf.
    tickers: new Set(),
    start: null,
  };
  root.__aegisAmbience = state;

  const alive = () => (particles ? particles.canvas.isConnected
    : (bg && bg.stack ? bg.stack.isConnected : root.isConnected));
  const loop = (t) => {
    // Frozen by the engine (full-screen app / battery) → stop cold; resume
    // re-applies the skin and starts fresh. Self-terminate on detached DOM or
    // once there's nothing left to animate.
    if (state.paused) return;
    const work = particles || bgMoving || state.tickers.size > 0;
    if (!alive() || !work) { if (particles) particles.observer.disconnect(); state.raf = 0; return; }
    state.raf = requestAnimationFrame(loop);
    if (t - last < frameInterval) return;
    const dt = Math.min(t - last, 100) / 1000;
    last = t;
    if (particles) { particles.step(dt, t); particles.draw(t); }
    if (bgMoving) stepBackgroundMotion(bg, dt, t);
    if (state.tickers.size) for (const fn of state.tickers) { try { fn(dt, t); } catch (e) { /* fail soft */ } }
  };
  // Start the ONE shared loop — used here for ambience/background, and by
  // registerSurfaceTick when a rig subscribes to an otherwise-still surface.
  state.start = () => { if (!state.paused && !state.reduced && !state.raf) { last = 0; state.raf = requestAnimationFrame(loop); } };

  // Reduced motion → particles already drew one static frame and every layer
  // sits at its base transform; rigs stay still too. Otherwise auto-run when
  // ambience or the background needs it (a rig-only pack starts it on subscribe).
  if (reduced) return;
  if (particles || bgMoving) state.start();
}

// Subscribe a per-frame tick fn to the surface's ONE shared animation loop
// (breathing rigs; later the timeline). Never a second raf. Returns
// { animating, stop }: when the surface is static/reduced, animating is false
// and the caller should render a single resting frame instead of subscribing.
function registerSurfaceTick(root, fn) {
  const state = root && root.__aegisAmbience;
  if (!state || state.reduced || typeof state.start !== 'function') return { animating: false, stop: () => {} };
  state.tickers.add(fn);
  state.start();
  return { animating: true, stop: () => { state.tickers.delete(fn); } };
}

// The pointer a rig follows for gaze/tilt. When a parallax background exists we
// share ITS lerped pointer, so the character and the world move as one; with no
// background we track + lerp our own (same 0.08 factor). Range [-1, 1].
function makeRigPointer(skinRoot) {
  const bg = skinRoot && skinRoot.__aegisBg;
  if (bg && bg.pointer) return { read: () => bg.pointer, cleanup: null };
  const st = { x: 0, y: 0, tx: 0, ty: 0 };
  const doc = (skinRoot && skinRoot.ownerDocument) || document;
  const win = doc.defaultView || window;
  const onMove = (e) => {
    st.tx = Math.max(-1, Math.min(1, (e.clientX / (win.innerWidth || 1) - 0.5) * 2));
    st.ty = Math.max(-1, Math.min(1, (e.clientY / (win.innerHeight || 1) - 0.5) * 2));
  };
  doc.addEventListener('pointermove', onMove, { passive: true });
  return {
    read: () => { st.x += (st.tx - st.x) * 0.08; st.y += (st.ty - st.y) * 0.08; return st; },
    cleanup: () => doc.removeEventListener('pointermove', onMove),
  };
}

// ── Time-of-day schedule (Phase G) ──────────────────────────────────────────
// skin.schedule recolours the palette across four slots (dawn/day/dusk/night)
// as the local clock passes each slot's start hour. Only palette tokens change
// (the CSS custom properties + surface void colour); the change crossfades over
// SCHEDULE_FADE_MS, driven by the ONE shared loop — never a second raf, and it
// stops dead with the loop on freeze. The gradient base fill and particle colour
// are baked at setup and don't recolour mid-run (documented in PACKS.md).

const SCHEDULE_SLOT_NAMES = ['dawn', 'day', 'dusk', 'night'];
const SCHEDULE_FADE_MS = 2000;
const SCHEDULE_CHECK_SEC = 60; // re-evaluate the active slot ~once a minute

// The forced hour for previews/dev, else the real local hour. pack.__previewHour
// is a runtime-only field the editor sets to preview a slot; ?fakeHour is the
// DE_FAKE_HOUR dev override. Neither is persisted or sanitized into a pack.
function resolveScheduleHour(pack) {
  const pv = pack && pack.__previewHour;
  if (typeof pv === 'number' && Number.isFinite(pv)) return ((Math.floor(pv) % 24) + 24) % 24;
  if (QUERY_FAKE_HOUR !== null) return QUERY_FAKE_HOUR;
  return new Date().getHours();
}

// The active slot for `hour`: order the four slots by start hour and pick the
// one whose start is the greatest that is still ≤ hour, wrapping (before the
// earliest start = the latest slot, i.e. yesterday's night). Robust to any
// per-pack start hours.
function activeScheduleSlot(schedule, hour) {
  const entries = SCHEDULE_SLOT_NAMES
    .map((name) => schedule.slots[name] && { name, startHour: schedule.slots[name].startHour, palette: schedule.slots[name].palette })
    .filter((e) => e && typeof e.startHour === 'number')
    .sort((a, b) => a.startHour - b.startHour);
  if (!entries.length) return null;
  let active = entries[entries.length - 1]; // wrap: before the first start = last slot
  for (const e of entries) if (hour >= e.startHour) active = e;
  return active;
}

// Base palette with the given slot's partial overrides layered on top.
function mergePalette(base, override) {
  const out = {};
  for (const k of PALETTE_KEYS) out[k] = (override && override[k]) || base[k];
  return out;
}

function lerpPalette(from, to, f) {
  const out = {};
  for (const k of PALETTE_KEYS) out[k] = lerpColor(from[k], to[k], f);
  return out;
}

// The palette to paint right now given the schedule (or null when there is no
// active schedule → the base palette is used). Called from applySkin's first
// paint AND for static previews, so a thumbnail shows the current slot too.
function effectiveScheduledPalette(pack, opts) {
  const sched = pack.skin.schedule;
  if (!sched || !sched.enabled) return null;
  const slot = activeScheduleSlot(sched, resolveScheduleHour(pack));
  if (!slot) return null;
  return mergePalette(pack.skin.palette, slot.palette);
}

function applySchedule(root, pack, opts) {
  root.__aegisSchedule = null;
  const sched = pack.skin.schedule;
  if (!sched || !sched.enabled) return;
  const reduced = (opts && opts.staticAmbience === true)
    || (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  // Static/preview surface: the first paint already shows the current slot and
  // registerSurfaceTick would decline — nothing to animate.
  if (reduced) return;

  const { palette, texture, shape } = pack.skin;
  const initSlot = activeScheduleSlot(sched, resolveScheduleHour(pack));
  const state = {
    slotKey: initSlot ? initSlot.name : null,
    current: mergePalette(palette, initSlot ? initSlot.palette : {}),
    fade: null,
    sinceCheck: 0,
  };

  // Begin a crossfade from the currently-painted palette to `to`. t0 is anchored
  // on the first tick so the fade is timed off real frames, not the trigger.
  const startFade = (to, slotName) => {
    state.fade = { from: state.current, to, t0: null };
    state.current = to;
    if (slotName) state.slotKey = slotName;
  };

  const tick = (dt, t) => {
    // Re-check the active slot about once a wall-clock minute. dt-accumulated so
    // it pauses with the loop on freeze; the rest of the time this is two float
    // ops and a return — negligible on the shared frame.
    if (!state.fade) {
      state.sinceCheck += dt;
      if (state.sinceCheck >= SCHEDULE_CHECK_SEC) {
        state.sinceCheck = 0;
        const slot = activeScheduleSlot(sched, resolveScheduleHour(pack));
        if (slot && slot.name !== state.slotKey) startFade(mergePalette(palette, slot.palette), slot.name);
      }
    }
    if (state.fade) {
      if (state.fade.t0 === null) state.fade.t0 = t;
      const f = Math.min(1, (t - state.fade.t0) / SCHEDULE_FADE_MS);
      setPaletteVars(root, lerpPalette(state.fade.from, state.fade.to, f), texture, shape);
      if (f >= 1) state.fade = null;
    }
  };
  // Rides the shared loop (like a rig): a schedule-only pack starts the loop on
  // subscribe; a stale ticker is dropped when applySkin rebuilds __aegisAmbience.
  registerSurfaceTick(root, tick);

  // Editor/dev affordance: crossfade to a given hour's slot ON DEMAND (the
  // Preview-time picker and the "Play the day" button) so the 2 s transition is
  // visible without waiting for a real clock boundary.
  root.__aegisSchedule = {
    transitionTo(hour) {
      const slot = activeScheduleSlot(sched, ((Math.floor(hour) % 24) + 24) % 24);
      if (!slot) return;
      startFade(mergePalette(palette, slot.palette), slot.name);
      registerSurfaceTick(root, tick); // make sure the loop is running to advance it
    },
    // Marketing timelapse: set the palette CONTINUOUSLY for a fractional hour,
    // interpolating (smoothstep) between the two surrounding slots so a fast-
    // forwarded day sweeps smoothly through dawn→day→dusk→night. Drives the
    // palette directly (no fade); state kept in sync so the auto-ticker won't fight.
    setHour(hour) {
      hour = ((hour % 24) + 24) % 24;
      const entries = SCHEDULE_SLOT_NAMES
        .map((name) => sched.slots[name] && { name, startHour: sched.slots[name].startHour, palette: sched.slots[name].palette })
        .filter((e) => e && typeof e.startHour === 'number')
        .sort((a, b) => a.startHour - b.startHour);
      if (!entries.length) return;
      let pi = entries.length - 1;
      for (let i = 0; i < entries.length; i++) if (hour >= entries[i].startHour) pi = i;
      const prev = entries[pi], next = entries[(pi + 1) % entries.length];
      let span = next.startHour - prev.startHour; if (span <= 0) span += 24;
      let into = hour - prev.startHour; if (into < 0) into += 24;
      let f = Math.max(0, Math.min(1, into / span));
      f = f * f * (3 - 2 * f); // smoothstep: linger near each slot, transition between
      const pal = lerpPalette(mergePalette(palette, prev.palette), mergePalette(palette, next.palette), f);
      setPaletteVars(root, pal, texture, shape);
      state.slotKey = prev.name; state.fade = null;
    },
  };
}

// ── Keyframe timeline (Phase G) ──────────────────────────────────────────────
// pack.timeline animates a whitelist of numeric targets (component opacity /
// x / y / scale / rotate, and ambience canvas opacity) over a looping duration,
// evaluated INSIDE the shared loop. Component transform props are composed into
// ONE transform per element (translate·rotate·scale), preserving the element's
// base style rotate. rotate is additive on the base; x/y are cqw offsets; scale
// and opacity are absolute.

const TIMELINE_PROP_DEFAULT = { opacity: 1, x: 0, y: 0, scale: 1, rotate: 0 };

function easeFn(ease, x) {
  if (ease === 'in') return x * x;
  if (ease === 'out') return 1 - (1 - x) * (1 - x);
  if (ease === 'inout') return x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2;
  return x; // linear
}

// Value of one track at position `pos` (seconds). Before the first key holds its
// value, after the last holds its value; between two keys the SEGMENT eases with
// the destination key's easing.
function evalTrack(track, pos) {
  const keys = track.keys;
  if (pos <= keys[0].t) return keys[0].v;
  const last = keys[keys.length - 1];
  if (pos >= last.t) return last.v;
  for (let i = 0; i < keys.length - 1; i++) {
    const k0 = keys[i], k1 = keys[i + 1];
    if (pos >= k0.t && pos <= k1.t) {
      const span = k1.t - k0.t;
      const lin = span > 0 ? (pos - k0.t) / span : 1;
      return k0.v + (k1.v - k0.v) * easeFn(k1.ease, lin);
    }
  }
  return last.v;
}

// Subscribe the timeline to a surface's shared loop. Returns a disposer (or null
// for a static/reduced surface, where it applies the pos-0 resting frame once).
function setupTimeline(skinRoot, pack, elements) {
  const tl = pack.timeline;
  if (!tl || !Array.isArray(tl.tracks) || !tl.tracks.length) return null;

  // Which component elements are animated, plus their base transform values.
  const bases = new Map();
  for (const tr of tl.tracks) {
    if (tr.target.kind !== 'component') continue;
    const el = elements[tr.target.index];
    if (!el || bases.has(tr.target.index)) continue;
    const st = (pack.components[tr.target.index] && pack.components[tr.target.index].style) || {};
    bases.set(tr.target.index, {
      el,
      baseRotate: typeof st.rotate === 'number' ? st.rotate : 0,
      baseOpacity: typeof st.opacity === 'number' ? st.opacity : 1,
    });
  }
  const ambienceCanvas = skinRoot.__aegisAmbience && skinRoot.__aegisAmbience.canvas;

  const evalAt = (pos) => {
    const acc = new Map();
    for (const [i, b] of bases) acc.set(i, { x: 0, y: 0, scale: 1, rotate: b.baseRotate, opacity: b.baseOpacity });
    let ambienceOpacity = null;
    for (const tr of tl.tracks) {
      const v = evalTrack(tr, pos);
      if (tr.target.kind === 'ambience') { ambienceOpacity = v; continue; }
      const a = acc.get(tr.target.index);
      if (!a) continue;
      const b = bases.get(tr.target.index);
      if (tr.target.prop === 'opacity') a.opacity = v;
      else if (tr.target.prop === 'rotate') a.rotate = b.baseRotate + v;
      else a[tr.target.prop] = v; // x, y (cqw offset) or scale (absolute)
    }
    for (const [i, a] of acc) {
      const b = bases.get(i);
      b.el.style.opacity = String(a.opacity);
      b.el.style.transform = `translate(${a.x.toFixed(3)}cqw, ${a.y.toFixed(3)}cqw) rotate(${a.rotate.toFixed(3)}deg) scale(${a.scale.toFixed(4)})`;
    }
    if (ambienceOpacity !== null && ambienceCanvas) ambienceCanvas.style.opacity = String(ambienceOpacity);
  };

  const D = tl.duration;
  let t0 = null;
  const tick = (dt, t) => {
    if (t0 === null) t0 = t;
    const elapsed = (t - t0) / 1000;
    let pos;
    if (tl.loop === 'once') pos = Math.min(elapsed, D);
    else if (tl.loop === 'mirror') { const c = elapsed % (2 * D); pos = c <= D ? c : 2 * D - c; }
    else pos = elapsed % D; // loop
    evalAt(pos);
  };

  const reg = registerSurfaceTick(skinRoot, tick);
  if (reg.animating) return () => reg.stop();
  evalAt(0); // static/reduced preview: the resting (first-keyframe) frame, no loop
  return null;
}

// Stop the ambience animation without tearing down the DOM — the last frame
// stays on screen (a frozen wallpaper) at near-zero cost. Resuming re-applies
// the skin, which builds a fresh ambience loop.
function freezeAmbience(root) {
  const s = root && root.__aegisAmbience;
  if (s) { s.paused = true; cancelAnimationFrame(s.raf); }
  // Freeze the video wallpaper too, so a power-frozen desktop is truly idle.
  setWallpaperPlayback(root, false);
  // Pause an animated base fill (harmless when nothing is animating).
  if (root && root.style) root.style.animationPlayState = 'paused';
}

function applyComponentStyle(el, style, pack) {
  const accent = style.accent || pack.skin.palette.accent;
  if (style.accent) {
    el.style.setProperty('--accent', style.accent);
    el.style.setProperty('--glow', rgba(style.accent, 0.45 * pack.skin.texture.glow));
    el.style.setProperty('--hairline', rgba(style.accent, pack.skin.shape.borderOpacity));
    el.style.setProperty('--hairline-dim', rgba(style.accent, pack.skin.shape.borderOpacity * 0.5));
  }
  if (style.glow !== null) el.style.setProperty('--glow', rgba(accent, 0.45 * style.glow));
  if (style.textColor) el.style.setProperty('--accent-bright', style.textColor);
  if (style.font) el.style.setProperty('--font-display', FONT_STACKS[style.font]);
  if (style.fontScale !== null) el.style.setProperty('--font-scale', String(style.fontScale));
  if (style.align) {
    el.style.textAlign = style.align;
    // Inner flex rows (e.g. the weather glyph + temperature) don't follow
    // text-align — expose the choice as a justify value they can opt into.
    el.style.setProperty('--comp-justify', { left: 'flex-start', center: 'center', right: 'flex-end' }[style.align] || 'center');
  }
  if (style.place) {
    el.style.justifyContent = { top: 'flex-start', center: 'center', bottom: 'flex-end', spread: 'space-between' }[style.place];
  }
  if (style.opacity !== null) el.style.opacity = String(style.opacity);
  // Padding token is documented in px at the 1920-wide design basis; render
  // it container-relative so it scales with the surface (1px ≈ 0.0521cqw).
  if (style.padding !== null) el.style.padding = `${(style.padding * 0.0521).toFixed(3)}cqw`;
  if (style.rotate !== null) el.style.transform = `rotate(${style.rotate}deg)`;

  const panel = style.panel !== null ? style.panel : true;
  el.classList.toggle('panel', panel);
  el.classList.toggle('borderless', !(style.border !== null ? style.border : panel));
  if (style.notches !== null) el.classList.toggle('no-notches', !style.notches);
}

// ── Sandboxed module components ──────────────────────────────────────────────
// A `module` component runs designer-authored HTML/CSS/JS. It is UNTRUSTED, so
// it renders inside an <iframe sandbox="allow-scripts"> (opaque origin: no
// same-origin, no parent access, no top navigation, no forms/popups) wrapped in
// a document whose CSP forbids the network entirely (default-src 'none'; the
// only reachable resources are inline script/style and data: images). The frame
// therefore cannot reach Node, the IPC bridge (also withheld from subframes in
// every preload), the user's files, or the internet. The host and the module
// talk ONLY over postMessage, and the host only ever *pushes* an allowlisted
// feed — theme tokens and public system telemetry — so the module can never ask
// the engine to do anything.

const MODULE_CSP = [
  "default-src 'none'",       // nothing is reachable unless named below — no network, no frames
  "script-src 'unsafe-inline'", // the module's inline JS + our SDK shim (opaque origin, so scoped here)
  "style-src 'unsafe-inline'",
  "img-src data:",            // pack images arrive as data: URIs via DE.asset()
  "font-src data:",
  "media-src data:",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

const MODULE_BASE_CSS = [
  '*{box-sizing:border-box}',
  'html,body{margin:0;width:100%;height:100%}',
  // Make cqw/cqh inside the module resolve against the frame (= the component
  // box), so a module scales with its component just like native components do.
  'html{container-type:size}',
  'body{background:transparent;overflow:hidden;color:var(--de-accent-bright,#e6f6ff);',
  "font-family:var(--de-font,'Segoe UI',system-ui,sans-serif);",
  'letter-spacing:var(--de-ls,0);font-size:2.6cqw;line-height:1.35}',
  'a{color:var(--de-accent,#3fd8ff)}',
].join('');

// Injected as the FIRST script in the frame, before the module's own code, so
// window.DE exists when the module runs. It caches the last theme/data so late
// listeners still get current values, and only trusts messages from the host.
const MODULE_SDK = [
  '(function(){"use strict";',
  // SECURITY: the served CSP is network-less, but CSP does NOT cover WebRTC — a
  // hostile module could otherwise leak bytes via STUN/DNS lookups
  // (RTCPeerConnection ICE gathering resolves an attacker-encoded hostname).
  // This shim runs FIRST in the frame, so neuter WebRTC + media capture before
  // any designer code runs.
  'try{["RTCPeerConnection","webkitRTCPeerConnection","RTCDataChannel","RTCSessionDescription","RTCIceCandidate","RTCPeerConnectionIceEvent"].forEach(function(k){try{window[k]=undefined;}catch(e){}try{delete window[k];}catch(e){}});}catch(e){}',
  'try{if(navigator.mediaDevices){navigator.mediaDevices.getUserMedia=function(){return Promise.reject(new Error("blocked"));};navigator.mediaDevices.enumerateDevices=function(){return Promise.resolve([]);};}}catch(e){}',
  'var themeCache=null,dataCache=null,assetCache={},themeCbs=[],dataCbs=[];',
  'function safe(fn,a){try{fn(a);}catch(e){}}',
  'function applyVars(t){if(!t||!t.vars)return;var r=document.documentElement;',
  'for(var k in t.vars){if(Object.prototype.hasOwnProperty.call(t.vars,k))r.style.setProperty(k,t.vars[k]);}}',
  'window.addEventListener("message",function(e){',
  'if(e.source!==window.parent)return;var m=e.data;if(!m||m.__de!==1)return;',
  'if(m.type==="theme"){themeCache=m.theme;applyVars(m.theme);themeCbs.forEach(function(f){safe(f,m.theme);});}',
  'else if(m.type==="assets"){assetCache=m.assets||{};}',
  'else if(m.type==="data"){dataCache=m.data;dataCbs.forEach(function(f){safe(f,m.data);});}});',
  'window.DE={',
  'onTheme:function(cb){if(typeof cb==="function"){themeCbs.push(cb);if(themeCache)safe(cb,themeCache);}},',
  'onData:function(cb){if(typeof cb==="function"){dataCbs.push(cb);if(dataCache)safe(cb,dataCache);}},',
  'theme:function(){return themeCache;},data:function(){return dataCache;},',
  'asset:function(n){return assetCache[n]||null;}};',
  'try{window.parent.postMessage({__de:1,type:"ready"},"*");}catch(e){}',
  '})();',
].join('');

// Wrap a designer's fragment in the locked-down document shell. The fragment is
// authored like an Artifact: markup + inline <style>/<script>, no <html>/<head>/
// <body> of its own. A stray tag can only corrupt the module's own frame.
function moduleSrcdoc(fragment, o) {
  const scrollCss = o && o.scroll ? 'body{overflow:auto}' : '';
  return '<!doctype html><html><head><meta charset="utf-8">'
    + '<meta http-equiv="Content-Security-Policy" content="' + MODULE_CSP + '">'
    + '<style>' + MODULE_BASE_CSS + scrollCss + '</style>'
    + '<script>' + MODULE_SDK + '</' + 'script>'
    + '</head><body>' + fragment + '</body></html>';
}

// Load the module document from the custom `demodule://` scheme rather than
// srcdoc/data: — a custom scheme does NOT inherit the embedding page's strict
// CSP, so the module can run its own inline code under the network-less policy
// main serves it with. The whole document rides in the URL as base64url (UTF-8
// safe); main (see MODULE_SCHEME) decodes and echoes it back.
function moduleDocUrl(doc) {
  const bytes = new TextEncoder().encode(doc);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  const b64url = btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return 'demodule://m/' + b64url;
}

// Theme payload pushed to a module: pack skin tokens as both a structured object
// and ready-to-use CSS custom properties (--de-*). Persona name/tagline is pack
// content (not user data), so a module can greet in character.
function moduleTheme(pack) {
  const p = pack.skin.palette, t = pack.skin.typography, sh = pack.skin.shape;
  const fonts = {
    display: FONT_STACKS[t.display] || FONT_STACKS['system-sans'],
    sans: FONT_STACKS['system-sans'],
    serif: FONT_STACKS['system-serif'],
    mono: FONT_STACKS['mono'],
  };
  return {
    palette: {
      void: p.void, glass: p.glass, accent: p.accent, accentBright: p.accentBright,
      muted: p.muted, warn: p.warn, gold: p.gold,
    },
    fonts,
    radius: sh.radius,
    uppercase: !!t.uppercase,
    letterSpacing: t.letterSpacing,
    persona: { name: pack.persona.name, tagline: pack.persona.tagline || '' },
    vars: {
      '--de-void': p.void, '--de-glass': p.glass, '--de-accent': p.accent,
      '--de-accent-bright': p.accentBright, '--de-muted': p.muted,
      '--de-warn': p.warn, '--de-gold': p.gold,
      '--de-font': fonts.display, '--de-font-mono': fonts.mono,
      '--de-radius': sh.radius + 'px', '--de-ls': t.letterSpacing + 'em',
    },
  };
}

// The telemetry subset a module may see: system load, not identity. hostname is
// deliberately withheld (least privilege — the module has no exfil path anyway,
// but there's no reason to hand it over).
function moduleSample(v) {
  return {
    cpu: v.cpu, mem: v.mem, disk: v.disk, battery: v.battery,
    cores: Array.isArray(v.cores) ? v.cores.slice(0, 32) : [],
    memText: v.memText, diskText: v.diskText, diskFreeText: v.diskFreeText,
    uptimeText: v.uptimeText, batteryText: v.batteryText,
    now: Date.now(),
  };
}

// A plausible first frame so a preview (or the ~2 s before the first real tick)
// isn't blank. Live telemetry overwrites it on the desktop.
function moduleMockSample() {
  return {
    cpu: 24, mem: 58, disk: 46, battery: 80,
    cores: [30, 22, 40, 18, 26, 34, 20, 28],
    memText: '9.3 / 16.0 GB', diskText: '470 / 1000 GB', diskFreeText: '530 GB',
    uptimeText: '3h 12m', batteryText: '80 %', now: Date.now(),
  };
}

// ── Renderer instance ───────────────────────────────────────────────────────
// createRenderer(services) → { render(canvasEl, pack, assets), destroy() }.
// Every render() cleans up the previous one's timers/observers.

function createRenderer(services) {
  const live = {
    timers: [],
    observers: [],
    disposers: [],  // teardown callbacks (e.g. module postMessage listeners)
    telemetry: { subscribers: [], history: { cpu: [], mem: [], disk: [], battery: [] } },
  };

  // The desktop warms the local model as soon as an assistant component renders
  // (buildAssistant), hiding the ~1 GB cold load behind the time before the user
  // opens the chat. Debounced so frequent re-renders don't re-fire the warm.
  let lastAssistantWarmAt = 0;
  const ASSISTANT_WARM_DEBOUNCE_MS = 30000;

  function cssVar(el, name) {
    return getComputedStyle(el).getPropertyValue(name).trim();
  }

  function observeCanvas(canvas, draw) {
    const observer = new ResizeObserver(() => {
      canvas.width = Math.max(1, canvas.clientWidth * devicePixelRatio);
      canvas.height = Math.max(1, canvas.clientHeight * devicePixelRatio);
      draw();
    });
    observer.observe(canvas);
    live.observers.push(observer);
  }

  async function batteryPercent() {
    try {
      if (!navigator.getBattery) return null;
      const battery = await navigator.getBattery();
      return Math.round(battery.level * 100);
    } catch {
      return null;
    }
  }

  function startTelemetry() {
    if (live.telemetry.subscribers.length === 0) return;
    const tick = async () => {
      const res = await services.stats();
      if (!res.ok) return;
      const gb = (bytes) => (bytes / 2 ** 30).toFixed(1);
      const uptime = (sec) => {
        const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
        return d > 0 ? `${d}d ${h}h ${m}m` : `${h}h ${m}m`;
      };
      const values = {
        cpu: res.cpuPercent,
        cores: Array.isArray(res.coresPercent) ? res.coresPercent.slice(0, 32) : [],
        mem: Math.round((res.memUsedBytes / res.memTotalBytes) * 100),
        memText: `${gb(res.memUsedBytes)} / ${gb(res.memTotalBytes)} GB`,
        disk: res.diskTotalBytes > 0 ? Math.round((res.diskUsedBytes / res.diskTotalBytes) * 100) : 0,
        diskText: res.diskTotalBytes > 0 ? `${gb(res.diskUsedBytes)} / ${gb(res.diskTotalBytes)} GB` : '—',
        diskFreeText: res.diskTotalBytes > 0 ? `${Math.round((res.diskTotalBytes - res.diskUsedBytes) / 2 ** 30)} GB` : '—',
        uptimeText: typeof res.uptimeSec === 'number' ? uptime(res.uptimeSec) : '—',
        hostname: typeof res.hostname === 'string' ? res.hostname.slice(0, 24).toUpperCase() : '—',
        battery: await batteryPercent(),
        batteryText: null,
      };
      if (res.hasBattery === false) {
        // Settled OS-side: this machine has no battery (a desktop). It's always
        // on mains, so show "AC power" and a full, never-"low" gauge instead of
        // the Battery API's bogus 100%.
        values.battery = 100;
        values.batteryText = 'AC power';
      } else {
        if (values.battery === null) values.battery = 0;
        values.batteryText = navigator.getBattery ? `${values.battery} %` : 'no battery';
      }
      for (const key of ['cpu', 'mem', 'disk', 'battery']) {
        const series = live.telemetry.history[key];
        series.push(values[key]);
        if (series.length > HISTORY_LENGTH) series.shift();
      }
      for (const update of live.telemetry.subscribers) update(values);
    };
    tick();
    live.timers.push(setInterval(tick, TELEMETRY_INTERVAL_MS));
  }

  function bindText(values, bind) {
    if (bind === 'mem') return values.memText;
    if (bind === 'disk') return values.diskText;
    if (bind === 'battery') return values.batteryText;
    return `${values[bind]} %`;
  }

  // A "hot" (warning) reading depends on the metric's direction: cpu/mem/disk
  // are alarming when HIGH, but battery is alarming when LOW. Treating a nearly
  // full battery as a warning (the old shared `>= 85`) was backwards.
  const METER_HOT_HIGH = 85; // cpu / mem / disk
  const METER_HOT_LOW = 15;  // battery
  function meterHot(bind, value) {
    if (typeof value !== 'number') return false;
    if (bind === 'battery') return value <= METER_HOT_LOW;
    return value >= METER_HOT_HIGH;
  }

  // Live health line (sysinfo): per-metric thresholds. cpu/mem/disk alarm when
  // HIGH; battery alarms when LOW. Two levels — warn (amber) and critical (red).
  const HEALTH_METRICS = [
    { key: 'cpu', label: 'CPU', warn: 85, crit: 95, high: true },
    { key: 'mem', label: 'MEM', warn: 85, crit: 93, high: true },
    { key: 'disk', label: 'DISK', warn: 85, crit: 93, high: true },
    { key: 'battery', label: 'BATTERY', warn: 20, crit: 10, high: false },
  ];
  const HEALTH_TRIP_SAMPLES = 3; // must hold past a threshold this many ticks before alerting (debounce)
  const HEALTH_CLEAR_MARGIN = 5; // hysteresis: step down only once the value clears the line by this much

  // A per-component monitor with its own debounce + hysteresis, so a momentary
  // spike doesn't flap the line and a reading must genuinely recover to clear.
  // Returns { severity: 0|1|2, alerts: [{sev,label,v}] } — worst first.
  function makeHealthMonitor() {
    const latched = {}; // key -> currently shown severity (0|1|2)
    const rising = {};  // key -> consecutive ticks the raw level has exceeded the latched one
    const rawSev = (m, v) => {
      if (typeof v !== 'number') return 0;
      return m.high ? (v >= m.crit ? 2 : v >= m.warn ? 1 : 0) : (v <= m.crit ? 2 : v <= m.warn ? 1 : 0);
    };
    const cleared = (m, v, level) => {
      const line = level === 2 ? m.crit : m.warn;
      return m.high ? v < line - HEALTH_CLEAR_MARGIN : v > line + HEALTH_CLEAR_MARGIN;
    };
    return (values) => {
      const alerts = [];
      const perMetric = {}; // label -> { sev, v } for EVERY metric, so a clear (→0) is visible too
      let worst = 0;
      for (const m of HEALTH_METRICS) {
        // Only a real discharging battery counts — not an AC desktop or none present.
        if (m.key === 'battery' && values.batteryText !== `${values.battery} %`) {
          latched[m.key] = 0; rising[m.key] = 0; perMetric[m.label] = { sev: 0, v: values[m.key] };
          continue;
        }
        const v = values[m.key];
        const raw = rawSev(m, v);
        const cur = latched[m.key] || 0;
        if (raw > cur) {
          rising[m.key] = (rising[m.key] || 0) + 1;
          if (rising[m.key] >= HEALTH_TRIP_SAMPLES) { latched[m.key] = raw; rising[m.key] = 0; }
        } else if (raw < cur && (typeof v !== 'number' || cleared(m, v, cur))) {
          latched[m.key] = raw; rising[m.key] = 0;
        } else {
          rising[m.key] = 0;
        }
        const sev = latched[m.key] || 0;
        perMetric[m.label] = { sev, v };
        if (sev > 0) { worst = Math.max(worst, sev); alerts.push({ sev, label: m.label, v }); }
      }
      alerts.sort((a, b) => b.sev - a.sev);
      return { severity: worst, alerts, perMetric };
    };
  }

  // ── Builders ──────────────────────────────────────────────────────────────

  function buildStatus(component, el, ctx) {
    const name = document.createElement('div');
    name.className = 'status-name';
    name.textContent = ctx.pack.persona.name;
    const tagline = document.createElement('div');
    tagline.className = 'status-tagline display-case';
    tagline.textContent = ctx.pack.persona.tagline;
    const line = document.createElement('div');
    line.className = 'status-line';
    el.append(name, tagline, line);

    const lines = ctx.pack.persona.lines;
    if (lines.length === 0) return;
    let index = 0;
    line.textContent = lines[0];
    if (lines.length > 1) {
      live.timers.push(setInterval(() => {
        index = (index + 1) % lines.length;
        line.textContent = lines[index];
      }, 4000));
    }
  }

  function buildClock(component, el) {
    const time = document.createElement('div');
    time.className = 'clock-time';
    const date = document.createElement('div');
    date.className = 'clock-date display-case';
    el.append(time);
    if (component.options.showDate) el.append(date);

    const tick = () => {
      const now = new Date();
      let hours = now.getHours();
      let suffix = '';
      if (component.options.format === '12h') {
        suffix = hours >= 12 ? ' PM' : ' AM';
        hours = hours % 12 || 12;
      }
      const parts = [String(hours).padStart(2, '0'), String(now.getMinutes()).padStart(2, '0')];
      if (component.options.seconds) parts.push(String(now.getSeconds()).padStart(2, '0'));
      time.textContent = parts.join(':') + suffix;
      if (component.options.showDate) {
        date.textContent = now.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
      }
    };
    tick();
    live.timers.push(setInterval(tick, 250));
  }

  function buildAnalogClock(component, el) {
    const canvas = document.createElement('canvas');
    canvas.className = 'fill-canvas';
    el.appendChild(canvas);

    const draw = () => {
      const ctx2 = canvas.getContext('2d');
      const w = canvas.width, h = canvas.height;
      ctx2.clearRect(0, 0, w, h);
      const cx = w / 2, cy = h / 2;
      const radius = Math.min(w, h) / 2 - 6 * devicePixelRatio;
      if (radius <= 0) return;

      const accent = cssVar(el, '--accent');
      const bright = cssVar(el, '--accent-bright');
      const hairline = cssVar(el, '--hairline');
      const gold = cssVar(el, '--gold');
      const muted = cssVar(el, '--muted');

      ctx2.lineWidth = 1 * devicePixelRatio;
      ctx2.strokeStyle = hairline;
      ctx2.beginPath();
      ctx2.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx2.stroke();

      if (component.options.minuteTicks !== false) {
        ctx2.strokeStyle = hairline;
        for (let i = 0; i < 60; i++) {
          if (i % 5 === 0) continue;
          const angle = (i / 60) * Math.PI * 2;
          ctx2.beginPath();
          ctx2.moveTo(cx + Math.sin(angle) * radius * 0.945, cy - Math.cos(angle) * radius * 0.945);
          ctx2.lineTo(cx + Math.sin(angle) * radius * 0.97, cy - Math.cos(angle) * radius * 0.97);
          ctx2.stroke();
        }
      }

      ctx2.strokeStyle = accent;
      for (let i = 0; i < 12; i++) {
        const angle = (i / 12) * Math.PI * 2;
        const inner = i % 3 === 0 ? radius * 0.86 : radius * 0.92;
        ctx2.beginPath();
        ctx2.moveTo(cx + Math.sin(angle) * inner, cy - Math.cos(angle) * inner);
        ctx2.lineTo(cx + Math.sin(angle) * radius * 0.97, cy - Math.cos(angle) * radius * 0.97);
        ctx2.stroke();
      }

      // Numerals in the pack's display font — quarters big and bright, the
      // rest (in 'all' mode) small and muted so the dial keeps its hierarchy.
      const numerals = component.options.numerals || 'quarters';
      if (numerals !== 'none') {
        const fontFamily = getComputedStyle(el).fontFamily;
        ctx2.textAlign = 'center';
        ctx2.textBaseline = 'middle';
        for (let n = 1; n <= 12; n++) {
          const quarter = n % 3 === 0;
          if (numerals === 'quarters' && !quarter) continue;
          const angle = (n / 12) * Math.PI * 2;
          const size = radius * (quarter ? 0.17 : 0.115);
          ctx2.font = `600 ${size}px ${fontFamily}`;
          ctx2.fillStyle = quarter ? bright : muted;
          ctx2.fillText(String(n), cx + Math.sin(angle) * radius * 0.74, cy - Math.cos(angle) * radius * 0.74);
        }
      }

      const now = new Date();
      const seconds = now.getSeconds() + now.getMilliseconds() / 1000;
      const minutes = now.getMinutes() + seconds / 60;
      const hours = (now.getHours() % 12) + minutes / 60;

      // Hands get a short counterweight tail and a soft glow.
      ctx2.shadowColor = cssVar(el, '--glow');
      ctx2.shadowBlur = 6 * devicePixelRatio;
      const hand = (angle, length, width, colour) => {
        ctx2.strokeStyle = colour;
        ctx2.lineWidth = width * devicePixelRatio;
        ctx2.lineCap = 'round';
        ctx2.beginPath();
        ctx2.moveTo(cx - Math.sin(angle) * length * 0.16, cy + Math.cos(angle) * length * 0.16);
        ctx2.lineTo(cx + Math.sin(angle) * length, cy - Math.cos(angle) * length);
        ctx2.stroke();
      };
      hand((hours / 12) * Math.PI * 2, radius * 0.5, 3, bright);
      hand((minutes / 60) * Math.PI * 2, radius * 0.72, 2, accent);
      if (component.options.seconds) hand((seconds / 60) * Math.PI * 2, radius * 0.8, 1, gold);
      ctx2.shadowBlur = 0;

      ctx2.fillStyle = accent;
      ctx2.beginPath();
      ctx2.arc(cx, cy, 3.5 * devicePixelRatio, 0, Math.PI * 2);
      ctx2.fill();
      ctx2.fillStyle = cssVar(el, '--void');
      ctx2.beginPath();
      ctx2.arc(cx, cy, 1.4 * devicePixelRatio, 0, Math.PI * 2);
      ctx2.fill();
    };

    observeCanvas(canvas, draw);
    live.timers.push(setInterval(draw, component.options.seconds ? 100 : 1000));
  }

  // Faint area-fill of a bind's history, drawn inside a bar's track so the
  // bar reads as "now" on top of "the last three minutes".
  function drawTrace(canvas, el, bind) {
    const ctx2 = canvas.getContext('2d');
    const w = canvas.width, h = canvas.height;
    ctx2.clearRect(0, 0, w, h);
    const series = live.telemetry.history[bind];
    if (!series || series.length < 2) return;
    const step = w / Math.max(series.length - 1, 1);
    ctx2.beginPath();
    ctx2.moveTo(0, h);
    series.forEach((v, i) => ctx2.lineTo(i * step, h - (v / 100) * h));
    ctx2.lineTo((series.length - 1) * step, h);
    ctx2.closePath();
    ctx2.globalAlpha = 0.22;
    ctx2.fillStyle = cssVar(el, '--accent');
    ctx2.fill();
    ctx2.globalAlpha = 1;
  }

  // HUD clock — the "arc reactor": counter-rotating ring layers drawn from
  // the original HUD-clock geometry (400-unit viewBox, outer radius 186),
  // digital time + date in the centre. Ring alphas are fixed to the original
  // design so pack border settings don't wash the reactor out.
  function buildHudClock(component, el) {
    const wrap = document.createElement('div');
    wrap.className = 'hud-wrap';
    const canvas = document.createElement('canvas');
    canvas.className = 'fill-canvas';
    const face = document.createElement('div');
    face.className = 'hud-face';
    const time = document.createElement('div');
    time.className = 'hud-time';
    const date = document.createElement('div');
    date.className = 'hud-date display-case';
    face.append(time);
    if (component.options.showDate) face.append(date);
    wrap.append(canvas, face);
    el.appendChild(wrap);

    const reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const start = performance.now();

    const draw = () => {
      const ctx2 = canvas.getContext('2d');
      const w = canvas.width, h = canvas.height;
      ctx2.clearRect(0, 0, w, h);
      const cx = w / 2, cy = h / 2;
      const R = Math.min(w, h) / 2 - 2 * devicePixelRatio;
      if (R <= 0) return;
      const u = R / 186; // original geometry unit
      const accent = cssVar(el, '--accent');
      const bright = cssVar(el, '--accent-bright');
      const glow = cssVar(el, '--glow');
      const t = reduced ? 0 : performance.now() - start;
      // Layer rotations from the original: outer 90 s, mid −36 s, inner 18 s.
      const outerA = (t / 90000) * Math.PI * 2;
      const midA = -(t / 36000) * Math.PI * 2;
      const innerA = (t / 18000) * Math.PI * 2;

      const circle = (r, alpha, width, dash) => {
        ctx2.beginPath();
        ctx2.setLineDash(dash || []);
        ctx2.globalAlpha = alpha;
        ctx2.lineWidth = width * devicePixelRatio;
        ctx2.strokeStyle = accent;
        ctx2.arc(cx, cy, r * u, 0, Math.PI * 2);
        ctx2.stroke();
        ctx2.setLineDash([]);
        ctx2.globalAlpha = 1;
      };
      const arc = (r, from, sweep, colour, width, alpha, useGlow) => {
        ctx2.beginPath();
        ctx2.globalAlpha = alpha;
        ctx2.lineWidth = width * devicePixelRatio;
        ctx2.strokeStyle = colour;
        if (useGlow) { ctx2.shadowColor = glow; ctx2.shadowBlur = 7 * devicePixelRatio; }
        ctx2.arc(cx, cy, r * u, from, from + sweep);
        ctx2.stroke();
        ctx2.shadowBlur = 0;
        ctx2.globalAlpha = 1;
      };

      // outer: faint ring + 60 ticks (every 5th brighter), slow spin
      circle(186, 0.45, 1);
      for (let i = 0; i < 60; i++) {
        const a = (i / 60) * Math.PI * 2 + outerA;
        const major = i % 5 === 0;
        const r2 = major ? 176 : 181;
        ctx2.beginPath();
        ctx2.globalAlpha = major ? 0.8 : 0.45;
        ctx2.lineWidth = (major ? 1.5 : 1) * devicePixelRatio;
        ctx2.strokeStyle = accent;
        ctx2.moveTo(cx + Math.cos(a) * 186 * u, cy + Math.sin(a) * 186 * u);
        ctx2.lineTo(cx + Math.cos(a) * r2 * u, cy + Math.sin(a) * r2 * u);
        ctx2.stroke();
        ctx2.globalAlpha = 1;
      }
      // mid: dashed ring + two opposed quarter arcs, counter-rotating
      circle(150, 0.45, 1, [3 * u, 9 * u]);
      arc(162, midA - Math.PI / 2, Math.PI / 2, accent, 2, 0.55, true);
      arc(162, midA + Math.PI / 2, Math.PI / 2, accent, 2, 0.55, true);
      // inner: faint ring + bright three-quarter arc + glow disc
      circle(118, 0.45, 1);
      arc(105, innerA - Math.PI / 2, Math.PI * 1.5, bright, 2.5, 1, true);
      ctx2.beginPath();
      ctx2.globalAlpha = 0.09;
      ctx2.fillStyle = accent;
      ctx2.arc(cx, cy, 92 * u, 0, Math.PI * 2);
      ctx2.fill();
      ctx2.globalAlpha = 0.45;
      ctx2.lineWidth = 1 * devicePixelRatio;
      ctx2.strokeStyle = accent;
      ctx2.stroke();
      ctx2.globalAlpha = 1;
    };

    const tick = () => {
      const now = new Date();
      let hours = now.getHours();
      let suffix = '';
      if (component.options.format === '12h') {
        suffix = hours >= 12 ? ' PM' : ' AM';
        hours = hours % 12 || 12;
      }
      const parts = [String(hours).padStart(2, '0'), String(now.getMinutes()).padStart(2, '0')];
      if (component.options.seconds) parts.push(String(now.getSeconds()).padStart(2, '0'));
      time.textContent = parts.join(':') + suffix;
      if (component.options.showDate) {
        date.textContent = now.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
      }
    };

    observeCanvas(canvas, draw);
    tick();
    live.timers.push(setInterval(tick, 250));
    if (!reduced) live.timers.push(setInterval(draw, 50)); // 20 fps ring drift
  }

  // A themeable centerpiece clock — the non-sci-fi counterpart to hud-clock.
  // Same palette-driven colour, but the drawn form is quiet and adapts to any
  // pack: `minimal` (a clean thin ring + tick marks) or `halo` (a soft thick
  // ring that fills with the passing seconds). No reactor motif, no constant
  // rotation. The time uses the pack's display font so it reads warm/serif/
  // minimal as the pack intends, not techy-mono.
  function buildRingClock(component, el) {
    const style = component.options.style === 'halo' ? 'halo' : 'minimal';
    el.classList.add('ring-clock', `ring-${style}`);
    const wrap = document.createElement('div');
    wrap.className = 'rc-wrap';
    const canvas = document.createElement('canvas');
    canvas.className = 'fill-canvas';
    const face = document.createElement('div');
    face.className = 'rc-face';
    const time = document.createElement('div');
    time.className = 'rc-time';
    const date = document.createElement('div');
    date.className = 'rc-date display-case';
    face.append(time);
    if (component.options.showDate) face.append(date);
    wrap.append(canvas, face);
    el.appendChild(wrap);

    const reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const draw = () => {
      const ctx2 = canvas.getContext('2d');
      const w = canvas.width, h = canvas.height;
      ctx2.clearRect(0, 0, w, h);
      const cx = w / 2, cy = h / 2;
      const R = Math.min(w, h) / 2 - 3 * devicePixelRatio;
      if (R <= 0) return;
      const accent = cssVar(el, '--accent');
      const bright = cssVar(el, '--accent-bright');
      const glow = cssVar(el, '--glow');
      const now = new Date();
      // The seconds fraction drives a gentle sweep. Under reduced motion it
      // still reflects the current time, just stepped once per second.
      const secFrac = (now.getSeconds() + (reduced ? 0 : now.getMilliseconds() / 1000)) / 60;
      const top = -Math.PI / 2; // 12 o'clock

      if (style === 'halo') {
        const lw = Math.max(2 * devicePixelRatio, R * 0.09);
        ctx2.lineCap = 'round';
        // Soft track ring.
        ctx2.beginPath();
        ctx2.globalAlpha = 0.16;
        ctx2.lineWidth = lw;
        ctx2.strokeStyle = accent;
        ctx2.arc(cx, cy, R * 0.82, 0, Math.PI * 2);
        ctx2.stroke();
        // Progress arc fills clockwise with the passing seconds, with a soft glow.
        ctx2.beginPath();
        ctx2.globalAlpha = 1;
        ctx2.lineWidth = lw;
        ctx2.strokeStyle = bright;
        ctx2.shadowColor = glow;
        ctx2.shadowBlur = 8 * devicePixelRatio;
        ctx2.arc(cx, cy, R * 0.82, top, top + secFrac * Math.PI * 2);
        ctx2.stroke();
        ctx2.shadowBlur = 0;
        ctx2.globalAlpha = 1;
        ctx2.lineCap = 'butt';
      } else {
        // minimal: a hairline ring, 12 ticks (12/3/6/9 longer), a bright dot at
        // the current second.
        ctx2.beginPath();
        ctx2.globalAlpha = 0.4;
        ctx2.lineWidth = 1.5 * devicePixelRatio;
        ctx2.strokeStyle = accent;
        ctx2.arc(cx, cy, R * 0.9, 0, Math.PI * 2);
        ctx2.stroke();
        for (let i = 0; i < 12; i++) {
          const a = (i / 12) * Math.PI * 2;
          const major = i % 3 === 0;
          const r1 = R * 0.9, r2 = R * (major ? 0.81 : 0.86);
          ctx2.beginPath();
          ctx2.globalAlpha = major ? 0.7 : 0.4;
          ctx2.lineWidth = (major ? 1.5 : 1) * devicePixelRatio;
          ctx2.strokeStyle = accent;
          ctx2.moveTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
          ctx2.lineTo(cx + Math.cos(a) * r2, cy + Math.sin(a) * r2);
          ctx2.stroke();
        }
        const sa = top + secFrac * Math.PI * 2;
        ctx2.beginPath();
        ctx2.globalAlpha = 1;
        ctx2.fillStyle = bright;
        ctx2.arc(cx + Math.cos(sa) * R * 0.9, cy + Math.sin(sa) * R * 0.9, 2.6 * devicePixelRatio, 0, Math.PI * 2);
        ctx2.fill();
        ctx2.globalAlpha = 1;
      }
    };

    const tick = () => {
      const now = new Date();
      let hours = now.getHours();
      let suffix = '';
      if (component.options.format === '12h') {
        suffix = hours >= 12 ? ' PM' : ' AM';
        hours = hours % 12 || 12;
      }
      const parts = [String(hours).padStart(2, '0'), String(now.getMinutes()).padStart(2, '0')];
      if (component.options.seconds) parts.push(String(now.getSeconds()).padStart(2, '0'));
      time.textContent = parts.join(':') + suffix;
      if (component.options.showDate) {
        date.textContent = now.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
      }
      draw();
    };

    observeCanvas(canvas, draw);
    tick();
    // A soft ~4 fps sweep normally; once per second under reduced motion.
    live.timers.push(setInterval(tick, reduced ? 1000 : 250));
  }

  // Per-core CPU load bars (the "core load" strip).
  function buildCores(component, el) {
    const label = document.createElement('span');
    label.className = 'comp-label';
    label.textContent = component.options.label || 'Core load';
    const strip = document.createElement('div');
    strip.className = 'cores-strip';
    el.append(label, strip);
    live.telemetry.subscribers.push((values) => {
      const cores = values.cores || [];
      while (strip.childElementCount < cores.length) strip.appendChild(document.createElement('span'));
      while (strip.childElementCount > cores.length) strip.removeChild(strip.lastChild);
      [...strip.children].forEach((bar, i) => { bar.style.height = `${Math.max(4, cores[i])}%`; });
    });
  }

  // Key/value machine readouts.
  function buildSysinfo(component, el) {
    const rows = [];
    const addRow = (name, valueKey, fixed) => {
      const row = document.createElement('div');
      row.className = 'ds-row';
      const key = document.createElement('span');
      key.className = 'ds-key display-case';
      key.textContent = name;
      const value = document.createElement('span');
      value.className = `ds-value${fixed ? ' ds-ok' : ''}`;
      value.textContent = fixed || '—';
      row.append(key, value);
      el.appendChild(row);
      if (!fixed) rows.push({ value, valueKey });
    };
    if (component.options.memory) addRow('Memory', 'memText');
    if (component.options.disk) addRow('Disk free', 'diskFreeText');
    if (component.options.uptime) addRow('Uptime', 'uptimeText');
    if (component.options.host) addRow('Host', 'hostname');
    // Status line: either a static motto, OR a LIVE health readout that shows the
    // idle text when everything's nominal and the worst offender(s) when a metric
    // crosses a threshold (debounced + colour-coded by severity).
    let healthCell = null;
    let healthIdle = '';
    if (component.options.health) {
      healthIdle = component.options.statusText || 'ALL SYSTEMS NOMINAL';
      const row = document.createElement('div');
      row.className = 'ds-row';
      const key = document.createElement('span');
      key.className = 'ds-key display-case';
      key.textContent = 'Status';
      healthCell = document.createElement('span');
      healthCell.className = 'ds-value ds-ok';
      healthCell.textContent = healthIdle;
      row.append(key, healthCell);
      el.appendChild(row);
    } else if (component.options.statusText) {
      addRow('Status', null, component.options.statusText);
    }

    // The status component's health line is purely VISUAL (it shows the worst
    // reading in place of the motto). Spoken alerts are handled globally in
    // render() so they work for any pack, not only ones with this line enabled.
    const monitor = healthCell ? makeHealthMonitor() : null;
    live.telemetry.subscribers.push((values) => {
      for (const row of rows) row.value.textContent = values[row.valueKey] ?? '—';
      if (!healthCell) return;
      const { severity, alerts } = monitor(values);
      if (severity === 0) {
        healthCell.textContent = healthIdle;
        healthCell.style.color = '';
        healthCell.style.fontWeight = '';
      } else {
        healthCell.textContent = alerts.slice(0, 2).map((a) => `${a.label} ${Math.round(a.v)}%`).join(' · ');
        healthCell.style.color = severity === 2 ? 'var(--danger, #ff5a5a)' : 'var(--warn, #ffb23e)';
        healthCell.style.fontWeight = severity === 2 ? '700' : '';
      }
    });
  }

  function statRow(name, traced, el, bind) {
    const row = document.createElement('div');
    row.className = 'stat-row';
    const label = document.createElement('span');
    label.className = 'stat-name';
    label.textContent = name;
    const bar = document.createElement('div');
    bar.className = 'stat-bar';
    let trace = null;
    if (traced) {
      trace = document.createElement('canvas');
      trace.className = 'stat-trace';
      bar.appendChild(trace);
      observeCanvas(trace, () => drawTrace(trace, el, bind));
    }
    const fill = document.createElement('span');
    bar.appendChild(fill);
    const value = document.createElement('span');
    value.className = 'stat-value';
    value.textContent = '—';
    row.append(label, bar, value);
    return { row, bar, fill, value, trace };
  }

  function buildStats(component, el) {
    const label = document.createElement('span');
    label.className = 'comp-label';
    label.textContent = 'System telemetry';
    el.appendChild(label);
    const traced = component.options.history !== false;
    const rows = [];
    for (const bind of ['cpu', 'mem', 'disk', 'battery']) {
      if (!component.options[bind]) continue;
      const r = statRow(bind.toUpperCase(), traced, el, bind);
      rows.push({ bind, ...r });
      el.appendChild(r.row);
    }
    live.telemetry.subscribers.push((values) => {
      for (const r of rows) {
        r.fill.style.width = `${values[r.bind]}%`;
        r.fill.classList.toggle('hot', meterHot(r.bind, values[r.bind]));
        r.value.textContent = bindText(values, r.bind);
        if (r.trace) drawTrace(r.trace, el, r.bind);
      }
    });
  }

  function buildMeter(component, el) {
    const bind = component.options.bind;
    const label = document.createElement('span');
    label.className = 'comp-label';
    label.textContent = component.options.label || bind.toUpperCase();

    if (component.options.variant === 'bar') {
      el.appendChild(label);
      let big = null;
      if (component.options.readout !== false) {
        big = document.createElement('div');
        big.className = 'meter-value';
        big.textContent = '—';
        el.appendChild(big);
      }
      const bar = document.createElement('div');
      bar.className = `stat-bar meter-bar${component.options.ticks !== false ? ' ticked' : ''}`;
      const trace = document.createElement('canvas');
      trace.className = 'stat-trace';
      bar.appendChild(trace);
      observeCanvas(trace, () => drawTrace(trace, el, bind));
      const fill = document.createElement('span');
      bar.appendChild(fill);
      el.appendChild(bar);
      live.telemetry.subscribers.push((values) => {
        fill.style.width = `${values[bind]}%`;
        fill.classList.toggle('hot', meterHot(bind, values[bind]));
        if (big) big.textContent = bindText(values, bind);
        drawTrace(trace, el, bind);
      });
      return;
    }

    const wrap = document.createElement('div');
    wrap.className = 'ring-wrap';
    const canvas = document.createElement('canvas');
    canvas.className = 'fill-canvas';
    const value = document.createElement('span');
    value.className = 'ring-value';
    value.textContent = '—';
    wrap.append(canvas, value);
    el.append(label, wrap);

    let current = 0;
    const draw = () => {
      const ctx2 = canvas.getContext('2d');
      const w = canvas.width, h = canvas.height;
      ctx2.clearRect(0, 0, w, h);
      const cx = w / 2, cy = h / 2;
      const radius = Math.min(w, h) / 2 - 8 * devicePixelRatio;
      if (radius <= 0) return;
      const start = -Math.PI / 2;

      ctx2.lineWidth = 5 * devicePixelRatio;
      ctx2.lineCap = 'round';
      ctx2.strokeStyle = cssVar(el, '--hairline-dim');
      ctx2.beginPath();
      ctx2.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx2.stroke();

      ctx2.strokeStyle = meterHot(bind, current) ? cssVar(el, '--warn') : cssVar(el, '--accent');
      ctx2.beginPath();
      ctx2.arc(cx, cy, radius, start, start + (current / 100) * Math.PI * 2);
      ctx2.stroke();
    };

    observeCanvas(canvas, draw);
    live.telemetry.subscribers.push((values) => {
      current = values[bind];
      // Battery shows its label text ("AC power" / "80 %" / "no battery");
      // other binds show the raw percent.
      value.textContent = bind === 'battery' ? bindText(values, bind) : `${current}%`;
      draw();
    });
  }

  function buildSparkline(component, el) {
    const bind = component.options.bind;
    const head = document.createElement('div');
    head.className = 'spark-head';
    const label = document.createElement('span');
    label.className = 'comp-label';
    label.textContent = component.options.label || `${bind.toUpperCase()} HISTORY`;
    head.appendChild(label);
    let readout = null;
    if (component.options.readout !== false) {
      readout = document.createElement('span');
      readout.className = 'spark-value';
      readout.textContent = '—';
      head.appendChild(readout);
    }
    const canvas = document.createElement('canvas');
    canvas.className = 'fill-canvas spark';
    el.append(head, canvas);

    const draw = () => {
      const ctx2 = canvas.getContext('2d');
      const w = canvas.width, h = canvas.height;
      ctx2.clearRect(0, 0, w, h);

      // Quarter grid first, so the chart looks composed even before the
      // history has any samples in it.
      if (component.options.grid !== false) {
        ctx2.strokeStyle = cssVar(el, '--hairline-dim');
        ctx2.lineWidth = 1 * devicePixelRatio;
        for (const f of [0.25, 0.5, 0.75]) {
          ctx2.beginPath();
          ctx2.moveTo(0, h * f);
          ctx2.lineTo(w, h * f);
          ctx2.stroke();
        }
      }

      const series = live.telemetry.history[bind];
      if (series.length < 2) return;
      // Stretch whatever history exists across the full width — a fresh boot
      // fills the panel immediately and compresses toward final density.
      const step = w / Math.max(series.length - 1, 1);
      const yFor = (v) => h - (v / 100) * (h - 4 * devicePixelRatio) - 2 * devicePixelRatio;

      ctx2.beginPath();
      ctx2.moveTo(0, h);
      series.forEach((v, i) => ctx2.lineTo(i * step, yFor(v)));
      ctx2.lineTo((series.length - 1) * step, h);
      ctx2.closePath();
      ctx2.fillStyle = cssVar(el, '--glow-wash');
      ctx2.fill();

      ctx2.shadowColor = cssVar(el, '--glow');
      ctx2.shadowBlur = 5 * devicePixelRatio;
      ctx2.beginPath();
      series.forEach((v, i) => {
        if (i === 0) ctx2.moveTo(0, yFor(v));
        else ctx2.lineTo(i * step, yFor(v));
      });
      ctx2.strokeStyle = cssVar(el, '--accent');
      ctx2.lineWidth = 1.5 * devicePixelRatio;
      ctx2.stroke();

      // "Now" dot on the newest sample.
      ctx2.fillStyle = cssVar(el, '--accent-bright');
      ctx2.beginPath();
      ctx2.arc((series.length - 1) * step, yFor(series[series.length - 1]), 2.2 * devicePixelRatio, 0, Math.PI * 2);
      ctx2.fill();
      ctx2.shadowBlur = 0;
    };

    observeCanvas(canvas, draw);
    live.telemetry.subscribers.push((values) => {
      if (readout) readout.textContent = bindText(values, bind);
      draw();
    });
  }

  function buildText(component, el) {
    const text = document.createElement('div');
    text.className = 'text-body display-case';
    text.textContent = component.options.text;
    el.appendChild(text);
  }

  function buildImage(component, el, ctx) {
    const uri = ctx.assets[component.options.src];
    if (!uri) return;
    const img = document.createElement('img');
    img.className = `image-body fit-${component.options.fit}`;
    img.alt = '';
    img.src = uri;
    el.appendChild(img);
  }

  // Breathing rig (Phase F): layered PNGs that come alive via per-layer
  // oscillators (breath=scale, sway=rotate, bob=translate) + pointer gaze/tilt.
  // Transform-only, ticked on the ONE shared surface loop (never a second raf);
  // halts in place on freeze; a preview/reduced-motion surface shows static art.
  function buildRig(component, el, ctx) {
    const layers = Array.isArray(component.options.layers) ? component.options.layers : [];
    const built = [];
    for (const layer of layers) {
      const uri = ctx.assets[layer.src];
      if (!uri) continue;
      const d = document.createElement('div');
      d.className = 'rig-layer';
      d.style.backgroundImage = `url(${uri})`;
      d.style.transformOrigin = `${layer.anchor.x}% ${layer.anchor.y}%`;
      el.appendChild(d);
      built.push({ el: d, layer });
    }
    if (!built.length) return;

    // ctx.skinRoot is resolved from the attached canvas (el isn't in the DOM yet
    // while this builder runs, so el.closest can't find the skin root).
    const skinRoot = (ctx && ctx.skinRoot) || el.closest('.skin-root') || (el.ownerDocument && el.ownerDocument.body) || document.body;
    const pointer = makeRigPointer(skinRoot);
    const TAU = Math.PI * 2;
    // Per layer each tick: translate(bob + gaze·pointer) rotate(sway·sin +
    // tilt·pointer) scale(1 + breath·sin), about the layer's anchor. The editor's
    // "Preview breeze" sets component.__breezeGust (0..1), which decays here and
    // adds a clear extra sway/bob to EVERY layer — so the motion is easy to judge
    // even on layers whose own sway is low.
    const draw = (dt, t) => {
      const gust = typeof component.__breezeGust === 'number' && component.__breezeGust > 0 ? component.__breezeGust : 0;
      if (gust > 0) component.__breezeGust = Math.max(0, gust - dt / 2.5); // ~2.5 s fade-out
      const p = pointer.read();
      const sec = t / 1000;
      for (let i = 0; i < built.length; i++) {
        const b = built[i], L = b.layer;
        const gustRot = gust * 5 * Math.sin(sec * 3 + i * 0.6);   // extra degrees, staggered per layer
        const gustBob = gust * 1.4 * Math.sin(sec * 2.6 + i * 0.5); // extra cqw
        const breathe = 1 + L.breath.scale * (1 + gust) * Math.sin(TAU * (sec * L.breath.speed + L.breath.phase));
        const rot = L.sway.rotate * Math.sin(TAU * (sec * L.sway.speed + L.sway.phase)) + gustRot + L.tiltWithPointer * p.x;
        const ty = L.bob.y * Math.sin(TAU * (sec * L.bob.speed + L.bob.phase)) + gustBob + L.gaze.y * p.y;
        const tx = L.gaze.x * p.x;
        b.el.style.transform = `translate(${tx.toFixed(3)}cqw, ${ty.toFixed(3)}cqw) rotate(${rot.toFixed(3)}deg) scale(${breathe.toFixed(4)})`;
      }
    };

    const reg = registerSurfaceTick(skinRoot, (dt, t) => draw(dt, t));
    if (reg.animating) {
      live.disposers.push(() => { reg.stop(); if (pointer.cleanup) pointer.cleanup(); });
    } else {
      // Static surface (preview / reduced motion): one resting frame, no loop.
      for (const b of built) b.el.style.transform = 'none';
      if (pointer.cleanup) pointer.cleanup();
    }
  }

  function buildDivider(component, el) {
    el.classList.add(`divider-${component.options.orientation}`);
    const line = document.createElement('span');
    line.className = 'divider-line';
    el.appendChild(line);
  }

  // Photo gallery: cycle a list of pack images, one at a time, inside the box.
  // Two stacked layers crossfade between slides. Low-frequency timer (seconds),
  // so freezing/destroying the renderer stops it cleanly.
  function buildGallery(component, el, ctx) {
    const o = component.options;
    el.classList.add('comp-gallery');
    const uris = (o.images || []).map((src) => ctx.assets[src]).filter(Boolean);
    if (uris.length === 0) {
      const hint = document.createElement('div');
      hint.className = 'gallery-empty';
      hint.textContent = 'Add photos in the editor';
      el.appendChild(hint);
      return;
    }

    const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (o.transition === 'fade' && !reduced) el.classList.add('gallery-fade');

    const size = o.fit === 'contain' ? 'contain' : 'cover';
    const layers = [document.createElement('div'), document.createElement('div')];
    for (const layer of layers) {
      layer.className = 'gallery-slide';
      layer.style.backgroundSize = size;
      el.appendChild(layer);
    }

    // A stable per-render order (optionally shuffled). No Math.random at module
    // scope — vary the seed by first URI length so packs differ but a render is
    // deterministic.
    let order = uris.map((_, i) => i);
    if (o.shuffle && uris.length > 2) {
      let seed = uris[0].length + uris.length;
      for (let i = order.length - 1; i > 0; i--) {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        const j = seed % (i + 1);
        [order[i], order[j]] = [order[j], order[i]];
      }
    }

    let front = 0;
    let idx = 0;
    layers[0].style.backgroundImage = `url(${uris[order[0]]})`;
    layers[0].style.opacity = '1';
    if (uris.length === 1) return;

    const advance = () => {
      idx = (idx + 1) % order.length;
      const back = 1 - front;
      layers[back].style.backgroundImage = `url(${uris[order[idx]]})`;
      layers[back].style.opacity = '1';
      layers[front].style.opacity = '0';
      front = back;
    };
    live.timers.push(setInterval(advance, Math.max(2, o.interval || 6) * 1000));
  }

  // Local (not UTC) YYYY-MM-DD — reminder dates are the user's wall dates.
  function localIso(date) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  }

  function buildCalendar(component, el) {
    const label = document.createElement('span');
    label.className = 'comp-label';
    const grid = document.createElement('div');
    grid.className = 'cal-grid';
    el.append(label, grid);

    const byDay = new Map(); // day-of-month → this month's (non-done) reminders, for the hover peek

    // Interactive only where reminder-write services exist (the live desktop),
    // and only when the pack shows reminders at all. Editor/manager previews
    // omit these services, so the calendar there stays a static preview.
    const editable = component.options.showReminders !== false
      && typeof services.remindersAdd === 'function';

    // Reminder markers: dot the days that still have something planned.
    // Repeating events land on every occurrence (expanded in main).
    const decorate = async () => {
      if (!services.reminders || component.options.showReminders === false) return;
      const now = new Date();
      const prefix = localIso(now).slice(0, 8);
      const last = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
      const res = await services.reminders({ from: `${prefix}01`, to: `${prefix}${String(last).padStart(2, '0')}` });
      if (!res.ok) return;
      const entries = res.occurrences || res.reminders;
      byDay.clear();
      const marked = new Set();
      for (const r of entries) {
        if (!r.date.startsWith(prefix) || r.done) continue;
        const day = Number(r.date.slice(8));
        marked.add(day);
        if (!byDay.has(day)) byDay.set(day, []);
        byDay.get(day).push(r);
      }
      for (const cell of grid.querySelectorAll('.cal-day')) {
        cell.classList.toggle('has-rem', marked.has(Number(cell.dataset.day)));
      }
    };

    const render = () => {
      const now = new Date();
      label.textContent = now.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
      grid.textContent = '';
      const mondayFirst = component.options.weekStart === 'mon';
      const dayNames = mondayFirst ? ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] : ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
      for (const d of dayNames) {
        const head = document.createElement('span');
        head.className = 'cal-head';
        head.textContent = d;
        grid.appendChild(head);
      }
      const prefix = localIso(now).slice(0, 8); // YYYY-MM-
      const first = new Date(now.getFullYear(), now.getMonth(), 1);
      const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
      let lead = first.getDay(); // 0 = Sunday
      if (mondayFirst) lead = (lead + 6) % 7;
      for (let i = 0; i < lead; i++) grid.appendChild(document.createElement('span'));
      for (let day = 1; day <= daysInMonth; day++) {
        const cell = document.createElement('span');
        cell.className = `cal-day${day === now.getDate() ? ' today' : ''}`;
        cell.textContent = String(day);
        cell.dataset.day = String(day);
        cell.dataset.iso = `${prefix}${String(day).padStart(2, '0')}`;
        if (editable) {
          cell.classList.add('cal-clickable');
          cell.addEventListener('click', () => openDay(cell.dataset.iso, cell));
        }
        // Peek this day's events on hover — after a short delay so it doesn't flash
        // as the cursor passes over. Read-only; the click editor is separate.
        cell.addEventListener('mouseenter', () => {
          clearTimeout(hoverTimer);
          const d = Number(cell.dataset.day);
          hoverTimer = setTimeout(() => showHover(d, cell), HOVER_DELAY_MS);
        });
        cell.addEventListener('mouseleave', () => { clearTimeout(hoverTimer); closeHover(); });
        grid.appendChild(cell);
      }
      decorate();
    };

    // ── In-place reminder editor (desktop only) ─────────────────────────────
    // Clicking a day floats a small glass popover anchored to that cell where
    // the user can add/remove/complete reminders without opening the manager.
    let popover = null;

    const closePopover = () => {
      if (popover) { popover.remove(); popover = null; }
    };

    const openDay = async (iso, anchor) => {
      closePopover();
      closeHover();
      const pop = document.createElement('div');
      pop.className = 'cal-pop skin-root';
      popover = pop;

      const [y, m, d] = iso.split('-').map(Number);
      const heading = new Date(y, m - 1, d)
        .toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });

      const head = document.createElement('div');
      head.className = 'cal-pop-head';
      const title = document.createElement('span');
      title.className = 'cal-pop-title';
      title.textContent = heading;
      const close = document.createElement('button');
      close.className = 'cal-pop-close';
      close.type = 'button';
      close.textContent = '×';
      close.addEventListener('click', closePopover);
      head.append(title, close);

      const listEl = document.createElement('div');
      listEl.className = 'cal-pop-list';

      // Add form: text (required) + optional time + repeat.
      const form = document.createElement('form');
      form.className = 'cal-pop-form';
      const textInput = document.createElement('input');
      textInput.className = 'cal-pop-text-input';
      textInput.type = 'text';
      textInput.placeholder = 'Add a reminder…';
      textInput.maxLength = 120;

      // Time picker: explicit hour / minute / AM-PM spinners. The native
      // <input type="time"> hides an AM/PM slot in 12-hour locales and refuses
      // to submit while any part is blank ("field is incomplete"); these can't
      // reach that state, and read clearly on the wallpaper. "No time" leaves
      // the reminder untimed (a whole-day item).
      const helper = (cls, values, labeller) => {
        const sel = document.createElement('select');
        sel.className = cls;
        for (const v of values) {
          const opt = document.createElement('option');
          opt.value = String(v);
          opt.textContent = labeller ? labeller(v) : String(v);
          sel.appendChild(opt);
        }
        return sel;
      };
      const timeWrap = document.createElement('div');
      timeWrap.className = 'cal-pop-timepick';
      const hourSel = helper('cal-pop-hour', ['', 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
        (v) => (v === '' ? 'No time' : String(v)));
      const minSel = helper('cal-pop-min', Array.from({ length: 60 }, (_, i) => i),
        (v) => String(v).padStart(2, '0'));
      const apSel = helper('cal-pop-ap', ['AM', 'PM']);
      timeWrap.append(hourSel, minSel, apSel);

      // Grey out minute/AM-PM until an hour is chosen, so "No time" is obvious.
      const syncTimeEnabled = () => {
        const off = hourSel.value === '';
        minSel.disabled = off;
        apSel.disabled = off;
      };
      hourSel.addEventListener('change', syncTimeEnabled);
      syncTimeEnabled();

      // Combine the pickers into a 24-hour "HH:MM" string, or null if untimed.
      const readTime = () => {
        if (hourSel.value === '') return null;
        let h = Number(hourSel.value) % 12;        // 12 → 0
        if (apSel.value === 'PM') h += 12;         // 12PM→12, 12AM→0, 1PM→13…
        return `${String(h).padStart(2, '0')}:${String(Number(minSel.value)).padStart(2, '0')}`;
      };
      const resetTime = () => {
        hourSel.value = ''; minSel.value = '0'; apSel.value = 'AM';
        syncTimeEnabled();
      };

      const row = document.createElement('div');
      row.className = 'cal-pop-row';
      const repeatSel = helper('cal-pop-repeat', ['none', 'daily', 'weekly', 'monthly', 'yearly'],
        (v) => ({ none: 'Once', daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly', yearly: 'Yearly' }[v]));
      const addBtn = document.createElement('button');
      addBtn.className = 'cal-pop-add';
      addBtn.type = 'submit';
      addBtn.textContent = 'Add';
      row.append(repeatSel, addBtn);
      form.append(textInput, timeWrap, row);

      // Render this day's reminders into the list (re-run after any change).
      const refresh = async () => {
        const res = await services.reminders({ from: iso, to: iso });
        listEl.textContent = '';
        const entries = (res.ok && (res.occurrences || res.reminders)) || [];
        const dayEntries = entries.filter((r) => r.date === iso);
        if (dayEntries.length === 0) {
          const empty = document.createElement('div');
          empty.className = 'cal-pop-empty';
          empty.textContent = 'Nothing planned.';
          listEl.appendChild(empty);
          return;
        }
        for (const r of dayEntries) {
          const item = document.createElement('div');
          item.className = `cal-pop-item${r.done ? ' done' : ''}`;
          const when = document.createElement('span');
          when.className = 'cal-pop-when';
          when.textContent = r.time || (r.repeat && r.repeat !== 'none' ? '↻' : '·');
          const text = document.createElement('span');
          text.className = 'cal-pop-text';
          text.textContent = r.text;
          // One-off tasks toggle done on click; repeating events can't be done.
          if (r.repeat === 'none') {
            text.classList.add('togglable');
            text.title = 'Mark done';
            text.addEventListener('click', async () => {
              await services.remindersToggle(r.id);
              await refresh();
              decorate();
            });
          }
          const del = document.createElement('button');
          del.className = 'cal-pop-del';
          del.type = 'button';
          del.textContent = '×';
          del.title = r.repeat === 'none' ? 'Remove' : 'Remove series';
          del.addEventListener('click', async () => {
            await services.remindersRemove(r.id);
            await refresh();
            decorate();
          });
          item.append(when, text, del);
          listEl.appendChild(item);
        }
      };

      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const value = textInput.value.trim();
        if (!value) { textInput.focus(); return; }
        addBtn.disabled = true;
        const res = await services.remindersAdd({
          date: iso,
          time: readTime(),
          text: value,
          repeat: repeatSel.value,
        });
        addBtn.disabled = false;
        if (res && res.ok) {
          textInput.value = '';
          resetTime();
          repeatSel.value = 'none';
          await refresh();
          decorate();
          textInput.focus();
        }
      });

      pop.append(head, listEl, form);
      document.body.appendChild(pop);
      positionPopover(pop, anchor);
      await refresh();
      positionPopover(pop, anchor); // re-place now the day's events give it real height
      textInput.focus();
    };

    // Anchor the popover under its day cell, flipping above / clamping to the
    // viewport so it's never clipped off-screen.
    const positionPopover = (pop, anchor) => {
      const rect = anchor.getBoundingClientRect();
      const pw = pop.offsetWidth;
      const ph = pop.offsetHeight;
      const margin = 8;
      let left = rect.left + rect.width / 2 - pw / 2;
      left = Math.max(margin, Math.min(left, window.innerWidth - pw - margin));
      let top = rect.bottom + 6;
      if (top + ph > window.innerHeight - margin) top = rect.top - ph - 6;
      if (top < margin) top = margin;
      pop.style.left = `${Math.round(left)}px`;
      pop.style.top = `${Math.round(top)}px`;
    };

    // ── Hover peek (read-only) ──────────────────────────────────────────────
    // Hovering a day with reminders (after a short delay) floats a small,
    // click-through list of that day's events. The click editor stays separate.
    const HOVER_DELAY_MS = 450;
    let hoverPop = null;
    let hoverTimer = 0;
    const closeHover = () => { if (hoverPop) { hoverPop.remove(); hoverPop = null; } };
    const showHover = (day, anchor) => {
      if (popover) return; // the click editor is open — don't stack over it
      const items = byDay.get(day);
      if (!items || !items.length) return;
      closeHover();
      const pop = document.createElement('div');
      pop.className = 'cal-hover skin-root';
      for (const r of items.slice(0, 6)) {
        const row = document.createElement('div');
        row.className = 'cal-hover-row';
        const when = document.createElement('span');
        when.className = 'cal-hover-when';
        when.textContent = r.time || (r.repeat && r.repeat !== 'none' ? '↻' : '·');
        const text = document.createElement('span');
        text.className = 'cal-hover-text';
        text.textContent = r.text || r.title || 'Reminder';
        row.append(when, text);
        pop.appendChild(row);
      }
      if (items.length > 6) {
        const more = document.createElement('div');
        more.className = 'cal-hover-more';
        more.textContent = `+${items.length - 6} more`;
        pop.appendChild(more);
      }
      hoverPop = pop;
      document.body.appendChild(pop);
      positionPopover(pop, anchor);
    };
    live.disposers.push(() => { clearTimeout(hoverTimer); closeHover(); });

    if (editable) {
      // Dismiss on outside click / Escape. mousedown fires before the day's
      // click, and popover is still null then, so opening never self-closes.
      const onDocDown = (e) => {
        if (popover && !popover.contains(e.target) && !e.target.closest('.cal-day')) closePopover();
      };
      const onKey = (e) => { if (e.key === 'Escape') closePopover(); };
      document.addEventListener('mousedown', onDocDown, true);
      document.addEventListener('keydown', onKey);
      live.disposers.push(() => {
        document.removeEventListener('mousedown', onDocDown, true);
        document.removeEventListener('keydown', onKey);
        closePopover();
      });
    }

    render();
    live.timers.push(setInterval(render, 60 * 1000));
  }

  // Focus / Pomodoro timer. The COUNTDOWN itself lives in main (lib/pomodoro.js)
  // so it keeps running — and dings — even while the desktop is frozen for a
  // full-screen app; this component only DISPLAYS the state and drives it.
  // Controls (owner's design): Start · Stop(=pause) · Break · Reset, where Break
  // opens an inline choice of a short/long break that auto-starts when focus ends.
  // Interactive on the desktop (services.pomodoro is present); the editor/manager
  // previews omit that service, so it renders a static sample like the calendar.
  const POMO_PHASE_LABEL = { focus: 'Focus', break: 'Break' };

  function buildPomodoro(component, el) {
    const o = component.options;
    const svc = services.pomodoro;
    const interactive = !!(svc && typeof svc.control === 'function');
    const dpr = window.devicePixelRatio || 1;
    const shortMin = Math.max(1, Math.min(180, o.shortBreakMin || 5));
    const longMin = Math.max(1, Math.min(180, o.longBreakMin || 15));

    // The editor options main needs to run the timer, sent with every control
    // call so the running timer tracks whatever this pack configures.
    const cfg = {
      focusMin: o.focusMin, shortBreakMin: o.shortBreakMin, longBreakMin: o.longBreakMin,
      cyclesBeforeLong: o.cyclesBeforeLong, notify: o.notify, sound: o.sound,
    };

    el.classList.add('pomodoro');
    const wrap = document.createElement('div');
    wrap.className = 'pomo-wrap';
    const canvas = document.createElement('canvas');
    canvas.className = 'pomo-ring fill-canvas';
    const face = document.createElement('div');
    face.className = 'pomo-face';
    const phaseEl = document.createElement('div');
    phaseEl.className = 'pomo-phase display-case';
    const timeEl = document.createElement('div');
    timeEl.className = 'pomo-time';
    const hintEl = document.createElement('div');
    hintEl.className = 'pomo-hint';
    const pipsEl = document.createElement('div');
    pipsEl.className = 'pomo-pips';
    face.append(phaseEl, timeEl, hintEl);
    if (o.showPips !== false) face.append(pipsEl);
    wrap.append(canvas, face);
    el.appendChild(wrap);

    const controls = document.createElement('div');
    controls.className = 'pomo-controls';
    el.appendChild(controls);

    // Optimistic starting state so the box is never blank; the real state
    // arrives right after (sync) on the desktop.
    let st = { phase: 'focus', running: false, endsAt: null, remainingMs: o.focusMin * 60000, breakMin: null, queuedBreakMin: null, completedFocus: 0 };
    let breakMenu = false; // the Break button swaps the row into a short/long choice

    // Full length of the phase currently shown — a break uses the length chosen
    // for it (or the queued one on the preview), focus uses this pack's focusMin.
    const phaseFullMs = () => (st.phase === 'break' ? (st.breakMin || shortMin) : o.focusMin) * 60000;

    const remainingMs = () => {
      if (!st) return 0;
      if (st.running && st.endsAt) return Math.max(0, st.endsAt - Date.now());
      return Math.max(0, Number(st.remainingMs) || 0);
    };
    const fmt = (ms) => {
      const total = Math.ceil(ms / 1000);
      return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
    };

    const draw = () => {
      const ctx2 = canvas.getContext('2d');
      const w = canvas.width, h = canvas.height;
      ctx2.clearRect(0, 0, w, h);
      const cx = w / 2, cy = h / 2;
      const R = Math.min(w, h) / 2 - 3 * dpr;
      if (R <= 0) return;
      const isBreak = st.phase === 'break';
      const arc = cssVar(el, isBreak ? '--gold' : '--accent-bright');
      const track = cssVar(el, '--accent');
      const glow = cssVar(el, '--glow');
      const full = phaseFullMs();
      const progress = full > 0 ? Math.min(1, Math.max(0, 1 - remainingMs() / full)) : 0;
      const lw = Math.max(2 * dpr, R * 0.1);
      const top = -Math.PI / 2; // 12 o'clock
      ctx2.lineCap = 'round';
      ctx2.beginPath();
      ctx2.globalAlpha = 0.16;
      ctx2.lineWidth = lw;
      ctx2.strokeStyle = track;
      ctx2.arc(cx, cy, R * 0.82, 0, Math.PI * 2);
      ctx2.stroke();
      if (progress > 0) {
        ctx2.beginPath();
        ctx2.globalAlpha = 1;
        ctx2.lineWidth = lw;
        ctx2.strokeStyle = arc;
        ctx2.shadowColor = glow;
        ctx2.shadowBlur = 8 * dpr;
        ctx2.arc(cx, cy, R * 0.82, top, top + progress * Math.PI * 2);
        ctx2.stroke();
        ctx2.shadowBlur = 0;
      }
      ctx2.globalAlpha = 1;
      ctx2.lineCap = 'butt';
    };

    const renderPips = () => {
      if (o.showPips === false) return;
      const n = Math.max(1, Math.min(12, o.cyclesBeforeLong || 4));
      const done = Math.max(0, Math.min(n, st.completedFocus || 0));
      pipsEl.textContent = '';
      for (let i = 0; i < n; i++) {
        const dot = document.createElement('i');
        dot.className = `pomo-pip${i < done ? ' on' : ''}`;
        pipsEl.appendChild(dot);
      }
    };

    const btn = (label, cls, disabled, onClick) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `pomo-btn${cls ? ' ' + cls : ''}`;
      b.textContent = label;
      b.disabled = !interactive || disabled; // static preview: controls are inert
      if (interactive && !disabled) b.addEventListener('click', onClick);
      return b;
    };

    // Two rows share the controls strip: the default Start/Stop/Break/Reset, and
    // the Break choice (short/long + close). Rebuilt on every state change.
    const renderControls = () => {
      controls.textContent = '';
      if (breakMenu) {
        controls.append(
          btn(`${shortMin}m`, '', false, () => { breakMenu = false; act('break', shortMin); }),
          btn(`${longMin}m`, '', false, () => { breakMenu = false; act('break', longMin); }),
          st.queuedBreakMin
            ? btn('None', '', false, () => { breakMenu = false; act('break', 0); }) // clear the queued break
            : btn('✕', '', false, () => { breakMenu = false; renderControls(); }),
        );
      } else {
        controls.append(
          btn('Start', 'pomo-primary', st.running, () => act('start')),
          btn('Stop', '', !st.running, () => act('pause')),
          btn('Break', st.queuedBreakMin ? 'queued' : '', false, () => { breakMenu = true; renderControls(); }),
          btn('Reset', '', false, () => act('reset')),
        );
      }
    };

    const applyState = () => {
      phaseEl.textContent = POMO_PHASE_LABEL[st.phase] || 'Focus';
      el.classList.toggle('pomo-break', st.phase === 'break');
      timeEl.textContent = fmt(remainingMs());
      // A queued break (during focus) is shown as a small sub-line so the Break
      // button stays short.
      hintEl.textContent = (st.phase === 'focus' && st.queuedBreakMin) ? `${st.queuedBreakMin}m break next` : '';
      renderPips();
      renderControls();
      draw();
    };

    async function act(action, breakMin) {
      const res = await svc.control(action, cfg, breakMin);
      if (res && res.ok && res.state) { st = res.state; applyState(); }
    }

    // A short, pleasant two-note chime (no bundled audio). Descending when a
    // break begins ("rest"), rising when focus resumes ("go"). Plays only on a
    // real phase-end while the desktop is active — the main-fired notification
    // covers the frozen case.
    let audioCtx = null;
    const playChime = (newPhase) => {
      try {
        if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const now = audioCtx.currentTime;
        const notes = newPhase === 'break' ? [660, 495] : [495, 660];
        notes.forEach((f, i) => {
          const osc = audioCtx.createOscillator();
          const gain = audioCtx.createGain();
          osc.type = 'sine';
          osc.frequency.value = f;
          const t0 = now + i * 0.16;
          gain.gain.setValueAtTime(0, t0);
          gain.gain.linearRampToValueAtTime(0.18, t0 + 0.02);
          gain.gain.exponentialRampToValueAtTime(0.0008, t0 + 0.35);
          osc.connect(gain);
          gain.connect(audioCtx.destination);
          osc.start(t0);
          osc.stop(t0 + 0.42);
        });
      } catch { /* audio unavailable — the notification still alerts */ }
    };

    applyState();
    observeCanvas(canvas, draw);

    if (interactive) {
      // Adopt this pack's cfg (durations) and read the live state in one call;
      // a running timer is left running, an idle one snaps to this focus length.
      svc.control('sync', cfg).then((res) => { if (res && res.ok && res.state) { st = res.state; applyState(); } });
      if (typeof svc.onChanged === 'function') {
        const off = svc.onChanged((msg) => {
          if (!msg || !msg.state) return;
          st = msg.state;
          breakMenu = false; // a state change from elsewhere closes an open choice
          applyState();
          if (msg.event === 'phase-end' && o.sound !== false) playChime(st.phase);
        });
        live.disposers.push(off);
      }
      // Tick the shown time down each second (the ring + MM:SS); the real end
      // moment is main's — we just render toward it and clamp at 00:00.
      live.timers.push(setInterval(() => { timeEl.textContent = fmt(remainingMs()); draw(); }, 1000));
      live.disposers.push(() => { if (audioCtx) { try { audioCtx.close(); } catch (e) { /* ignore */ } audioCtx = null; } });
    } else {
      // Static preview: a representative mid-focus frame so the box reads well on
      // the editor stage / library card without any live service.
      st = { phase: 'focus', running: false, endsAt: null, remainingMs: Math.round(o.focusMin * 60000 * 0.62), breakMin: null, queuedBreakMin: null, completedFocus: 1 };
      applyState();
    }
  }

  function buildAgenda(component, el) {
    const label = document.createElement('span');
    label.className = 'comp-label';
    label.textContent = component.options.label || 'Planner';
    const listEl = document.createElement('div');
    listEl.className = 'agenda';
    el.append(label, listEl);

    const dayTitle = (iso, todayIso, tomorrowIso) => {
      if (iso === todayIso) return 'Today';
      if (iso === tomorrowIso) return 'Tomorrow';
      const [y, m, d] = iso.split('-').map(Number);
      return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
    };

    const paint = async () => {
      if (!services.reminders) return;
      const today = new Date();
      const todayIso = localIso(today);
      const tomorrowIso = localIso(new Date(today.getTime() + 86400000));
      const horizonIso = localIso(new Date(today.getTime() + (component.options.days - 1) * 86400000));
      const res = await services.reminders({ from: todayIso, to: horizonIso });
      if (!res.ok) return;
      listEl.textContent = '';

      // Expanded occurrences put repeating events on each of their days.
      const entries = res.occurrences || res.reminders;
      const upcoming = entries.filter((r) => r.date >= todayIso && r.date <= horizonIso);

      if (upcoming.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'agenda-empty';
        empty.textContent = 'Nothing planned — add reminders in the manager.';
        listEl.appendChild(empty);
        return;
      }

      let shown = 0;
      let currentDay = null;
      for (const reminder of upcoming) {
        if (shown >= component.options.limit) break;
        if (reminder.date !== currentDay) {
          currentDay = reminder.date;
          const head = document.createElement('div');
          head.className = 'agenda-day display-case';
          head.textContent = dayTitle(reminder.date, todayIso, tomorrowIso);
          listEl.appendChild(head);
        }
        const item = document.createElement('div');
        item.className = `agenda-item${reminder.done ? ' done' : ''}`;
        const time = document.createElement('span');
        time.className = 'agenda-time';
        // Untimed repeating events show their repeat mark where the time goes.
        time.textContent = reminder.time || (reminder.repeat && reminder.repeat !== 'none' ? '↻' : '·');
        const text = document.createElement('span');
        text.className = 'agenda-text';
        text.textContent = reminder.text;
        item.append(time, text);
        listEl.appendChild(item);
        shown++;
      }
      const remaining = upcoming.length - shown;
      if (remaining > 0) {
        const more = document.createElement('div');
        more.className = 'agenda-empty';
        more.textContent = `+ ${remaining} more`;
        listEl.appendChild(more);
      }
    };
    paint();
    live.timers.push(setInterval(paint, 60 * 1000));
  }

  // Live Windows notifications (personal data; read in main). Fails soft:
  // shows how to grant access if the user hasn't, or an unavailable note.
  function buildNotifications(component, el) {
    // Clear buttons only where we can actually dismiss (the live desktop);
    // editor/manager previews render the sample feed read-only.
    const interactive = !!services.notificationsDismiss;
    const header = document.createElement('div');
    header.className = 'notif-header';
    const label = document.createElement('span');
    label.className = 'comp-label';
    label.textContent = component.options.label || 'Notifications';
    header.appendChild(label);
    const listEl = document.createElement('div');
    listEl.className = 'notif-feed';
    const clearAll = document.createElement('button');
    clearAll.type = 'button';
    clearAll.className = 'notif-clear-all';
    clearAll.textContent = 'Clear all';
    clearAll.hidden = true;
    if (interactive) {
      clearAll.addEventListener('click', async () => {
        listEl.textContent = '';
        clearAll.hidden = true;
        try { await services.notificationsDismiss({ all: true }); } catch (e) { /* fail soft */ }
        paint();
      });
      header.appendChild(clearAll);
    }
    el.append(header, listEl);

    const relTime = (iso) => {
      if (!iso) return '';
      const then = Date.parse(iso);
      if (Number.isNaN(then)) return '';
      const s = Math.max(0, (Date.now() - then) / 1000);
      if (s < 60) return 'just now';
      const m = Math.floor(s / 60);
      if (m < 60) return `${m}m ago`;
      const h = Math.floor(m / 60);
      if (h < 24) return `${h}h ago`;
      return `${Math.floor(h / 24)}d ago`;
    };

    const message = (text) => {
      if (interactive) clearAll.hidden = true;
      listEl.textContent = '';
      const msg = document.createElement('div');
      msg.className = 'notif-empty';
      msg.textContent = text;
      listEl.appendChild(msg);
    };

    const paint = async () => {
      if (!services.notifications) return;
      const res = await services.notifications();
      if (!res || !res.ok) return;
      if (!res.granted) {
        message(res.status === 'unsupported'
          ? 'System notifications need Windows.'
          : 'Allow notification access in Windows Settings › Privacy › Notifications.');
        return;
      }
      const items = res.notifications.slice(0, component.options.limit);
      if (items.length === 0) { message('No notifications.'); return; }
      if (interactive) clearAll.hidden = false;

      listEl.textContent = '';
      for (const n of items) {
        const item = document.createElement('div');
        item.className = 'notif-item';

        const head = document.createElement('div');
        head.className = 'notif-head';
        const app = document.createElement('span');
        app.className = 'notif-app display-case';
        app.textContent = component.options.showApp !== false && n.app ? n.app : '';
        const time = document.createElement('span');
        time.className = 'notif-time';
        time.textContent = relTime(n.time);
        head.append(app, time);
        if (interactive && n.id != null) {
          const x = document.createElement('button');
          x.type = 'button';
          x.className = 'notif-dismiss';
          x.textContent = '×';
          x.title = 'Dismiss';
          x.addEventListener('click', async (ev) => {
            ev.stopPropagation();
            item.remove();
            if (!listEl.querySelector('.notif-item')) message('No notifications.');
            try { await services.notificationsDismiss({ ids: [n.id] }); } catch (e) { /* fail soft */ }
          });
          head.append(x);
        }
        item.appendChild(head);

        if (n.title) {
          const title = document.createElement('div');
          title.className = 'notif-title';
          title.textContent = n.title;
          item.appendChild(title);
        }
        if (n.body) {
          const body = document.createElement('div');
          body.className = 'notif-body';
          body.textContent = n.body;
          item.appendChild(body);
        }
        listEl.appendChild(item);
      }
    };
    paint();
    live.timers.push(setInterval(paint, 20000));
  }

  // Assistant chat: an in-pack, self-contained AI console. The wallpaper shows
  // a compact prompt line; clicking it opens a PERSISTENT chat panel with the
  // full, scrollable conversation. The panel lives on <body> (not inside the
  // component tree) and is a renderer-scoped singleton, so it survives the
  // frequent pack re-renders that used to wipe the old inline log — and its
  // transcript is restored from main (persisted to disk) for real history.
  const chat = {
    panel: null, log: null, input: null, sendBtn: null,
    titleEl: null, sessionsPanel: null, sessionsList: null,
    built: false, busy: false, audioCtx: null, anchor: null, moved: false,
    stream: null, // { el, id, buf } for the reply currently streaming in
    sessions: [], activeId: null, sessionsOpen: false, // the local chat list
  };

  // ── Spoken replies: SENTENCE-STREAMING TTS ─────────────────────────────────
  // Instead of waiting for the whole reply and then synthesizing it, we detect
  // each sentence AS it streams in, synthesize it, and play the clips back-to-back.
  // The voice starts on sentence one while later sentences are still generating.
  // One reused AudioContext (the panel is built once) avoids a per-render leak.

  // Schedule a PCM clip to start exactly when the previous queued clip ends, so
  // sentences play in order, gaplessly, with no overlap (playCursor is the audio
  // time the next clip should begin; it never schedules in the past).
  // `speech` is passed in (never read from the module var) so a clip always belongs
  // to the reply that produced it — a newer reply can't hijack an in-flight clip.
  // We track every scheduled source on that reply so it can be stopped if superseded.
  const scheduleClip = (pcm, sampleRate, speech) => {
    try {
      if (!speech || speech.cancelled) return; // a newer reply took over — drop this clip
      if (!chat.audioCtx) chat.audioCtx = new AudioContext();
      const ctx = chat.audioCtx;
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      const int16 = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.byteLength >> 1);
      const floats = new Float32Array(int16.length);
      for (let i = 0; i < int16.length; i++) floats[i] = int16[i] / 32768;
      const buffer = ctx.createBuffer(1, floats.length, sampleRate);
      buffer.copyToChannel(floats, 0);
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(ctx.destination);
      const now = ctx.currentTime;
      const startAt = Math.max(now, speech.playCursor || now);
      src.start(startAt);
      speech.playCursor = startAt + buffer.duration;
      speech.sources.push(src);
      src.onended = () => { const i = speech.sources.indexOf(src); if (i >= 0) speech.sources.splice(i, 1); };
    } catch (err) { console.warn(`[assistant] playback: ${err.message}`); }
  };

  const resetSpeech = (speakOn) => {
    // A new reply supersedes any in-flight one: cancel its drain and STOP its
    // scheduled/playing audio so the two voices never overlap ("one voice at a
    // time"). The old drain checks `cancelled` and bails; unplayed clips are dropped.
    if (chat.speech) {
      chat.speech.cancelled = true;
      for (const s of chat.speech.sources) { try { s.stop(); } catch (e) { /* already ended */ } }
    }
    chat.speech = { spokenLen: 0, playCursor: 0, synthing: false, queue: [], speakOn: !!speakOn, cancelled: false, sources: [] };
  };

  // Synthesize queued sentences ONE at a time (serial: they finish in order and
  // schedule gaplessly). Bound to THIS reply's speech object so a superseding reply
  // (which sets cancelled) stops it cleanly instead of racing a second drain.
  const drainSpeech = async () => {
    const speech = chat.speech;
    if (!speech || speech.synthing) return;
    speech.synthing = true;
    try {
      while (speech && !speech.cancelled && speech.queue.length) {
        const sentence = speech.queue.shift();
        let spoken = null;
        try { spoken = await services.assistant.speak(sentence); } catch (e) { spoken = null; }
        if (speech.cancelled) break; // a newer reply took over while we were synthesizing
        if (spoken && spoken.ok && spoken.pcm) scheduleClip(spoken.pcm, spoken.sampleRate, speech);
      }
    } finally { speech.synthing = false; }
  };

  // Queue any complete sentences in `fullText` past what we've already spoken. When
  // `final`, queue everything remaining (the last sentence may lack terminal
  // punctuation). Main sanitizes (emoji/markdown/think) + synthesizes each chunk.
  const SENTENCE_END = /[.!?。！？…]+["'”’)\]]*(\s|$)/g;
  const feedSpeech = (fullText, final) => {
    if (!chat.speech || !chat.speech.speakOn || typeof fullText !== 'string') return;
    let cut;
    if (final) {
      cut = fullText.length;
    } else {
      const re = new RegExp(SENTENCE_END.source, 'g');
      re.lastIndex = chat.speech.spokenLen;
      let m, last = 0;
      while ((m = re.exec(fullText)) !== null) last = m.index + m[0].length;
      cut = last;
    }
    if (cut <= chat.speech.spokenLen) return;
    const chunk = fullText.slice(chat.speech.spokenLen, cut).trim();
    chat.speech.spokenLen = cut;
    if (chunk) { chat.speech.queue.push(chunk); drainSpeech(); }
  };

  const addChatMsg = (who, text) => {
    const m = document.createElement('div');
    m.className = `ac-msg ac-${who}`;
    m.textContent = text;
    chat.log.appendChild(m);
    chat.log.scrollTop = chat.log.scrollHeight;
    return m;
  };

  // ── Chat sessions (multiple local conversations) ────────────────────────────
  const relTimeShort = (ms) => {
    if (!ms) return '';
    const s = Math.max(0, (Date.now() - ms) / 1000);
    if (s < 60) return 'now';
    const m = Math.floor(s / 60); if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60); if (h < 24) return `${h}h`;
    return `${Math.floor(h / 24)}d`;
  };

  const setHeaderTitle = () => {
    if (!chat.titleEl) return;
    const active = chat.sessions.find((s) => s.id === chat.activeId);
    const label = (active && active.title) ? active.title : 'New chat';
    chat.titleEl.textContent = label;
    chat.titleEl.title = label;
  };

  const paintThread = (thread) => {
    chat.log.textContent = '';
    if (!Array.isArray(thread) || thread.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'ac-empty';
      empty.textContent = 'No conversation yet — ask me anything.';
      chat.log.appendChild(empty);
      return;
    }
    for (const m of thread) addChatMsg(m.role === 'user' ? 'you' : 'bot', m.content);
    chat.log.scrollTop = chat.log.scrollHeight;
  };

  const closeSessions = () => {
    chat.sessionsOpen = false;
    if (chat.sessionsPanel) chat.sessionsPanel.classList.remove('open');
  };

  const switchSession = async (id) => {
    if (id === chat.activeId) { closeSessions(); return; }
    const res = await services.assistant.sessionSwitch(id);
    applySessions(res);
    paintThread(res && res.thread);
    closeSessions();
    chat.input.focus();
  };

  const newChatSession = async () => {
    const res = await services.assistant.sessionNew();
    applySessions(res);
    paintThread(res && res.thread); // a fresh, empty chat
    closeSessions();
    chat.input.focus();
  };

  const deleteSession = async (id) => {
    const res = await services.assistant.sessionDelete(id);
    applySessions(res);
    paintThread(res && res.thread); // active may have changed
  };

  const startRename = (row, s) => {
    const input = document.createElement('input');
    input.className = 'ac-sess-rename';
    input.type = 'text';
    input.value = s.title || '';
    input.maxLength = 60;
    input.placeholder = 'Name this chat';
    let done = false;
    const commit = async (save) => {
      if (done) return; done = true;
      const val = input.value.trim();
      if (save && val) applySessions(await services.assistant.sessionRename(s.id, val));
      else renderSessions();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); commit(true); }
      else if (e.key === 'Escape') { e.preventDefault(); commit(false); }
    });
    input.addEventListener('blur', () => commit(true));
    row.textContent = '';
    row.appendChild(input);
    input.focus();
    input.select();
  };

  const renderSessions = () => {
    if (!chat.sessionsList) return;
    chat.sessionsList.textContent = '';
    for (const s of chat.sessions) {
      const row = document.createElement('div');
      row.className = `ac-sess${s.id === chat.activeId ? ' active' : ''}`;
      const name = document.createElement('button');
      name.type = 'button';
      name.className = 'ac-sess-name';
      name.textContent = s.title || 'New chat';
      name.title = s.title || 'New chat';
      name.addEventListener('click', () => switchSession(s.id));
      const time = document.createElement('span');
      time.className = 'ac-sess-time';
      time.textContent = relTimeShort(s.updatedAt);
      const ren = document.createElement('button');
      ren.type = 'button'; ren.className = 'ac-sess-act'; ren.textContent = '✎'; ren.title = 'Rename';
      ren.addEventListener('click', (e) => { e.stopPropagation(); startRename(row, s); });
      const del = document.createElement('button');
      del.type = 'button'; del.className = 'ac-sess-act'; del.textContent = '×'; del.title = 'Delete';
      del.addEventListener('click', (e) => { e.stopPropagation(); deleteSession(s.id); });
      row.append(name, time, ren, del);
      chat.sessionsList.appendChild(row);
    }
  };

  // Adopt a {sessions, activeId} payload (from history() or any session op).
  function applySessions(res) {
    if (!res || !res.ok) return;
    if (Array.isArray(res.sessions)) chat.sessions = res.sessions;
    if (typeof res.activeId === 'string') chat.activeId = res.activeId;
    setHeaderTitle();
    renderSessions();
  }

  // Repaint the panel from main's saved transcript + session list (one call).
  const renderChatHistory = async () => {
    if (services.assistant.history) {
      const res = await services.assistant.history();
      if (res && res.ok) { applySessions(res); paintThread(res.thread); return; }
    }
    paintThread([]);
  };

  const chatSend = async () => {
    const text = chat.input.value.trim();
    if (text === '' || chat.busy) return;
    chat.input.value = '';
    chat.busy = true;
    chat.sendBtn.disabled = true;
    // Drop the "nothing yet" hint on the first message.
    const hint = chat.log.querySelector('.ac-empty');
    if (hint) hint.remove();
    addChatMsg('you', text);
    const reply = addChatMsg('bot', '…');
    // Tokens streamed from main (via onStream) append here while we await; the
    // resolved result is authoritative and reconciles any streaming artifact.
    chat.stream = { el: reply, id: null, buf: '' };
    // Learn up-front whether to speak, so the stream handler can synth each sentence
    // AS it arrives (the voice starts on sentence one instead of after the whole
    // reply + full synth).
    let speakOn = false;
    try { const c = await services.assistant.config(); speakOn = !!(c && c.ok && c.config.speak); } catch (e) { /* default: silent */ }
    resetSpeech(speakOn);
    const res = await services.assistant.ask(text);
    chat.stream = null;
    if (!res || !res.ok) {
      reply.textContent = (res && res.error) || 'Something went wrong.';
      reply.classList.add('ac-err');
    } else {
      reply.textContent = res.text;
      chat.log.scrollTop = chat.log.scrollHeight;
      // The active session may have just been auto-titled from this first message.
      if (services.assistant.sessions) services.assistant.sessions().then(applySessions);
      // Speak whatever hasn't been spoken yet: the trailing sentence(s) after a
      // stream, or (for an endpoint that didn't stream) the whole reply now. Use
      // res.text — the AUTHORITATIVE full reply — NOT the stream buffer: the stream
      // delta events can lag behind this resolution and drop the tail, which
      // truncated the SPOKEN reply mid-sentence even though the displayed text was
      // complete. spokenLen (a sentence-boundary index into the identical streamed
      // prefix) makes this speak only the still-unspoken tail, never a repeat.
      if (speakOn) feedSpeech(res.text, true);
    }
    chat.busy = false;
    chat.sendBtn.disabled = false;
    chat.input.focus();
  };

  const closeChatPanel = () => {
    if (chat.panel) chat.panel.classList.remove('open');
  };

  // Anchor the panel to the console line, growing upward; flip below / clamp to
  // the viewport so the conversation is never clipped or off-screen.
  const positionChatPanel = () => {
    if (!chat.anchor || !document.body.contains(chat.anchor)) return;
    const rect = chat.anchor.getBoundingClientRect();
    const pw = chat.panel.offsetWidth;
    const ph = chat.panel.offsetHeight;
    const margin = 12;
    let left = rect.left + rect.width / 2 - pw / 2;
    left = Math.max(margin, Math.min(left, window.innerWidth - pw - margin));
    let top = rect.top - ph - 8;
    if (top < margin) top = Math.min(rect.bottom + 8, window.innerHeight - ph - margin);
    if (top < margin) top = margin;
    chat.panel.style.left = `${Math.round(left)}px`;
    chat.panel.style.top = `${Math.round(top)}px`;
  };

  const ensureChatPanel = () => {
    if (chat.built) return;
    const panel = document.createElement('div');
    panel.className = 'ac-panel skin-root';

    const head = document.createElement('div');
    head.className = 'ac-panel-head';
    const sessionsBtn = document.createElement('button');
    sessionsBtn.type = 'button';
    sessionsBtn.className = 'ac-panel-sessions-btn';
    sessionsBtn.textContent = '☰';
    sessionsBtn.title = 'Chats';
    const title = document.createElement('span');
    title.className = 'ac-panel-title';
    title.textContent = 'Assistant';
    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.className = 'ac-panel-clear';
    clearBtn.textContent = 'Clear';
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'ac-panel-close';
    closeBtn.textContent = '×';
    head.append(sessionsBtn, title, clearBtn, closeBtn);

    // Chat switcher: a compact dropdown of local conversations, overlaying the log.
    const sessionsPanel = document.createElement('div');
    sessionsPanel.className = 'ac-sessions';
    const newBtn = document.createElement('button');
    newBtn.type = 'button';
    newBtn.className = 'ac-sessions-new';
    newBtn.textContent = '+ New chat';
    const sessionsList = document.createElement('div');
    sessionsList.className = 'ac-sessions-list';
    sessionsPanel.append(newBtn, sessionsList);

    const log = document.createElement('div');
    log.className = 'ac-panel-log';

    const form = document.createElement('form');
    form.className = 'ac-panel-form';
    const mark = document.createElement('span');
    mark.className = 'ac-mark';
    mark.textContent = '❯';
    const input = document.createElement('input');
    input.className = 'ac-panel-input';
    input.type = 'text';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.placeholder = 'Ask anything, or give me a task on this machine…';
    const sendBtn = document.createElement('button');
    sendBtn.type = 'submit';
    sendBtn.className = 'ac-panel-send display-case';
    sendBtn.textContent = 'Send';
    form.append(mark, input, sendBtn);

    panel.append(head, sessionsPanel, log, form);
    document.body.appendChild(panel);
    chat.panel = panel; chat.log = log; chat.input = input; chat.sendBtn = sendBtn;
    chat.titleEl = title; chat.sessionsPanel = sessionsPanel; chat.sessionsList = sessionsList;
    chat.built = true;

    form.addEventListener('submit', (e) => { e.preventDefault(); chatSend(); });
    input.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeChatPanel(); });
    closeBtn.addEventListener('click', closeChatPanel);
    clearBtn.addEventListener('click', async () => {
      await services.assistant.reset();
      await renderChatHistory();
      chat.input.focus();
    });
    // Sessions: toggle the switcher; new-chat; close it on a click elsewhere.
    sessionsBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      chat.sessionsOpen = !chat.sessionsOpen;
      sessionsPanel.classList.toggle('open', chat.sessionsOpen);
      if (chat.sessionsOpen) renderSessions();
    });
    newBtn.addEventListener('click', () => newChatSession());
    panel.addEventListener('mousedown', (e) => {
      if (chat.sessionsOpen && !sessionsPanel.contains(e.target) && e.target !== sessionsBtn) closeSessions();
    });
    // Dismiss on an outside click (but not on any assistant console trigger).
    document.addEventListener('mousedown', (e) => {
      if (chat.panel.classList.contains('open')
        && !chat.panel.contains(e.target) && !e.target.closest('.assistant-console')) {
        closeChatPanel();
      }
    }, true);

    // Draggable by its header. Grabbing a header button (Clear/×) doesn't drag.
    // Once moved, the panel keeps that spot instead of snapping back to the
    // console on the next open.
    let drag = null;
    head.addEventListener('mousedown', (e) => {
      if (e.target.closest('button')) return;
      const rect = panel.getBoundingClientRect();
      drag = { dx: e.clientX - rect.left, dy: e.clientY - rect.top };
      e.preventDefault(); // don't select the header text while dragging
    });
    document.addEventListener('mousemove', (e) => {
      if (!drag) return;
      const margin = 8;
      let left = e.clientX - drag.dx;
      let top = e.clientY - drag.dy;
      left = Math.max(margin, Math.min(left, window.innerWidth - panel.offsetWidth - margin));
      top = Math.max(margin, Math.min(top, window.innerHeight - panel.offsetHeight - margin));
      panel.style.left = `${Math.round(left)}px`;
      panel.style.top = `${Math.round(top)}px`;
      chat.moved = true;
    });
    document.addEventListener('mouseup', () => { drag = null; });

    // Live reply streaming: append tokens to the pending bot bubble as they
    // arrive from main. The panel enforces single-in-flight (input disabled
    // while busy), so any delta belongs to the current reply; the id is a
    // belt-and-braces guard against a stale one.
    if (services.assistant && services.assistant.onStream) {
      services.assistant.onStream((msg) => {
        if (!msg || !chat.stream) return;
        if (msg.start) { if (chat.stream.id == null) chat.stream.id = msg.id; return; }
        if (chat.stream.id != null && msg.id != null && msg.id !== chat.stream.id) return;
        if (typeof msg.delta === 'string' && msg.delta) {
          chat.stream.buf += msg.delta;
          // Trim only leading whitespace (a stripped leading <think> leaves a
          // space); interior text streams verbatim. `done` sets the trimmed final.
          chat.stream.el.textContent = chat.stream.buf.replace(/^\s+/, '');
          chat.log.scrollTop = chat.log.scrollHeight;
          // Speak each sentence the moment it completes (no-op when speak is off).
          feedSpeech(chat.stream.buf, false);
        }
      });
    }
    // Deliberately NO live.disposer: the panel is a persistent singleton that
    // must outlive component re-renders (that's what keeps the chat from
    // vanishing). It's rebuilt only if the whole window reloads.
  };

  const openChatPanel = async (component, anchor) => {
    ensureChatPanel();
    chat.anchor = anchor;
    if (component.options.label) chat.input.placeholder = component.options.label;
    chat.panel.classList.add('open');
    // Start loading a local model NOW (while the user reads/types) so the first
    // reply isn't a cold start. No-op for hosted endpoints; fully fail-soft.
    if (services.assistant && services.assistant.warmup) services.assistant.warmup('open').catch(() => {}); // main skips this at Low speed
    // Anchor to the console on first open; once the user has dragged it, respect
    // where they put it. (The panel is a fixed size now, so no re-clamp needed.)
    if (!chat.moved) positionChatPanel();
    await renderChatHistory();
    chat.input.focus();
  };

  // Assistant console: the always-visible prompt line on the wallpaper. It's a
  // trigger — clicking it opens the chat panel above. In the editor/manager
  // preview there's no `services.assistant`, so it stays a static prompt line.
  function buildAssistant(component, el) {
    el.classList.add('assistant-console');
    const interactive = !!(services.assistant && services.assistant.ask);

    const row = document.createElement('div');
    row.className = 'ac-row';
    const mark = document.createElement('span');
    mark.className = 'ac-mark';
    mark.textContent = '❯';
    const prompt = document.createElement('span');
    prompt.className = 'ac-prompt';
    prompt.textContent = component.options.label || 'Ask anything, or give me a task on this machine…';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ac-btn display-case';
    btn.textContent = component.options.button || 'Execute';
    row.append(mark, prompt, btn);
    el.append(row);

    if (!interactive) { el.classList.add('ac-inert'); return; }

    el.classList.add('ac-trigger');
    row.addEventListener('click', () => openChatPanel(component, row));
    // Warm the local model NOW — its cold load (~1 GB) takes tens of seconds on a
    // modest machine, so starting it when the assistant first appears (long before
    // the user opens the chat) hides the load instead of racing the first message.
    // Debounced against frequent re-renders; the panel-open warm is the backstop.
    if (services.assistant.warmup && Date.now() - lastAssistantWarmAt > ASSISTANT_WARM_DEBOUNCE_MS) {
      lastAssistantWarmAt = Date.now();
      services.assistant.warmup('render').catch(() => {}); // main only acts on this at High speed
    }
  }

  // Per-app volume mixer (Windows Core Audio). A master slider + one row per app
  // currently using audio — icon, name, volume slider, mute — adjustable live,
  // the same control the Windows Volume Mixer / Win+G buries. Interactive only on
  // the desktop (services.audio); editor/manager previews show a static sample.
  function buildMixer(component, el) {
    const o = component.options;
    const svc = services.audio;
    const interactive = !!(svc && typeof svc.set === 'function');
    const showMaster = o.showMaster !== false;

    const label = document.createElement('span');
    label.className = 'comp-label';
    label.textContent = o.label || 'Volume';
    const list = document.createElement('div');
    list.className = 'mixer-list';
    el.append(label, list);

    const rows = new Map();   // id -> { root, iconWrap, name, slider, mute, dragging }
    let draggingId = null;    // don't rebuild the row a user is actively dragging
    let pending = null;       // a snapshot that arrived mid-drag, applied on release
    // A row stays "sticky" to the user's own value for a moment after they touch
    // it, so the ~1.2 s enumeration poll (which may still report the pre-change
    // value, in flight when the SET landed) can't rubberband the slider back.
    const recentSet = new Map(); // id -> last user-interaction timestamp
    const GRACE_MS = 1600;       // longer than the poll interval + SET-apply latency
    const touch = (id) => recentSet.set(id, Date.now());
    const locked = (h, id) => h.dragging || (Date.now() - (recentSet.get(id) || 0) < GRACE_MS);

    // Throttle the live SET during a drag (drag fires ~60/s; the daemon SET is a
    // COM call). The exact final value is always sent again on release.
    const throttle = (fn, ms) => {
      let t = 0, timer = null, lastArgs = null;
      return (...args) => {
        lastArgs = args;
        const now = Date.now();
        if (now - t >= ms) { t = now; fn(...args); }
        else if (!timer) { timer = setTimeout(() => { timer = null; t = Date.now(); fn(...lastArgs); }, ms - (now - t)); }
      };
    };
    const sendVol = interactive ? throttle((id, v) => svc.set(id, { volume: v }), 60) : () => {};

    const makeRow = (item) => {
      const root = document.createElement('div');
      root.className = 'mixer-row';
      const iconWrap = document.createElement('span');
      iconWrap.className = 'mixer-icon';
      const name = document.createElement('span');
      name.className = 'mixer-name';
      const slider = document.createElement('input');
      slider.type = 'range'; slider.min = '0'; slider.max = '100'; slider.className = 'mixer-slider';
      const mute = document.createElement('button');
      mute.type = 'button'; mute.className = 'mixer-mute';
      root.append(iconWrap, name, slider, mute);
      const h = { root, iconWrap, name, slider, mute, dragging: false };

      if (interactive) {
        const endDrag = () => {
          if (!h.dragging) return;
          h.dragging = false; draggingId = null;
          touch(item.id);
          svc.set(item.id, { volume: Number(slider.value) });
          if (pending) { const p = pending; pending = null; paint(p); } // updateRow keeps this row sticky
        };
        slider.addEventListener('pointerdown', () => { h.dragging = true; draggingId = item.id; touch(item.id); });
        slider.addEventListener('pointerup', endDrag);
        slider.addEventListener('pointercancel', endDrag);
        slider.addEventListener('input', () => { touch(item.id); slider.style.setProperty('--fill', `${slider.value}%`); sendVol(item.id, Number(slider.value)); });
        mute.addEventListener('click', () => {
          const next = !root.classList.contains('muted');
          touch(item.id);
          root.classList.toggle('muted', next);           // optimistic; next poll confirms
          mute.textContent = next ? '🔇' : '🔊';
          svc.set(item.id, { muted: next });
        });
      } else {
        slider.disabled = true; mute.disabled = true;
      }
      return h;
    };

    const updateRow = (h, item) => {
      h.name.textContent = item.name;
      h.name.title = item.name;
      if (item.icon) {
        h.iconWrap.style.backgroundImage = `url("${item.icon}")`;
        h.iconWrap.classList.add('has-img');
        h.iconWrap.textContent = '';
      } else {
        h.iconWrap.classList.remove('has-img');
        h.iconWrap.style.backgroundImage = '';
        h.iconWrap.textContent = item.system ? '🔔' : '🔊';
      }
      // While the user is dragging (or just did), keep THEIR value/mute — only an
      // untouched row follows the incoming snapshot. The --fill always tracks
      // whatever value is actually shown.
      if (!locked(h, item.id)) {
        h.slider.value = String(item.volume);
        h.root.classList.toggle('muted', !!item.muted);
        h.mute.textContent = item.muted ? '🔇' : '🔊';
      }
      h.slider.style.setProperty('--fill', `${h.slider.value}%`);
    };

    const itemsFrom = (state) => {
      const items = [];
      if (showMaster && state.master) {
        items.push({ id: 'master', name: 'System volume', icon: null, master: true, volume: state.master.volume, muted: state.master.muted });
      }
      for (const s of state.sessions || []) {
        items.push({ id: s.id, name: s.name || 'App', icon: s.icon || null, system: s.system, volume: s.volume, muted: s.muted });
      }
      return items;
    };

    const note = document.createElement('p');
    note.className = 'mixer-empty';

    function paint(state) {
      if (!state || state.ok !== true) {
        for (const [, h] of rows) h.root.remove();
        rows.clear();
        note.textContent = interactive ? 'Connecting to audio…' : 'Per-app volume (Windows).';
        list.appendChild(note);
        return;
      }
      const savedScroll = list.scrollTop; // preserve the user's scroll across updates
      const items = itemsFrom(state);
      const wantIds = new Set(items.map((i) => i.id));
      for (const [id, h] of rows) {
        if (!wantIds.has(id) && id !== draggingId) { h.root.remove(); rows.delete(id); }
      }
      if (note.parentNode) note.remove(); // repositioned below; keeps child indexing clean
      let anyApp = false;
      items.forEach((item, i) => {
        if (!item.master) anyApp = true;
        let h = rows.get(item.id);
        if (!h) { h = makeRow(item); rows.set(item.id, h); }
        updateRow(h, item);
        // Only move a row when it isn't already in its slot. Re-appending an
        // already-correct row on every ~1.2 s poll reset the list's scrollTop —
        // that's the "drag a lower slider and it jumps to the top" bug.
        if (list.children[i] !== h.root) list.insertBefore(h.root, list.children[i] || null);
      });
      if (!anyApp) { note.textContent = 'No apps are playing audio.'; list.appendChild(note); }
      list.scrollTop = savedScroll; // restore (e.g. when a new app row grows the list)
    }

    const onState = (state) => {
      if (draggingId) { pending = state; return; } // never rebuild mid-drag
      paint(state);
    };

    if (interactive) {
      svc.state().then((s) => onState(s));
      live.disposers.push(svc.onChange((s) => onState(s)));
    } else {
      // Static preview (no service): a master + a couple of apps.
      paint({ ok: true, master: { volume: 80, muted: false }, sessions: [
        { id: '1', name: 'Spotify', icon: null, system: false, volume: 65, muted: false },
        { id: '2', name: 'Chrome', icon: null, system: false, volume: 45, muted: false },
        { id: 'system', name: 'System sounds', icon: null, system: true, volume: 100, muted: true },
      ] });
    }
  }

  // Now playing (Windows media session — Spotify, a browser, any player). Album
  // art + title/artist + a progress bar + transport controls. Live only on the
  // desktop (services.media); editor/manager previews show a static placeholder.
  function buildNowPlaying(component, el) {
    el.classList.add('nowplaying');
    const o = component.options;
    const liveMedia = !!(services.media && services.media.state);

    const art = document.createElement('div');
    art.className = 'np-art np-noart';
    const info = document.createElement('div');
    info.className = 'np-info';
    const title = document.createElement('div');
    title.className = 'np-title';
    const artist = document.createElement('div');
    artist.className = 'np-artist';
    const bar = document.createElement('div');
    bar.className = 'np-bar';
    const fill = document.createElement('div');
    fill.className = 'np-fill';
    bar.appendChild(fill);
    info.append(title, artist, bar);

    const controls = document.createElement('div');
    controls.className = 'np-controls';
    const mkBtn = (cls, glyph, action) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `np-btn ${cls}`;
      b.textContent = glyph;
      if (liveMedia) b.addEventListener('click', () => services.media.control(action));
      return b;
    };
    const prevBtn = mkBtn('np-prev', '⏮', 'previous');
    const playBtn = mkBtn('np-play', '▶', 'playpause');
    const nextBtn = mkBtn('np-next', '⏭', 'next');
    controls.append(prevBtn, playBtn, nextBtn);

    if (o.showArt !== false) el.appendChild(art);
    el.appendChild(info);
    if (o.showControls !== false) el.appendChild(controls);

    if (!liveMedia) { // preview: static placeholder
      el.classList.add('np-inert');
      title.textContent = o.label || 'Now Playing';
      artist.textContent = 'nothing playing';
      for (const b of [prevBtn, playBtn, nextBtn]) b.disabled = true;
      return;
    }

    const base = { posMs: 0, durMs: 0, updated: Date.now(), status: 'stopped' };
    let hasMedia = false;

    const paintMeta = (s) => {
      hasMedia = !!(s && s.has);
      if (!hasMedia) {
        title.textContent = o.label || 'Now Playing';
        artist.textContent = 'nothing playing';
        art.className = 'np-art np-noart';
        art.style.backgroundImage = '';
        playBtn.textContent = '▶';
        for (const b of [prevBtn, playBtn, nextBtn]) b.disabled = true;
        base.durMs = 0;
        fill.style.width = '0%';
        return;
      }
      title.textContent = s.title || 'Unknown';
      artist.textContent = s.artist || '';
      if (o.showArt !== false) {
        if (s.art) {
          // SMTC thumbnails are PNG or JPEG; sniff from the base64 header.
          const mime = String(s.art).startsWith('iVBOR') ? 'image/png' : 'image/jpeg';
          art.className = 'np-art';
          art.style.backgroundImage = `url(data:${mime};base64,${s.art})`;
        } else {
          art.className = 'np-art np-noart';
          art.style.backgroundImage = '';
        }
      }
      playBtn.textContent = s.status === 'playing' ? '⏸' : '▶';
      prevBtn.disabled = !s.canPrev;
      nextBtn.disabled = !s.canNext;
      playBtn.disabled = !s.canPause;
      base.posMs = Number(s.posMs) || 0;
      base.durMs = Number(s.durMs) || 0;
      base.updated = Number(s.updated) || Date.now();
      base.status = s.status;
    };

    // Advance the progress bar between metadata pushes (main only re-emits on a
    // change + a periodic resync), so it moves smoothly while playing.
    const tickProgress = () => {
      if (!hasMedia || !base.durMs) { fill.style.width = '0%'; return; }
      const pos = base.status === 'playing' ? base.posMs + (Date.now() - base.updated) : base.posMs;
      fill.style.width = `${Math.max(0, Math.min(100, (pos / base.durMs) * 100))}%`;
    };

    services.media.state().then((res) => { if (res && res.ok) paintMeta(res.media); tickProgress(); });
    const off = services.media.onChange((s) => { paintMeta(s); tickProgress(); });
    live.disposers.push(off);
    live.timers.push(setInterval(tickProgress, 500));
  }

  // ── Audio visualizer (system-audio loopback) ───────────────────────────────
  // One shared capture → AnalyserNode drives every `visualizer` component. The
  // stream comes from getDisplayMedia({audio:'loopback'}) — main grants system
  // audio ONLY to this desktop top-frame (never a module). Fail-soft: if capture
  // is unavailable/denied, the component shows a quiet idle pattern, never an
  // error. Renderer-scoped singleton so multiple visualizers share one stream.
  const viz = {
    ctx: null, analyser: null, stream: null, freq: null, time: null,
    requested: false, ready: false, armed: false, raf: 0, drawers: new Set(),
  };

  async function vizGetLoopbackStream() {
    // Request video too — Chromium requires it for getDisplayMedia to resolve —
    // then stop the video track; main pairs a screen source with loopback audio.
    const stream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
    stream.getVideoTracks().forEach((t) => t.stop());
    return stream;
  }

  async function vizAcquire() {
    if (viz.ready) return true;
    if (viz.requested) return false;
    viz.requested = true;
    try {
      const stream = await vizGetLoopbackStream();
      if (stream.getAudioTracks().length === 0) throw new Error('no audio track granted');
      const ctx = new AudioContext();
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.82;
      source.connect(analyser);
      viz.ctx = ctx;
      viz.analyser = analyser;
      viz.stream = stream;
      viz.freq = new Uint8Array(analyser.frequencyBinCount);
      viz.time = new Uint8Array(analyser.fftSize);
      viz.ready = true;
      return true;
    } catch (err) {
      viz.requested = false; // allow a gesture-triggered retry
      console.warn(`[visualizer] system audio capture unavailable: ${err && err.message}`);
      return false;
    }
  }

  function vizStartLoop() {
    if (viz.raf) return;
    const loop = () => {
      viz.raf = requestAnimationFrame(loop);
      if (!viz.ready || viz.drawers.size === 0) return;
      viz.analyser.getByteFrequencyData(viz.freq);
      viz.analyser.getByteTimeDomainData(viz.time);
      for (const d of viz.drawers) { try { d(viz.freq, viz.time); } catch (e) { /* one bad drawer won't stop the rest */ } }
    };
    viz.raf = requestAnimationFrame(loop);
  }
  function vizStopLoop() { if (viz.raf) { cancelAnimationFrame(viz.raf); viz.raf = 0; } }

  // Marketing/trailer capture ONLY: drive every visualizer with synthetic "music"
  // so a captured beat shows them reacting, without live system audio (which an
  // offscreen render can't get). Guarded by window.__vizSynthetic, which only the
  // trailer tooling (trailer-dash.js) ever sets — production never runs this.
  function vizStartSyntheticLoop() {
    if (viz.raf) return;
    const t0 = (window.performance && performance.now()) || 0;
    const freq = new Uint8Array(256), time = new Uint8Array(512);
    const loop = () => {
      viz.raf = requestAnimationFrame(loop);
      if (viz.drawers.size === 0) return;
      const t = (((window.performance && performance.now()) || 0) - t0) / 1000;
      const kick = Math.pow(0.5 + 0.5 * Math.sin(t * Math.PI * 2 * 1.9), 4); // ~2 Hz beat
      // Several travelling "formants" so the whole spectrum dances (not just bass),
      // with only a mild high-frequency rolloff so the right of the bars stays lively.
      for (let i = 0; i < 256; i++) {
        const v = 0.5 * Math.sin(i * 0.05 - t * 4) + 0.3 * Math.sin(i * 0.13 + t * 2.5) + 0.2 * Math.sin(i * 0.31 - t * 6);
        const amp = (0.55 + 0.45 * v) * (0.6 + 0.4 * kick) * (1 - 0.32 * (i / 256));
        freq[i] = Math.max(6, Math.min(255, 34 + 224 * amp));
      }
      for (let i = 0; i < 512; i++) {
        const x = i / 511;
        const w = Math.sin(x * Math.PI * 5 + t * 7) + 0.4 * Math.sin(x * Math.PI * 11 - t * 5);
        time[i] = 128 + 72 * w * (0.5 + 0.5 * kick);
      }
      for (const d of viz.drawers) { try { d(freq, time); } catch (e) { /* one bad drawer won't stop the rest */ } }
    };
    viz.raf = requestAnimationFrame(loop);
  }

  function vizEnsureRunning() {
    vizAcquire().then((ok) => {
      if (ok) {
        if (viz.ctx.state === 'suspended') viz.ctx.resume().catch(() => {});
        vizStartLoop();
        return;
      }
      // getDisplayMedia often needs a user gesture — retry on first interaction.
      if (viz.armed) return;
      viz.armed = true;
      const start = () => {
        document.removeEventListener('pointerdown', start);
        document.removeEventListener('keydown', start);
        vizEnsureRunning();
      };
      document.addEventListener('pointerdown', start);
      document.addEventListener('keydown', start);
    });
  }

  // Register a per-frame drawer; returns an unregister fn. When the last drawer
  // leaves (freeze / re-render), the loop stops and capture is suspended.
  function vizAddDrawer(fn) {
    viz.drawers.add(fn);
    if (window.__vizSynthetic) vizStartSyntheticLoop(); // trailer capture only
    else vizEnsureRunning();
    return () => {
      viz.drawers.delete(fn);
      // Only stop the DRAW loop when nothing's on screen — keep the audio graph
      // running. Suspending/resuming a MediaStream-fed AudioContext on every
      // re-render (a style change + save does that) desyncs the analyser and,
      // under fast repeated saves, races itself into a stuck state (needed a
      // full reload to recover). An idle analyser on a stream is ~0 CPU.
      if (viz.drawers.size === 0) vizStopLoop();
    };
  }

  const VIZ_IDLE_FREQ = new Uint8Array(256).fill(5);
  const VIZ_IDLE_TIME = new Uint8Array(512).fill(128);

  function buildVisualizer(component, el) {
    const style = ['bars', 'waveform', 'radial', 'bloom'].includes(component.options.style)
      ? component.options.style : 'bars';
    el.classList.add('visualizer', `viz-${style}`);
    const canvas = document.createElement('canvas');
    canvas.className = 'fill-canvas';
    el.appendChild(canvas);

    const reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const desktop = !!services.media; // live capture only on the desktop surface

    const draw = (freq, time) => {
      const ctx2 = canvas.getContext('2d');
      const W = canvas.width, H = canvas.height;
      if (W <= 0 || H <= 0) return;
      ctx2.clearRect(0, 0, W, H);
      const accent = cssVar(el, '--accent');
      const bright = cssVar(el, '--accent-bright');
      const dpr = devicePixelRatio;

      if (style === 'waveform') {
        ctx2.beginPath();
        ctx2.lineWidth = Math.max(1, 1.6 * dpr);
        ctx2.strokeStyle = bright;
        for (let i = 0; i < time.length; i++) {
          const x = (i / (time.length - 1)) * W;
          const y = (time[i] / 255) * H;
          if (i === 0) ctx2.moveTo(x, y); else ctx2.lineTo(x, y);
        }
        ctx2.stroke();
      } else if (style === 'radial') {
        const cx = W / 2, cy = H / 2, R = Math.min(W, H) / 2 * 0.5;
        const n = 64, step = Math.floor(freq.length / n) || 1;
        ctx2.strokeStyle = accent;
        ctx2.lineWidth = Math.max(1, 2 * dpr);
        for (let i = 0; i < n; i++) {
          const len = ((freq[i * step] || 0) / 255) * R * 0.95;
          const a = (i / n) * Math.PI * 2 - Math.PI / 2;
          ctx2.globalAlpha = 0.85;
          ctx2.beginPath();
          ctx2.moveTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R);
          ctx2.lineTo(cx + Math.cos(a) * (R + len), cy + Math.sin(a) * (R + len));
          ctx2.stroke();
        }
        ctx2.globalAlpha = 1;
      } else if (style === 'bloom') {
        // Overall energy → a soft radial glow that pulses. Reads well full-bleed
        // behind other components as a reactive "ambience".
        let sum = 0;
        for (let i = 0; i < freq.length; i++) sum += freq[i];
        const energy = sum / (freq.length * 255);
        const cx = W / 2, cy = H / 2;
        const g = ctx2.createRadialGradient(cx, cy, 0, cx, cy, Math.min(W, H) * (0.2 + energy * 0.55));
        g.addColorStop(0, bright);
        g.addColorStop(0.55, accent);
        g.addColorStop(1, 'transparent');
        ctx2.globalAlpha = 0.2 + energy * 0.55;
        ctx2.fillStyle = g;
        ctx2.fillRect(0, 0, W, H);
        ctx2.globalAlpha = 1;
      } else { // bars
        const n = 48, step = Math.floor(freq.length / n) || 1, bw = W / n;
        ctx2.fillStyle = accent;
        for (let i = 0; i < n; i++) {
          let v = 0;
          for (let j = 0; j < step; j++) v += freq[i * step + j] || 0;
          v /= step;
          const bh = (v / 255) * H * 0.94;
          ctx2.globalAlpha = 0.85;
          ctx2.fillRect(i * bw + bw * 0.15, H - bh, bw * 0.7, Math.max(bh, dpr));
        }
        ctx2.globalAlpha = 1;
      }
    };

    // Resize keeps the canvas crisp; on resize (and in the static case) draw a
    // quiet idle frame — the live loop overwrites it each frame when running.
    observeCanvas(canvas, () => draw(VIZ_IDLE_FREQ, VIZ_IDLE_TIME));

    // Reduced-motion or non-desktop (editor/manager preview): no capture, no
    // animation — just the static idle pattern.
    if (reduced || !desktop) { draw(VIZ_IDLE_FREQ, VIZ_IDLE_TIME); return; }
    live.disposers.push(vizAddDrawer(draw));
  }

  function buildCountdown(component, el) {
    const label = document.createElement('span');
    label.className = 'comp-label';
    label.textContent = component.options.label || 'Countdown';
    const value = document.createElement('div');
    value.className = 'clock-time countdown-value';
    const sub = document.createElement('div');
    sub.className = 'clock-date';
    el.append(label, value, sub);

    // A missing target must NOT parse to a real time. `new Date(null)` is the
    // epoch (0), not Invalid Date, so the old NaN guard never fired and a fresh
    // countdown read "NOW" forever. Map unset/blank to NaN explicitly.
    const raw = component.options.target;
    const target = (raw === undefined || raw === null || raw === '')
      ? NaN : new Date(raw).getTime();
    const tick = () => {
      if (!Number.isFinite(target)) {
        value.textContent = '—';
        sub.textContent = 'no date set';
        return;
      }
      const diff = target - Date.now();
      if (diff <= 0) {
        value.textContent = 'NOW';
        sub.textContent = '';
        return;
      }
      const days = Math.floor(diff / 86400000);
      const hours = Math.floor((diff % 86400000) / 3600000);
      const mins = Math.floor((diff % 3600000) / 60000);
      value.textContent = days > 0 ? `${days}d ${hours}h` : `${hours}h ${String(mins).padStart(2, '0')}m`;
      sub.textContent = new Date(target).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
    };
    tick();
    live.timers.push(setInterval(tick, 30 * 1000));
  }

  // Weather with no location of its own (unset, or 0,0 "null island") no longer
  // dead-ends — main substitutes the user's default location from Settings and
  // returns { needsLocation: true } only if the user hasn't set one either.
  function buildWeather(component, el) {
    // Compact: one horizontal strip — place · temp · sky · wind.
    if (component.options.compact) {
      el.classList.add('weather-strip');
      const place = document.createElement('span');
      place.className = 'wx-place display-case';
      place.textContent = component.options.place || 'Weather';
      const temp = document.createElement('span');
      temp.className = 'wx-temp';
      temp.textContent = '—°';
      const desc = document.createElement('span');
      desc.className = 'wx-desc display-case';
      const wind = document.createElement('span');
      wind.className = 'wx-wind';
      el.append(place, temp, desc, wind);
      const refresh = async () => {
        if (!services.weather) return;
        const res = await services.weather({ lat: component.options.lat, lon: component.options.lon });
        if (!res.ok) { desc.textContent = res.needsLocation ? 'set location in Settings' : 'weather unavailable'; return; }
        if (!component.options.place && res.place) place.textContent = res.place;
        temp.textContent = `${Math.round(res.tempC)}°C`;
        desc.textContent = res.description;
        wind.textContent = `wind ${Math.round(res.windKmh)} km/h`;
      };
      refresh();
      live.timers.push(setInterval(refresh, WEATHER_REFRESH_MS));
      return;
    }

    const label = document.createElement('span');
    label.className = 'comp-label';
    label.textContent = component.options.place || 'Weather';
    const main = document.createElement('div');
    main.className = 'weather-main';
    const glyph = document.createElement('span');
    glyph.className = 'weather-glyph';
    const temp = document.createElement('div');
    temp.className = 'clock-time weather-temp';
    temp.textContent = '—';
    main.append(glyph, temp);
    const desc = document.createElement('div');
    desc.className = 'clock-date display-case';
    el.append(label, main, desc);
    let meta = null;
    if (component.options.details !== false) {
      meta = document.createElement('div');
      meta.className = 'weather-meta';
      el.appendChild(meta);
    }

    const refresh = async () => {
      if (!services.weather) return;
      const res = await services.weather({ lat: component.options.lat, lon: component.options.lon });
      if (!res.ok) {
        desc.textContent = res.needsLocation ? 'set your location in Settings' : 'weather unavailable';
        return;
      }
      if (!component.options.place && res.place) label.textContent = res.place;
      temp.textContent = `${Math.round(res.tempC)}°`;
      // Fixed engine-authored markup only — pack/service text never goes near innerHTML.
      glyph.innerHTML = WEATHER_GLYPHS[weatherGlyphKey(res.code)] || WEATHER_GLYPHS.cloud;
      desc.textContent = res.description;
      if (meta) {
        const parts = [];
        if (typeof res.hiC === 'number' && typeof res.loC === 'number') {
          parts.push(`H ${Math.round(res.hiC)}°  L ${Math.round(res.loC)}°`);
        }
        parts.push(`wind ${Math.round(res.windKmh)} km/h`);
        meta.textContent = parts.join(' · ');
      }
    };
    refresh();
    live.timers.push(setInterval(refresh, WEATHER_REFRESH_MS));
  }

  // Launcher: the user's pinned / recent / running apps as clickable tiles.
  // Content comes from main over the launcher service (opaque ids only);
  // in the editor the service has no launch(), so tiles render inert.
  function buildLauncher(component, el) {
    const o = component.options;
    const label = document.createElement('span');
    label.className = 'comp-label';
    label.textContent = o.label || 'Launcher';
    const wrap = document.createElement('div');
    wrap.className = 'launch-wrap';
    el.classList.add(`launch-${o.iconSize || 'm'}`);
    if (o.labels === false) el.classList.add('launch-nolabels');
    el.append(label, wrap);
    if (!services.launcher) return;

    const canAct = typeof services.launcher.launch === 'function';
    const sectionsEnabled = [o.pinned, o.recent, o.running].filter(Boolean).length;

    const tile = (name, fullTitle, icon, onAct) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `launch-tile${canAct ? '' : ' inert'}`;
      button.title = fullTitle || name;
      if (icon) {
        const img = document.createElement('img');
        img.className = 'launch-icon';
        img.alt = '';
        img.src = icon;
        button.appendChild(img);
      } else {
        const mono = document.createElement('span');
        mono.className = 'launch-mono';
        mono.textContent = (name || '?').slice(0, 1).toUpperCase();
        button.appendChild(mono);
      }
      const text = document.createElement('span');
      text.className = 'launch-name';
      text.textContent = name;
      button.appendChild(text);
      if (canAct) button.addEventListener('click', onAct);
      return button;
    };

    const section = (title, tiles) => {
      if (tiles.length === 0) return;
      if (sectionsEnabled > 1) {
        const head = document.createElement('div');
        head.className = 'launch-sec display-case';
        head.textContent = title;
        wrap.appendChild(head);
      }
      const grid = document.createElement('div');
      grid.className = 'launch-grid';
      grid.append(...tiles);
      wrap.appendChild(grid);
    };

    const paint = async () => {
      const res = await services.launcher.state({ running: Boolean(o.running) });
      if (!res.ok) return;
      wrap.textContent = '';
      if (o.pinned) {
        section('Pinned', res.pins.map((p) => tile(p.name, p.name, p.icon, () => services.launcher.launch(p.id))));
      }
      if (o.recent) {
        section('Recent', res.recent.map((r) => tile(r.name, r.name, r.icon, () => services.launcher.launch(r.id))));
      }
      if (o.running) {
        section('Open now', res.running.map((w) => tile(w.name || w.title, w.title, w.icon, () => services.launcher.focus(w.hwnd))));
      }
      if (wrap.childElementCount === 0) {
        const empty = document.createElement('div');
        empty.className = 'launch-empty';
        empty.textContent = 'Pin apps in the manager (Launcher tab).';
        wrap.appendChild(empty);
      }
    };
    paint();
    // Running windows change often; pins/recents also repaint on the
    // launcher:changed broadcast the page subscribes to.
    live.timers.push(setInterval(paint, o.running ? 15000 : 60000));
  }

  // Designer-authored sandboxed component. The untrusted fragment runs in an
  // isolated <iframe> (see the MODULE_* block above); here we just mount it and
  // wire the one-way theme/telemetry feed over postMessage.
  function buildModule(component, el, ctx) {
    const opts = component.options || {};
    const html = typeof opts.html === 'string' ? opts.html : '';
    el.classList.add('comp-module-host');
    el.classList.toggle('module-scroll', opts.scroll === true);

    if (!html.trim()) {
      // Nothing authored yet — a hint so the editor shows where code goes.
      const hint = document.createElement('div');
      hint.className = 'module-empty';
      hint.textContent = 'Empty module — add HTML in the inspector.';
      el.appendChild(hint);
      return;
    }

    const frame = document.createElement('iframe');
    frame.className = 'module-frame';
    // allow-scripts WITHOUT allow-same-origin ⇒ opaque origin, no parent/cookie
    // access, no top navigation, no forms/popups. The served CSP kills network.
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.setAttribute('referrerpolicy', 'no-referrer');
    frame.setAttribute('allow', ''); // Permissions-Policy: grant the frame NO device features (camera/mic/geo/…)
    frame.setAttribute('title', 'pack module');
    frame.src = moduleDocUrl(moduleSrcdoc(html, { scroll: opts.scroll === true }));
    el.appendChild(frame);

    const theme = moduleTheme(ctx.pack);
    const assets = ctx.assets || {};
    const post = (msg) => {
      const win = frame.contentWindow;
      if (win) { try { win.postMessage(msg, '*'); } catch (e) { /* frame gone */ } }
    };
    // First frame: theme + pack images + a plausible telemetry sample. The SDK
    // caches these, so listeners the module registers later still receive them.
    const pushInit = () => {
      post({ __de: 1, type: 'theme', theme });
      post({ __de: 1, type: 'assets', assets });
      if (opts.telemetry !== false) post({ __de: 1, type: 'data', data: moduleMockSample() });
    };

    // The module posts {type:'ready'} once its SDK is live; answer with a fresh
    // push. Accept messages ONLY from this frame, and never act on them beyond
    // re-sending the same allowlisted feed.
    const onMessage = (event) => {
      if (event.source !== frame.contentWindow) return;
      const m = event.data;
      if (!m || m.__de !== 1) return;
      if (m.type === 'ready') pushInit();
    };
    window.addEventListener('message', onMessage);
    live.disposers.push(() => window.removeEventListener('message', onMessage));
    frame.addEventListener('load', pushInit); // belt-and-braces if 'ready' is missed

    // Live system telemetry (desktop, and the editor preview which also has a
    // stats service). Silent if the pack opted out.
    if (opts.telemetry !== false) {
      live.telemetry.subscribers.push((values) => post({ __de: 1, type: 'data', data: moduleSample(values) }));
    }
  }

  const BUILDERS = {
    status: buildStatus,
    clock: buildClock,
    'analog-clock': buildAnalogClock,
    'hud-clock': buildHudClock,
    'ring-clock': buildRingClock,
    cores: buildCores,
    sysinfo: buildSysinfo,
    stats: buildStats,
    meter: buildMeter,
    sparkline: buildSparkline,
    text: buildText,
    image: buildImage,
    gallery: buildGallery,
    rig: buildRig,
    divider: buildDivider,
    calendar: buildCalendar,
    pomodoro: buildPomodoro,
    countdown: buildCountdown,
    weather: buildWeather,
    agenda: buildAgenda,
    notifications: buildNotifications,
    launcher: buildLauncher,
    assistant: buildAssistant,
    mixer: buildMixer,
    nowplaying: buildNowPlaying,
    visualizer: buildVisualizer,
    module: buildModule,
  };

  function cleanup() {
    for (const timer of live.timers) clearInterval(timer);
    for (const observer of live.observers) observer.disconnect();
    for (const dispose of live.disposers) { try { dispose(); } catch (e) { /* fail soft */ } }
    live.timers = [];
    live.observers = [];
    live.disposers = [];
    live.telemetry.subscribers = [];
  }

  /** Render a pack's components into canvasEl. Returns the component elements by index. */
  function render(canvasEl, pack, assets) {
    cleanup();
    canvasEl.textContent = '';
    canvasEl.style.inset = `${pack.canvas.padding}%`;
    // The surface (skin) root — resolved from canvasEl, which IS attached (each
    // component `el` is still detached while its builder runs, so el.closest()
    // can't find it). Rigs subscribe their tick to this root's shared loop.
    const skinRoot = canvasEl.closest('.skin-root') || canvasEl.parentElement || (canvasEl.ownerDocument && canvasEl.ownerDocument.body) || document.body;
    const ctx = { pack, assets, skinRoot };
    const elements = [];

    for (const component of pack.components) {
      const el = document.createElement('section');
      el.className = `comp comp-${component.type}`;
      const [x, y, w, h] = component.rect;
      el.style.left = `${x}%`;
      el.style.top = `${y}%`;
      el.style.width = `${w}%`;
      el.style.height = `${h}%`;
      el.style.zIndex = String(component.z);
      applyComponentStyle(el, component.style, pack);
      const builder = BUILDERS[component.type];
      if (builder) builder(component, el, ctx);
      canvasEl.appendChild(el);
      elements.push(el);
    }
    // Global spoken-health monitor (desktop only — services.speakHealthAlert is
    // absent in editor/manager). The Settings "Speak system-health alerts" toggle
    // must work for ANY pack, not only ones that happen to include a status
    // component with its health line on — so ONE monitor watches the shared
    // telemetry and reports per-metric level CHANGES (rise / escalation / clear)
    // to main, which gates on the opt-in setting and de-duplicates. Pushed BEFORE
    // startTelemetry so a pack with no telemetry widgets still polls for alerts.
    if (services.speakHealthAlert) {
      const healthMon = makeHealthMonitor();
      const reportedSev = {}; // label -> severity last reported to main
      // Enabling alerts mid-session re-announces anything already in a bad state:
      // main clears its memory and the desktop dispatches this so we re-report.
      const rearm = () => { for (const k of Object.keys(reportedSev)) delete reportedSev[k]; };
      document.addEventListener('aegis:health:rearm', rearm);
      live.disposers.push(() => document.removeEventListener('aegis:health:rearm', rearm));
      live.telemetry.subscribers.push((values) => {
        const { perMetric } = healthMon(values);
        for (const label of Object.keys(perMetric)) {
          const sev = perMetric[label].sev;
          const prev = reportedSev[label] || 0;
          if (sev === prev) continue;
          reportedSev[label] = sev;
          if (sev > 0 || prev > 0) services.speakHealthAlert(label, sev, perMetric[label].v);
        }
      });
    }
    startTelemetry();
    // Keyframe timeline (Phase G): subscribes to the shared loop; the disposer
    // rides live.disposers so the next render()/freeze unsubscribes it.
    const tlDispose = setupTimeline(skinRoot, pack, elements);
    if (tlDispose) live.disposers.push(tlDispose);
    return elements;
  }

  return { render, destroy: cleanup };
}

// Neutral SAMPLE notifications for PREVIEW/DESIGN surfaces (editor stage, manager
// detail preview, Workshop preview render) — never real toasts, so those windows
// stay privacy-safe to share/screenshot. The live DESKTOP surface still shows the
// user's real notifications. Times are recomputed each call so the panel always
// looks fresh. All content is invented — no personal data.
function demoNotifications() {
  const ago = (mins) => new Date(Date.now() - mins * 60000).toISOString();
  return [
    { app: 'Calendar', title: 'Design review', body: 'Today at 3:00 PM', time: ago(6) },
    { app: 'Messages', title: 'Alex', body: 'Sounds good — see you then!', time: ago(24) },
    { app: 'System', title: 'Backup complete', body: 'All your files are up to date.', time: ago(95) },
    { app: 'Mail', title: 'Weekly digest', body: 'Your summary is ready to read.', time: ago(180) },
  ];
}

window.AegisComponents = { FONT_STACKS, rgba, applySkin, createRenderer, freezeAmbience, setWallpaperPlayback, demoNotifications };

})();
