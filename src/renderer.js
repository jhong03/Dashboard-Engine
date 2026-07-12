'use strict';

// Tuning panel renderer. Talks to the main process ONLY through the
// window.aegis bridge (preload.js) — no Node, no direct filesystem, no
// network. Slider bounds come from PARAM_RANGES over IPC so ranges are never
// duplicated in the UI.

/* global aegis */

// ── Parameter metadata (labels/format only — bounds arrive via IPC) ────────

function signed(v, digits) {
  return (v > 0 ? '+' : '') + v.toFixed(digits);
}

const GROUPS = [
  {
    container: 'group-prosody',
    params: [
      { path: 'prosody.pitchShift', label: 'Pitch shift', hint: 'semitones', step: 0.5, fmt: (v) => `${signed(v, 1)} st` },
      { path: 'prosody.rate', label: 'Rate', hint: 'words / min', step: 5, fmt: (v) => `${v.toFixed(0)} wpm` },
      { path: 'prosody.expressiveness', label: 'Expressiveness', hint: 'pitch variance', step: 0.05, fmt: (v) => v.toFixed(2) },
      { path: 'prosody.steadiness', label: 'Steadiness', hint: 'timing variance', step: 0.05, fmt: (v) => v.toFixed(2) },
      { path: 'prosody.pauseSentence', label: 'Sentence pause', hint: 'milliseconds', step: 10, fmt: (v) => `${v.toFixed(0)} ms` },
      { path: 'prosody.pauseComma', label: 'Comma pause', hint: 'milliseconds', step: 10, fmt: (v) => `${v.toFixed(0)} ms`, reserved: 'Not wired' },
    ],
  },
  {
    container: 'group-timbre',
    params: [
      { path: 'timbre.warmth', label: 'Warmth', hint: 'low shelf · 180 Hz', step: 0.5, fmt: (v) => `${signed(v, 1)} dB` },
      { path: 'timbre.brightness', label: 'Brightness', hint: 'high shelf · 5.5 kHz', step: 0.5, fmt: (v) => `${signed(v, 1)} dB` },
      { path: 'timbre.presence', label: 'Presence', hint: 'bell · 2.8 kHz', step: 0.5, fmt: (v) => `${signed(v, 1)} dB` },
      { path: 'timbre.sibilance', label: 'Sibilance', hint: 'cut · 7 kHz', step: 0.5, fmt: (v) => `${signed(v, 1)} dB` },
      { path: 'timbre.breath', label: 'Breath', hint: 'noise mix', step: 0.05, fmt: (v) => v.toFixed(2), reserved: 'Reserved' },
    ],
  },
  {
    container: 'group-character',
    params: [
      { path: 'character.compression', label: 'Compression', hint: 'broadcast squash', step: 0.05, fmt: (v) => v.toFixed(2) },
      { path: 'character.radioFilter', label: 'Radio filter', hint: 'comms band', step: 0.05, fmt: (v) => v.toFixed(2) },
      { path: 'character.reverb.mix', label: 'Reverb mix', hint: 'room level', step: 0.05, fmt: (v) => v.toFixed(2) },
      { path: 'character.reverb.size', label: 'Reverb size', hint: 'room size', step: 0.05, fmt: (v) => v.toFixed(2) },
      { path: 'character.bitcrush', label: 'Bitcrush', hint: 'digital decimation', step: 0.05, fmt: (v) => v.toFixed(2) },
      { path: 'character.chorus', label: 'Chorus', hint: 'detuned ensemble', step: 0.05, fmt: (v) => v.toFixed(2) },
    ],
  },
];

// ── State ───────────────────────────────────────────────────────────────────

const state = {
  ranges: null,
  profile: null,          // the working profile (sanitized copies from main)
  voices: [],
  presets: [],
  activePresetFile: null,
  lastPcm: null,
  lastSampleRate: 0,
  audioCtx: null,
  audioSource: null,
};

const $ = (id) => document.getElementById(id);

