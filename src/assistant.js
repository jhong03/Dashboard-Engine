'use strict';

// Assistant chat renderer. Sends prompts to the configured model (via main),
// renders the exchange, and speaks replies through the tuned voice pipeline.
// The API key lives only in main — this window only learns hasKey.

/* global aegis */

const $ = (id) => document.getElementById(id);

const state = { config: null, busy: false, audioCtx: null, expanded: false };

function hexToRgba(hex, alpha) {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function scrollToEnd() {
  const log = $('log');
  log.scrollTop = log.scrollHeight;
}

// Grow to show the conversation, or shrink to the slim bar. Main owns the
// actual window size; we just ask and flip the layout.
function setExpanded(expanded) {
  state.expanded = expanded;
  document.body.classList.toggle('collapsed', !expanded);
  aegis.resize(expanded);
  if (expanded) scrollToEnd();
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

function showGreeting() {
  const log = $('log');
  log.textContent = '';
  const notice = document.createElement('div');
  notice.className = 'notice';
  notice.textContent = 'Good evening, sir. Ask me anything — a free model is standing by. You can choose a different model in the manager under Assistant.';
  const btn = document.createElement('button');
  btn.textContent = 'ASSISTANT SETTINGS';
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
  const c = state.config;
  // Free provider is always ready; custom is ready too (key optional).
  const model = c ? (c.provider === 'free' ? (c.model || 'free') : (c.model || 'custom')) : '';
  $('status').textContent = c ? `ONLINE · ${model}`.toUpperCase() : 'OFFLINE';
  if (!$('log').children.length) showGreeting();
}

async function send() {
  const input = $('input');
  const text = input.value.trim();
  if (text === '' || state.busy) return;

  if (!state.expanded) setExpanded(true); // sending always reveals the reply

  // First real message clears the greeting.
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
    if (e.key === 'Escape') { if ($('input').value) $('input').value = ''; else setExpanded(false); }
  });
  $('expand').addEventListener('click', () => { setExpanded(true); $('input').focus(); });
  $('collapse').addEventListener('click', () => setExpanded(false));
  $('new-session').addEventListener('click', async () => {
    await aegis.reset();
    $('log').textContent = '';
    showGreeting();
    $('input').focus();
  });
  // A click on the desktop console asks us to open + focus.
  aegis.onSummon(() => { setExpanded(true); $('input').focus(); });
  // Theme + labels for the active pack, so the bar matches the dashboard.
  aegis.onConfig((cfg) => {
    const root = document.documentElement.style;
    if (cfg.accent) {
      root.setProperty('--cyan', cfg.accent);
      root.setProperty('--line', hexToRgba(cfg.accent, 0.4));
      root.setProperty('--line-dim', hexToRgba(cfg.accent, 0.16));
    }
    if (cfg.bright) root.setProperty('--bright', cfg.bright);
    if (cfg.label) $('input').placeholder = cfg.label;
    if (cfg.button) $('send').textContent = cfg.button;
    if (cfg.name) document.querySelector('.brand').textContent = cfg.name;
  });
  refreshConfig();
}

init();
