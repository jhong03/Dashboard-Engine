'use strict';

// Generate lib/zh-t2s.json — a Traditional->Simplified CHARACTER map used to
// normalize Chinese text before the MeloTTS-Chinese engine (which was trained on
// Simplified input) synthesizes it. So the "Traditional Chinese" voice pronounces
// Traditional-script text correctly while using the exact same zh_hd voice.
//
// Why a char map (not runtime OpenCC): Traditional->Simplified is essentially
// many-to-one at the character level, so a simple per-character replace is
// accurate for TTS (the Mandarin reading is script-invariant anyway) and ships as
// ~80 KB of data with NO runtime dependency. It's a strict no-op on already-
// Simplified text (Simplified characters are never keys), so it cannot change how
// existing Chinese synthesis sounds.
//
// Build-only, like scripts/gen-zh-hant.js:
//   npm i opencc-js --no-save && node scripts/gen-zh-t2s.js
//
// Covers CJK Unified Ideographs (U+4E00–U+9FFF) + Extension A (U+3400–U+4DBF),
// merging Taiwan and Hong Kong traditional variants so both map to Simplified.

const fs = require('fs');
const path = require('path');
const OpenCC = require('opencc-js');

const RANGES = [[0x4E00, 0x9FFF], [0x3400, 0x4DBF]];
const converters = [OpenCC.Converter({ from: 'tw', to: 'cn' }), OpenCC.Converter({ from: 'hk', to: 'cn' })];

const map = {};
for (const [lo, hi] of RANGES) {
  for (let cp = lo; cp <= hi; cp++) {
    const ch = String.fromCodePoint(cp);
    for (const convert of converters) {
      const out = convert(ch);
      // Only record a genuine single-character change; skip identity + the rare
      // one-to-many expansions (not meaningful for a char map).
      if (out && out !== ch && [...out].length === 1 && !(ch in map)) map[ch] = out;
    }
  }
}

fs.writeFileSync(path.join(__dirname, '..', 'lib', 'zh-t2s.json'), JSON.stringify(map), 'utf8');
console.log(`lib/zh-t2s.json written: ${Object.keys(map).length} Traditional->Simplified character mappings`);
