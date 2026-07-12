'use strict';

// Voice bank CLI — list, download, verify. This is the Stage 2 face of the
// bank; Stage 4's UI drives lib/voicebank.js through IPC the same way.
//
//   npm run voices                    list the bank
//   npm run voices -- download <id>   install one voice (or: download all)
//   npm run voices -- verify          re-hash installed models against the manifest
//
// Exits non-zero with a plain-language message on failure; never a stack trace.

const path = require('path');
const bank = require('../lib/voicebank');

const APP_ROOT = path.join(__dirname, '..');

function mb(bytes) {
  return `${(bytes / 1048576).toFixed(0)} MB`;
}

function printWarnings(warnings) {
  for (const w of warnings) console.warn(`  ! ${w}`);
}

function list(manifest) {
  console.log('AEGIS voice bank');
  console.log('================');
  for (const voice of manifest.voices) {
    const installed = bank.isInstalled(APP_ROOT, voice) ? 'INSTALLED' : '         ';
    const isDefault = voice.id === manifest.defaultVoice ? ' (default)' : '';
    console.log(`  ${installed}  ${voice.id.padEnd(24)} ${voice.displayName.padEnd(24)} ${voice.sex.padEnd(3)} ${voice.accent.padEnd(18)} ${voice.licence.padEnd(14)} ${mb(voice.sizeBytes)}${isDefault}`);
  }
  console.log('');
  console.log(`  ${manifest.voices.length} voices, ${manifest.excluded.length} excluded by licence audit (see voices/voices.json).`);
  console.log('  Install with: npm run voices -- download <id|all>');
}

// onProgress fires per network chunk; only repaint when the whole percent
// moves, or a 60 MB download writes megabytes of carriage returns.
let lastPct = -1;
function renderProgress(id, received, total) {
  const pct = total > 0 ? Math.floor((received / total) * 100) : 0;
  if (pct === lastPct) return;
  lastPct = pct;
  process.stderr.write(`\r  downloading ${id}: ${pct}% (${mb(received)} / ${mb(total)})   `);
}

async function download(manifest, target) {
  const targets = target === 'all'
    ? manifest.voices
    : [bank.voiceById(manifest, target)].filter(Boolean);
  if (targets.length === 0) {
    throw new Error(`No voice named "${target}" in the bank. Run "npm run voices" to see ids.`);
  }
  for (const voice of targets) {
    if (bank.isInstalled(APP_ROOT, voice)) {
      console.log(`  ${voice.id}: already installed.`);
      continue;
    }
    await bank.downloadVoice(APP_ROOT, voice, (r, t) => renderProgress(voice.id, r, t));
    process.stderr.write('\n');
    console.log(`  ${voice.id}: installed and checksum-verified.`);
    if (/required/i.test(voice.attribution)) {
      console.log(`    licence note: ${voice.attribution}`);
    }
  }
}

async function verify(manifest) {
  let failures = 0;
  for (const voice of manifest.voices) {
    if (!bank.isInstalled(APP_ROOT, voice)) continue;
    const digest = await bank.sha256OfFile(bank.modelPathFor(APP_ROOT, voice));
    if (digest === voice.sha256) {
      console.log(`  OK       ${voice.id}`);
    } else {
      failures++;
      console.log(`  CORRUPT  ${voice.id} — re-download with: npm run voices -- download ${voice.id}`);
    }
  }
  if (failures > 0) throw new Error(`${failures} installed model(s) failed verification.`);
  console.log('  All installed models verified.');
}

async function main() {
  const [command = 'list', arg] = process.argv.slice(2);
  const manifest = bank.loadManifest(APP_ROOT);
  printWarnings([...manifest.warnings, ...bank.auditWarnings(manifest)]);

  if (command === 'list') {
    list(manifest);
  } else if (command === 'download') {
    if (!arg) throw new Error('Usage: npm run voices -- download <id|all>');
    await download(manifest, arg);
  } else if (command === 'verify') {
    await verify(manifest);
  } else {
    throw new Error(`Unknown command "${command}". Commands: list, download <id|all>, verify.`);
  }
}

main().catch((err) => {
  console.error(`\nvoices: ${err.message}`);
  process.exitCode = 1;
});
