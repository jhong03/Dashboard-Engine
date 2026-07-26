'use strict';

// A tiny, fail-soft engine log. Crashes and lifecycle events append here so a
// user (or whoever they send it to) can see what happened without a telemetry
// server — nothing ever leaves the machine. Privacy: this is diagnostic text
// (timestamps, error stacks, event names), NOT personal data — reminders,
// launcher pins, notification contents, and API keys never pass through here.
//
// Rotates by size so it can't grow without bound. Every call is wrapped so a
// logging failure can never take down the engine (the whole point is to be the
// thing that survives a crash).

const fs = require('fs');
const path = require('path');

const LOG_DIR_NAME = 'logs';
const LOG_FILE = 'engine.log';
const MAX_BYTES = 1024 * 1024; // rotate at ~1 MB
const KEEP_OLD = 2;            // engine.log.1, engine.log.2

function logsDir(userDir) {
  return path.join(userDir, LOG_DIR_NAME);
}

function logFile(userDir) {
  return path.join(logsDir(userDir), LOG_FILE);
}

// Roll engine.log → engine.log.1 → engine.log.2 (dropping the oldest) once the
// active file passes the size cap. Best-effort: any error just skips rotation.
function rotateIfNeeded(userDir) {
  try {
    const file = logFile(userDir);
    const stat = fs.statSync(file); // throws if missing → nothing to rotate
    if (stat.size < MAX_BYTES) return;
    for (let i = KEEP_OLD; i >= 1; i--) {
      const src = i === 1 ? file : `${file}.${i - 1}`;
      const dest = `${file}.${i}`;
      if (fs.existsSync(src)) fs.renameSync(src, dest);
    }
  } catch {
    /* missing file or rename race — fine */
  }
}

// Append one timestamped line. `level` is a short tag (INFO/WARN/CRASH).
function write(userDir, level, message) {
  try {
    fs.mkdirSync(logsDir(userDir), { recursive: true });
    rotateIfNeeded(userDir);
    const stamp = new Date().toISOString();
    const line = `${stamp} [${String(level).toUpperCase()}] ${String(message).replace(/\s+$/, '')}\n`;
    fs.appendFileSync(logFile(userDir), line, 'utf8');
  } catch {
    /* logging must never throw */
  }
}

module.exports = { write, logsDir, logFile };
