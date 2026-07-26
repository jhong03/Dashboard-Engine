'use strict';

// Generates build/icon.ico — a placeholder brand mark (arc-reactor ring in
// cyan on the void background) so the packaged app and installer have an icon.
// Original geometry, no IP. Swap in real art anytime: replace build/icon.ico
// (electron-builder reads it from the buildResources dir). Run: node build/gen-icon.js
//
// A minimal PNG encoder (Node zlib for IDAT) wrapped in a single-image ICO —
// Windows Vista+ and electron-builder accept a 256×256 PNG-in-ICO.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZE = 256;

// Palette (brand): void background, cyan ring, brighter core.
const VOID = [4, 8, 15];
const CYAN = [63, 216, 255];
const BRIGHT = [127, 233, 255];

function lerp(a, b, t) { return Math.round(a + (b - a) * t); }
function mix(c1, c2, t) { return [lerp(c1[0], c2[0], t), lerp(c1[1], c2[1], t), lerp(c1[2], c2[2], t)]; }

// Per-pixel RGBA: a soft glow, an outer ring, and a filled core — the HUD look.
function pixel(x, y) {
  const cx = (SIZE - 1) / 2;
  const cy = (SIZE - 1) / 2;
  const dx = x - cx;
  const dy = y - cy;
  const r = Math.sqrt(dx * dx + dy * dy) / (SIZE / 2); // 0 at centre, 1 at edge

  let rgb = VOID.slice();
  let a = 255;

  // Ambient glow toward the centre.
  const glow = Math.max(0, 1 - r * 1.6);
  rgb = mix(rgb, CYAN, glow * 0.18);

  // Outer ring.
  const ring = 0.72;
  const ringHalf = 0.07;
  const ringD = Math.abs(r - ring);
  if (ringD < ringHalf) {
    const t = 1 - ringD / ringHalf;
    rgb = mix(rgb, CYAN, Math.min(1, t * 1.3));
  }

  // Inner core (filled) + a bright centre.
  if (r < 0.34) {
    const t = 1 - r / 0.34;
    rgb = mix(CYAN, BRIGHT, t);
  } else if (r < 0.40) {
    // thin gap glow around the core
    rgb = mix(rgb, CYAN, 0.35);
  }

  return [rgb[0], rgb[1], rgb[2], a];
}

// ── PNG encoding ────────────────────────────────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePng() {
  const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
  let o = 0;
  for (let y = 0; y < SIZE; y++) {
    raw[o++] = 0; // filter: none
    for (let x = 0; x < SIZE; x++) {
      const [r, g, b, a] = pixel(x, y);
      raw[o++] = r; raw[o++] = g; raw[o++] = b; raw[o++] = a;
    }
  }
  const sig = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(SIZE, 0);
  ihdr.writeUInt32BE(SIZE, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // colour type: RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

// ── ICO container (single 256×256 PNG image) ────────────────────────────────
function encodeIco(png) {
  const dir = Buffer.alloc(6);
  dir.writeUInt16LE(0, 0); // reserved
  dir.writeUInt16LE(1, 2); // type: icon
  dir.writeUInt16LE(1, 4); // one image
  const entry = Buffer.alloc(16);
  entry[0] = 0;  // width 0 = 256
  entry[1] = 0;  // height 0 = 256
  entry[2] = 0;  // palette
  entry[3] = 0;  // reserved
  entry.writeUInt16LE(1, 4);  // colour planes
  entry.writeUInt16LE(32, 6); // bits per pixel
  entry.writeUInt32LE(png.length, 8);
  entry.writeUInt32LE(6 + 16, 12); // offset to image data
  return Buffer.concat([dir, entry, png]);
}

const png = encodePng();
const ico = encodeIco(png);
const outIco = path.join(__dirname, 'icon.ico');
const outPng = path.join(__dirname, 'icon.png'); // handy for macOS/Linux/store art
fs.writeFileSync(outIco, ico);
fs.writeFileSync(outPng, png);
console.log(`Wrote ${outIco} (${ico.length} bytes) and ${outPng} (${png.length} bytes)`);
