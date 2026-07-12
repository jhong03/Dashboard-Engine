'use strict';

// Pack CLI — the DIY author's toolbox. Everything the Library UI does, from
// a terminal:
//
//   npm run packs                          list built-in + installed packs
//   npm run packs -- validate              sanitizer preflight on every pack
//   npm run packs -- export <id> [file]    write <id>.aegispack
//   npm run packs -- install <file>        install an .aegispack
//   npm run packs -- uninstall <id>        remove an installed pack
//
// Validation never fails a pack outright (the sanitizer always yields a
// usable skin) — exit code 1 just means "you have warnings to read".

const fs = require('fs');
const path = require('path');
const packs = require('../lib/packs');
const packstore = require('../lib/packstore');
const { userDataDir } = require('../lib/paths');

const APP_ROOT = path.join(__dirname, '..');
const USER_DIR = userDataDir();

function list(listed) {
  console.log('Persona packs');
  console.log('=============');
  for (const p of listed.packs) {
    const flag = p.warnings.length > 0 ? `  (${p.warnings.length} warning${p.warnings.length > 1 ? 's' : ''})` : '';
    console.log(`  ${p.origin.padEnd(10)} ${p.id.padEnd(20)} ${p.name.padEnd(24)} by ${p.author || 'unknown'}${flag}`);
  }
  console.log(`\n  installed packs live in ${packstore.userPacksDir(USER_DIR)}`);
}

function validate(listed) {
  let totalWarnings = 0;
  for (const p of listed.packs) {
    const loaded = packs.loadPack(APP_ROOT, USER_DIR, p.id);
    const collected = packs.collectAssets(loaded.dir, loaded.pack);
    const all = [...loaded.warnings, ...collected.warnings];
    totalWarnings += all.length;
    console.log(`  ${all.length === 0 ? 'CLEAN' : 'WARN '}  ${p.id} — ${loaded.pack.components.length} component(s), ${Object.keys(collected.assets).length} asset(s) [${loaded.origin}]`);
    for (const w of all) console.log(`         ${w}`);
  }
  if (totalWarnings > 0) {
    console.log(`\n  ${totalWarnings} warning(s). The packs still load — defaults were substituted where needed.`);
    process.exitCode = 1;
  } else {
    console.log('\n  All packs validate clean.');
  }
}

function main() {
  const [command = 'list', arg, arg2] = process.argv.slice(2);
  const listed = packs.listPacks(APP_ROOT, USER_DIR);
  for (const w of listed.warnings) console.warn(`  ! ${w}`);

  if (command === 'list') return list(listed);
  if (command === 'validate') return validate(listed);

  if (command === 'export') {
    if (!arg) throw new Error('Usage: npm run packs -- export <id> [file]');
    const resolved = packs.resolvePackDir(APP_ROOT, USER_DIR, arg);
    if (resolved.origin === 'missing') throw new Error(`No pack named "${arg}".`);
    const exported = packstore.exportPack(resolved.dir);
    if (!exported.ok) throw new Error(exported.error);
    const out = arg2 || `${arg}.aegispack`;
    fs.writeFileSync(out, exported.buffer);
    console.log(`  exported ${arg} -> ${out} (${exported.buffer.length} bytes)`);
    return;
  }

  if (command === 'install') {
    if (!arg) throw new Error('Usage: npm run packs -- install <file.aegispack>');
    const result = packstore.installFromBuffer(APP_ROOT, USER_DIR, fs.readFileSync(arg), { source: 'file' });
    if (!result.ok) throw new Error(result.error);
    for (const w of result.warnings) console.warn(`  ! ${w}`);
    console.log(`  installed "${result.id}" -> ${path.join(packstore.userPacksDir(USER_DIR), result.id)}`);
    return;
  }

  if (command === 'uninstall') {
    if (!arg) throw new Error('Usage: npm run packs -- uninstall <id>');
    const result = packstore.uninstall(USER_DIR, arg);
    if (!result.ok) throw new Error(result.error);
    console.log(`  uninstalled "${arg}".`);
    return;
  }

  throw new Error(`Unknown command "${command}". Commands: list, validate, export, install, uninstall.`);
}

try {
  main();
} catch (err) {
  console.error(`\npacks: ${err.message}`);
  process.exitCode = 1;
}
