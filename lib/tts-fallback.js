'use strict';

// System-voice fallback: when Piper (or its model) is unavailable the app
// must still speak (CLAUDE.md: fail soft). Each platform gets a FIXED argv —
// user text travels over stdin only, never inside a command line.
//
// This plays through the OS audio device directly; it returns no PCM, so the
// analyzer readouts stay empty in fallback mode. That is intentional — the
// numbers would describe a voice the tuning chain didn't shape.

const { spawn } = require('child_process');
const path = require('path');

const MAX_FALLBACK_CHARS = 600;

function commandFor(appRoot, voiceHint) {
  if (process.platform === 'win32') {
    const script = path.join(appRoot, 'scripts', 'speak.ps1');
    const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script];
    if (voiceHint) args.push(voiceHint);
    return { exe: 'powershell.exe', args };
  }
  if (process.platform === 'darwin') {
    return { exe: 'say', args: [] }; // reads stdin when given no phrase
  }
  return { exe: 'espeak-ng', args: ['--stdin'] };
}

/**
 * Speak text with the OS voice. Resolves when playback finishes.
 * @param {string} voiceHint optional substring to pick a voice (win32 only)
 */
function speakWithSystemVoice(appRoot, text, voiceHint) {
  return new Promise((resolve, reject) => {
    if (typeof text !== 'string' || text.trim() === '') {
      reject(new Error('Nothing to speak: the test text is empty.'));
      return;
    }
    const { exe, args } = commandFor(appRoot, typeof voiceHint === 'string' ? voiceHint.slice(0, 80) : '');
    const child = spawn(exe, args, { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });

    child.on('error', (err) => {
      if (err.code === 'ENOENT') {
        reject(new Error(`No system voice available (${exe} not found).`));
      } else {
        reject(new Error(`System voice failed to start: ${err.message}`));
      }
    });
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error('The system voice could not speak this text.'));
    });

    child.stdin.on('error', () => { /* EPIPE if the speaker died; close handler reports it */ });
    child.stdin.end(text.slice(0, MAX_FALLBACK_CHARS));
  });
}

module.exports = { speakWithSystemVoice, MAX_FALLBACK_CHARS };
