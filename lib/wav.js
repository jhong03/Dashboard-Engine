'use strict';

// Minimal RIFF/WAVE writer for s16le mono. The app plays PCM straight from
// memory; files are only for the CLI tools (smoke, audition), so this stays
// deliberately tiny instead of pulling in a dependency.

const fs = require('fs');

function writeWav(filePath, pcm, sampleRate) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);             // fmt chunk size
  header.writeUInt16LE(1, 20);              // PCM
  header.writeUInt16LE(1, 22);              // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); // byte rate (16-bit mono)
  header.writeUInt16LE(2, 32);              // block align
  header.writeUInt16LE(16, 34);             // bits per sample
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  fs.writeFileSync(filePath, Buffer.concat([header, pcm]));
}

module.exports = { writeWav };
