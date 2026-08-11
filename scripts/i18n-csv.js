'use strict';

// Translator bridge: turn the English dictionary into a spreadsheet a
// non-technical translator can fill in, and turn a filled-in sheet back into a
// locale JSON file. No dependencies — a tiny RFC-4180 CSV reader/writer so the
// values (which contain commas, quotes and the odd newline) survive a round trip
// through Excel / Google Sheets / LibreOffice.
//
// Usage:
//   node scripts/i18n-csv.js export [locale] [outfile.csv]
//       Writes a 3-column sheet: key, english, translation. The `translation`
//       column is pre-filled from an existing locale (so a partial translation
//       shows its gaps) and blank otherwise. Default outfile: i18n-<locale>.csv
//       in the repo root; `locale` defaults to a blank template.
//
//   node scripts/i18n-csv.js import <locale> <infile.csv>
//       Writes locales/<locale>.json from the sheet. Only non-empty
//       translations are kept; keys not in en.json are ignored (with a warning);
//       missing keys just fall back to English at runtime, so a partial sheet is
//       fine. Existing translations for keys the sheet leaves blank are
//       PRESERVED, so you can hand out one column at a time.
//
// English (locales/en.json) is always the source of truth for WHICH keys exist.

const fs = require('fs');
const path = require('path');

const LOCALES_DIR = path.join(__dirname, '..', 'locales');
const EN_FILE = path.join(LOCALES_DIR, 'en.json');
// A 2–3 letter base code, optionally with a script/region subtag (e.g. zh-hant).
const CODE_PATTERN = /^[a-z]{2,3}(-[a-z]{2,4})?$/;

// ── CSV primitives (RFC 4180) ────────────────────────────────────────────────

// Quote a field only when it must be: contains a comma, quote, CR or LF.
function csvField(value) {
  const s = value == null ? '' : String(value);
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function csvRow(fields) {
  return fields.map(csvField).join(',');
}

// Parse a whole CSV document into an array of string arrays. Handles quoted
// fields, escaped quotes ("") and both \n and \r\n line endings.
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  // A leading BOM (Excel loves adding one) would corrupt the first key.
  if (text.charCodeAt(0) === 0xfeff) i = 1;
  for (; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } // escaped quote
        else inQuotes = false;
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') { inQuotes = true; continue; }
    if (c === ',') { row.push(field); field = ''; continue; }
    if (c === '\r') continue; // fold CRLF -> LF
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += c;
  }
  // Flush the final field/row if the file didn't end with a newline.
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

// ── Locale helpers ───────────────────────────────────────────────────────────

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function localeFile(code) {
  return path.join(LOCALES_DIR, `${code}.json`);
}

function loadLocale(code) {
  const file = localeFile(code);
  if (!fs.existsSync(file)) return {};
  try { return readJson(file); } catch { return {}; }
}

// ── Commands ─────────────────────────────────────────────────────────────────

function doExport(code, outfile) {
  const en = readJson(EN_FILE);
  const existing = code ? loadLocale(code) : {};
  const out = outfile || path.join(__dirname, '..', code ? `i18n-${code}.csv` : 'i18n-template.csv');

  const lines = [csvRow(['key', 'english', 'translation'])];
  let filled = 0;
  for (const key of Object.keys(en)) {
    const translation = typeof existing[key] === 'string' ? existing[key] : '';
    if (translation) filled++;
    lines.push(csvRow([key, en[key], translation]));
  }
  // A trailing newline keeps editors from flagging "no newline at end of file".
  fs.writeFileSync(out, `${lines.join('\r\n')}\r\n`, 'utf8');

  const total = Object.keys(en).length;
  console.log(`Wrote ${out}`);
  console.log(`  ${total} keys${code ? ` · ${filled} already translated (${code}) · ${total - filled} to go` : ' · blank template'}`);
  console.log('  Fill in the "translation" column, then: node scripts/i18n-csv.js import <locale> <file>');
}

function doImport(code, infile) {
  if (!code || !CODE_PATTERN.test(code)) {
    fail(`Bad locale code "${code}". Use a code like es, fr, zh, or zh-hant.`);
  }
  if (!infile || !fs.existsSync(infile)) fail(`CSV not found: ${infile}`);

  const en = readJson(EN_FILE);
  const enKeys = new Set(Object.keys(en));
  const rows = parseCsv(fs.readFileSync(infile, 'utf8'));
  if (rows.length === 0) fail('The CSV is empty.');

  // Header is optional but expected; detect and skip it.
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const hasHeader = header[0] === 'key' && header.includes('translation');
  const dataRows = hasHeader ? rows.slice(1) : rows;
  const transCol = hasHeader ? header.indexOf('translation') : 2;

  // Start from any existing translation so a partial sheet only ADDS/updates.
  const result = { ...loadLocale(code) };
  let added = 0;
  let skippedUnknown = 0;
  let blank = 0;
  for (const row of dataRows) {
    const key = (row[0] || '').trim();
    if (!key) continue;
    const value = row[transCol] != null ? row[transCol] : '';
    if (!enKeys.has(key)) { skippedUnknown++; continue; }
    if (value === '') { blank++; continue; } // leave the existing/English fallback
    result[key] = value;
    added++;
  }

  // Emit keys in en.json order for a clean, reviewable diff.
  const ordered = {};
  for (const key of Object.keys(en)) {
    if (typeof result[key] === 'string') ordered[key] = result[key];
  }
  fs.writeFileSync(localeFile(code), `${JSON.stringify(ordered, null, 2)}\n`, 'utf8');

  console.log(`Wrote ${localeFile(code)}`);
  console.log(`  ${Object.keys(ordered).length}/${enKeys.size} keys translated (${added} set this run, ${blank} left blank -> English fallback)`);
  if (skippedUnknown) console.log(`  ${skippedUnknown} unknown key(s) in the CSV were ignored (not in en.json).`);
}

function fail(msg) {
  console.error(`Error: ${msg}`);
  process.exit(1);
}

function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];
  if (cmd === 'export') {
    const code = args[1] || null;
    if (code && !CODE_PATTERN.test(code)) fail(`Bad locale code "${code}". Use a code like es, fr, zh, or zh-hant.`);
    return doExport(code, args[2] || null);
  }
  if (cmd === 'import') return doImport(args[1], args[2]);
  console.log('Dashboard Engine — i18n CSV bridge');
  console.log('  node scripts/i18n-csv.js export [locale] [outfile.csv]   (blank template, or a locale sheet to fill/extend)');
  console.log('  node scripts/i18n-csv.js import <locale> <infile.csv>    (write locales/<locale>.json from the sheet)');
  process.exit(cmd ? 1 : 0);
}

main();
