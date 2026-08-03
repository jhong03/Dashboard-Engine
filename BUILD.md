# Building & packaging Dashboard Engine

Dashboard Engine packages with **electron-builder** into a Windows app +
installer. This is the ship path for a paid Steam release (and for direct
distribution / testing).

## Prerequisites

- Node 18+ and a checkout with dependencies installed: `npm install`
- The app icon lives at `build/icon.ico` (committed). Regenerate the placeholder
  with `npm run icon`, or replace it with real art (256×256+ `.ico`).

## Commands

| Command | Output |
|---|---|
| `npm run pack` | `dist/win-unpacked/` — the raw app folder (fast; no installer) |
| `npm run dist` | the above **plus** `dist/Dashboard Engine Setup <version>.exe` (NSIS installer) |
| `npm run icon` | regenerates `build/icon.ico` + `build/icon.png` |

Both build commands must run with code-signing discovery disabled unless you
have a certificate:

```
CSC_IDENTITY_AUTO_DISCOVERY=false npm run dist
```

## What the two outputs are for

- **`dist/win-unpacked/`** is the folder you upload to a **Steam depot**
  (SteamPipe). Steam handles install/update, so a Steam release does *not* use
  the NSIS installer.
- **`Dashboard Engine Setup <version>.exe`** is the standalone installer for
  direct distribution and for testing the installed experience. It's a per-user
  install (no admin) to `%LOCALAPPDATA%\Programs\dashboard-engine`.

## Packaging decisions (and why)

- **`asar: false`.** The engine spawns PowerShell scripts (`scripts/*.ps1`) and
  reads packs *by real path*, and loads an optional native module
  (`steamworks.js`). A loose app folder resolves every path exactly like
  `npm start`, avoiding a whole class of "works in dev, breaks packaged" bugs.
  Revisit asar + `asarUnpack` later if load time matters.
- **`signAndEditExecutable: false`.** Skips exe signing *and* the rcedit
  metadata/icon stamping. This is what lets the build run without the
  `winCodeSign` helper, which on a non-admin Windows box fails to extract
  (it contains macOS symlinks that need symlink-creation privilege — Developer
  Mode or admin). Consequence: the **exe's own icon** is Electron's default; the
  **installer and shortcuts** still use `build/icon.ico`. With a signing cert
  (and Developer Mode / admin so `winCodeSign` extracts), turn this back on to
  get a signed, fully-branded exe.
- **`steam_appid.txt` is excluded** from the build. It pins the dev/test AppID
  480 (Spacewar) and must never ship. A real Steam build gets its AppID from
  Steam itself.

## Known follow-ups (not blockers)

- **Steam Workshop native binding.** `steamworks.js` needs its platform
  `.node` under `node_modules/steamworks.js/dist/` to load; the npm package
  doesn't always ship prebuilt binaries, so Workshop is fail-soft (reports
  unavailable) until the binding is restored. Nothing else depends on it.
- **Runtime downloads land in the install dir.** Voice models
  (`voices/…onnx`) and piper (`bin/`) download next to the app. That's writable
  under a per-user install, but a reinstall/update replaces the folder, forcing
  a re-download. The clean fix is to download these into `%APPDATA%` (user data)
  instead — a small refactor of the appRoot paths in `lib/voicebank.js` /
  `lib/piper.js`.
- **Code signing.** Unsigned builds trigger SmartScreen on first run. A real
  release wants an Authenticode cert (and, for Steam, Steam's own trust).

## Bundling English HD in the Steam depot (first-run voice)

The voice bank is all-MeloTTS (en/es/fr/zh/ja/ko). By default NOTHING voice-wise
is packaged — the engine (~600 MB) and each voice pack download at runtime into
`%APPDATA%/dashboard-engine/`. That means a fresh install has no HD voice until a
download (it falls back to the Windows system voice, which is fine).

To ship an **instant** first-run HD voice, bundle the engine + English pack in the
Steam depot (Steam is the CDN + paywall, nothing personal). The code already
resolves a bundled copy from the app dir — `lib/melotts.findEngine` checks
`appRoot/bin/<engineId>/` and `lib/voicebank.resolveModelDir` checks
`appRoot/voices/<modelDir>/` — so you only need the build to include them:

1. Stage the two large artifacts into the repo (they're gitignored, like `bin/piper`):
   - engine → `bin/melotts_full/melotts-engine.exe`
   - English pack → `voices/en_hd/` (checkpoint.pth + config.json + bert/)
2. In `package.json` → `build.files`, AFTER the `!bin/**` and `!voices/**` lines,
   add includes so only these survive the exclude:
   `"bin/melotts_full/**"`, `"voices/en_hd/**"`.
3. `npm run pack` and upload `dist/win-unpacked/` to the depot as usual. (This adds
   ~730 MB to the depot; `npm run dist`'s NSIS installer grows by the same amount,
   so prefer `pack`/the depot for distribution.)

Leave es/fr/zh/ja/ko as on-demand downloads. Host them (and the engine, for
non-Steam installs) on a NEUTRAL account — an HF *organization* or Cloudflare R2 —
NOT a personal HF repo; update the URLs in `voices/voices.json` when you migrate.

## Real Steam release checklist (business + build)

1. Steam Direct ($100) → **create your app** in Steamworks, get its **AppID**,
   and **enable Workshop** for it. (Until all of that exists, Spacewar/480 is
   the only app you can publish to — there is no generic "public" Workshop.)
2. Point the engine at your AppID:
   - **To test against it now** (running outside Steam): set the env var
     `DE_STEAM_APPID=<your appid>` AND put the same number in `steam_appid.txt`.
     You must own the app on the Steam account you're signed into.
   - **For the shipped Steam build**: bake your AppID in as the default in
     `lib/workshop.js` (`resolveAppId`) and **delete `steam_appid.txt`** — Steam
     supplies the AppID at launch. The packaged build already omits it.
3. Build `npm run pack`, upload `dist/win-unpacked/` to the app's depot via
   SteamPipe, set launch options, submit for review.

Note on the Spacewar (480) item limit: an account can only hold so many
Workshop items on the shared test app, and it's a count (not time-based). Clear
them at steamcommunity.com → your Workshop files, or move to your own AppID.
Publishing still works meanwhile — it adopts an existing item when creation is
capped.