function getByPath(obj, dotted) {
  return dotted.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function setByPath(obj, dotted, value) {
  const keys = dotted.split('.');
  const last = keys.pop();
  let cursor = obj;
  for (const k of keys) cursor = cursor[k];
  cursor[last] = value;
}

// ── Status helpers ──────────────────────────────────────────────────────────

function setStatus(text, kind) {
  const el = $('status');
  el.textContent = text;
  el.className = `status-line-app${kind === 'error' ? ' warn' : kind === 'live' ? ' live' : ''}`;
}

// ── Sliders ────────────────────────────────────────────────────────────────

function buildSliders() {
  for (const group of GROUPS) {
    const container = $(group.container);
    for (const meta of group.params) {
      const range = state.ranges[meta.path];
      if (!range) continue;

      const row = document.createElement('div');
      row.className = `param${meta.reserved ? ' disabled' : ''}`;

      const label = document.createElement('label');
      label.className = 'param-label';
      label.htmlFor = `in-${meta.path}`;
      label.textContent = meta.label;
      if (meta.reserved) {
        const tag = document.createElement('span');
        tag.className = 'tag';
        tag.textContent = meta.reserved;
        label.appendChild(tag);
      }
      const hint = document.createElement('small');
      hint.textContent = meta.hint;
      label.appendChild(hint);

      const input = document.createElement('input');
      input.type = 'range';
      input.id = `in-${meta.path}`;
      input.min = range.min;
      input.max = range.max;
      input.step = meta.step;
      input.value = range.default;
      input.disabled = Boolean(meta.reserved);

      const value = document.createElement('span');
      value.className = 'param-value';
      value.textContent = meta.fmt(range.default);

      input.addEventListener('input', () => {
        const v = Number(input.value);
        setByPath(state.profile, meta.path, v);
        value.textContent = meta.fmt(v);
      });

      row.append(label, input, value);
      container.appendChild(row);
      meta.input = input;
      meta.valueEl = value;
    }
  }
}

function syncSlidersFromProfile() {
  for (const group of GROUPS) {
    for (const meta of group.params) {
      if (!meta.input) continue;
      const v = getByPath(state.profile, meta.path);
      meta.input.value = v;
      meta.valueEl.textContent = meta.fmt(v);
    }
  }
}

// ── Voice bank ─────────────────────────────────────────────────────────────

function renderVoices() {
  const list = $('voice-list');
  list.textContent = '';
  for (const voice of state.voices) {
    const li = document.createElement('li');
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'row';
    row.setAttribute('aria-pressed', String(voice.id === state.profile.base.voice));

    const name = document.createElement('span');
    name.className = 'row-name';
    name.textContent = voice.displayName;

    const meta = document.createElement('span');
    meta.className = `row-meta${voice.installed ? '' : ' warn'}`;
    meta.textContent = voice.installed ? `${voice.sex} · ${voice.accent}` : 'Not installed';

    row.append(name, meta);

    if (!voice.installed) {
      const dl = document.createElement('button');
      dl.type = 'button';
      dl.className = 'dl';
      dl.textContent = 'Get';
      dl.addEventListener('click', (e) => {
        e.stopPropagation();
        downloadVoice(voice, li, dl);
      });
      row.appendChild(dl);
    }

    row.addEventListener('click', () => {
      state.profile.base.voice = voice.id;
      renderVoices();
      setStatus(`Base voice: ${voice.displayName}`, 'live');
    });

    li.appendChild(row);
    list.appendChild(li);
  }
}

async function downloadVoice(voice, li, dlButton) {
  dlButton.disabled = true;
  const bar = document.createElement('div');
  bar.className = 'progress';
  const fill = document.createElement('span');
  bar.appendChild(fill);
  li.appendChild(bar);

  const unsubscribe = aegis.onBankProgress((p) => {
    if (p.id === voice.id) fill.style.width = `${p.pct}%`;
  });
  const res = await aegis.bankDownload(voice.id);
  unsubscribe();
  if (!res.ok) {
    setStatus(res.error, 'error');
    bar.remove();
    dlButton.disabled = false;
    return;
  }
  await refreshBank();
  setStatus(`Installed ${voice.displayName} (checksum verified).`, 'live');
}

async function refreshBank() {
  const res = await aegis.bankList();
  if (res.ok) {
    state.voices = res.voices;
    renderVoices();
    $('chip-bank').dataset.state = res.voices.some((v) => v.installed) ? 'on' : 'off';
  }
}

// ── Presets & saved profiles ───────────────────────────────────────────────

function applyProfile(profile, presetFile) {
  state.profile = structuredClone(profile);
  state.activePresetFile = presetFile || null;
  $('profile-name').value = state.profile.name;
  $('profile-author').value = state.profile.author;
  syncSlidersFromProfile();
  renderVoices();
  renderPresets();
}

function renderPresets() {
  const list = $('preset-list');
  list.textContent = '';
  for (const preset of state.presets) {
    const li = document.createElement('li');
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'row';
    row.setAttribute('aria-pressed', String(preset.file === state.activePresetFile));

    const name = document.createElement('span');
    name.className = 'row-name';
    name.textContent = preset.profile.name;
    const meta = document.createElement('span');
    meta.className = 'row-meta';
    meta.textContent = preset.profile.base.voice;
    row.append(name, meta);

    row.addEventListener('click', () => {
      applyProfile(preset.profile, preset.file);
      setStatus(`Loaded preset: ${preset.profile.name}`, 'live');
    });
    li.appendChild(row);
    list.appendChild(li);
  }
}

async function refreshSaved() {
  const res = await aegis.profilesList();
  const list = $('saved-list');
  list.textContent = '';
  if (!res.ok) return;
  for (const item of res.profiles) {
    const li = document.createElement('li');
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'row';
    const name = document.createElement('span');
    name.className = 'row-name';
    name.textContent = item.name;
    const meta = document.createElement('span');
    meta.className = 'row-meta';
    meta.textContent = item.voice;
    row.append(name, meta);
    row.addEventListener('click', async () => {
      const loaded = await aegis.profileLoad(item.file);
      if (!loaded.ok) {
        $('profile-status').textContent = loaded.error;
        return;
      }
      applyProfile(loaded.profile, null);
      setStatus(`Loaded profile: ${loaded.profile.name}`, 'live');
    });
    li.appendChild(row);
    list.appendChild(li);
  }
}

function syncProfileMeta() {
  state.profile.name = $('profile-name').value.trim() || 'Untitled';
  state.profile.author = $('profile-author').value.trim();
}

async function saveProfile() {
  syncProfileMeta();
  const res = await aegis.profileSave(state.profile);
  $('profile-status').textContent = res.ok ? `Saved to profiles/${res.file}` : res.error;
  if (res.ok) await refreshSaved();
}

// ── Synthesis, playback, readouts ──────────────────────────────────────────

function pcmToFloat32(pcm) {
  const int16 = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.byteLength >> 1);
  const floats = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) floats[i] = int16[i] / 32768;
  return floats;
}

