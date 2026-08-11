'use strict';

// Tuning panel renderer. Talks to the main process ONLY through the
// window.aegis bridge (preload.js) — no Node, no direct filesystem, no
// network. Slider bounds come from PARAM_RANGES over IPC so ranges are never
// duplicated in the UI.

/* global aegis */

// UI localization shortcut. i18n.js (loaded first) defines window.t; this alias
// is fail-soft so a missing runtime just yields the key's English fallback.
const t = (key, params) => (window.t ? window.t(key, params) : key);

// ── Parameter metadata (labels/format only — bounds arrive via IPC) ────────

function signed(v, digits) {
  return (v > 0 ? '+' : '') + v.toFixed(digits);
}

// Each control shows a PLAIN-language hint ("what you'll hear") so a user can
// picture the change; the original engineer term rides along as `tech` and shows
// on hover (row title) for anyone who wants it.
const GROUPS = [
  {
    container: 'group-prosody',
    params: [
      { path: 'prosody.pitchShift', label: 'Pitch', hint: 'higher or lower voice', tech: 'pitch shift · semitones', step: 0.5, fmt: (v) => `${signed(v, 1)} st` },
      { path: 'prosody.rate', label: 'Speed', hint: 'how fast it talks', tech: 'rate · words per minute', step: 5, fmt: (v) => `${v.toFixed(0)} wpm` },
      { path: 'prosody.expressiveness', label: 'Expressiveness', hint: 'lively vs flat and monotone', tech: 'pitch variance', step: 0.05, fmt: (v) => v.toFixed(2) },
      { path: 'prosody.steadiness', label: 'Steadiness', hint: 'even vs natural, human timing', tech: 'timing variance', step: 0.05, fmt: (v) => v.toFixed(2) },
      { path: 'prosody.pauseSentence', label: 'Sentence pause', hint: 'gap between sentences', tech: 'milliseconds', step: 10, fmt: (v) => `${v.toFixed(0)} ms` },
      { path: 'prosody.pauseComma', label: 'Comma pause', hint: 'gap at commas', tech: 'milliseconds', step: 10, fmt: (v) => `${v.toFixed(0)} ms`, reserved: 'Not wired' },
    ],
  },
  {
    container: 'group-timbre',
    params: [
      { path: 'timbre.warmth', label: 'Warmth', hint: 'fuller, deeper low end', tech: 'low shelf · 180 Hz', step: 0.5, fmt: (v) => `${signed(v, 1)} dB` },
      { path: 'timbre.brightness', label: 'Brightness', hint: 'crisp, airy highs', tech: 'high shelf · 5.5 kHz', step: 0.5, fmt: (v) => `${signed(v, 1)} dB` },
      { path: 'timbre.presence', label: 'Presence', hint: 'up-front vs distant', tech: 'bell · 2.8 kHz', step: 0.5, fmt: (v) => `${signed(v, 1)} dB` },
      { path: 'timbre.sibilance', label: 'Harshness', hint: 'tame hissy “s” and “t” sounds', tech: 'de-ess · 7 kHz', step: 0.5, fmt: (v) => `${signed(v, 1)} dB` },
      { path: 'timbre.breath', label: 'Breath', hint: 'breathy texture', tech: 'noise mix', step: 0.05, fmt: (v) => v.toFixed(2), reserved: 'Reserved' },
    ],
  },
  {
    container: 'group-character',
    params: [
      { path: 'character.compression', label: 'Compression', hint: 'steadier, punchier loudness', tech: 'broadcast squash', step: 0.05, fmt: (v) => v.toFixed(2) },
      { path: 'character.radioFilter', label: 'Radio filter', hint: 'tinny walkie-talkie sound', tech: 'comms band', step: 0.05, fmt: (v) => v.toFixed(2) },
      { path: 'character.reverb.mix', label: 'Reverb', hint: 'how much echo', tech: 'reverb mix · room level', step: 0.05, fmt: (v) => v.toFixed(2) },
      { path: 'character.reverb.size', label: 'Room size', hint: 'small booth to big hall', tech: 'reverb size', step: 0.05, fmt: (v) => v.toFixed(2) },
      { path: 'character.bitcrush', label: 'Lo-fi grit', hint: 'gritty, crunchy, digital', tech: 'bitcrush · digital decimation', step: 0.05, fmt: (v) => v.toFixed(2) },
      { path: 'character.chorus', label: 'Chorus', hint: 'shimmery, doubled voice', tech: 'detuned ensemble', step: 0.05, fmt: (v) => v.toFixed(2) },
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

// voiceId -> last-known download percent for downloads running in main. Seeded
// from aegis.bankInflight() at startup so a window reopened mid-download shows
// the bar, and kept current by the global onBankProgress subscription.
const inflight = new Map();

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
      // The engineer term, on hover, for anyone who wants it. The English in
      // GROUPS is the dev fallback; en.json carries the canonical strings.
      if (meta.tech) row.title = t(`panel.param.${meta.path}.tech`);

      const label = document.createElement('label');
      label.className = 'param-label';
      label.htmlFor = `in-${meta.path}`;
      label.textContent = t(`panel.param.${meta.path}.label`);
      if (meta.reserved) {
        const tag = document.createElement('span');
        tag.className = 'tag';
        tag.textContent = meta.reserved === 'Not wired' ? t('panel.reserved.notWired') : t('panel.reserved.reserved');
        label.appendChild(tag);
      }
      const hint = document.createElement('small');
      hint.textContent = t(`panel.param.${meta.path}.hint`);
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

function formatSize(bytes) {
  if (!bytes || bytes <= 0) return '';
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

// Live download rate — keeps a decimal in the MB range and drops to KB/s on a slow
// link so the number still visibly moves (formatSize rounds MB, too coarse here).
function formatRate(bytesPerSec) {
  if (!bytesPerSec || bytesPerSec <= 0) return '';
  const mb = bytesPerSec / (1024 * 1024);
  if (mb >= 1) return `${mb.toFixed(1)} MB/s`;
  return `${Math.max(1, Math.round(bytesPerSec / 1024))} KB/s`;
}

// Remaining time as ~m:ss (an HD pack never realistically exceeds an hour). '' when
// there's no speed sample yet.
function formatEta(sec) {
  if (sec == null || !isFinite(sec) || sec <= 0) return '';
  if (sec >= 3600) { const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60); return `~${h}h${m}m`; }
  let m = Math.floor(sec / 60), s = Math.round(sec % 60);
  if (s === 60) { m += 1; s = 0; }
  return `~${m}:${String(s).padStart(2, '0')}`;
}

// The compact "1.2 / 3.4 GB · 5.6 MB/s · ~2:15" line under a download bar. Kept
// numeric/symbolic on purpose so it reads the same in every locale.
function formatDlInfo(p) {
  if (!p || typeof p !== 'object') return '';
  const parts = [];
  if (p.total) parts.push(`${formatSize(p.received || 0) || '0 MB'} / ${formatSize(p.total)}`);
  const rate = formatRate(p.bytesPerSec);
  if (rate) parts.push(rate);
  const eta = formatEta(p.etaSec);
  if (eta) parts.push(eta);
  return parts.join(' · ');
}

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
    // HD voices run on the heavier MeloTTS engine — flag them so a user knows
    // this is the higher-quality upgrade (and a larger download).
    if (voice.hd) {
      const badge = document.createElement('span');
      badge.className = 'hd-badge';
      badge.textContent = 'HD';
      badge.title = t('panel.voice.hdTitle');
      name.appendChild(badge);
    }

    const meta = document.createElement('span');
    meta.className = `row-meta${voice.installed ? '' : ' warn'}`;
    meta.textContent = voice.installed ? `${voice.sex} · ${voice.accent}` : t('panel.voice.notInstalled');

    row.append(name, meta);

    // A voice that isn't installed shows a Get button — UNLESS it's downloading
    // right now (possibly started before this window was reopened), in which case
    // it shows a live progress bar restored from main's in-flight state.
    if (!voice.installed && !inflight.has(voice.id)) {
      const dl = document.createElement('button');
      dl.type = 'button';
      dl.className = 'dl';
      // HD packs are hundreds of MB — show the size so the download isn't a
      // surprise; standard Piper voices stay a plain "Get".
      dl.textContent = voice.hd ? t('panel.voice.upgrade', { size: formatSize(voice.sizeBytes) }) : t('panel.voice.get');
      dl.addEventListener('click', (e) => {
        e.stopPropagation();
        downloadVoice(voice);
      });
      row.appendChild(dl);
    }

    row.addEventListener('click', () => {
      state.profile.base.voice = voice.id;
      renderVoices();
      syncTestTextToVoice(); // switch the sample sentence to this voice's language
      setStatus(t('panel.voice.baseVoice', { name: voice.displayName }), 'live');
      prewarmCurrentVoice(); // warm the newly picked voice's engine now
    });

    li.appendChild(row);
    // Restore/attach the progress bar for an in-flight download. Its width is
    // driven by the ONE global onBankProgress subscription (see init), so it
    // keeps updating even in a window opened after the download started.
    if (inflight.has(voice.id)) {
      const p = inflight.get(voice.id) || {};
      const bar = document.createElement('div');
      bar.className = 'progress dl-bar';
      bar.dataset.voice = voice.id;
      const fill = document.createElement('span');
      fill.style.width = `${p.pct || 0}%`;
      bar.appendChild(fill);
      li.appendChild(bar);
      // Live readout: downloaded / total · speed · time left.
      const info = document.createElement('div');
      info.className = 'dl-info';
      info.dataset.voice = voice.id;
      info.textContent = formatDlInfo(p);
      li.appendChild(info);
    }
    list.appendChild(li);
  }
}

// Kick off a download. The download runs in MAIN, so it survives this window
// closing; the global onBankProgress subscription (init) drives the bar and the
// completion refresh, which is what makes it resilient to close/reopen.
async function downloadVoice(voice) {
  if (inflight.has(voice.id)) return;
  inflight.set(voice.id, { pct: 0 });
  renderVoices();
  if (voice.hd) setStatus(t('panel.voice.downloadingHd', { name: voice.displayName }), 'live');
  try { await aegis.bankDownload(voice.id); } catch { /* progress subscription reports done/error */ }
}

// One subscription for the whole panel: updates any visible progress bar and, on
// completion, refreshes the bank (installed) or reports the error. Because it's
// global (not per-click), a window reopened mid-download still finishes cleanly.
function watchBankDownloads() {
  aegis.onBankProgress((p) => {
    if (!p || !p.id) return;
    if (p.done) {
      inflight.delete(p.id);
      if (p.ok) {
        const v = state.voices.find((x) => x.id === p.id);
        const name = (v && v.displayName) || p.id;
        refreshBank();
        setStatus(t('panel.voice.installed', { name }), 'live');
      } else {
        setStatus(p.error || t('panel.voice.downloadFailed'), 'error');
        renderVoices();
      }
      return;
    }
    inflight.set(p.id, p);
    const fill = document.querySelector(`.dl-bar[data-voice="${p.id}"] > span`);
    if (fill) fill.style.width = `${p.pct}%`;
    const info = document.querySelector(`.dl-info[data-voice="${p.id}"]`);
    if (info) info.textContent = formatDlInfo(p);
    const v = state.voices.find((x) => x.id === p.id);
    if (v && v.hd) {
      const what = p.phase === 'engine' ? t('panel.voice.hdEngine') : t('panel.voice.hdVoice');
      setStatus(t('panel.voice.downloading', { what, pct: p.pct }), 'live');
    }
  });
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

// Warm the neural HD engine in the background as soon as we know which voice is
// active, so the FIRST Synthesize isn't a ~13 s cold start — it loads while the
// user is reading the panel / editing the clip text. No-op for a non-HD or
// not-installed voice (main's prewarm handler guards those). Cheap to call often.
function prewarmCurrentVoice() {
  try {
    const voiceId = state.profile && state.profile.base && state.profile.base.voice;
    if (voiceId && aegis.voicePrewarm) aegis.voicePrewarm(voiceId);
  } catch { /* best effort — prewarm must never block the UI */ }
}

// A sample sentence per VOICE language, so testing a Chinese voice actually
// speaks Chinese (an English sample through a Chinese voice is a poor test). The
// EN phrase matches the index.html default so it's recognized as "auto". These
// are voice-language samples, NOT UI strings — they stay in their own language
// regardless of the interface locale.
const TEST_PHRASES = {
  en: 'Good evening. All systems are online, and every diagnostic reports nominal performance across the board.',
  es: 'Buenas noches. Todos los sistemas están en línea y cada diagnóstico informa de un rendimiento nominal.',
  fr: 'Bonsoir. Tous les systèmes sont en ligne et chaque diagnostic signale des performances nominales.',
  zh: '晚上好。所有系统均已上线，各项诊断均报告一切运行正常。',
  ja: 'こんばんは。すべてのシステムがオンラインで、各診断は正常に動作していると報告しています。',
  ko: '안녕하세요. 모든 시스템이 온라인 상태이며 모든 진단이 정상 작동을 보고합니다.',
};
const AUTO_PHRASES = new Set(Object.values(TEST_PHRASES));

// A voice id's language, from its 2-letter prefix (en_hd, zh_hd, en_male, …).
function langOfVoiceId(voiceId) {
  const m = /^([a-z]{2})[_-]/i.exec(String(voiceId || ''));
  if (!m) return 'en';
  const p = m[1].toLowerCase();
  return p === 'jp' ? 'ja' : p === 'kr' ? 'ko' : p;
}

// Swap the test text to the chosen voice's language — but ONLY when the box
// still holds an auto phrase (or is empty). A test sentence the user typed
// themselves is never overwritten.
function syncTestTextToVoice() {
  const ta = $('test-text');
  if (!ta) return;
  const cur = ta.value.trim();
  if (cur !== '' && !AUTO_PHRASES.has(cur)) return;
  const lang = langOfVoiceId(state.profile && state.profile.base && state.profile.base.voice);
  ta.value = TEST_PHRASES[lang] || TEST_PHRASES.en;
}

function applyProfile(profile, presetFile) {
  state.profile = structuredClone(profile);
  state.activePresetFile = presetFile || null;
  $('profile-name').value = state.profile.name;
  $('profile-author').value = state.profile.author;
  syncSlidersFromProfile();
  renderVoices();
  renderPresets();
  updatePublishButton(); // a loaded imported voice can't be republished
  syncTestTextToVoice(); // match the sample sentence to this voice's language
  prewarmCurrentVoice(); // panel open + preset/profile load both flow through here
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
      setStatus(t('panel.loadedPreset', { name: preset.profile.name }), 'live');
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
      setStatus(t('panel.loadedProfile', { name: loaded.profile.name }), 'live');
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
  $('profile-status').textContent = res.ok ? t('panel.profile.savedTo', { file: res.file }) : res.error;
  // Keep the working profile's provenance in step with what was written (a fresh
  // save stamps 'scratch'), so the publish button reflects it immediately.
  if (res.ok && res.profile) { state.profile = res.profile; updatePublishButton(); await refreshSaved(); }
}

// A voice imported from another creator can be used and tuned, but not published
// as the user's own — reflect that on the Share button (the gate is enforced in
// main regardless).
function updatePublishButton() {
  const btn = $('btn-publish');
  if (!btn) return;
  const imported = state.profile && state.profile.origin === 'imported';
  btn.disabled = !!imported;
  btn.title = imported
    ? t('panel.publish.importedTitle')
    : t('panel.publish.shareTitle');
}

// Save the current tuning, then open the Workshop publish dialog for it. Sharing
// publishes the auditory PROFILE only (a base-voice reference + your tuning) —
// never any audio (the project's hard legal boundary).
async function publishVoiceFlow() {
  if (state.profile && state.profile.origin === 'imported') {
    $('profile-status').textContent = t('panel.publish.importedError');
    return;
  }
  syncProfileMeta();
  const saved = await aegis.profileSave(state.profile);
  if (!saved.ok) { $('profile-status').textContent = saved.error; return; }
  if (saved.profile) { state.profile = saved.profile; updatePublishButton(); }
  await refreshSaved();

  const st = await aegis.workshopStatus();
  if (!st.available) {
    $('profile-status').textContent = st.reason || t('panel.publish.steamUnavailable');
    return;
  }
  openVoicePublishDialog(saved.file, saved.profile || state.profile);
}

function voiceField(labelText, control) {
  const wrap = document.createElement('div');
  wrap.className = 'field';
  const label = document.createElement('label');
  label.textContent = labelText;
  wrap.append(label, control);
  return wrap;
}

// A compact publish dialog for the tuning panel (the manager has its own richer
// dashboard dialog; a voice needs far fewer fields). Blocks dismissal while an
// upload is in flight so the user can't close it thinking it stalled.
function openVoicePublishDialog(file, profile) {
  const scrim = document.createElement('div');
  scrim.className = 'tp-scrim';
  const dialog = document.createElement('div');
  dialog.className = 'tp-dialog';
  scrim.appendChild(dialog);

  let publishing = false;
  const escHandler = (e) => { if (e.key === 'Escape') tryClose(); };
  const close = () => { scrim.remove(); document.removeEventListener('keydown', escHandler); };
  const tryClose = () => { if (!publishing) close(); };

  const heading = document.createElement('h3');
  heading.textContent = t('panel.publish.heading', { name: profile.name });
  const sub = document.createElement('p');
  sub.className = 'tp-sub';
  sub.textContent = t('panel.publish.sub', { voice: profile.base.voice });
  dialog.append(heading, sub);

  const title = document.createElement('input');
  title.type = 'text'; title.maxLength = 128; title.value = profile.name || '';
  const desc = document.createElement('textarea');
  desc.maxLength = 8000;
  desc.value = t('panel.publish.descDefault', { voice: profile.base.voice });
  const tags = document.createElement('input');
  tags.type = 'text'; tags.placeholder = t('panel.publish.tagsPlaceholder');
  const vis = document.createElement('select');
  for (const [v, label] of [
    ['unlisted', t('panel.publish.vis.unlisted')],
    ['public', t('panel.publish.vis.public')],
    ['friends', t('panel.publish.vis.friends')],
    ['private', t('panel.publish.vis.private')],
  ]) {
    const opt = document.createElement('option'); opt.value = v; opt.textContent = label; vis.appendChild(opt);
  }
  dialog.append(
    voiceField(t('panel.publish.fieldTitle'), title),
    voiceField(t('panel.publish.fieldDescription'), desc),
    voiceField(t('panel.publish.fieldTags'), tags),
    voiceField(t('panel.publish.fieldVisibility'), vis),
  );

  const status = document.createElement('p');
  status.className = 'tp-status';

  const actions = document.createElement('div');
  actions.className = 'tp-actions';
  const cancel = document.createElement('button');
  cancel.className = 'btn'; cancel.textContent = t('common.cancel');
  cancel.addEventListener('click', tryClose);
  const spacer = document.createElement('div'); spacer.className = 'tp-spacer';
  const submit = document.createElement('button');
  submit.className = 'btn primary'; submit.textContent = t('panel.publish.publish');
  submit.addEventListener('click', async () => {
    publishing = true;
    submit.disabled = true; cancel.disabled = true;
    status.style.color = '';
    status.textContent = t('panel.publish.publishing');
    const out = await aegis.voicePublish({
      profileFile: file,
      title: title.value,
      description: desc.value,
      tags: tags.value.split(',').map((t) => t.trim()).filter(Boolean),
      visibility: vis.value,
    });
    publishing = false; cancel.disabled = false;
    if (!out.ok) {
      submit.disabled = false;
      status.style.color = 'var(--warn)';
      status.textContent = out.error || t('panel.publish.failed');
      return;
    }
    const parts = [`${out.updated ? t('panel.publish.updated') : t('panel.publish.published')} ${out.url}`];
    if (out.needsToAcceptAgreement) parts.push(t('panel.publish.acceptAgreement'));
    if (out.note) parts.push(out.note);
    status.style.color = '';
    status.textContent = parts.join(' — ');
    submit.disabled = true;
    cancel.textContent = t('common.close');
    $('profile-status').textContent = parts.join(' — ');
  });
  actions.append(cancel, spacer, submit);
  dialog.append(status, actions);

  scrim.addEventListener('click', (e) => { if (e.target === scrim) tryClose(); });
  document.addEventListener('keydown', escHandler);
  document.body.appendChild(scrim);
  title.focus();
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
  // F0 is absolute Hz, but the Pitch slider is a RELATIVE shift — show the measured
  // shift in semitones too so it reads against the slider (e.g. 205 Hz = +0.5 st
  // above the dry 200 Hz), not as an unrelated number.
  const shiftSt = (stats.medianF0Hz > 0 && stats.dryMedianF0Hz > 0) ? 12 * Math.log2(stats.medianF0Hz / stats.dryMedianF0Hz) : 0;
  $('ro-f0').textContent = stats.medianF0Hz > 0
    ? `${stats.medianF0Hz.toFixed(0)} Hz${Math.abs(shiftSt) >= 0.05 ? ` (${signed(shiftSt, 1)} st)` : ''}`
    : '—';
  $('ro-f0-dry').textContent = t('panel.readout.dry', { v: `${stats.dryMedianF0Hz.toFixed(0)} Hz` });
  $('ro-rate').textContent = `${stats.wpm.toFixed(0)} wpm`;
  $('ro-rate-target').textContent = t('panel.readout.target', { v: `${state.profile.prosody.rate.toFixed(0)} wpm` });
  $('ro-duration').textContent = `${stats.durationSeconds.toFixed(2)} s`;
  $('ro-speech').textContent = t('panel.readout.speech', { v: `${stats.speechSeconds.toFixed(2)} s` });
  $('ro-voiced').textContent = `${(stats.voicedFraction * 100).toFixed(0)} %`;
}

async function synthesize({ play = true } = {}) {
  syncProfileMeta();
  const btn = $('btn-synth');
  btn.disabled = true;
  btn.classList.add('busy');
  setStatus(t('panel.synth.synthesizing'), 'live');
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
  setStatus(res.warning || t('panel.synth.done'), res.warning ? 'error' : 'live');
  if (play) playPcm(res.pcm, res.sampleRate);
  return res;
}

async function speakFallback() {
  setStatus(t('panel.synth.speakingSystem'), 'live');
  const hint = state.profile.base.fallback ? state.profile.base.fallback.match : '';
  const res = await aegis.speakFallback($('test-text').value, hint);
  setStatus(res.ok ? t('panel.synth.doneSystem') : res.error, res.ok ? undefined : 'error');
}

// ── Environment chips ──────────────────────────────────────────────────────

function renderEnv(env) {
  $('chip-piper').dataset.state = env.piper ? 'on' : 'off';
  $('chip-ffmpeg').dataset.state = env.ffmpeg ? 'on' : 'off';
  if (!env.piper) {
    setStatus(t('panel.env.noPiper'), 'error');
  } else if (!env.ffmpeg) {
    setStatus(t('panel.env.noFfmpeg'), 'error');
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

  // Restore any download that's already running in main (it survives this window
  // closing), then watch progress for the whole panel with ONE subscription — so
  // reopening mid-download shows the live bar and still finishes cleanly.
  try {
    const inf = await aegis.bankInflight();
    if (inf && inf.ok) for (const d of inf.downloads) inflight.set(d.id, d);
  } catch { /* fail-soft — no restored bars */ }
  watchBankDownloads();

  // Start from the Butler preset (or the first available) so the panel never
  // opens on a blank profile.
  const first = state.presets.find((p) => p.file === 'composed-butler.json') || state.presets[0];
  state.profile = first ? structuredClone(first.profile) : null;
  if (!state.profile) {
    setStatus(t('panel.init.noPresets'), 'error');
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
  $('btn-publish').addEventListener('click', publishVoiceFlow);
  updatePublishButton();

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
  setStatus(t('panel.init.startFailed', { message: err.message }), 'error');
});
