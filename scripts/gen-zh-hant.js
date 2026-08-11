'use strict';

// Generate locales/zh-hant.json (Traditional Chinese, Taiwan vocabulary) from the
// Simplified locales/zh.json using OpenCC's s2twp conversion (cn -> twp): a proper
// phrase-aware Simplified->Traditional pass that also localizes vocabulary
// (软件->軟體, 默认->預設, 视频->影片) — far better than a naive character swap, and
// it correctly disambiguates one-to-many characters (里/裡, 后/後, 发/發/髮).
//
// OpenCC is a BUILD-ONLY tool — install it ephemerally so it never enters
// package.json or the shipped app; only the produced JSON ships:
//   npm i opencc-js --no-save && node scripts/gen-zh-hant.js
//
// Keys and any {param} placeholders / <b>…</b> markup are Latin and pass through
// untouched; only the Chinese text in each value is converted. Output follows
// en.json's key order so parity checks stay clean.

const fs = require('fs');
const path = require('path');
const OpenCC = require('opencc-js');

const localesDir = path.join(__dirname, '..', 'locales');
const en = JSON.parse(fs.readFileSync(path.join(localesDir, 'en.json'), 'utf8'));
const zh = JSON.parse(fs.readFileSync(path.join(localesDir, 'zh.json'), 'utf8'));

const convert = OpenCC.Converter({ from: 'cn', to: 'twp' });

const out = {};
let converted = 0, fellBack = 0;
for (const key of Object.keys(en)) {
  const src = typeof zh[key] === 'string' ? zh[key] : null;
  if (src == null) { out[key] = en[key]; fellBack++; continue; } // missing in zh (shouldn't happen)
  out[key] = convert(src);
  converted++;
}

fs.writeFileSync(path.join(localesDir, 'zh-hant.json'), JSON.stringify(out, null, 2) + '\n', 'utf8');
console.log(`zh-hant.json written: ${converted} converted, ${fellBack} English fallbacks, ${Object.keys(out).length} keys total`);
