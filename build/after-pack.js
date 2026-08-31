'use strict';

// electron-builder afterPack hook: embed build/icon.ico (+ basic version
// metadata) into the packaged Windows executable.
//
// WHY THIS EXISTS: the build config keeps `signAndEditExecutable: false` to
// avoid electron-builder's winCodeSign extraction, which fails on non-admin
// Windows without Developer Mode (symlinks in that package). But that same flag
// ALSO skips native icon embedding, so the packaged exe would keep the default
// Electron icon. Here we do the edit ourselves with rcedit — the very tool
// electron-builder caches — invoked directly, so there's no winCodeSign download
// and no symlink extraction. Runs for `pack` AND `dist` (afterPack fires before
// NSIS packaging, so the installer's exe gets the icon too).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

// rcedit ships INSIDE electron-builder's cached winCodeSign dir. Find it there
// (any cached version) or via a DE_RCEDIT override. No network, no extraction.
function findRcedit() {
  if (process.env.DE_RCEDIT && fs.existsSync(process.env.DE_RCEDIT)) return process.env.DE_RCEDIT;
  const roots = [
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'electron-builder', 'Cache', 'winCodeSign'),
    path.join(os.homedir(), '.cache', 'electron-builder', 'winCodeSign'),
  ].filter(Boolean);
  for (const root of roots) {
    try {
      for (const dir of fs.readdirSync(root)) {
        const p = path.join(root, dir, 'rcedit-x64.exe');
        if (fs.existsSync(p)) return p;
      }
    } catch { /* try the next root */ }
  }
  return null;
}

// The bundled llama.cpp server + ggml DLLs are built with MSVC and import the
// Visual C++ 2015-2022 runtime (VCRUNTIME140 / VCRUNTIME140_1 / MSVCP140), which
// is NOT part of Windows. We ship the `dir` target (no installer to run
// vc_redist.exe), so the runtime must travel APP-LOCAL: place the three imported
// DLLs next to llama-server.exe. Windows resolves an exe's own directory first,
// so the AI runs on a clean machine with no VC++ redist installed. (Steam review
// rejects a build whose bundled AI "doesn't run due to a missing dependency".)
// These DLLs are redistributable app-local under the MSVC redistributable licence.
function ensureVcRuntime(context) {
  const llmDir = path.join(context.appOutDir, 'resources', 'app', 'bin', 'llm');
  const server = path.join(llmDir, 'llama-server.exe');
  if (!fs.existsSync(server)) return; // no bundled LLM in this build — nothing to do
  const sys32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
  const need = ['vcruntime140.dll', 'vcruntime140_1.dll', 'msvcp140.dll'];
  const notes = [];
  for (const dll of need) {
    const dest = path.join(llmDir, dll);
    if (fs.existsSync(dest)) { notes.push(`${dll} ok`); continue; }
    const from = path.join(sys32, dll);
    if (fs.existsSync(from)) { fs.copyFileSync(from, dest); notes.push(`${dll} copied`); }
    else notes.push(`${dll} MISSING — install the VC++ 2015-2022 x64 redist on the build box`);
  }
  console.log(`[after-pack] llama-server VC++ runtime: ${notes.join(', ')}`);
}

// The voice DSP chain (timbre / character / loudness stages) shells out to
// ffmpeg. It must be BUNDLED, else on a clean machine with no system ffmpeg the
// voice falls back to the raw, untuned neural output. bin/ffmpeg is gitignored
// (large owner-side binary), so a fresh clone could rebuild without it — verify
// it made it into the payload, and try DE_FFMPEG_PATH as a copy source if not.
function ensureFfmpeg(context) {
  const ffDir = path.join(context.appOutDir, 'resources', 'app', 'bin', 'ffmpeg');
  const dest = path.join(ffDir, 'ffmpeg.exe');
  if (fs.existsSync(dest)) { console.log('[after-pack] bundled ffmpeg: ok'); return; }
  const src = process.env.DE_FFMPEG_PATH;
  if (src && fs.existsSync(src)) {
    try { fs.mkdirSync(ffDir, { recursive: true }); fs.copyFileSync(src, dest); console.log('[after-pack] bundled ffmpeg: copied from DE_FFMPEG_PATH'); return; }
    catch (e) { /* fall through to the warning */ }
  }
  console.warn('[after-pack] WARNING: bin/ffmpeg/ffmpeg.exe is MISSING from the build. '
    + 'The voice will run untuned (raw neural output) on machines without a system ffmpeg. '
    + 'Place ffmpeg.exe in bin/ffmpeg/ (or set DE_FFMPEG_PATH) and rebuild.');
}

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return; // Windows only
  ensureVcRuntime(context); // make the bundled AI self-contained on a clean machine
  ensureFfmpeg(context);    // make the tuned voice self-contained on a clean machine
  const product = context.packager.appInfo.productFilename; // "Dashboard Engine"
  const exe = path.join(context.appOutDir, `${product}.exe`);
  const ico = path.join(__dirname, 'icon.ico');
  if (!fs.existsSync(exe)) { console.warn(`[after-pack] exe not found: ${exe}`); return; }
  if (!fs.existsSync(ico)) { console.warn(`[after-pack] build/icon.ico missing — run the icon step first.`); return; }

  const rcedit = findRcedit();
  if (!rcedit) {
    console.warn('[after-pack] rcedit not found in the electron-builder cache; the exe keeps the default '
      + 'Electron icon. Set DE_RCEDIT to a rcedit-x64.exe, or enable signAndEditExecutable for one build.');
    return;
  }

  const run = (args) => execFileSync(rcedit, [exe, ...args], { stdio: 'ignore' });
  run(['--set-icon', ico]);
  run(['--set-version-string', 'ProductName', product]);
  run(['--set-version-string', 'FileDescription', product]);
  run(['--set-version-string', 'CompanyName', context.packager.appInfo.companyName || 'jhong03']);
  console.log(`[after-pack] embedded icon + metadata into ${product}.exe`);
};