function playPcm(pcm, sampleRate) {
  if (!state.audioCtx) state.audioCtx = new AudioContext();
  if (state.audioSource) {
    try { state.audioSource.stop(); } catch { /* already stopped */ }
  }
  const floats = pcmToFloat32(pcm);
  const buffer = state.audioCtx.createBuffer(1, floats.length, sampleRate);
  buffer.copyToChannel(floats, 0);
  const source = state.audioCtx.createBufferSource();
  source.buffer = buffer;
  source.connect(state.audioCtx.destination);
  source.start();
  state.audioSource = source;
}

function drawWaveform(pcm) {
  const canvas = $('waveform');
  const ctx = canvas.getContext('2d');
  const { width, height } = canvas;
  ctx.clearRect(0, 0, width, height);

  const int16 = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.byteLength >> 1);
  const perColumn = Math.max(1, Math.floor(int16.length / width));
  const mid = height / 2;

  ctx.strokeStyle = '#4c8dff';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = 0; x < width; x++) {
    let min = 0, max = 0;
    const start = x * perColumn;
    for (let i = start; i < start + perColumn && i < int16.length; i++) {
      if (int16[i] < min) min = int16[i];
      if (int16[i] > max) max = int16[i];
    }
    ctx.moveTo(x + 0.5, mid - (max / 32768) * (mid - 4));
    ctx.lineTo(x + 0.5, mid - (min / 32768) * (mid - 4));
  }
  ctx.stroke();
}

function updateReadouts(stats) {
  $('ro-f0').textContent = stats.medianF0Hz > 0 ? `${stats.medianF0Hz.toFixed(0)} Hz` : '—';
  $('ro-f0-dry').textContent = `dry ${stats.dryMedianF0Hz.toFixed(0)} Hz`;
  $('ro-rate').textContent = `${stats.wpm.toFixed(0)} wpm`;
  $('ro-rate-target').textContent = `target ${state.profile.prosody.rate.toFixed(0)} wpm`;
  $('ro-duration').textContent = `${stats.durationSeconds.toFixed(2)} s`;
  $('ro-speech').textContent = `speech ${stats.speechSeconds.toFixed(2)} s`;
  $('ro-voiced').textContent = `${(stats.voicedFraction * 100).toFixed(0)} %`;
}

