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

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return; // Windows only
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
