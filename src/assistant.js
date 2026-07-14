'use strict';

// Assistant chat renderer. Sends prompts to the configured model (via main),
// renders the exchange, and speaks replies through the tuned voice pipeline.
// The API key lives only in main — this window only learns hasKey.

/* global aegis */

const $ = (id) => document.getElementById(id);

const state = { config: null, busy: false, audioCtx: null };

function scrollToEnd() {
  const log = $('log');
  log.scrollTop = log.scrollHeight;
}

function addMessage(who, text, kind) {
  const msg = document.createElement('div');
  msg.className = `msg ${kind || who}`;
  const label = document.createElement('div');
  label.className = 'who';
  label.textContent = who === 'user' ? 'You' : (who === 'error' ? 'System' : 'JARVIS');
  const body = document.createElement('div');
  body.className = 'text';
  body.textContent = text;
  msg.append(label, body);
  $('log').appendChild(msg);
  scrollToEnd();
  return body;
}

function showKeyNotice() {
  const log = $('log');
  log.textContent = '';
  const notice = document.createElement('div');
  notice.className = 'notice';
  notice.textContent = 'No AI provider is connected yet. Add your API key in the manager to bring me online, sir.';
  const btn = document.createElement('button');
  btn.textContent = 'OPEN SETTINGS';
  btn.addEventListener('click', () => aegis.openManager());
  notice.appendChild(document.createElement('br'));
  notice.appendChild(btn);
  log.appendChild(notice);
}

// Play a PCM clip (signed 16-bit mono) returned by the speak handler. Over
// IPC a Node Buffer arrives as a Uint8Array, so read Int16 from its bytes.
function playPcm(pcm, sampleRate) {
  try {
    if (!state.audioCtx) state.audioCtx = new AudioContext();
    const int16 = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.byteLength >> 1);
    const floats = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) floats[i] = int16[i] / 32768;
    const buffer = state.audioCtx.createBuffer(1, floats.length, sampleRate);
    buffer.copyToChannel(floats, 0);
    const source = state.audioCtx.createBufferSource();
    source.buffer = buffer;
    source.connect(state.audioCtx.destination);
    source.start();
  } catch (err) {
    console.warn(`[assistant] playback failed: ${err.message}`);
  }
}

async function refreshConfig() {
  const res = await aegis.configGet();
  state.config = res.ok ? res.config : null;
  $('status').textContent = state.config && state.config.hasKey ? 'ONLINE' : 'NO KEY';
  if (!state.config || !state.config.hasKey) showKeyNotice();
}

async function send() {
  const input = $('input');
  const text = input.value.trim();
  if (text === '' || state.busy) return;

  if (!state.config || !state.config.hasKey) { showKeyNotice(); return; }

  // First real message clears the key/empty notice.
  const notice = $('log').querySelector('.notice');
  if (notice) $('log').textContent = '';

  input.value = '';
  state.busy = true;
  $('send').disabled = true;
  addMessage('user', text);
  const replyBody = addMessage('jarvis', '');
  replyBody.classList.add('thinking');

  const res = await aegis.ask(text);
  replyBody.classList.remove('thinking');

  if (!res.ok) {
    replyBody.parentElement.remove();
    addMessage('error', res.error || 'Something went wrong.', 'error');
  } else {
    replyBody.textContent = res.text;
    scrollToEnd();
    if (state.config.speak) {
      const spoken = await aegis.speak(res.text);
      if (spoken.ok) playPcm(spoken.pcm, spoken.sampleRate);
    }
  }
  state.busy = false;
  $('send').disabled = false;
  input.focus();
}

function init() {
  $('send').addEventListener('click', send);
  $('input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); send(); }
    if (e.key === 'Escape') { $('input').value = ''; }
  });
  $('new-session').addEventListener('click', async () => {
    await aegis.reset();
    $('log').textContent = '';
    if (!state.config || !state.config.hasKey) showKeyNotice();
    $('input').focus();
  });
  refreshConfig();
  $('input').focus();
}

init();