async function synthesize({ play = true } = {}) {
  syncProfileMeta();
  const btn = $('btn-synth');
  btn.disabled = true;
  btn.classList.add('busy');
  setStatus('Synthesizing…', 'live');
  $('btn-fallback').classList.add('hidden');

  const res = await aegis.synthesize(state.profile, $('test-text').value);

  btn.disabled = false;
  btn.classList.remove('busy');

  if (!res.ok) {
    setStatus(res.error, 'error');
    if (res.canFallback) $('btn-fallback').classList.remove('hidden');
    return res;
  }

  state.lastPcm = res.pcm;
  state.lastSampleRate = res.sampleRate;
  $('btn-play').disabled = false;
  drawWaveform(res.pcm);
  updateReadouts(res.stats);
  setStatus(res.warning || 'Done.', res.warning ? 'error' : 'live');
  if (play) playPcm(res.pcm, res.sampleRate);
  return res;
}

async function speakFallback() {
  setStatus('Speaking with the system voice…', 'live');
  const hint = state.profile.base.fallback ? state.profile.base.fallback.match : '';
  const res = await aegis.speakFallback($('test-text').value, hint);
  setStatus(res.ok ? 'Done (system voice — untuned; install Piper for the full chain).' : res.error, res.ok ? undefined : 'error');
}

// ── Environment chips ──────────────────────────────────────────────────────

function renderEnv(env) {
  $('chip-piper').dataset.state = env.piper ? 'on' : 'off';
  $('chip-ffmpeg').dataset.state = env.ffmpeg ? 'on' : 'off';
  if (!env.piper) {
    setStatus('Piper isn’t installed — synthesis falls back to the system voice.', 'error');
  } else if (!env.ffmpeg) {
    setStatus('FFmpeg isn’t installed — raw voice only; timbre and character are bypassed.', 'error');
  }
}

// ── Self test (npm run selftest) ───────────────────────────────────────────

async function selftest() {
  try {
    const res = await synthesize({ play: false });
    if (!res.ok) throw new Error(res.error);
    if (!res.pcm || res.pcm.byteLength === 0) throw new Error('empty PCM');
    if (!(res.stats.medianF0Hz > 0)) throw new Error('no voiced frames measured');
    const saved = await aegis.profileSave({ ...state.profile, name: 'Selftest Profile' });
    if (!saved.ok) throw new Error(saved.error);
    const listed = await aegis.profilesList();
    if (!listed.ok || !listed.profiles.some((p) => p.file === saved.file)) throw new Error('saved profile not listed');
    console.log(`[SELFTEST] PASS pcm=${res.pcm.byteLength}B f0=${res.stats.medianF0Hz.toFixed(0)}Hz wpm=${res.stats.wpm.toFixed(0)}`);
  } catch (err) {
    console.log(`[SELFTEST] FAIL ${err.message}`);
  }
  window.close();
}

// ── Init ───────────────────────────────────────────────────────────────────

async function init() {
  const [ranges, env, bankRes, presetsRes] = await Promise.all([
    aegis.ranges(), aegis.env(), aegis.bankList(), aegis.presetsList(),
  ]);
  state.ranges = ranges.ranges;
  state.voices = bankRes.voices;
  state.presets = presetsRes.presets;

  // Start from the Butler preset (or the first available) so the panel never
  // opens on a blank profile.
  const first = state.presets.find((p) => p.file === 'composed-butler.json') || state.presets[0];
  state.profile = first ? structuredClone(first.profile) : null;
  if (!state.profile) {
    setStatus('No presets found — the presets folder is missing.', 'error');
    return;
  }

  buildSliders();
  applyProfile(state.profile, first.file);
  renderEnv(env);
  $('chip-bank').dataset.state = state.voices.some((v) => v.installed) ? 'on' : 'off';
  await refreshSaved();

  for (const w of bankRes.warnings || []) console.warn(`[voicebank] ${w}`);

  $('btn-synth').addEventListener('click', () => synthesize());
  $('btn-play').addEventListener('click', () => {
    if (state.lastPcm) playPcm(state.lastPcm, state.lastSampleRate);
  });
  $('btn-fallback').addEventListener('click', speakFallback);
  $('btn-save').addEventListener('click', saveProfile);

  // Ctrl/Cmd+Enter in the textarea synthesizes — the tune-listen loop lives
  // on the keyboard.
  $('test-text').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) synthesize();
  });

  if (new URLSearchParams(location.search).get('selftest') === '1') {
    selftest();
  }
}

init().catch((err) => {
  // Last-resort surface — the panel should degrade before ever reaching this.
  setStatus(`The panel failed to start: ${err.message}`, 'error');
});
