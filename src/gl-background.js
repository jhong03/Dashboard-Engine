'use strict';

// WebGL background effects (Phase C). When any background layer declares
// `effects`, the WHOLE layer stack renders through ONE GL canvas (layers as
// textured quads, back-to-front) instead of the DOM path — so parallax/drift
// behave identically (they're the same per-layer transform, here as uniforms)
// and the shader adds ripple / sway / drift-warp / pulse / cursor-ripple on top.
//
// Fail-soft is the whole point: no GL, a lost context, or a shader that won't
// compile → the caller silently falls back to the DOM stack. Nothing here ever
// throws to the renderer. Targets GLSL ES 1.00 so ONE shader runs on both
// WebGL2 and WebGL1.
//
// Public surface (window.AegisGL):
//   supported() -> bool
//   create(container, layers, assets, opts) -> handle | null
//   handle.setParallax(x,y)  // lerped pointer, [-1,1]
//   handle.setPointer(x,y,down)  // raw pointer (0..1) + button, for cursor-ripple
//   handle.tick(nowMs)
//   handle.freeze() / handle.resume()
//   handle.destroy()

(function () {
  const MAX_RINGS = 12;          // cursor-ripple ring buffer
  const PARALLAX_MAX_UV = 0.04;  // max parallax shift (UV) at depth1·strength1
  const DRIFT_MAX_UV = 0.03;     // max drift amplitude (UV) at |drift| 20
  const DRIFT_REF = 20;
  const DRIFT_BASE_FREQ = 0.32;

  // Perf HUD accounting (dev-only). Module-level so the HUD sums every GL handle
  // live in this window; guarded so it is free when the HUD is off.
  let _perfTex = 0, _perfBytes = 0;
  function pushPerf() { if (window.AegisPerf) window.AegisPerf.reportGL(_perfTex, _perfBytes); }

  let _supported = null;
  function supported() {
    // Reliable off switch (a bad/slow GPU, or forcing the DOM path for testing):
    // set by the dashboard from DE_NO_GL. Not cached, so it always wins.
    if (typeof window !== 'undefined' && window.__DE_DISABLE_GL) return false;
    if (_supported !== null) return _supported;
    try {
      const c = document.createElement('canvas');
      const gl = c.getContext('webgl2') || c.getContext('webgl') || c.getContext('experimental-webgl');
      _supported = !!gl;
      if (gl) { const lose = gl.getExtension('WEBGL_lose_context'); if (lose) lose.loseContext(); }
    } catch (e) { _supported = false; }
    return _supported;
  }

  const VERT = [
    'attribute vec2 aPos;',
    'varying vec2 vUV;',
    'void main(){',
    '  vUV = vec2(aPos.x*0.5+0.5, 1.0-(aPos.y*0.5+0.5));', // flip Y (texture origin)
    '  gl_Position = vec4(aPos, 0.0, 1.0);',
    '}',
  ].join('\n');

  // Build a fragment shader for one layer, injecting #defines for its effects.
  function buildFrag(layer) {
    const types = (layer.effects || []).map((e) => e.type);
    const region = (layer.effects || []).find((e) => e.region);
    const mask = (layer.effects || []).find((e) => e.mask);
    const pulse = (layer.effects || []).find((e) => e.type === 'pulse');
    const defs = [];
    if (types.includes('ripple')) defs.push('#define FX_RIPPLE');
    if (types.includes('sway')) defs.push('#define FX_SWAY');
    if (types.includes('drift-warp')) defs.push('#define FX_DRIFTWARP');
    if (types.includes('pulse')) defs.push('#define FX_PULSE');
    if (pulse && pulse.paletteKey) defs.push('#define PULSE_TINT');
    if (types.includes('cursor-ripple')) defs.push('#define FX_CURSORRIPPLE');
    if (region) { defs.push('#define REGION'); defs.push(`#define REGION_SHAPE ${region.region.shape === 'ellipse' ? 1 : 0}`); }
    if (mask) defs.push('#define MASK');
    defs.push(`#define MAX_RINGS ${MAX_RINGS}`);

    return [
      'precision highp float;',
      ...defs,
      'varying vec2 vUV;',
      'uniform sampler2D uTex;',
      'uniform float uTime, uOpacity, uOverscan, uLetterbox;',
      'uniform vec2 uOffset, uFitScale, uFitOffset;',
      '#ifdef FX_RIPPLE',
      'uniform vec3 uRipple;', // speed, scale, strength
      '#endif',
      '#ifdef FX_SWAY',
      'uniform vec3 uSway;', // speed, strength, direction(rad)
      '#endif',
      '#ifdef FX_DRIFTWARP',
      'uniform vec2 uWarp;', // speed, scale
      '#endif',
      '#ifdef FX_PULSE',
      'uniform vec2 uPulse;', // speed, amount
      '#ifdef PULSE_TINT',
      'uniform vec3 uPulseColor;',
      '#endif',
      '#endif',
      '#ifdef FX_CURSORRIPPLE',
      'uniform vec4 uRings[MAX_RINGS];', // xy=centre, z=age(s), w=active
      'uniform vec3 uCursor;', // strength, decay, speed
      '#endif',
      '#ifdef REGION',
      'uniform vec4 uRegion;',  // x,y,w,h in 0..1
      'uniform float uFeather;', // 0..1
      '#endif',
      '#ifdef MASK',
      'uniform sampler2D uMask;',
      '#endif',
      'float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7)))*43758.5453); }',
      'float vnoise(vec2 p){ vec2 i=floor(p), f=fract(p); float a=hash(i),b=hash(i+vec2(1.,0.)),c=hash(i+vec2(0.,1.)),d=hash(i+vec2(1.,1.)); vec2 u=f*f*(3.-2.*f); return mix(mix(a,b,u.x),mix(c,d,u.x),u.y); }',
      'float regionMask(vec2 p){',
      '#ifdef REGION',
      '  vec2 c = uRegion.xy + uRegion.zw*0.5; vec2 hf = max(uRegion.zw*0.5, vec2(1e-4));',
      '#if REGION_SHAPE == 1',
      '  float r = length((p-c)/hf); float f = max(uFeather/max(min(hf.x,hf.y),1e-4), 1e-3); return clamp(1.0 - smoothstep(1.0-f, 1.0, r), 0.0, 1.0);',
      '#else',
      '  vec2 d = abs(p-c) - hf; float f = max(uFeather, 1e-3); return clamp((1.0-smoothstep(-f,0.0,d.x))*(1.0-smoothstep(-f,0.0,d.y)),0.0,1.0);',
      '#endif',
      '#else',
      '  return 1.0;',
      '#endif',
      '}',
      'void main(){',
      '  float amt = regionMask(vUV);',
      '#ifdef MASK',
      '  amt *= texture2D(uMask, vUV).r;',
      '#endif',
      '  vec2 disp = vec2(0.0);',
      '#ifdef FX_RIPPLE',
      '  disp += sin(vUV.yx*uRipple.y*6.28318 + uTime*uRipple.x)*uRipple.z*0.02;',
      '#endif',
      '#ifdef FX_SWAY',
      '  { float s = sin(uTime*uSway.x)*uSway.y*0.05; disp += vec2(cos(uSway.z),sin(uSway.z))*s*(1.0-vUV.y); }',
      '#endif',
      '#ifdef FX_DRIFTWARP',
      '  { float n1=vnoise(vUV*uWarp.y+uTime*uWarp.x); float n2=vnoise(vUV*uWarp.y+5.2+uTime*uWarp.x*0.9); disp += (vec2(n1,n2)-0.5)*0.045; }',
      '#endif',
      '#ifdef FX_CURSORRIPPLE',
      // A single crisp ring per spawn, expanding at `speed` (uCursor.z) — a
      // narrow gaussian pulse riding outward, fading with age (uCursor.y). Reads
      // as a smooth ripple, not a standing distortion.
      '  for(int i=0;i<MAX_RINGS;i++){ vec4 r=uRings[i]; if(r.w<0.5) continue;',
      '    vec2 dd=vUV-r.xy; float dist=length(dd);',
      '    float radius = r.z * uCursor.z * 0.9;',
      '    float front = (dist - radius) * 20.0;',
      '    float pulse = exp(-front*front) * exp(-r.z*uCursor.y);',
      '    disp += normalize(dd+1e-5) * pulse * uCursor.x * 0.045; }',
      '#endif',
      '  vec2 uv = vUV + disp*amt;',
      '  uv = (uv-0.5)/uOverscan + 0.5 + uOffset;',        // overscan + parallax/drift
      '  vec2 suv = (uv-0.5)*uFitScale + 0.5 + uFitOffset;', // object-fit cover
      '  vec4 col = texture2D(uTex, suv);',
      // Only `contain` letterboxes to transparent; cover/stretch rely on
      // CLAMP_TO_EDGE (plus effect overscan) so displaced edges never show void.
      '  if (uLetterbox > 0.5 && (suv.x < 0.0 || suv.x > 1.0 || suv.y < 0.0 || suv.y > 1.0)) col.a = 0.0;',
      '#ifdef FX_PULSE',
      '  { float p = sin(uTime*uPulse.x)*uPulse.y*amt;',
      '#ifdef PULSE_TINT',
      '    col.rgb = mix(col.rgb, uPulseColor, clamp(max(0.0,p),0.0,1.0));',
      '#else',
      '    col.rgb *= 1.0 + p;',
      '#endif',
      '  }',
      '#endif',
      '  col.a *= uOpacity;',
      '  col.rgb *= col.a;', // premultiplied for ONE / ONE_MINUS_SRC_ALPHA
      '  gl_FragColor = col;',
      '}',
    ].join('\n');
  }

  function compile(gl, vsrc, fsrc) {
    const mk = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) { gl.deleteShader(s); return null; }
      return s;
    };
    const vs = mk(gl.VERTEX_SHADER, vsrc);
    const fs = mk(gl.FRAGMENT_SHADER, fsrc);
    if (!vs || !fs) return null;
    const p = gl.createProgram();
    gl.attachShader(p, vs); gl.attachShader(p, fs); gl.linkProgram(p);
    gl.deleteShader(vs); gl.deleteShader(fs);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) { gl.deleteProgram(p); return null; }
    return p;
  }

  function hexToRgb(hex) {
    const h = String(hex || '').replace('#', '');
    if (h.length < 6) return [1, 1, 1];
    return [parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255];
  }

  function create(container, layers, assets, opts) {
    opts = opts || {};
    const canvas = document.createElement('canvas');
    canvas.className = 'bg-gl';
    container.insertBefore(canvas, container.firstChild);
    let gl = null;
    try {
      const attrs = { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, preserveDrawingBuffer: false };
      gl = canvas.getContext('webgl2', attrs) || canvas.getContext('webgl', attrs) || canvas.getContext('experimental-webgl', attrs);
    } catch (e) { gl = null; }
    if (!gl) { canvas.remove(); return null; }

    let dead = false, lost = 0;
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault(); lost++;
      if (lost >= 2) { dead = true; if (typeof opts.onLost === 'function') opts.onLost(); }
    });

    const maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE) || 4096;
    const quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);

    const strength = typeof opts.strength === 'number' ? opts.strength : 1;
    const axisX = opts.axisX !== false, axisY = opts.axisY !== false;
    const reduced = !!opts.reduced;

    function newTex() {
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      // 1px placeholder so a not-yet-loaded texture samples transparent, not error.
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 0]));
      _perfTex++; pushPerf();
      return t;
    }

    function uploadImage(rec, imgOrCanvas, w, h) {
      gl.bindTexture(gl.TEXTURE_2D, rec.tex);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      try {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, imgOrCanvas);
        rec.texW = w; rec.texH = h; rec.ready = true;
        _perfBytes += (w * h * 4) - (rec.bytes || 0); rec.bytes = w * h * 4; pushPerf();
      } catch (e) { /* leave placeholder */ }
    }

    // Build per-layer GL state.
    const glLayers = [];
    let anyProgram = false;
    for (let i = 0; i < layers.length; i++) {
      const layer = layers[i];
      const program = compile(gl, VERT, buildFrag(layer));
      if (!program) continue; // this layer just won't draw; ladder handles all-fail
      anyProgram = true;
      const rec = {
        layer, program, tex: newTex(), maskTex: null, ready: false, texW: 1, texH: 1,
        video: (opts.videos && opts.videos[i]) || null,
        u: {}, // uniform locations, filled lazily
      };
      // Load the image texture (data: URI) unless it's a video layer.
      if (!rec.video) {
        const uri = assets[layer.src];
        if (uri) {
          const img = new Image();
          img.onload = () => {
            let src = img, w = img.naturalWidth, h = img.naturalHeight;
            if (w > maxTex || h > maxTex) { // downscale oversize textures
              const scale = maxTex / Math.max(w, h);
              const oc = document.createElement('canvas');
              oc.width = Math.max(1, Math.floor(w * scale)); oc.height = Math.max(1, Math.floor(h * scale));
              oc.getContext('2d').drawImage(img, 0, 0, oc.width, oc.height);
              src = oc; w = oc.width; h = oc.height;
            }
            uploadImage(rec, src, w, h);
          };
          img.src = uri;
        }
      }
      // Optional multiply mask.
      const maskFx = (layer.effects || []).find((e) => e.mask);
      if (maskFx && assets[maskFx.mask]) {
        rec.maskTex = newTex();
        const mimg = new Image();
        mimg.onload = () => {
          gl.bindTexture(gl.TEXTURE_2D, rec.maskTex);
          // Downscale an oversized mask to the GPU's limit — one warning, never a
          // GL error. A grayscale mask only needs the .r channel, but decoding it
          // as RGBA is simplest and portable across WebGL1/2.
          let src = mimg, w = mimg.naturalWidth, h = mimg.naturalHeight;
          if (w > maxTex || h > maxTex) {
            const scale = maxTex / Math.max(w, h);
            const oc = document.createElement('canvas');
            oc.width = Math.max(1, Math.floor(w * scale)); oc.height = Math.max(1, Math.floor(h * scale));
            oc.getContext('2d').drawImage(mimg, 0, 0, oc.width, oc.height);
            src = oc; w = oc.width; h = oc.height;
            console.warn(`[gl-background] mask "${maskFx.mask}" downscaled to ${w}×${h} (GPU max ${maxTex}).`);
          }
          try { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src); rec.maskBytes = w * h * 4; _perfBytes += rec.maskBytes; pushPerf(); } catch (e) {}
        };
        mimg.src = assets[maskFx.mask];
      }
      // Motion params (mirror the DOM path so GL/DOM parallax match).
      const depth = typeof layer.depth === 'number' ? layer.depth : 0;
      const driftX = layer.drift ? layer.drift.x || 0 : 0;
      const driftY = layer.drift ? layer.drift.y || 0 : 0;
      rec.depth = depth;
      rec.parallaxAmp = reduced ? 0 : PARALLAX_MAX_UV * depth * strength;
      rec.driftAmpX = reduced ? 0 : DRIFT_MAX_UV * Math.min(1, Math.abs(driftX) / DRIFT_REF);
      rec.driftAmpY = reduced ? 0 : DRIFT_MAX_UV * Math.min(1, Math.abs(driftY) / DRIFT_REF);
      rec.driftSpeedX = (Math.sign(driftX) || 1) * (Math.abs(driftX) / DRIFT_REF) * DRIFT_BASE_FREQ;
      rec.driftSpeedY = (Math.sign(driftY) || 1) * (Math.abs(driftY) / DRIFT_REF) * DRIFT_BASE_FREQ;
      rec.driftPhaseX = 0; rec.driftPhaseY = 0;
      // UV-displacing effects (ripple/sway/warp/cursor-ripple) push sampling
      // past the texture edge; zoom in a touch more so cover layers never smear
      // the void in at the edges.
      const hasUvFx = (layer.effects || []).some((e) => ['ripple', 'sway', 'drift-warp', 'cursor-ripple'].includes(e.type));
      const over = rec.parallaxAmp + Math.max(rec.driftAmpX, rec.driftAmpY) + (hasUvFx ? 0.06 : 0);
      rec.overscan = 1 + 2 * (over + 0.005);
      rec.opacity = typeof layer.opacity === 'number' ? layer.opacity : 1;
      rec.fit = layer.fit || 'cover';
      rec.posX = typeof layer.posX === 'number' ? layer.posX : 50;
      rec.posY = typeof layer.posY === 'number' ? layer.posY : 50;
      glLayers.push(rec);
    }
    if (!anyProgram) { // every shader failed to compile → let the caller fall back
      try { gl.deleteBuffer(quad); const lose = gl.getExtension('WEBGL_lose_context'); if (lose) lose.loseContext(); } catch (e) {}
      canvas.remove();
      return null;
    }

    const parallax = { x: 0, y: 0 };
    const pointer = { x: 0.5, y: 0.5, down: false };
    const rings = Array.from({ length: MAX_RINGS }, () => ({ x: 0, y: 0, age: 0, active: false }));
    let lastSpawn = 0;

    function uloc(rec, name) {
      if (!(name in rec.u)) rec.u[name] = gl.getUniformLocation(rec.program, name);
      return rec.u[name];
    }

    function resize() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
      const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
      gl.viewport(0, 0, canvas.width, canvas.height);
    }

    // object-fit cover: crop the longer axis; posX/posY chooses the focal point.
    function fitFor(rec) {
      const cw = canvas.width, ch = canvas.height;
      const tw = rec.texW || 1, th = rec.texH || 1;
      const cA = cw / ch, tA = tw / th;
      let sx = 1, sy = 1, ox = 0, oy = 0;
      if (rec.fit === 'stretch') return [1, 1, 0, 0];
      if (rec.fit === 'contain') {
        if (cA > tA) { sx = cA / tA; ox = (0.5) * (1 - sx); } else { sy = tA / cA; oy = (0.5) * (1 - sy); }
        // contain samples outside [0,1] → shader letterboxes to transparent
        return [1 / sx, 1 / sy, -ox / sx, -oy / sy];
      }
      // cover
      if (cA > tA) { sy = tA / cA; oy = (rec.posY / 100 - 0.5) * (1 - sy); } else { sx = cA / tA; ox = (rec.posX / 100 - 0.5) * (1 - sx); }
      return [sx, sy, ox, oy];
    }

    function spawnRing(t) {
      if (reduced) return;
      let slot = rings.find((r) => !r.active);
      if (!slot) slot = rings.reduce((a, b) => (a.age > b.age ? a : b));
      slot.x = pointer.x; slot.y = pointer.y; slot.age = 0; slot.active = true;
    }

    let prevT = 0;
    function tick(now) {
      if (dead) return;
      const t = now / 1000;
      const dt = prevT ? Math.min(t - prevT, 0.1) : 0;
      prevT = t;
      resize();
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

      // Age cursor-ripple rings; spawn on movement/press (throttled).
      const wantsCursor = glLayers.some((r) => (r.layer.effects || []).some((e) => e.type === 'cursor-ripple'));
      if (wantsCursor && !reduced) {
        for (const r of rings) if (r.active) { r.age += dt; if (r.age > 2.2) r.active = false; }
        if ((pointer.down || pointer.moved) && (t - lastSpawn) > 0.12) { spawnRing(t); lastSpawn = t; pointer.moved = false; }
      }

      for (const rec of glLayers) {
        // Update video textures each frame while playing.
        if (rec.video && rec.video.readyState >= 2) {
          gl.bindTexture(gl.TEXTURE_2D, rec.tex);
          gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
          try {
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, rec.video); rec.texW = rec.video.videoWidth || rec.texW; rec.texH = rec.video.videoHeight || rec.texH; rec.ready = true;
            const nb = rec.texW * rec.texH * 4; if (nb !== rec.bytes) { _perfBytes += nb - (rec.bytes || 0); rec.bytes = nb; pushPerf(); }
          } catch (e) {}
        }
        if (!rec.ready) continue;

        gl.useProgram(rec.program);
        const posLoc = gl.getAttribLocation(rec.program, 'aPos');
        gl.bindBuffer(gl.ARRAY_BUFFER, quad);
        gl.enableVertexAttribArray(posLoc);
        gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

        // Parallax + drift offset (matches the DOM path).
        rec.driftPhaseX += rec.driftSpeedX * dt; rec.driftPhaseY += rec.driftSpeedY * dt;
        const ox = (axisX ? -parallax.x * rec.parallaxAmp : 0) + Math.sin(rec.driftPhaseX) * rec.driftAmpX;
        const oy = (axisY ? -parallax.y * rec.parallaxAmp : 0) + Math.sin(rec.driftPhaseY) * rec.driftAmpY;

        gl.uniform1f(uloc(rec, 'uTime'), reduced ? 0 : t);
        gl.uniform1f(uloc(rec, 'uOpacity'), rec.opacity);
        gl.uniform1f(uloc(rec, 'uOverscan'), rec.overscan);
        gl.uniform1f(uloc(rec, 'uLetterbox'), rec.fit === 'contain' ? 1 : 0);
        gl.uniform2f(uloc(rec, 'uOffset'), ox, oy);
        const fit = fitFor(rec);
        gl.uniform2f(uloc(rec, 'uFitScale'), fit[0], fit[1]);
        gl.uniform2f(uloc(rec, 'uFitOffset'), fit[2], fit[3]);

        // Per-effect uniforms.
        for (const e of rec.layer.effects || []) {
          if (e.type === 'ripple') gl.uniform3f(uloc(rec, 'uRipple'), e.speed, e.scale, e.strength);
          else if (e.type === 'sway') gl.uniform3f(uloc(rec, 'uSway'), e.speed, e.strength, e.direction * Math.PI / 180);
          else if (e.type === 'drift-warp') gl.uniform2f(uloc(rec, 'uWarp'), e.speed, e.scale);
          else if (e.type === 'pulse') { gl.uniform2f(uloc(rec, 'uPulse'), e.speed, e.amount); if (e.paletteKey && opts.palette) { const c = hexToRgb(opts.palette[e.paletteKey]); const l = uloc(rec, 'uPulseColor'); if (l) gl.uniform3f(l, c[0], c[1], c[2]); } }
          else if (e.type === 'cursor-ripple') gl.uniform3f(uloc(rec, 'uCursor'), e.strength, e.decay, typeof e.speed === 'number' ? e.speed : 1.4);
          if (e.region) {
            const r = e.region;
            const l = uloc(rec, 'uRegion'); if (l) gl.uniform4f(l, r.x / 100, r.y / 100, r.w / 100, r.h / 100);
            const lf = uloc(rec, 'uFeather'); if (lf) gl.uniform1f(lf, r.feather / 100);
          }
        }
        // cursor-ripple ring array.
        if ((rec.layer.effects || []).some((e) => e.type === 'cursor-ripple')) {
          const arr = new Float32Array(MAX_RINGS * 4);
          for (let i = 0; i < MAX_RINGS; i++) { const r = rings[i]; arr[i * 4] = r.x; arr[i * 4 + 1] = r.y; arr[i * 4 + 2] = r.age; arr[i * 4 + 3] = r.active ? 1 : 0; }
          const l = uloc(rec, 'uRings[0]'); if (l) gl.uniform4fv(l, arr);
        }

        gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, rec.tex);
        gl.uniform1i(uloc(rec, 'uTex'), 0);
        if (rec.maskTex) { gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, rec.maskTex); const l = uloc(rec, 'uMask'); if (l) gl.uniform1i(l, 1); }

        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      }
    }

    function setParallax(x, y) { parallax.x = x; parallax.y = y; }
    function setPointer(x, y, down) {
      if (Math.abs(x - pointer.x) > 0.002 || Math.abs(y - pointer.y) > 0.002) pointer.moved = true;
      pointer.x = x; pointer.y = y; pointer.down = !!down;
    }
    function freeze() { /* the caller stops calling tick; last frame persists */ }
    function resume() { prevT = 0; }
    function destroy() {
      try {
        for (const rec of glLayers) {
          if (rec.tex) { gl.deleteTexture(rec.tex); _perfTex--; }
          if (rec.maskTex) { gl.deleteTexture(rec.maskTex); _perfTex--; }
          _perfBytes -= (rec.bytes || 0) + (rec.maskBytes || 0);
          if (rec.program) gl.deleteProgram(rec.program);
        }
        pushPerf();
        if (quad) gl.deleteBuffer(quad);
        const lose = gl.getExtension('WEBGL_lose_context'); if (lose) lose.loseContext();
      } catch (e) {}
      canvas.remove();
    }

    // Reduced motion / static thumbnail: draw exactly one frame, no loop (the
    // caller won't tick). Images may still be decoding, so schedule a couple of
    // redraws as they arrive.
    if (reduced) { tick(0); setTimeout(() => tick(0), 120); setTimeout(() => tick(0), 400); }

    return { canvas, setParallax, setPointer, tick, freeze, resume, destroy };
  }

  window.AegisGL = { supported, create };
})();
