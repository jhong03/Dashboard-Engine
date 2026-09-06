# Resubmission readiness — vs. BuildID 25038603 review failures

Last updated after: warmup-freeze fix, whole-bar-clickable, reviewer instructions,
Workshop guidelines POSTED + pinned.

---

## ✅ DONE

### Failure 1 — "dashboard not interactable"
- [x] Diagnosed: the **assistant-warmup freeze** (48 s main-thread block, confirmed in the log). Clicks reach fine — the load looked like a freeze.
- [x] **Fix (f2479f5):** stagger LLM/voice cold-loads + drop the redundant `synthSpeech('Hello.')`. Retest = **zero main-thread stalls**, "quite smooth now."
- [x] Supporting: voice engines below-normal CPU priority; Low/Med/High idle tiering; High stays warm through fullscreen.
- [x] **Whole assistant bar clickable (6658680)** — not just the inner text line (matches the pointer cursor; bigger target for the reviewer).
- [x] **Reviewer step-by-step instructions written** (steam/reviewer-instructions.md).

### Failure 2 — Workshop moderation
- [x] Moderation plan built + shipping (schema sanitizer, sandbox, zip-safe installer, no-audio voice format; in-app Report; blocklist kill-switch + 72 h triage; escalation). lib/moderation.js + 14-case test.
- [x] Content guidelines written.
- [x] **Guidelines POSTED + PINNED** on the Workshop Discussions hub (public, reviewer-visible). ← done just now.

---

## ⬜ REMAINING (the path to resubmit)

1. [ ] **Combined review note** — assemble interaction instructions + moderation plan into one paste-ready block for the "Mark build ready for review" field.  *(I can do this now.)*
2. [ ] **Rebuild** — `rm -rf dist && npm run dist` (bundles everything since 25038603: freeze fix, whole-bar-clickable, ffmpeg, VC++ runtime, voice priority/tiering). *(I do this — needs the app closed.)*
3. [ ] **Re-upload** via SteamPipe → **Set build live** on Default. *(steamcmd command; you approve/run.)*
4. [ ] **Mark ready for review** with the combined note pasted in. *(you, on the web.)*

---

## Decisions locked (no action)
- **I/O-throttle insurance:** SKIP. The stagger already fixes the memory/paging cause; the clean Windows API can't even be applied to the prebuilt LLM. Revisit only if a rebuilt+resubmitted build still stutters on the review VM.
- **Structural click-not-reaching hardening (verify-input → fallback):** HOLD. Clicks demonstrably reach on real machines (the "burst after freeze" proved it); probably not what the reviewer hit. Revisit only if a 4th review fails with the same click complaint.

## Can't fully do here
- **Verify on the review VM** — we can't replicate a low-RAM Steam review VM; the definitive proof is the review itself. The stagger directly targets the cause that VM hit, so confidence is reasonable but not certain.

## Diagnostics shipping in the build (kept on purpose)
- Always-on stall watchdog + warmup timing → engine.log (rotates ~1 MB, silent in normal use). Keeps future freezes self-documenting in the packaged app. Harmless to ship; strip later if desired.
