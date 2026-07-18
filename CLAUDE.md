# Dashboard Engine — Project Context

Read this before doing anything. It is the source of truth for architecture and constraints.

## What we're building

**Dashboard Engine**: a desktop platform where designers author and share dashboard packs — skin + layout + personality + voice for a live dashboard that renders straight onto the desktop, Wallpaper Engine style. Users browse, subscribe, install, and customize; the wallpaper thinks, speaks, and (eventually) acts on the machine.

We ship the engine. Designers author the content. We never ship or bundle a copyrighted character.

### Naming

The product was born "AEGIS Voice" and rebranded once its scope outgrew voice. Rules:
- User-visible surfaces say **Dashboard Engine** (titles, tray, docs).
- Internal names are FROZEN legacy and must not churn: the `window.aegis` bridge, `aegis:*` IPC channels. The `aegis-holo` pack id stays reserved (legacy) even though the pack was removed.
- `jarvis` is the DEFAULT built-in pack — the owner's port of their own standalone "JARVIS Dashboard" app (owner's explicit call 2026-07-13; the "no copyrighted characters" rule below is owner-waived for this one pack). The old `aegis-holo`/`ember-archive` references were removed 2026-07-13 (recoverable from git history).
- A **seed gallery** of 8 built-in packs demonstrates range for new users (each clears the JARVIS quality floor; distinct aesthetic + persona + component coverage): `jarvis` (sci-fi HUD, default), `hearth` (warm/cozy serif + embers), `slate` (minimal monochrome), `sakura` (anime spring, petals + soft-sky wallpaper), `pastel-dream` (kawaii, sparkles + pastel wallpaper), `gothic-noir` (crimson/black serif, heavy vignette), `vaporwave` (retro sun-grid wallpaper, scanlines), `neon-cyberpunk` (neon-skyline wallpaper, rain). Wallpapers are procedurally generated (original art, no IP) — see the generator approach in scratch/`gen-wallpapers.js` (minimal zlib PNG encoder). Anime packs are aesthetic-only: NO copyrighted characters in public defaults. Font limit: only 4 built-in stacks (no custom fonts in packs) — palette/shape/ambience carry mood; adding system-font stacks is the lever for more cute/expressive range (still an open option).
- **Ambience effects** (`skin.ambience.effect`, engine-drawn particle layer, reduced-motion safe): none, embers, dust, snow, petals (sakura), rain (cyberpunk), sparkle (twinkling stars, pastel). Colour comes from a palette key per effect; density 0.05–1.
- **QUALITY FLOOR (owner directive 2026-07-13): the JARVIS pack is the bare minimum for design and component usability. Nothing ships — no component, no reference pack, no default — that looks or works worse than it.**
- `.dpack` is the pack extension; legacy `.aegispack` installs forever. `DE_*` env vars are canonical; legacy `AEGIS_*` still honoured. User data migrates from the old `aegis-voice` dir automatically (lib/paths.js).

## Current state (as of 2026-07-13; M1–M3 + app shell + component depth + planner + launcher + JARVIS default)

Dashboard Engine is a working Wallpaper-Engine-class product: designers publish packs, users subscribe/install/edit them, the active pack renders straight onto the desktop. Git log tells the full story milestone by milestone. Repo pushes to https://github.com/jhong03/Dashboard-Engine (origin/master) — push every commit.

**Confirmed 2026-07-13:** clicks reach the wallpaper-layer window — launcher tiles launch apps/files and focus windows on the user's machine. Interactive wallpaper components are a proven pattern.

