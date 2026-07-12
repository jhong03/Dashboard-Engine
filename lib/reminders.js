'use strict';

// Reminders / daily planner store. PERSONAL data — lives in user data and is
// displayed by calendar/agenda components, but is never part of a pack:
// exporting or sharing a pack must never carry someone's appointments.
// Validated like everything else (the file is hand-editable JSON).
//
// An entry is either a one-off task (can be marked done) or a repeating
// event (daily/weekly/monthly/yearly — never "done", like a calendar event).
// Occurrence expansion lives here so the planner grid, the wallpaper
// components, and the alert scheduler all agree on what lands on which day.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FILE = 'reminders.json';
const MAX_REMINDERS = 500;
const MAX_TEXT = 120;
const MAX_LEAD_MINUTES = 1440;      // "remind me up to a day before"
const MAX_WINDOW_DAYS = 400;        // expansion window cap
const MAX_OCCURRENCES = 2000;       // expansion output cap
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
const OCCURRENCE_PATTERN = /^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d$/;
const REPEATS = ['none', 'daily', 'weekly', 'monthly', 'yearly'];

function remindersFile(userDir) {
  return path.join(userDir, FILE);
}

function validEntry(raw) {
  if (typeof raw !== 'object' || raw === null) return null;
  if (typeof raw.date !== 'string' || !DATE_PATTERN.test(raw.date) || Number.isNaN(Date.parse(raw.date))) return null;
  if (typeof raw.text !== 'string' || raw.text.trim() === '') return null;
  const repeat = REPEATS.includes(raw.repeat) ? raw.repeat : 'none';
  const lead = typeof raw.lead === 'number' && Number.isFinite(raw.lead)
    ? Math.min(MAX_LEAD_MINUTES, Math.max(0, Math.round(raw.lead))) : 0;
  return {
    id: typeof raw.id === 'string' && raw.id.length <= 64 ? raw.id : crypto.randomUUID(),
    date: raw.date,
    time: typeof raw.time === 'string' && TIME_PATTERN.test(raw.time) ? raw.time : null,
    text: raw.text.trim().slice(0, MAX_TEXT),
    repeat,
    lead,
    // Repeating entries are events, not tasks — they can't be "done".
    done: raw.done === true && repeat === 'none',
    // Last occurrence (YYYY-MM-DDTHH:MM) already alerted — internal state,
    // preserved on load, only ever set by markAlerted().
    alertedAt: typeof raw.alertedAt === 'string' && OCCURRENCE_PATTERN.test(raw.alertedAt) ? raw.alertedAt : null,
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
  const source = typeof raw === 'object' && raw !== null ? raw : {};
  const entry = validEntry({ ...source, id: undefined, done: false, alertedAt: undefined });
  if (!entry) return { ok: false, error: 'A reminder needs a valid date (YYYY-MM-DD) and some text.' };
  const { reminders } = list(userDir);
  if (reminders.length >= MAX_REMINDERS) {
    return { ok: false, error: `You already have ${MAX_REMINDERS} reminders — tidy up first.` };
  }
  reminders.push(entry);
  save(userDir, reminders);
  return { ok: true, reminder: entry };
}

/** Edit an entry's fields (date/time/text/repeat/lead). Changing when the
 *  entry fires resets its alert state so the new moment alerts again. */
function update(userDir, id, patch) {
  const source = typeof patch === 'object' && patch !== null ? patch : {};
  const { reminders } = list(userDir);
  const index = reminders.findIndex((r) => r.id === id);
  if (index === -1) return { ok: false, error: 'That reminder no longer exists.' };
  const current = reminders[index];
  const merged = validEntry({
    ...current,
    date: source.date !== undefined ? source.date : current.date,
    time: source.time !== undefined ? source.time : current.time,
    text: source.text !== undefined ? source.text : current.text,
    repeat: source.repeat !== undefined ? source.repeat : current.repeat,
    lead: source.lead !== undefined ? source.lead : current.lead,
  });
  if (!merged) return { ok: false, error: 'That change is not valid — check the date and text.' };
  const timingChanged = merged.date !== current.date || merged.time !== current.time
    || merged.repeat !== current.repeat || merged.lead !== current.lead;
  if (timingChanged) merged.alertedAt = null;
  reminders[index] = merged;
  save(userDir, reminders);
  return { ok: true, reminder: merged };
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
  if (entry.repeat !== 'none') return { ok: false, error: 'Repeating events cannot be marked done.' };
  entry.done = !entry.done;
  save(userDir, reminders);
  return { ok: true, done: entry.done };
}

/** Record that an occurrence (YYYY-MM-DDTHH:MM) has been alerted. */
function markAlerted(userDir, id, occurrenceIso) {
  if (typeof occurrenceIso !== 'string' || !OCCURRENCE_PATTERN.test(occurrenceIso)) {
    return { ok: false, error: 'Invalid occurrence.' };
  }
  const { reminders } = list(userDir);
  const entry = reminders.find((r) => r.id === id);
  if (!entry) return { ok: false, error: 'That reminder no longer exists.' };
  entry.alertedAt = occurrenceIso;
  save(userDir, reminders);
  return { ok: true };
}

// ── Occurrence expansion ────────────────────────────────────────────────────
// Reminder dates are the user's WALL dates — all math is local-time.

function parseLocal(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function toLocalIso(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function daysInMonth(year, month1) { // month1: 1–12
  return new Date(year, month1, 0).getDate();
}

/** Occurrence dates (YYYY-MM-DD strings) of one reminder within [fromIso, toIso]. */
function occurrencesBetween(reminder, fromIso, toIso) {
  if (!DATE_PATTERN.test(fromIso) || !DATE_PATTERN.test(toIso)) return [];
  const start = fromIso > reminder.date ? fromIso : reminder.date; // ISO strings compare correctly
  if (toIso < start) return [];

  if (reminder.repeat === 'none') {
    return reminder.date >= fromIso && reminder.date <= toIso ? [reminder.date] : [];
  }

  const out = [];
  const base = parseLocal(reminder.date);
  const cursor = parseLocal(start);
  const end = parseLocal(toIso);

  if (reminder.repeat === 'daily') {
    for (let d = new Date(cursor); d <= end && out.length < MAX_OCCURRENCES; d.setDate(d.getDate() + 1)) {
      out.push(toLocalIso(d));
    }
  } else if (reminder.repeat === 'weekly') {
    const d = new Date(cursor);
    d.setDate(d.getDate() + ((base.getDay() - d.getDay() + 7) % 7));
    for (; d <= end && out.length < MAX_OCCURRENCES; d.setDate(d.getDate() + 7)) {
      out.push(toLocalIso(d));
    }
  } else if (reminder.repeat === 'monthly') {
    const day = base.getDate();
    for (let y = cursor.getFullYear(), m = cursor.getMonth() + 1; ; m === 12 ? (y++, m = 1) : m++) {
      if (y > end.getFullYear() || (y === end.getFullYear() && m > end.getMonth() + 1)) break;
      if (day <= daysInMonth(y, m)) { // months without the day (e.g. the 31st) skip
        const iso = `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        if (iso >= start && iso <= toIso) out.push(iso);
      }
      if (out.length >= MAX_OCCURRENCES) break;
    }
  } else if (reminder.repeat === 'yearly') {
    const m = base.getMonth() + 1, day = base.getDate();
    for (let y = cursor.getFullYear(); y <= end.getFullYear() && out.length < MAX_OCCURRENCES; y++) {
      if (day <= daysInMonth(y, m)) { // Feb 29 only lands on leap years
        const iso = `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        if (iso >= start && iso <= toIso) out.push(iso);
      }
    }
  }
  return out;
}

/**
 * Expand reminders into dated occurrences within [fromIso, toIso], sorted by
 * date then time. The window is clamped to MAX_WINDOW_DAYS. Each occurrence
 * carries its parent's fields plus the concrete date.
 */
function expand(reminders, fromIso, toIso) {
  if (typeof fromIso !== 'string' || !DATE_PATTERN.test(fromIso)) return [];
  if (typeof toIso !== 'string' || !DATE_PATTERN.test(toIso)) return [];
  const cap = new Date(parseLocal(fromIso));
  cap.setDate(cap.getDate() + MAX_WINDOW_DAYS);
  const clampedTo = toIso <= toLocalIso(cap) ? toIso : toLocalIso(cap);

  const occurrences = [];
  for (const reminder of Array.isArray(reminders) ? reminders : []) {
    for (const date of occurrencesBetween(reminder, fromIso, clampedTo)) {
      occurrences.push({
        id: reminder.id,
        date,
        time: reminder.time,
        text: reminder.text,
        repeat: reminder.repeat,
        lead: reminder.lead,
        done: reminder.done,
        baseDate: reminder.date,
      });
      if (occurrences.length >= MAX_OCCURRENCES) break;
    }
    if (occurrences.length >= MAX_OCCURRENCES) break;
  }
  occurrences.sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
  return occurrences;
}

module.exports = { list, add, update, remove, toggle, markAlerted, expand, occurrencesBetween };
