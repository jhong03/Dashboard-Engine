'use strict';

// Reminders / daily planner store. PERSONAL data — lives in user data and is
// displayed by calendar/agenda components, but is never part of a pack:
// exporting or sharing a pack must never carry someone's appointments.
// Validated like everything else (the file is hand-editable JSON).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FILE = 'reminders.json';
const MAX_REMINDERS = 500;
const MAX_TEXT = 120;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

function remindersFile(userDir) {
  return path.join(userDir, FILE);
}

function validEntry(raw) {
  if (typeof raw !== 'object' || raw === null) return null;
  if (typeof raw.date !== 'string' || !DATE_PATTERN.test(raw.date) || Number.isNaN(Date.parse(raw.date))) return null;
  if (typeof raw.text !== 'string' || raw.text.trim() === '') return null;
  return {
    id: typeof raw.id === 'string' && raw.id.length <= 64 ? raw.id : crypto.randomUUID(),
    date: raw.date,
    time: typeof raw.time === 'string' && TIME_PATTERN.test(raw.time) ? raw.time : null,
    text: raw.text.trim().slice(0, MAX_TEXT),
    done: raw.done === true,
  };
}

function sortKey(reminder) {
  return `${reminder.date}T${reminder.time || '99:99'}`; // untimed items sort after timed ones
}

/** Load all reminders, sorted by date then time. Never throws. */
function list(userDir) {
  let raw = null;
  try {
    const text = fs.readFileSync(remindersFile(userDir), 'utf8');
    raw = JSON.parse(text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text);
  } catch {
    return { reminders: [] }; // none yet — not an error
  }
  const reminders = (Array.isArray(raw.reminders) ? raw.reminders : [])
    .map(validEntry)
    .filter(Boolean)
    .slice(0, MAX_REMINDERS)
    .sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
  return { reminders };
}

function save(userDir, reminders) {
  fs.mkdirSync(userDir, { recursive: true });
  const tmp = `${remindersFile(userDir)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ reminders }, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, remindersFile(userDir));
}

function add(userDir, raw) {
  const entry = validEntry({ ...raw, id: undefined, done: false });
  if (!entry) return { ok: false, error: 'A reminder needs a valid date (YYYY-MM-DD) and some text.' };
  const { reminders } = list(userDir);
  if (reminders.length >= MAX_REMINDERS) {
    return { ok: false, error: `You already have ${MAX_REMINDERS} reminders — tidy up first.` };
  }
  reminders.push(entry);
  save(userDir, reminders);
  return { ok: true, reminder: entry };
}

function remove(userDir, id) {
  const { reminders } = list(userDir);
  const next = reminders.filter((r) => r.id !== id);
  if (next.length === reminders.length) return { ok: false, error: 'That reminder no longer exists.' };
  save(userDir, next);
  return { ok: true };
}

function toggle(userDir, id) {
  const { reminders } = list(userDir);
  const entry = reminders.find((r) => r.id === id);
  if (!entry) return { ok: false, error: 'That reminder no longer exists.' };
  entry.done = !entry.done;
  save(userDir, reminders);
  return { ok: true, done: entry.done };
}

module.exports = { list, add, remove, toggle };