**Windows & surfaces**
- **Desktop surface** (`src/dashboard.*`) — chromeless window reparented under the shell's wallpaper layer (`scripts/desktop-attach.ps1`, handles classic WorkerW and 24H2 Progman; `--no-desktop` or non-Windows falls back to a normal window). Narrowest preload in the app.
- **Manager** (`src/manager.*`) — THE app window: library gallery (cards are real frozen mini-renders via the shared renderer; the detail sidebar runs a LIVE in-motion preview at the display's aspect; blueprint/monogram only as fallbacks for unloadable/remote packs), Browse tab (registry feeds: subscribe / install / update, sha256+size-pinned downloads), Planner tab (Google-Calendar-style month grid: click-a-day quick-add, event chips, edit modal, repeats daily/weekly/monthly/yearly, per-event alert lead time), Launcher tab (pin apps from a Start Menu picker, files/folders via main-side dialog, reorder).
- **Editor** (`src/editor.*`) — WYSIWYG pack editor: palette drag&drop, move/resize/z/duplicate, three-tab inspector (component options, skin tokens, persona), image import (dialog + staging in MAIN only), fork-on-save (editing built-in/registry packs copies them; `packstore.saveEdited`). Stage uses the real display aspect ratio.
- **Voice panel** (`src/index.html` + `renderer.js`) — the M1 tuning panel as a tool window (`npm run panel`; isolated Chromium profile so it runs beside the engine).
- **Tray** — the engine lives here: Open Manager / Voice Tuning / Switch Pack (radio) / Pause-Resume Desktop / **Performance** (submenu: pause on full-screen apps, pause on battery, fps cap 24/30/48/60) / Quit. Closing windows never quits engine mode.
- **Performance citizenship** (shipped 2026-07-15): the animated wallpaper pauses/throttles like Wallpaper Engine so it's a good 24/7 citizen. `lib/presence.js` runs ONE long-lived PowerShell watcher (`scripts/fullscreen-watch.ps1`; compiles the P/Invoke once, cheap polls every 3 s, emits FULLSCREEN/NORMAL on change) → main folds that with `powerMonitor` battery state + the user's prefs (`settings.getPerformance`: `pauseOnFullscreen` default on, `pauseOnBattery` default off, `maxFps` default 30) into `aegis:desktop:power {active,maxFps}`, sent on did-finish-load + every change. The desktop renderer (dashboard.js) caches the pack; `active:false` → `renderer.destroy()` + `AegisComponents.freezeAmbience(body)` freezes the last frame at ~0 CPU; resume re-renders from cache; `maxFps` caps the ambience raf loop. FAIL-SOFT: non-Windows / spawn fail / watcher death → never full-screen, wallpaper keeps running. Manual tray Pause still just hides the window. **DETECTION (fixed 2026-07-19):** freezes only when a real window actually COVERS THE PRIMARY MONITOR (foreground-window geometry vs the primary `GetMonitorInfo` rect; excludes the shell classes + our WS_CHILD reparented window). NOT `SHQueryUserNotificationState` — that reported "busy" for any background full-screen app (a game left running), which froze a fully-visible wallpaper on its empty pre-telemetry frame (the "everything shows –, stuck" bug), and it also missed borderless full-screen. Foreground-covers-primary catches borderless too and resumes the instant you're back on the desktop; a full-screen app on a secondary monitor doesn't pause the primary wallpaper.

**Shared foundations**
- `src/components.js` — ONE renderer for desktop + editor (that's what makes the editor exact). 20 component types: status, clock, analog-clock, hud-clock (reactor rings), stats, cores (per-core bars), sysinfo (key/value readouts incl. uptime/host), meter, sparkline, text, image, divider, calendar, countdown, weather (Open-Meteo via main, keyless; `compact` one-line strip), agenda, notifications (live Windows toasts via WinRT UserNotificationListener in main, `scripts/notifications-list.ps1`; personal data, fail-soft if access not granted), launcher (user's pinned/recent/open apps as clickable tiles; opaque-id launch allowlist in main, `lib/launcher.js` + `scripts/windows-list.ps1`/`window-focus.ps1`), assistant (console line that opens the AI chat on click), module (SHIPPED 2026-07-15 — designer-authored sandboxed HTML/CSS/JS; see Module SDK below). Telemetry binds: cpu, mem, disk, battery (+ coresPercent/uptimeSec/hostname in the stats sample).
- **Module SDK** (shipped 2026-07-15; the once-out-of-scope "sandboxed HTML packs", now the owner's explicit call): the `module` component runs untrusted designer HTML/JS in an `<iframe sandbox="allow-scripts">` (opaque origin) loaded from a custom `demodule://` scheme (main.js) — a custom scheme does NOT inherit the trusted page's strict CSP the way srcdoc/data: do, so the frame runs its own inline code under a served, NETWORK-LESS CSP (`default-src 'none'`; no connect/fetch/ws; imgs/fonts data: only; no eval). The whole wrapped doc rides in the frame URL as base64url; main echoes it back (never parses/runs it). Code is stored inline in `options.html` (≤24 KB; manifest cap raised to 256 KB). The engine↔module channel is postMessage-only and ONE-WAY push: theme tokens (`--de-*` CSS vars + `DE.onTheme`) + public system telemetry (`DE.onData`, NO hostname/personal data) + pack images (`DE.asset`) — the module can never drive the engine. CRITICAL preload hardening: every pack-hosting preload (dashboard/editor/manager) now exposes the `aegis` bridge ONLY when `window===window.top`, so a module subframe can't reach IPC. `frame-src demodule:` added to the three page CSPs. Authored in the editor (Custom module palette entry → live code box). Verified with a hostile probe module: IPC/Node/cross-origin/storage/cookies/eval/fetch all blocked; theme + live stats work. Docs: PACKS.md → Module SDK.
- **AI assistant / LLM bridge** (`lib/assistant.js` + the `assistant` component in `src/components.js`): FREE by default — a keyless community endpoint (Pollinations, `text.pollinations.ai/openai`) with a live model list (`aegis:assistant:models`); works with no account/key/charge. Second provider `openai` = any OpenAI-compatible endpoint (base URL + OPTIONAL key) for local Ollama/LM Studio or a free-tier account (OpenRouter/Groq) to unlock more brands (Gemini/Qwen/Llama/DeepSeek). GPT-4/Claude are NOT free anywhere; keyless free is currently ~1 open model (GPT-OSS). Any key entered is stored OS-encrypted via Electron `safeStorage`, never exposed to a renderer (only `hasKey`) or written into a pack/export. Configured in Manager → Assistant tab. The chat is an IN-PACK COMPONENT (`assistant`), NOT a separate window: each pack's assistant component IS the real, typeable console — a live `<input>` with an inline reply log that expands upward, rendered right in the wallpaper (`buildAssistant`). To let that input take keyboard focus the desktop window is now `focusable:true` (mouse-on-wallpaper was already proven; keyboard-on-wallpaper is the thing to watch — it's shown `showInactive` so it never steals focus at launch). The OLD docked-window system (`createAssistantWindow`/`syncConsole`/`resizeConsole` + the `src/assistant.*` and `preload-assistant.js` files) was REMOVED once and for all — one dialog per dashboard, no overlap. Editor/manager previews render the component as a static prompt line (no `services.assistant` there). Replies are spoken via `aegis:assistant:speak` (piper/dsp with the saved profile); conversation state lives in main (`aegis:assistant:ask`, `:reset`).
- `lib/packs.js` (schema-2 sanitizer, dual roots: built-in repo packs + user-data installs) · `lib/packstore.js` (install/export/uninstall/fork, .aegis-meta.json) · `lib/zip.js` (dependency-free, zip-slip/bomb-proof) · `lib/registry.js` (index feeds, update checks, tamper refusal) — pack format is `.dpack`, legacy `.aegispack` accepted.
- **Steam Workshop** (`lib/workshop.js`, PROTOTYPE, shipped 2026-07-15): publish packs to / read subscribed packs from Steam Workshop (WE's channel), via the `steamworks.js` binding (OPTIONAL dependency — native N-API prebuilds win/mac/linux; loaded lazily in MAIN, never renderer). Runs against Valve's public **test AppID 480 (Spacewar)** so the full create/upload/subscribe flow works with NO Steamworks partnership — `steam_appid.txt` (=480, DEV-ONLY, must be deleted for a real Steam build) provides the appid. FAIL-SOFT throughout: no binding or no running Steam client → every path reports Workshop unavailable and the engine is unchanged (verified live: status returned available+real username with Steam running). Publish stages only pack.json+assets (never .aegis-meta or personal data), **renders a real preview image of the dashboard** (off-screen window loading `src/shot.*` with DEMO/empty data so NO personal info is captured — main `renderPackPreview` via `offscreen:true` capturePage, PNG or JPEG if >1 MB; falls back to the pack wallpaper), auto-writes a **rich BBCode description** (persona + component list + author, editable in the dialog), and returns the Workshop URL. IPC `aegis:workshop:status/publish/subscribed/import`; Manager pack-detail has a **Publish to Workshop…** dialog (title/desc/tags/visibility); `importSubscribed` brings a subscribed item into the library via exportPack→installFromBuffer. **The gate is business, not code:** real Workshop needs the app shipped on Steam (Steam Direct $100 + AppID + Valve review). BigInt itemIds cross IPC as strings. Untrusted Workshop packs are safe via the existing sanitizer + Module-SDK sandbox. Consume-side gallery UI (subscribed items as first-class gallery entries) is the main open follow-up; also a real AppID + a Steam build pipeline.
- Voice: `lib/piper.js` / `dsp.js` / `analyze.js` / `voicebank.js` (8 licence-audited voices, sha256-pinned downloads, per-voice wpm calibration) + `presets/` + `lib/profiles.js`.
- Personal data in `%APPDATA%/dashboard-engine` (auto-migrates from the old `aegis-voice` dir): `settings.json` (active pack), `reminders.json` (`lib/reminders.js` — repeat rules expanded to occurrences in main; `lib/alerts.js` fires desktop notifications for timed events with lead time + 12 h missed-alert catch-up, click opens the planner), `launcher.json` (app pins + engine-tracked recents), installed packs, registries. **Personal data never enters a pack, export, or registry download.**

**Dev surface**
- `npm start` engine · `npm run panel` · `electron . --edit <id>` editor (works against a running engine via single-instance) · `--no-desktop`.
- Tests: `npm run selftest` (boots real app, synthesizes over live IPC) · `smoke` · `packs -- validate/export/install/uninstall` · `voices -- download/verify` · `calibrate` · `audition`.
- Env (legacy `AEGIS_*` still honoured): `DE_PACK`, `DE_VIEW=library|browse|planner`, `DE_SELFTEST`, `DE_PIPER_PATH`, `DE_FFMPEG_PATH`, `DE_SHOT=<dir>` — captures every window via the Electron compositor (occlusion-proof; the ONLY reliable way to screenshot these windows), and `DE_SHOTPREVIEW=<dir>` — renders `DE_PACK`'s Workshop preview image (demo data) to `<dir>/preview.png` and quits.
- `PACKS.md` is the designer-facing doc: authoring, components, styles, `.dpack` export, registry hosting format.

**Hard-won rules (do not relearn these)**
- Every `fs.watch` gets an error handler — deleting a watched dir is an EPERM crash on Windows — and repaints are broadcast directly, never dependent on a watcher surviving. Main has a log-only `uncaughtException` guard (fail-soft).
- Component styling uses cqw container units only (design basis 1920px wide; 1px ≈ 0.0521cqw). A px size inside `.comp` styles breaks editor WYSIWYG and pack portability.
- Two Electron instances must never share a Chromium profile dir (deadlock); tool modes use an isolated one.
- Shells spawned from VS Code inherit `ELECTRON_RUN_AS_NODE=1` — clear it before launching Electron.

**Next milestone candidates (undecided — ask the user before starting)**
- LLM bridge SHIPPED 2026-07-13 (free keyless chat by default via Pollinations + optional OpenAI-compatible endpoint for more models, voice-spoken replies, desktop console). Still open: response streaming, richer curated free-model presets, and the rest of the service widgets — Spotify/YouTube media, audio visualizer, Bluetooth nearby, net-rate telemetry (each needs real infra: OAuth token storage, audio loopback, etc.)
- Official pack registry (format is static-hosting-only; just needs a home + default URL). Steam Workshop is now an ALTERNATIVE/parallel channel (prototype shipped 2026-07-15 against test app 480; see the Workshop entry above) — WE-style, both can coexist. Real Workshop is gated on shipping the app on Steam ($100 Steam Direct + AppID + Valve review), a business decision the owner has NOT yet made — the code path is proven against Spacewar.
- Shell polish: auto-start with Windows, multi-monitor "choose display", editor stage zoom, per-pack user-adjustable properties (WE-style). Performance citizenship (pause on full-screen/battery + fps cap) SHIPPED 2026-07-15 (see above) — first item of the "road to a paid Steam launch" (owner chose flat paid ~$3.99; Steam ownership = the paywall, no gating code). Remaining launch-blockers: multi-monitor, auto-start, per-pack properties, onboarding + a real Settings screen (tray-only for now), DPI/ultrawide hardening, crash reporting.
- Launcher v2: Windows-wide recent apps via UserAssist registry (v1 recents = shell Recent folder + launches through the engine), drag-reorder pins, jump lists. v1 shipped 2026-07-12 — the desktop surface covers icons on 24H2, so the launcher component replaces them (user's explicit call).
- Module SDK (sandboxed HTML packs) SHIPPED 2026-07-15 (see the Module SDK entry above). The hosted marketplace (accounts/payments/moderation) remains out of scope until deliberately chosen. Open follow-ups: a `DE.asset()`-style richer capability surface, a curated module gallery/examples, and possibly per-module user-adjustable properties.

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
