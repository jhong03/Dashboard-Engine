# FINAL review note — paste this whole block into "Mark build ready for review"

(Plain text; addresses both failures from Build 25038603.)

---

Thank you for reviewing Build 25038603. Two items were flagged — both are addressed in
this build. Context and step-by-step verification below.

Dashboard Engine is a live desktop wallpaper (a Utilities app, not a game). It draws an
interactive dashboard onto the Windows desktop — behind the desktop icons, like Wallpaper
Engine. You interact by clicking the dashboard on the desktop. The AI assistant runs 100%
locally/offline (a bundled model — no internet, account, or setup).

==================================================
FAILURE 1 — "dashboard cannot be interacted with / clicks have no effect" — FIXED
==================================================

WHAT IT WAS: clicks were never disabled. Clicking the AI assistant loaded its local
model, and on the reviewed build that load FROZE the whole dashboard for up to ~48
seconds while it worked (the animated background kept moving, so it looked fine but
nothing responded — clicks were queued and only reacted once the load finished). This
build loads the model in the BACKGROUND without freezing anything, so the desktop stays
clickable the entire time. We also made the AI bar clickable across its whole area.

HOW TO VERIFY:

STEP 1 — See the dashboard:
1) Launch from Steam. On first run the Manager window opens — you can close it.
2) Press Windows key + D to minimize all windows and show your desktop.
3) The dashboard covers your desktop: clocks, meters, weather, and a dark bar across the
   BOTTOM reading "Ask anything, or give me a task on this machine..." with an EXECUTE
   button. (If you don't see it, press Win+D again — any open window sits on top of it.)

STEP 2 — The AI assistant (the main test):
1) Click anywhere on that bottom bar (the whole bar is clickable).
2) A chat panel appears.
3) IMPORTANT — please wait here. The first time, it shows "Warming up the assistant..."
   while the local model loads from disk: usually a few seconds, up to ~30 seconds the
   very first time on a slow or virtual machine. THIS IS NORMAL — IT IS NOT FROZEN. The
   rest of the desktop stays clickable meanwhile (please try STEP 3 while you wait).
4) When the text box lights up, type a message (e.g. "Hello, who are you?") + Enter.
5) It replies in text and speaks the reply aloud. This confirms the AI + voice work.

STEP 3 — The launcher (works even while the AI warms):
1) The dashboard shows a Launcher area with small app tiles.
2) Click any tile — that app opens (or its window comes to the front). This confirms the
   desktop receives clicks.

STEP 4 — A custom dashboard + a manually-added element:
1) Right-click the app's tray icon (near the clock, bottom-right) -> Open Manager.
2) Create a new dashboard (or Edit an existing one), add an "Assistant" and/or "Launcher"
   component, then Save.
3) Click "Use" to set it on the desktop, press Win+D, and repeat STEP 2 / STEP 3.

IF A CLICK SEEMS TO DO NOTHING: make sure you're clicking directly on a dashboard
component (not a desktop icon on top of it) with no window covering it (press Win+D), and
for the AI bar, wait for "Warming up the assistant..." to finish before typing.

==================================================
FAILURE 2 — Workshop / UGC moderation plan
==================================================

Users can share Dashboard packs and Voice profiles (tuning parameters only — never an
audio recording) via Steam Workshop. Moderation:

- PUBLISHED RULES: content guidelines are posted and PINNED on our Workshop Discussions
  hub (prohibiting illegal/CSAM content, pornography/extreme violence, hate/harassment,
  private info/impersonation, IP infringement, and malware / sandbox-escape code).
- PREVENTION (built-in): every downloaded pack is validated against a strict schema and
  NO code is executed from pack data (zero eval); any designer-authored script runs in a
  network-less sandboxed iframe with no OS/IPC/filesystem access; the installer is
  zip-slip- and zip-bomb-proof; the voice format stores parameters only, so uploading a
  voice recording is impossible by design.
- DETECTION: every Workshop item has an in-app Report action that opens the item's Steam
  page (where Steam's own Report control lives) and surfaces our review email; Steam-
  native reporting remains fully available, and Valve is the moderator of record.
- RESPONSE: confirmed violations are added to a bundled blocklist that refuses to install
  the item on every machine in the next app update, and we request Valve remove it.
  Reports are triaged within 72 hours; illegal content is escalated to Valve and the
  appropriate authorities immediately.

Please let us know if anything is unclear and we'll clarify right away.
