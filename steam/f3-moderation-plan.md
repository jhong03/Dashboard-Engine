# F3 — Steam Workshop / UGC moderation plan

Valve F3: *the app supports user-generated content (Steam Workshop) but no plan was
provided for how that content is moderated.*

This is the moderation plan for Dashboard Engine's Workshop. It uses **Steam-native
reporting** as the primary intake and a **developer-side blocklist** as the enforcement
mechanism — **no external server, account system, or new infrastructure** is introduced.

## What can be shared, and the rules

Two Workshop item types, both small and inert data — never executables:
- **Dashboard packs** (`pack.json` + image/video/audio assets, optional sandboxed
  HTML/JS "module" widgets).
- **Voice profiles** (~1 KB of JSON: a reference to a licensed base voice + numeric
  tuning parameters — **never any audio recording**).

**Content guidelines** (published on the Workshop page and enforced below). An item
must not contain or depict: sexual content involving minors or any illegal content;
pornographic or extreme-violence imagery; hate speech or harassment; real people's
private information; malware or code that attempts to escape the sandbox; or material
that infringes someone else's copyright or trademark (art, logos, characters, fonts,
or a third party's voice). Voice profiles must reference only the app's licensed base
voices; **uploading a voice sample is impossible by design** — the format stores no
audio.

## Prevention — structural gates (built, shipping)

Untrusted Workshop content is contained before it can do harm, independent of any human
review:
- **Schema sanitizer** (`lib/packs.js`): every field of a downloaded pack is validated,
  clamped, or dropped against a strict schema. There is **zero `eval` on pack data**; a
  pack is data rendered by our engine, not code we run.
- **Module sandbox**: designer HTML/JS runs in an `<iframe sandbox="allow-scripts">` at
  an opaque origin over a network-less CSP (`default-src 'none'`) — no IPC bridge, no
  Node, no network/fetch/WebRTC, no camera/mic/geolocation, no navigation or
  `window.open`. A hostile module can't reach the OS or exfiltrate anything.
- **Safe installer** (`lib/zip.js`): the `.dpack` reader is zip-slip- and zip-bomb-proof,
  with per-entry type and size caps.
- **No personal data in shared content** (`packstore.sanitizeForShare`): publishing an
  item strips the author's own data (location, labels, text) to neutral placeholders.
- **No audio ever**: the voice format cannot carry a recording, so voice-cloning and
  sample-upload abuse are structurally impossible.

## Detection — reporting (built, shipping)

- **In-app Report** action on every Workshop item (pack **and** voice), in the item's
  detail panel. It opens the item's Steam page — where Valve's own Report control lives —
  so a report reaches Valve's moderation queue, and it surfaces our direct review channel
  (`dashboardengine.support@gmail.com`) for reports that also warrant a developer block.
- **Steam-native reporting** remains fully available on every item page; Valve is the
  moderator of record for Workshop content.

## Response — enforcement (built, shipping)

- **Developer blocklist** (`moderation/blocklist.json`, versioned, bundled): a list of
  Workshop item ids the app **refuses to install/import** (`lib/moderation.js`, enforced
  at both import paths and hidden from Browse). When a report is confirmed, the id is
  added here and the next app release stops that item from installing on **every**
  machine — a kill-switch we control directly, in parallel with Valve removal.
- **Triage SLA**: reports to our channel are reviewed within **72 hours**. Confirmed
  violations → (1) add to the blocklist for the next release, and (2) request Valve
  remove the item from the Workshop.
- **Fail-soft**: a missing or malformed blocklist blocks nothing (never breaks a normal
  install), so the mechanism can't itself become a denial-of-service.

## Escalation

- **Illegal content** (e.g. CSAM): reported to Valve immediately for takedown and to the
  appropriate authorities; the id is blocklisted in the same release cycle.
- **Copyright / trademark**: handled via Steam's / Valve's DMCA process; the claimant is
  directed to Valve, and we blocklist the item on a confirmed claim.
- **Repeat offenders**: escalated to Valve, who own account-level enforcement on Steam.

## Paste-ready reviewer note

> User-generated content is shared through Steam Workshop and moderated as follows.
> Prevention: every downloaded pack is validated against a strict schema (no code is
> executed from pack data), any designer script runs in a network-less sandboxed iframe
> with no OS/IPC access, the installer is zip-slip/zip-bomb-proof, and the voice format
> stores parameters only — never audio, so voice-sample abuse is impossible. Detection:
> every Workshop item has an in-app Report action that opens Steam's report flow and
> our review email; Steam-native reporting is fully available. Response: confirmed
> violations are added to a bundled blocklist that refuses to install the item on every
> machine in the next update, and we request Valve remove it — reports are triaged within
> 72 hours, with illegal content escalated to Valve and the authorities immediately.

## Verified

`lib/moderation.js` 14-case unit test (blocklist parse, object/bare-string entries,
numeric-id normalization, whitespace trim, non-numeric junk ignored, null-safe, version
parsed, malformed JSON fails soft blocking nothing, shipped list parses empty at v1);
import gate returns `{ ok:false, blocked:true }` for a listed id; Browse filters blocked
ids. node -c clean; `packs validate` + `smoke` green; locales 1301×7.
