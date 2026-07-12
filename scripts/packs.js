'use strict';

// Pack CLI — the DIY author's pre-flight check.
//
//   npm run packs                 list installed packs
//   npm run packs -- validate     load every pack through the sanitizer and
//                                 print what got clamped/dropped and why
//
// Validation never fails a pack outright (the sanitizer always yields a
// usable skin) — exit code 1 just means "you have warnings to read".

const path = require('path');
const packs = require('../lib/packs');

const APP_ROOT = path.join(__dirname, '..');

function main() {
  const command = process.argv[2] || 'list';
  const listed = packs.listPacks(APP_ROOT);
  for (const w of listed.warnings) console.warn(`  ! ${w}`);

  if (command === 'list') {
    console.log('Installed persona packs');
    console.log('=======================');
    for (const p of listed.packs) {
      const flag = p.warnings.length > 0 ? `  (${p.warnings.length} warning${p.warnings.length > 1 ? 's' : ''} — run: npm run packs -- validate)` : '';
      console.log(`  ${p.id.padEnd(20)} ${p.name.padEnd(24)} by ${p.author || 'unknown'}${flag}`);
    }
    console.log(`\n  ${listed.packs.length} pack(s) in packs/`);
    return;
  }

  if (command === 'validate') {
    let totalWarnings = 0;
    for (const p of listed.packs) {
      const { pack, warnings } = packs.loadPack(APP_ROOT, p.id);
      const wp = packs.wallpaperDataUri(APP_ROOT, pack);
      const all = [...warnings, ...wp.warnings];
      totalWarnings += all.length;
      console.log(`  ${all.length === 0 ? 'CLEAN' : 'WARN '}  ${p.id} — ${pack.layout.widgets.length} widget(s), wallpaper: ${wp.uri ? 'yes' : 'none'}`);
      for (const w of all) console.log(`         ${w}`);
    }
    if (totalWarnings > 0) {
      console.log(`\n  ${totalWarnings} warning(s). The packs still load — defaults were substituted where needed.`);
      process.exitCode = 1;
    } else {
      console.log('\n  All packs validate clean.');
    }
    return;
  }

  console.error(`Unknown command "${command}". Commands: list, validate.`);
  process.exitCode = 1;
}

main();
