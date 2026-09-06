# Resubmission readiness — vs. BuildID 25038603 review failures

Two failures were reported. Status of each below. **The single blocker is: the fixes
are in source but not in a built/uploaded build — the reviewer tested 25038603, which
had NONE of them.**

---

## FAILURE 1 — "Dashboards cannot be interacted with once set to the desktop; clicks have no effect on any menu, including the AI box; as if clicks are disabled / can't obtain focus."

### Root cause (diagnosed with hard data)
The **assistant-warmup freeze**, NOT clicks failing to reach the window. Clicking the
"Ask anything" bar cold-loaded the LLM (~1 GB) + voice (~0.9 GB) **simultaneously** →
main thread stalled up to **48 s** (RAM exhaustion / paging on a low-RAM VM) → the
dashboard looked dead (the particle canvas kept animating, so it *seemed* fine) → the
reviewer's clicks queued and appeared ignored → "nothing is interactable."
Proof: `engine.log` logged `[STALL] main-thread blocked ~48029ms`, and the "burst of
queued clicks after the freeze" proves the clicks DID register (so it's the freeze, not
a click-routing bug).

### DONE ✅
- [x] Diagnosed via always-on stall watchdog + warmup timing (fd40829, 67aa1bb).
- [x] **THE FIX (f2479f5):** stagger the cold-loads (LLM first, voice in the background) + drop the redundant `synthSpeech('Hello.')`. Never loads ~2 GB at once. **Retest result: ZERO main-thread stalls during warmup** (was 875 ms + 1936 ms + 48 s); the cold LLM load (~2.8 s) now runs in the background without freezing the desktop; free RAM held ~3 GB. Owner confirmed "quite smooth now."
- [x] Supporting fixes: voice engines at **below-normal CPU priority** (de4e5f4); Low/Med/High **idle tiering** (High keeps the engine always warm → no cold-load at all); High stays warm through fullscreen (1ee632e).

### NOT DONE / TO DO ⬜
- [ ] **REBUILD + RE-UPLOAD** — the fix is only in source/dev. `rm -rf dist && npm run dist` → SteamPipe → set live. **← the actual blocker.**
- [ ] **Reviewer instructions** in the notes (the reviewer explicitly ASKED for "instructions on how to progress"): which components are interactive + what each does + that the assistant warms ~2-3 s after a cold click (input shows "warming up," desktop stays clickable).
- [ ] **(Optional insurance)** Throttle the engines' **disk-I/O priority** (Windows background mode, not just CPU) for extra margin on a weak-disk / very-low-RAM VM.
- [ ] **(Residual risk — honest)** A separate structural finding: the WorkerW reparent lands *behind* the desktop icon layer, and the attach reports "success" without verifying clicks reach the window — so on a machine where the reparent lands in a non-input spot, the clickable fallback never fires. Clicks DO reach on the dev box (proven by the burst) and the app has worked as an interactive wallpaper, so this is probably NOT what the reviewer hit — but it can't be verified without the VM. **Decision:** harden the attach (verify-input → fallback) as insurance, or bet on the warmup fix + instructions first.
- [ ] **Verify on a clean/low-RAM environment** — the definitive test is the review VM; we can't fully replicate it here.

---

## FAILURE 2 — "What are your moderation plans for Workshop UGC?"

### DONE ✅
- [x] Full moderation plan built + documented (steam/f3-moderation-plan.md): guidelines → prevention (schema sanitizer, network-less sandboxed module iframe, zip-slip/bomb-safe installer, no-audio voice format) → detection (in-app Report → Steam's native flow + our email) → response (bundled **blocklist kill-switch** + **72 h triage** + request Valve removal) → escalation (illegal → Valve + authorities). Code shipping (lib/moderation.js, 14-case test).
- [x] Paste-ready public guidelines written (steam/workshop-guidelines-to-post.md).

### NOT DONE / TO DO ⬜
- [ ] **OWNER: POST the guidelines** on the Workshop page (About / a pinned Rules post) — Steam wants to SEE published rules, not just be told. **← your action, no code.**
- [ ] Restate the moderation plan (prevention/detection/response/escalation) clearly in the resubmission notes.

---

## RESUBMISSION STEPS (once the above are done)
- [ ] Rebuild dist (bundles: the freeze fix + ffmpeg + VC++ runtime + everything since 25038603).
- [ ] SteamPipe upload → set the new build live on Default.
- [ ] Mark ready for review with notes = (1) component-interaction guide, (2) moderation plan. Keep it clean — do NOT re-append the LLM-customization question (it got bounced to Developer Support last time and isn't needed).
