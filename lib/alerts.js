'use strict';

// Alert scheduler for timed reminders. The engine lives in the tray, so this
// runs in the main process for as long as the desktop persona does: it keeps
// one timer armed for the next upcoming alert and fires a desktop
// notification when the moment (minus the reminder's lead time) arrives.
//
// Catch-up: if the PC was off/asleep when an alert came due, the next rearm
// fires it late rather than silently skipping — but only within a bounded
// window, so a week away from the machine doesn't replay a week of alerts.
//
// Everything is injected (notify, now) so the logic tests without Electron.

const reminders = require('./reminders');

const CATCH_UP_MS = 12 * 60 * 60 * 1000;   // fire late alerts up to 12 h after
const MAX_SLEEP_MS = 24 * 60 * 60 * 1000;  // re-scan at least daily (repeats far out)
const SCAN_AHEAD_DAYS = 370;               // covers the next yearly occurrence

function parseOccurrence(dateIso, time) {
  const [y, m, d] = dateIso.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  return new Date(y, m - 1, d, hh, mm).getTime();
}

function localIso(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * @param {object} deps
 * @param {string}   deps.userDir  user-data dir holding reminders.json
 * @param {function} deps.notify   (occurrence, minutesLate) => void
 * @param {function} [deps.now]    ms clock, injectable for tests
 */
function createAlertScheduler({ userDir, notify, now = () => Date.now() }) {
  let timer = null;
  let stopped = false;

  // Every timed, not-done occurrence in the scan window, with its alert
  // moment (occurrence minus lead) and whether it has already been alerted.
  function pendingAlerts() {
    const t = now();
    const from = localIso(t - CATCH_UP_MS - 24 * 60 * 60 * 1000);
    const to = localIso(t + SCAN_AHEAD_DAYS * 24 * 60 * 60 * 1000);
    const { reminders: all } = reminders.list(userDir);
    const pending = [];
    for (const occurrence of reminders.expand(all, from, to)) {
      if (!occurrence.time || occurrence.done) continue;
      const occurrenceIso = `${occurrence.date}T${occurrence.time}`;
      const parent = all.find((r) => r.id === occurrence.id);
      if (parent && parent.alertedAt && parent.alertedAt >= occurrenceIso) continue; // already alerted
      pending.push({
        occurrence,
        occurrenceIso,
        alertAt: parseOccurrence(occurrence.date, occurrence.time) - occurrence.lead * 60 * 1000,
      });
    }
    pending.sort((a, b) => a.alertAt - b.alertAt);
    return pending;
  }

  // Fire everything due (within the catch-up window), then arm one timer for
  // the earliest future alert. Called on boot, on any reminders change, and
  // when the armed timer wakes.
  function rearm() {
    if (stopped) return;
    if (timer) { clearTimeout(timer); timer = null; }
    const t = now();

    let nextAt = null;
    const dueByReminder = new Map(); // fire only the latest missed occurrence per reminder
    for (const p of pendingAlerts()) {
      if (p.alertAt <= t) {
        if (t - p.alertAt <= CATCH_UP_MS) dueByReminder.set(p.occurrence.id, p);
        else reminders.markAlerted(userDir, p.occurrence.id, p.occurrenceIso); // too old — skip silently
      } else if (nextAt === null) {
        nextAt = p.alertAt;
      }
    }

    for (const p of dueByReminder.values()) {
      // Mark before notifying: a notifier that throws must not retry forever.
      reminders.markAlerted(userDir, p.occurrence.id, p.occurrenceIso);
      try {
        notify(p.occurrence, Math.max(0, Math.round((t - p.alertAt) / 60000)));
      } catch (err) {
        console.warn(`[alerts] notification failed: ${err.message}`);
      }
    }
    if (dueByReminder.size > 0) return rearm(); // marking changed state; re-derive nextAt

    const sleep = nextAt === null ? MAX_SLEEP_MS : Math.min(Math.max(nextAt - t, 1000), MAX_SLEEP_MS);
    timer = setTimeout(rearm, sleep);
    if (typeof timer.unref === 'function') timer.unref(); // never hold the process open
  }

  function stop() {
    stopped = true;
    if (timer) { clearTimeout(timer); timer = null; }
  }

  return { rearm, stop };
}

module.exports = { createAlertScheduler };
