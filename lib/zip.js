'use strict';

// Minimal zip read/write for .aegispack files. Written in-repo because the
// project is dependency-light and a pack archive needs only a fraction of
// the format: store/deflate methods, no zip64, no encryption, no streaming.
//
// Reading is defensive — an .aegispack comes from the internet:
//   - entry names must match an allowlist (pack.json or assets/<img>) —
//     anything else (absolute paths, .., backslashes, executables) is skipped
//   - per-entry and total uncompressed sizes are capped BEFORE inflation
//     (zlib maxOutputLength), so a zip bomb dies at the cap
//   - entry count is capped

const zlib = require('zlib');

const MAX_ENTRIES = 40;
const MAX_ENTRY_BYTES = 5 * 1024 * 1024;   // one asset
const MAX_TOTAL_BYTES = 25 * 1024 * 1024;  // whole pack, uncompressed

// What may live inside a pack archive. Deliberately identical in spirit to
// lib/packs.js ASSET_PATTERN — the archive can't smuggle what the sanitizer
// would reject anyway, but rejecting at the container keeps junk off disk.
const ENTRY_PATTERN = /^(pack\.json|assets\/[a-z0-9._-]+\.(png|jpg|jpeg|webp))$/i;

// ── CRC32 (PNG/zip polynomial) ──────────────────────────────────────────────

let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

// ── Writing ─────────────────────────────────────────────────────────────────

/**
 * Build a zip from { name, data } entries. Names are trusted here (the
 * exporter builds them); readers elsewhere never are.
 */
function writeZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    // Store when deflate doesn't help (already-compressed images).
    const useStore = deflated.length >= data.length;
    const payload = useStore ? data : deflated;
    const method = useStore ? 0 : 8;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);            // version needed
    local.writeUInt16LE(0, 6);             // flags
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(0, 10);            // mod time/date: epoch — packs are content-addressed by sha256
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);            // extra len

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);          // made by
    central.writeUInt16LE(20, 6);          // version needed
    central.writeUInt16LE(0, 8);           // flags
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(0, 12);          // time/date
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    // extra/comment/disk/attrs all zero
    central.writeUInt32LE(offset, 42);     // local header offset

    localParts.push(local, nameBuf, payload);
    centralParts.push(Buffer.concat([central, nameBuf]));
    offset += local.length + nameBuf.length + payload.length;
  }

  const centralDir = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(offset, 16);

  return Buffer.concat([...localParts, centralDir, eocd]);
}

// ── Reading ─────────────────────────────────────────────────────────────────

function findEocd(buf) {
  // EOCD is within the last 64 KB + 22 bytes (comment can pad it).
  const floor = Math.max(0, buf.length - 65558);
  for (let i = buf.length - 22; i >= floor; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i;
  }
  return -1;
}

/**
 * Parse an .aegispack buffer into { entries, warnings }.
 * entries: Map<name, Buffer> — only allowlisted names, sizes pre-capped.
 * Throws a human-readable Error only if the buffer isn't a zip at all.
 */
function readZip(buf) {
  const warnings = [];
  const eocdAt = findEocd(buf);
  if (eocdAt < 0) throw new Error('Not a valid pack file (no zip directory found).');

  const count = buf.readUInt16LE(eocdAt + 10);
  let cursor = buf.readUInt32LE(eocdAt + 16);
  if (count > MAX_ENTRIES) {
    warnings.push(`Archive lists ${count} entries (max ${MAX_ENTRIES}); extras are ignored.`);
  }

  const entries = new Map();
  let totalBytes = 0;

  for (let i = 0; i < Math.min(count, MAX_ENTRIES); i++) {
    if (cursor + 46 > buf.length || buf.readUInt32LE(cursor) !== 0x02014b50) {
      warnings.push('Archive directory is truncated; stopping early.');
      break;
    }
    const method = buf.readUInt16LE(cursor + 10);
    const compSize = buf.readUInt32LE(cursor + 20);
    const uncompSize = buf.readUInt32LE(cursor + 24);
    const nameLen = buf.readUInt16LE(cursor + 28);
    const extraLen = buf.readUInt16LE(cursor + 30);
    const commentLen = buf.readUInt16LE(cursor + 32);
    const localOffset = buf.readUInt32LE(cursor + 42);
    const name = buf.toString('utf8', cursor + 46, cursor + 46 + nameLen);
    cursor += 46 + nameLen + extraLen + commentLen;

    if (!ENTRY_PATTERN.test(name)) {
      if (!name.endsWith('/')) warnings.push(`Skipped archive entry "${name.slice(0, 60)}" — not part of a pack.`);
      continue;
    }
    if (uncompSize > MAX_ENTRY_BYTES) {
      warnings.push(`Skipped "${name}" — ${(uncompSize / 1048576).toFixed(1)} MB exceeds the ${MAX_ENTRY_BYTES / 1048576} MB per-file cap.`);
      continue;
    }
    if (totalBytes + uncompSize > MAX_TOTAL_BYTES) {
      warnings.push(`Skipped "${name}" — pack exceeds the ${MAX_TOTAL_BYTES / 1048576} MB total cap.`);
      continue;
    }

    // Local header repeats name/extra lengths; the data follows them.
    if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== 0x04034b50) {
      warnings.push(`Skipped "${name}" — corrupt local header.`);
      continue;
    }
    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const localExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    if (dataStart + compSize > buf.length) {
      warnings.push(`Skipped "${name}" — data extends past end of file.`);
      continue;
    }
    const raw = buf.subarray(dataStart, dataStart + compSize);

    let data;
    try {
      if (method === 0) {
        data = Buffer.from(raw);
      } else if (method === 8) {
        data = zlib.inflateRawSync(raw, { maxOutputLength: MAX_ENTRY_BYTES });
      } else {
        warnings.push(`Skipped "${name}" — unsupported compression method ${method}.`);
        continue;
      }
    } catch {
      warnings.push(`Skipped "${name}" — could not decompress.`);
      continue;
    }
    totalBytes += data.length;
    entries.set(name, data);
  }

  return { entries, warnings };
}

module.exports = { writeZip, readZip, MAX_ENTRY_BYTES, MAX_TOTAL_BYTES };
