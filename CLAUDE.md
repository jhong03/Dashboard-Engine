# Dashboard Engine — Project Context

Read this before doing anything. It is the source of truth for architecture and constraints.

## What we're building

**Dashboard Engine**: a desktop platform where designers author and share dashboard packs — skin + layout + personality + voice for a live dashboard that renders straight onto the desktop, Wallpaper Engine style. Users browse, subscribe, install, and customize; the wallpaper thinks, speaks, and (eventually) acts on the machine.

We ship the engine. Designers author the content. We never ship or bundle a copyrighted character.

### Naming

The product was born "AEGIS Voice" and rebranded once its scope outgrew voice. Rules:
- User-visible surfaces say **Dashboard Engine** (titles, tray, docs).
- Internal names are FROZEN legacy and must not churn: the `window.aegis` bridge, `aegis:*` IPC channels, the `aegis-holo` reference pack id. AEGIS survives only as content (the reference pack's persona is a character named AEGIS).
- `.dpack` is the pack extension; legacy `.aegispack` installs forever. `DE_*` env vars are canonical; legacy `AEGIS_*` still honoured. User data migrates from the old `aegis-voice` dir automatically (lib/paths.js).

## Current state (as of 2026-07-13; M1–M3 + app shell + component depth + planner + launcher)

Dashboard Engine is a working Wallpaper-Engine-class product: designers publish packs, users subscribe/install/edit them, the active pack renders straight onto the desktop. Git log tells the full story milestone by milestone. Repo pushes to https://github.com/jhong03/Dashboard-Engine (origin/master) — push every commit.

**Confirmed 2026-07-13:** clicks reach the wallpaper-layer window — launcher tiles launch apps/files and focus windows on the user's machine. Interactive wallpaper components are a proven pattern.

**Windows & surfaces**
- **Desktop surface** (`src/dashboard.*`) — chromeless window reparented under the shell's wallpaper layer (`scripts/desktop-attach.ps1`, handles classic WorkerW and 24H2 Progman; `--no-desktop` or non-Windows falls back to a normal window). Narrowest preload in the app.
- **Manager** (`src/manager.*`) — THE app window: library gallery (cards are real frozen mini-renders via the shared renderer; the detail sidebar runs a LIVE in-motion preview at the display's aspect; blueprint/monogram only as fallbacks for unloadable/remote packs), Browse tab (registry feeds: subscribe / install / update, sha256+size-pinned downloads), Planner tab (Google-Calendar-style month grid: click-a-day quick-add, event chips, edit modal, repeats daily/weekly/monthly/yearly, per-event alert lead time), Launcher tab (pin apps from a Start Menu picker, files/folders via main-side dialog, reorder).
- **Editor** (`src/editor.*`) — WYSIWYG pack editor: palette drag&drop, move/resize/z/duplicate, three-tab inspector (component options, skin tokens, persona), image import (dialog + staging in MAIN only), fork-on-save (editing built-in/registry packs copies them; `packstore.saveEdited`). Stage uses the real display aspect ratio.
- **Voice panel** (`src/index.html` + `renderer.js`) — the M1 tuning panel as a tool window (`npm run panel`; isolated Chromium profile so it runs beside the engine).
- **Tray** — the engine lives here: Open Manager / Voice Tuning / Switch Pack (radio) / Pause-Resume Desktop / Quit. Closing windows never quits engine mode.

**Shared foundations**
- `src/components.js` — ONE renderer for desktop + editor (that's what makes the editor exact). 14 component types: status, clock, analog-clock, stats, meter, sparkline, text, image, divider, calendar, countdown, weather (Open-Meteo via main, keyless), agenda, launcher (user's pinned/recent/open apps as clickable tiles; opaque-id launch allowlist in main, `lib/launcher.js` + `scripts/windows-list.ps1`/`window-focus.ps1`). Telemetry binds: cpu, mem, disk, battery.
- `lib/packs.js` (schema-2 sanitizer, dual roots: built-in repo packs + user-data installs) · `lib/packstore.js` (install/export/uninstall/fork, .aegis-meta.json) · `lib/zip.js` (dependency-free, zip-slip/bomb-proof) · `lib/registry.js` (index feeds, update checks, tamper refusal) — pack format is `.dpack`, legacy `.aegispack` accepted.
- Voice: `lib/piper.js` / `dsp.js` / `analyze.js` / `voicebank.js` (8 licence-audited voices, sha256-pinned downloads, per-voice wpm calibration) + `presets/` + `lib/profiles.js`.
- Personal data in `%APPDATA%/dashboard-engine` (auto-migrates from the old `aegis-voice` dir): `settings.json` (active pack), `reminders.json` (`lib/reminders.js` — repeat rules expanded to occurrences in main; `lib/alerts.js` fires desktop notifications for timed events with lead time + 12 h missed-alert catch-up, click opens the planner), `launcher.json` (app pins + engine-tracked recents), installed packs, registries. **Personal data never enters a pack, export, or registry download.**

**Dev surface**
- `npm start` engine · `npm run panel` · `electron . --edit <id>` editor (works against a running engine via single-instance) · `--no-desktop`.
- Tests: `npm run selftest` (boots real app, synthesizes over live IPC) · `smoke` · `packs -- validate/export/install/uninstall` · `voices -- download/verify` · `calibrate` · `audition`.
- Env (legacy `AEGIS_*` still honoured): `DE_PACK`, `DE_VIEW=library|browse|planner`, `DE_SELFTEST`, `DE_PIPER_PATH`, `DE_FFMPEG_PATH`, and `DE_SHOT=<dir>` — captures every window via the Electron compositor (occlusion-proof; the ONLY reliable way to screenshot these windows).
- `PACKS.md` is the designer-facing doc: authoring, components, styles, `.dpack` export, registry hosting format.

**Hard-won rules (do not relearn these)**
- Every `fs.watch` gets an error handler — deleting a watched dir is an EPERM crash on Windows — and repaints are broadcast directly, never dependent on a watcher surviving. Main has a log-only `uncaughtException` guard (fail-soft).
- Component styling uses cqw container units only (design basis 1920px wide; 1px ≈ 0.0521cqw). A px size inside `.comp` styles breaks editor WYSIWYG and pack portability.
- Two Electron instances must never share a Chromium profile dir (deadlock); tool modes use an isolated one.
- Shells spawned from VS Code inherit `ELECTRON_RUN_AS_NODE=1` — clear it before launching Electron.

**Next milestone candidates (undecided — ask the user before starting)**
- LLM bridge + service-backed widgets (user explicitly wants: chatbot section with free tier default + personal API key option, Spotify/YouTube media, audio visualizer, Bluetooth nearby — each needs real infra: token storage, audio loopback, etc.)
- Official pack registry (format is static-hosting-only; just needs a home + default URL)
- Shell polish: auto-start with Windows, multi-monitor "choose display", editor stage zoom, per-pack user-adjustable properties (WE-style)
- Launcher v2: Windows-wide recent apps via UserAssist registry (v1 recents = shell Recent folder + launches through the engine), drag-reorder pins, jump lists. v1 shipped 2026-07-12 — the desktop surface covers icons on 24H2, so the launcher component replaces them (user's explicit call).
- Module SDK (sandboxed HTML packs) and the hosted marketplace (accounts/payments/moderation) remain out of scope until deliberately chosen.

## Stack

- Electron (main + preload + renderer, `contextIsolation: true`, `nodeIntegration: false`)
- Vanilla JS / HTML / CSS in the renderer. No React, no build step, no bundler. Keep it dependency-light.
- Piper (`piper` CLI, ONNX neural TTS) for synthesis — local, offline, CPU
- ffmpeg for the DSP chain
- Node 18+, Windows-first (must not hard-break on macOS/Linux)

## Non-negotiable constraints

- **Voice profiles contain parameters, never audio.** No recordings, no cloned voices, no user-uploaded audio anywhere in the system. A profile is ~1 KB of JSON referencing a licensed base voice plus transformations. This is a legal boundary, not a preference. Do not add an "upload a voice sample" feature under any circumstances.
- **The renderer never touches Node or the OS.** All shell/filesystem/process work happens in the main process behind explicit IPC handlers exposed via `preload.js`. No `nodeIntegration`.
- **Never spawn a shell command built from user text.** Prompts and text go to child processes via stdin, never interpolated into a command line.
- **No browser storage APIs** (`localStorage`, `sessionStorage`) — persist to disk via the main process.
- **Fail soft.** If Piper or ffmpeg is missing, the app must still run and fall back to the OS/system TTS voice with a clear, actionable message. Never crash, never show a raw stack trace to a user.

## Design language

Two registers, never mixed:

**Pack content** — the desktop surface and anything a pack renders. Dark, holographic, technical; this is where the brand look lives (and packs may look like anything at all).
- Palette (reference packs): void `#04080F` · glass `rgba(10,22,35,.55)` · cyan `#3FD8FF` · bright `#7FE9FF` · steel `#5A7E93` · amber `#FFB23E` (warnings) · gold `#E8C56A`
- Type: Rajdhani for display (uppercase, letter-spaced), Share Tech Mono for readouts. These fonts belong to pack content ONLY.
- Glass panels, hairline borders, corner notches, subtle glow, constant-but-subtle motion.

**Engine chrome** — the manager, editor, and voice panel: a quiet, native-feeling dark utility that disappears next to the content it manages. Think well-made desktop tool, not sci-fi console.
- Neutral darks (`#1b1d21` bg · `#242629` panels · `#35383e` borders), text `#e6e8eb` / `#9aa1aa`, one muted accent `#4c8dff`, amber `#e0a446` for warnings only.
- System font stack, sentence case, normal letter-spacing. Monospace (Consolas) only for genuinely numeric/technical values.
- 6px radii, 1px borders, restrained hover states. No glow, no scanlines, no notches, no ambient animation.

Quality floor for both: keyboard focus visible, `prefers-reduced-motion` respected, no layout that breaks under the window minimums.

## Code conventions

- Comment the *why*, not the *what*.
- Small, single-purpose functions. No clever one-liners.
- Config and constants at the top of the file, never buried.
- Every IPC handler validates its input. Assume the renderer is hostile (one day it will be running someone else's pack).
- Prefer clarity over abstraction. We're early; premature layering will hurt.

## Definition of done for any task

- It runs on a clean `npm install && npm start`
- It degrades gracefully with dependencies missing
- No secrets, keys, or absolute personal paths in committed code
- I can hand it to a stranger and they understand it in ten minutes
