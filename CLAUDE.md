# AEGIS — Project Context

Read this before doing anything. It is the source of truth for architecture and constraints.

## What we're building

A desktop platform where users author and share Persona Packs — a dashboard skin + layout + personality + voice for an AI assistant that lives on their desktop. Think: Wallpaper Engine's creator ecosystem, but the wallpaper thinks, speaks, and can act on the machine.

We ship the engine. Users author the characters. We never ship or bundle a copyrighted character.

## Current milestone

**M3 — Pack Ecosystem.** (M1 voice panel and M2 skin engine shipped 2026-07-12.)

AEGIS is an ENGINE, not a personal dashboard app: designers anywhere publish packs, users subscribe and install them, the engine renders whatever arrives. M3 builds that loop. Scope decisions, agreed and fixed:

- **Engine/content split.** The repo ships the engine plus exactly two built-in reference packs (aegis-holo, ember-archive). Installed packs live in the user-data directory, never in the repo.
- **Wallpaper Engine window model.** On launch the active pack renders straight onto the desktop (frameless window reparented under the shell's wallpaper layer on Windows via scripts/desktop-attach.ps1; plain-window fallback elsewhere). The app window is the MANAGER — content navigation and selection only. `--panel` / selftest open the voice panel as a standalone tool.
- **Portable pack format:** `.aegispack` (zip of pack.json + assets), imported/exported in-app. Zip contents are validated with the same hostility as everything else (entry-name allowlist, size caps, no zip-slip).
- **Registry feeds:** users subscribe to https index URLs (anyone can host one — it's a static JSON listing packs with version, download URL, sha256). In-app browse / install / update / uninstall. Integrity comes from the index-pinned sha256; authenticity is trust in the registry you added, like any package feed.
- Packs remain pure data — the schema-2 declarative canvas, no code, no fonts.

Still out of scope: hosted marketplace service (accounts, payments, moderation), the module SDK (packs defining new component types), and the LLM bridge. If a task seems to require them, stop and ask.

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

Dark, holographic, technical. Not a generic dark-mode admin panel.

- Palette: void `#04080F` · glass `rgba(10,22,35,.55)` · cyan `#3FD8FF` · bright `#7FE9FF` · steel `#5A7E93` · amber `#FFB23E` (warnings) · gold `#E8C56A`
- Type: Rajdhani for display/UI (uppercase, letter-spaced), Share Tech Mono for numeric readouts
- Glass panels with hairline cyan borders, corner notches, subtle glow. Fine technical texture: tick marks, monospaced values, thin rules.
- Motion is constant but subtle. Nothing static, nothing bouncy.
- Quality floor, always: keyboard focus visible, `prefers-reduced-motion` respected, no layout that breaks under 1100px.

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
