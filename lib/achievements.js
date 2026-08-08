'use strict';

// Steam achievements — a thin, FAIL-SOFT wrapper (CLAUDE.md rule).
//
// Unlocks are one-shot booleans (no Steam Stats). We reuse the single Steam
// client the Workshop bridge already owns (lib/workshop.getClient), so there's
// no second init, and we quietly no-op whenever Steam isn't available — an
// achievement can NEVER break a feature. Idempotent: a per-session guard plus
// Steam's own persistence avoid redundant native calls.
//
// The API names here must match the ones configured in Steamworks exactly.

const workshop = require('./workshop');

const unlockedThisSession = new Set();

// Unlock an achievement by its Steamworks API name. Safe to call as often as you
// like at a trigger point — repeated calls are cheap and harmless.
function unlock(name) {
  if (typeof name !== 'string' || !name) return false;
  if (unlockedThisSession.has(name)) return true;

  let client = null;
  try { client = workshop.getClient(); } catch (err) { client = null; }
  if (!client || !client.achievement) return false;

  try {
    // Already unlocked in a previous session? Remember it and skip the write.
    if (typeof client.achievement.isActivated === 'function' && client.achievement.isActivated(name)) {
      unlockedThisSession.add(name);
      return true;
    }
  } catch (err) { /* isActivated is best-effort */ }

  try {
    client.achievement.activate(name); // sets + stores + fires the Steam toast
    unlockedThisSession.add(name);
    return true;
  } catch (err) {
    return false; // never surface an achievement error to a feature
  }
}

module.exports = { unlock };
