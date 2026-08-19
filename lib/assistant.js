'use strict';

// AI assistant bridge — BRING-YOUR-OWN endpoint (OpenAI-compatible). The user
// points it at any OpenAI-compatible /chat/completions endpoint. Three free or
// paid paths, all reliable because they're the user's own:
//   • a local model — Ollama / LM Studio (base URL like http://localhost:11434/v1,
//     NO key needed, fully offline & private);
//   • a free-tier key — OpenRouter / Groq give genuinely free models;
//   • their own paid key — OpenAI, etc.
//
// (We used to ship a keyless community default via Pollinations; it started
// returning 402/needs-payment and a shared free endpoint has no SLA, so the
// assistant is now BYO — no single point of failure, no owner cost.)
//
// If a key is used it is SECRET: stored OS-encrypted via Electron safeStorage,
// never handed to a renderer (they learn only hasKey), never written into a
// pack or export. All network calls live here in main and fail soft.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FILE = 'assistant.json';
const THREAD_FILE = 'assistant-thread.json'; // legacy single conversation (migrated into a session)
const SESSIONS_DIR = 'assistant-sessions';   // per-conversation store (personal data — never in a pack)
const INDEX_FILE = 'index.json';             // session metadata + which is active
const MAX_THREAD_TURNS = 40;                  // scrollback we keep on disk, per session
const MAX_SESSIONS = 100;                     // cap the chat list; oldest is pruned past this
const MAX_TITLE = 60;
const MAX_MSG_LEN = 4000;
// Context budget: how many recent messages get SENT to the model each turn. The
// full transcript is still kept on disk (up to MAX_THREAD_TURNS) for the user to
// read — this only bounds the prompt so a long chat can't overflow a small model
// or slow down / cost more every turn. A conservative default that's safe for
// tiny local models; power users raise it in Manager → Assistant.
const DEFAULT_CONTEXT_LIMIT = 12;
const MIN_CONTEXT_LIMIT = 2;
const MAX_CONTEXT_LIMIT = 500;
const PROVIDERS = ['openai']; // single OpenAI-compatible provider (local or hosted)
const MAX_PERSONA = 4000;
const MAX_MODEL = 80;
const MAX_URL = 300;
// User-saved personas (their own prompts, kept to reuse). Just text — no secrets.
const MAX_PRESETS = 24;
const MAX_PRESET_NAME = 40;
const REQUEST_TIMEOUT_MS = 60 * 1000;

function safeStorage() {
  try {
    return require('electron').safeStorage;
  } catch {
    return null;
  }
}

function configFile(userDir) {
  return path.join(userDir, FILE);
}

function defaults() {
  return {
    provider: 'openai',
    model: '', // user picks (e.g. gpt-4o-mini, llama3.1) — blank = not set up yet
    baseUrl: '', // blank → api.openai.com/v1; set a local/hosted OpenAI-compatible URL
    persona:
      // Leads with a language lock (matches the Aegis preset in src/manager.js): the
      // spoken reply is read by a single-language voice, so the model must not drift
      // into whatever language the user typed.
      'Always reply in English, whatever language the user writes in; never switch languages. '
      + 'You are Aegis, a calm, precise mission-control operator for this machine. '
      + 'Be concise — two to four sentences unless a task needs more. '
      + 'Never use markdown, bullet points, or emoji; reply in plain spoken sentences, as your words are read aloud.',
    maxTokens: 1024,
    speak: true,
    voiceProfile: '', // '' → the engine's default voice profile
    personaPresets: [], // the user's own saved personas
    contextLimit: DEFAULT_CONTEXT_LIMIT, // recent messages sent to the model per turn
  };
}

function clampInt(v, min, max, fallback) {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
}

function str(value, maxLen, fallback) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim().slice(0, maxLen) : fallback;
}

// The user's saved personas: [{ name, prompt }], deduped by name, capped.
function sanitizePresets(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const p of raw) {
    if (typeof p !== 'object' || p === null) continue;
    const name = str(p.name, MAX_PRESET_NAME, null);
    const prompt = str(p.prompt, MAX_PERSONA, null);
    if (!name || !prompt || seen.has(name)) continue;
    seen.add(name);
    out.push({ name, prompt });
    if (out.length >= MAX_PRESETS) break;
  }
  return out;
}

// ── Persistence ─────────────────────────────────────────────────────────────

function loadRaw(userDir) {
  const clean = defaults();
  let raw = null;
  try {
    const text = fs.readFileSync(configFile(userDir), 'utf8');
    raw = JSON.parse(text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text);
  } catch {
    return { config: clean, keyEnc: null };
  }
  if (typeof raw !== 'object' || raw === null) return { config: clean, keyEnc: null };
  clean.provider = PROVIDERS.includes(raw.provider) ? raw.provider : clean.provider;
  clean.model = str(raw.model, MAX_MODEL, clean.model);
  clean.baseUrl = str(raw.baseUrl, MAX_URL, '');
  clean.persona = str(raw.persona, MAX_PERSONA, clean.persona);
  clean.maxTokens = clampInt(raw.maxTokens, 64, 4096, clean.maxTokens);
  clean.speak = typeof raw.speak === 'boolean' ? raw.speak : clean.speak;
  clean.voiceProfile = str(raw.voiceProfile, 80, '');
  clean.personaPresets = sanitizePresets(raw.personaPresets);
  clean.contextLimit = clampInt(raw.contextLimit, MIN_CONTEXT_LIMIT, MAX_CONTEXT_LIMIT, clean.contextLimit);
  const keyEnc = typeof raw.keyEnc === 'string' && raw.keyEnc !== '' ? raw.keyEnc : null;
  return { config: clean, keyEnc };
}

// Enough to make a call: a model id, plus either a key (hosted) or a base URL
// (a local server needs no key). Without these the assistant is "not set up".
function isConfigured(config, hasKey) {
  const hasModel = !!(config.model && config.model.trim());
  const hasEndpoint = hasKey || !!(config.baseUrl && config.baseUrl.trim());
  return hasModel && hasEndpoint;
}

/** Public view for a renderer — config plus hasKey + configured, NEVER the key. */
function getPublicConfig(userDir) {
  const { config, keyEnc } = loadRaw(userDir);
  return { ...config, hasKey: keyEnc !== null, configured: isConfigured(config, keyEnc !== null) };
}

function decryptKey(keyEnc) {
  if (!keyEnc) return '';
  const ss = safeStorage();
  try {
    if (ss && ss.isEncryptionAvailable()) {
      return ss.decryptString(Buffer.from(keyEnc, 'base64'));
    }
    return Buffer.from(keyEnc, 'base64').toString('utf8');
  } catch {
    return '';
  }
}

function encryptKey(key) {
  const ss = safeStorage();
  try {
    if (ss && ss.isEncryptionAvailable()) {
      return ss.encryptString(key).toString('base64');
    }
  } catch { /* fall through to best-effort */ }
  return Buffer.from(key, 'utf8').toString('base64');
}

/**
 * Save config. `patch.apiKey`: a string sets a new key, '' clears it, omitted
 * leaves the stored key untouched.
 */
function saveConfig(userDir, patch) {
  const source = typeof patch === 'object' && patch !== null ? patch : {};
  const { config: current, keyEnc: currentKeyEnc } = loadRaw(userDir);
  const next = {
    provider: PROVIDERS.includes(source.provider) ? source.provider : current.provider,
    model: str(source.model, MAX_MODEL, current.model),
    baseUrl: source.baseUrl === undefined ? current.baseUrl : str(source.baseUrl, MAX_URL, ''),
    persona: str(source.persona, MAX_PERSONA, current.persona),
    maxTokens: source.maxTokens === undefined ? current.maxTokens : clampInt(source.maxTokens, 64, 4096, current.maxTokens),
    speak: typeof source.speak === 'boolean' ? source.speak : current.speak,
    voiceProfile: source.voiceProfile === undefined ? current.voiceProfile : str(source.voiceProfile, 80, ''),
    personaPresets: source.personaPresets === undefined ? current.personaPresets : sanitizePresets(source.personaPresets),
    contextLimit: source.contextLimit === undefined ? current.contextLimit : clampInt(source.contextLimit, MIN_CONTEXT_LIMIT, MAX_CONTEXT_LIMIT, current.contextLimit),
  };

  let keyEnc = currentKeyEnc;
  if (typeof source.apiKey === 'string') {
    keyEnc = source.apiKey.trim() === '' ? null : encryptKey(source.apiKey.trim());
  }

  fs.mkdirSync(userDir, { recursive: true });
  const onDisk = keyEnc ? { ...next, keyEnc } : next;
  const tmp = `${configFile(userDir)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(onDisk, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, configFile(userDir));
  return { ok: true, config: { ...next, hasKey: keyEnc !== null } };
}

// Save the user's current prompt as a named persona (replaces one of the same
// name). Returns the updated config.
function addPersonaPreset(userDir, name, prompt) {
  const nm = str(name, MAX_PRESET_NAME, null);
  const pr = str(prompt, MAX_PERSONA, null);
  if (!nm) return { ok: false, error: 'Give the persona a name.' };
  if (!pr) return { ok: false, error: 'Write a prompt first, then save it.' };
  const { config } = loadRaw(userDir);
  const list = (config.personaPresets || []).filter((p) => p.name !== nm);
  if (list.length >= MAX_PRESETS) return { ok: false, error: `You can save up to ${MAX_PRESETS} personas.` };
  list.push({ name: nm, prompt: pr });
  return saveConfig(userDir, { personaPresets: list });
}

function removePersonaPreset(userDir, name) {
  const { config } = loadRaw(userDir);
  const list = (config.personaPresets || []).filter((p) => p.name !== name);
  return saveConfig(userDir, { personaPresets: list });
}

// ── The AI call ─────────────────────────────────────────────────────────────

// Reasoning models (Qwen3, DeepSeek-R1, …) embed a chain-of-thought in
// <think>…</think> (or leave a dangling …</think> when they overrun) — keep
// only the actual answer. Used by both the one-shot and streaming parsers.
function stripThink(text) {
  let t = String(text || '').replace(/<think>[\s\S]*?<\/think>/gi, ' ');
  if (/<\/think>/i.test(t)) t = t.replace(/^[\s\S]*?<\/think>/i, ' ');
  return t;
}

// The answer text visible SO FAR from a still-growing raw buffer: drop finished
// <think>…</think> blocks, and if a <think> is still open (model mid-thought),
// hide everything from it onward until it closes. Append-only friendly — the
// final stripThink(raw) reconciles any streamed artifact.
function visiblePrefix(raw) {
  const t = raw.replace(/<think>[\s\S]*?<\/think>/gi, ' ');
  const open = t.search(/<think>/i);
  return open === -1 ? t : t.slice(0, open);
}

// Turn an OpenAI-compatible error response into plain, actionable guidance —
// the common statuses (bad key, no credits, rate limit, wrong model/URL) are
// exactly what a BYO user hits, so name them instead of leaking a raw code.
function parseOpenAIShape(status, ok, data) {
  if (!ok) {
    const detail = data && data.error && (data.error.message || data.error) ? String(data.error.message || data.error) : '';
    let msg;
    if (status === 401 || status === 403) msg = `Rejected (${status}): the API key is missing or invalid for this endpoint.`;
    else if (status === 402) msg = 'Payment required (402): this account is out of credits or needs billing. Use a free-tier key (OpenRouter/Groq), a local model, or add credits — set it in Manager → Assistant.';
    else if (status === 404) msg = 'Not found (404): double-check the Base URL and the Model id in Manager → Assistant.';
    else if (status === 429) msg = 'Rate limited (429): too many requests — wait a moment and retry, or switch endpoint.';
    else msg = detail || `The AI endpoint returned HTTP ${status}.`;
    return { ok: false, error: msg.slice(0, 300) };
  }
  const msg = data && data.choices && data.choices[0] && data.choices[0].message;
  const text = stripThink(msg ? msg.content : '').trim();
  if (text) return { ok: true, text };
  // Empty answer — most often a reasoning model that spent its whole reply budget
  // "thinking", or one that refused. Say so instead of a bare failure.
  return { ok: false, error: 'The model returned no text — if it is a reasoning model it may have used its reply budget thinking; raise the reply length or use a non-reasoning model.' };
}

async function callOpenAICompatible(config, key, messages, signal) {
  const base = (config.baseUrl && config.baseUrl.trim()) || 'https://api.openai.com/v1';
  const url = `${base.replace(/\/+$/, '')}/chat/completions`;
  const headers = { 'content-type': 'application/json' };
  if (key) headers.authorization = `Bearer ${key}`; // key is OPTIONAL (local servers need none)
  // Reasoning models (Qwen3, DeepSeek-R1, …) emit a long hidden reasoning stream
  // BEFORE the answer; at a small token ceiling they hit it mid-thought and
  // return EMPTY content (finish_reason "length") — the "model returned no text"
  // bug. max_tokens is only a CEILING, so a generous floor lets the answer fit
  // while non-reasoning models still stop at their short reply (finish "stop").
  const budget = Math.max(Number(config.maxTokens) || 1024, 4096);
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: config.model,
      max_tokens: budget,
      messages: [{ role: 'system', content: config.persona }, ...messages],
    }),
    signal,
  });
  const data = await res.json().catch(() => null);
  return parseOpenAIShape(res.status, res.ok, data);
}

// Streaming variant: same request with `stream:true`, but the visible answer is
// emitted incrementally through onDelta as Server-Sent Events arrive, so the UI
// can render the reply as it's generated. Returns the same {ok,text}|{ok,error}
// shape. Fails soft: an endpoint that ignores streaming (returns one JSON body)
// is parsed the normal way, so those still work with no live tokens.
async function streamOpenAICompatible(config, key, messages, signal, onDelta) {
  const base = (config.baseUrl && config.baseUrl.trim()) || 'https://api.openai.com/v1';
  const url = `${base.replace(/\/+$/, '')}/chat/completions`;
  const headers = { 'content-type': 'application/json' };
  if (key) headers.authorization = `Bearer ${key}`;
  const budget = Math.max(Number(config.maxTokens) || 1024, 4096);
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: config.model,
      max_tokens: budget,
      stream: true,
      messages: [{ role: 'system', content: config.persona }, ...messages],
    }),
    signal,
  });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    return parseOpenAIShape(res.status, false, data);
  }
  const ctype = (res.headers.get('content-type') || '').toLowerCase();
  if (!ctype.includes('text/event-stream') || !res.body || !res.body.getReader) {
    const data = await res.json().catch(() => null);
    return parseOpenAIShape(res.status, true, data); // endpoint didn't stream
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';     // unparsed SSE tail across chunks
  let raw = '';     // accumulated raw content (may still contain <think>)
  let emitted = 0;  // length of visible text already handed to onDelta
  const pump = (chunk) => {
    raw += chunk;
    const vis = visiblePrefix(raw);
    if (vis.length > emitted) { onDelta(vis.slice(emitted)); emitted = vis.length; }
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line || !line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') { buf = ''; break; }
      let json;
      try { json = JSON.parse(payload); } catch { continue; }
      const delta = json.choices && json.choices[0] && json.choices[0].delta;
      // Only the answer content streams; delta.reasoning / reasoning_content
      // (hidden chain-of-thought) are intentionally never shown.
      if (delta && typeof delta.content === 'string' && delta.content) pump(delta.content);
    }
  }
  const text = stripThink(raw).trim();
  if (text) return { ok: true, text };
  return { ok: false, error: 'The model returned no text — if it is a reasoning model it may have used its reply budget thinking; raise the reply length or use a non-reasoning model.' };
}

/**
 * Ask the configured model. `messages` is the running conversation. If `onDelta`
 * is a function, the reply is STREAMED (onDelta gets visible-text chunks as they
 * arrive) and the same final {ok,text} is returned; without it, one-shot.
 */
async function ask(userDir, messages, onDelta) {
  const { config, keyEnc } = loadRaw(userDir);
  if (!isConfigured(config, keyEnc !== null)) {
    return {
      ok: false,
      needsSetup: true,
      error: 'The assistant isn’t set up yet. Open Manager → Assistant and add an endpoint — a local model (Ollama/LM Studio, no key), a free-tier key (OpenRouter/Groq), or your own OpenAI key.',
    };
  }
  // Context budget: send only the last N messages so a long chat can't overflow
  // the model or slow down every turn. The full transcript is still kept on disk
  // (the caller passes it in); the system persona is prepended separately and is
  // never trimmed.
  const limit = clampInt(config.contextLimit, MIN_CONTEXT_LIMIT, MAX_CONTEXT_LIMIT, DEFAULT_CONTEXT_LIMIT);
  const windowed = Array.isArray(messages) ? messages.slice(-limit) : [];

  const streaming = typeof onDelta === 'function';
  const controller = new AbortController();
  // Idle timeout: reset on every chunk so a long (but steadily-producing) local
  // model isn't cut off, while a truly stalled endpoint still aborts.
  let timer;
  const arm = () => { clearTimeout(timer); timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS); };
  arm();
  try {
    if (streaming) {
      return await streamOpenAICompatible(config, decryptKey(keyEnc), windowed, controller.signal, (part) => {
        arm();
        onDelta(part);
      });
    }
    return await callOpenAICompatible(config, decryptKey(keyEnc), windowed, controller.signal);
  } catch (err) {
    if (err.name === 'AbortError') return { ok: false, error: 'The AI endpoint took too long to respond.' };
    return { ok: false, error: `Could not reach the AI endpoint: ${err.message}` };
  } finally {
    clearTimeout(timer);
  }
}

// ── Conversation persistence ─────────────────────────────────────────────────
// The transcript is kept on disk so the desktop chat has real history/memory:
// it survives a re-render (the wallpaper repaints often) AND an app restart.
// Personal data — like reminders, it stays local and never enters a pack.

function threadFile(userDir) {
  return path.join(userDir, THREAD_FILE);
}

function cleanThread(arr) {
  return (Array.isArray(arr) ? arr : [])
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_MSG_LEN) }))
    .slice(-MAX_THREAD_TURNS);
}

function loadThread(userDir) {
  try {
    const text = fs.readFileSync(threadFile(userDir), 'utf8');
    const raw = JSON.parse(text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text);
    return cleanThread(Array.isArray(raw) ? raw : raw && raw.thread);
  } catch {
    return []; // none yet — not an error
  }
}

function saveThread(userDir, thread) {
  try {
    fs.mkdirSync(userDir, { recursive: true });
    const tmp = `${threadFile(userDir)}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ thread: cleanThread(thread) }, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, threadFile(userDir));
  } catch { /* fail soft — history is a convenience, never critical */ }
}

function clearThread(userDir) {
  try { fs.rmSync(threadFile(userDir), { force: true }); } catch { /* ignore */ }
}

// ── Multiple local sessions ───────────────────────────────────────────────────
// The user keeps SEVERAL conversations (like ChatGPT's chat list), all local and
// never in a pack. Each session is its own file `<id>.json` (the thread, capped
// like the legacy single thread); a small `index.json` holds the list metadata +
// which one is active. The old single `assistant-thread.json` migrates in as the
// first session on first use, so nobody loses their history.

function sessionsDir(userDir) { return path.join(userDir, SESSIONS_DIR); }
function indexPath(userDir) { return path.join(sessionsDir(userDir), INDEX_FILE); }

// Session ids are our own UUIDs; validate the shape so an id from a renderer can
// never escape the sessions dir (path traversal). Returns '' if not a clean id.
function safeId(id) {
  return typeof id === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id) ? id : '';
}
function sessionPath(userDir, id) { return path.join(sessionsDir(userDir), `${safeId(id)}.json`); }

function ms(v) { return typeof v === 'number' && Number.isFinite(v) ? v : 0; }

// A user message's text makes a good auto-title (no model call needed).
function titleFromThread(thread) {
  const firstUser = (Array.isArray(thread) ? thread : []).find((m) => m && m.role === 'user' && m.content);
  return firstUser ? firstUser.content.replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE) : '';
}

function readIndex(userDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(indexPath(userDir), 'utf8'));
    if (!raw || typeof raw !== 'object') return null;
    const sessions = (Array.isArray(raw.sessions) ? raw.sessions : [])
      .filter((s) => s && safeId(s.id))
      .map((s) => ({ id: s.id, title: str(s.title, MAX_TITLE, ''), createdAt: ms(s.createdAt), updatedAt: ms(s.updatedAt) }))
      .slice(0, MAX_SESSIONS);
    if (sessions.length === 0) return null;
    let activeId = safeId(raw.activeId);
    if (!activeId || !sessions.find((s) => s.id === activeId)) activeId = sessions[0].id;
    return { activeId, sessions };
  } catch {
    return null;
  }
}

function writeIndex(userDir, index) {
  try {
    fs.mkdirSync(sessionsDir(userDir), { recursive: true });
    const tmp = `${indexPath(userDir)}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(index, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, indexPath(userDir));
  } catch { /* fail soft — history is a convenience, never critical */ }
}

function readSessionThread(userDir, id) {
  if (!safeId(id)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(sessionPath(userDir, id), 'utf8'));
    return cleanThread(Array.isArray(raw) ? raw : raw && raw.thread);
  } catch {
    return [];
  }
}

function writeSessionThread(userDir, id, thread) {
  if (!safeId(id)) return [];
  const clean = cleanThread(thread);
  try {
    fs.mkdirSync(sessionsDir(userDir), { recursive: true });
    const tmp = `${sessionPath(userDir, id)}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ thread: clean }, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, sessionPath(userDir, id));
  } catch { /* fail soft */ }
  return clean;
}

function makeSession() {
  const now = Date.now();
  return { id: crypto.randomUUID(), title: '', createdAt: now, updatedAt: now };
}

// Create the store on first use. If the legacy single thread exists, it becomes
// session #1 (so existing history carries over); otherwise start with one empty
// session. Always leaves a valid index with at least one session + an active id.
function ensureSessions(userDir) {
  const existing = readIndex(userDir);
  if (existing) return existing;

  const first = makeSession();
  let legacy = [];
  try { legacy = loadThread(userDir); } catch { legacy = []; }
  if (legacy.length) {
    first.title = titleFromThread(legacy);
    writeSessionThread(userDir, first.id, legacy);
    try { fs.rmSync(threadFile(userDir), { force: true }); } catch { /* leave it if locked */ }
  }
  const index = { activeId: first.id, sessions: [first] };
  writeIndex(userDir, index);
  return index;
}

// Newest first — the chat list reads best most-recent at the top.
function sortedSessions(index) {
  return index.sessions.slice().sort((a, b) => (b.updatedAt - a.updatedAt) || (b.createdAt - a.createdAt));
}

/** The chat list + which is active (metadata only; no threads). */
function listSessions(userDir) {
  const index = ensureSessions(userDir);
  return { activeId: index.activeId, sessions: sortedSessions(index).map((s) => ({ id: s.id, title: s.title, updatedAt: s.updatedAt })) };
}

/** The active session's messages. */
function activeThread(userDir) {
  const index = ensureSessions(userDir);
  return readSessionThread(userDir, index.activeId);
}

/** Persist the active session's thread; bump its updatedAt, and auto-title it
 *  from the first user message if it has no title yet. Returns the capped thread
 *  (so the caller's in-memory copy stays bounded like the disk one). */
function saveActiveThread(userDir, thread) {
  const index = ensureSessions(userDir);
  const clean = writeSessionThread(userDir, index.activeId, thread);
  const meta = index.sessions.find((s) => s.id === index.activeId);
  if (meta) {
    meta.updatedAt = Date.now();
    if (!meta.title) meta.title = titleFromThread(clean);
    writeIndex(userDir, index);
  }
  return clean;
}

/** Start a new empty conversation and make it active. Prunes the oldest past the
 *  cap. Returns the updated list. */
function newSession(userDir) {
  const index = ensureSessions(userDir);
  const s = makeSession();
  index.sessions.push(s);
  index.activeId = s.id;
  // Prune the least-recently-updated beyond the cap (delete its file too).
  if (index.sessions.length > MAX_SESSIONS) {
    const keep = sortedSessions(index).slice(0, MAX_SESSIONS);
    const keepIds = new Set(keep.map((k) => k.id));
    for (const old of index.sessions) {
      if (!keepIds.has(old.id)) { try { fs.rmSync(sessionPath(userDir, old.id), { force: true }); } catch { /* ignore */ } }
    }
    index.sessions = keep;
  }
  writeIndex(userDir, index);
  return listSessions(userDir);
}

/** Switch which session is active (no-op on an unknown id). */
function switchSession(userDir, id) {
  const index = ensureSessions(userDir);
  if (safeId(id) && index.sessions.find((s) => s.id === id)) {
    index.activeId = id;
    writeIndex(userDir, index);
  }
  return listSessions(userDir);
}

/** Rename a session (a manual title overrides the auto one). */
function renameSession(userDir, id, title) {
  const index = ensureSessions(userDir);
  const meta = safeId(id) ? index.sessions.find((s) => s.id === id) : null;
  if (meta) {
    meta.title = str(title, MAX_TITLE, meta.title);
    writeIndex(userDir, index);
  }
  return listSessions(userDir);
}

/** Delete a session. Always keeps at least one (a fresh empty one if the last is
 *  removed); if the active one is deleted, the newest remaining becomes active. */
function deleteSession(userDir, id) {
  const index = ensureSessions(userDir);
  if (!safeId(id) || !index.sessions.find((s) => s.id === id)) return listSessions(userDir);
  try { fs.rmSync(sessionPath(userDir, id), { force: true }); } catch { /* ignore */ }
  index.sessions = index.sessions.filter((s) => s.id !== id);
  if (index.sessions.length === 0) index.sessions.push(makeSession());
  if (!index.sessions.find((s) => s.id === index.activeId)) {
    index.activeId = sortedSessions(index)[0].id;
  }
  writeIndex(userDir, index);
  return listSessions(userDir);
}

/** Clear the active session's messages (keep the session itself). */
function clearActiveThread(userDir) {
  const index = ensureSessions(userDir);
  writeSessionThread(userDir, index.activeId, []);
  const meta = index.sessions.find((s) => s.id === index.activeId);
  if (meta) { meta.title = ''; meta.updatedAt = Date.now(); writeIndex(userDir, index); }
}

const WARMUP_TIMEOUT_MS = 3 * 60 * 1000; // a big local model can take a while to load

// Local endpoints (Ollama / LM Studio) load the model into RAM on the FIRST
// request — a slow cold start. When the assistant is configured and local, we
// preload it ahead of the user's first message so that first reply is fast.
// Gated to local hosts: warming a paid/hosted API would waste tokens.
function isLocalEndpoint(baseUrl) {
  if (!baseUrl) return false;
  let host;
  try { host = new URL(baseUrl.trim()).hostname.toLowerCase(); } catch { return false; }
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '0.0.0.0'
    || /^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host);
}

// Fire-and-forget preload of a LOCAL model. Never throws; a failed warmup just
// means the first real reply pays the cold start, exactly as before.
async function warmup(userDir) {
  try {
    const { config, keyEnc } = loadRaw(userDir);
    if (!isConfigured(config, keyEnc !== null)) return;
    if (!isLocalEndpoint(config.baseUrl)) return; // only local models cold-start
    const base = config.baseUrl.trim().replace(/\/+$/, '');
    const headers = { 'content-type': 'application/json' };
    const key = decryptKey(keyEnc);
    if (key) headers.authorization = `Bearer ${key}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), WARMUP_TIMEOUT_MS);
    try {
      // max_tokens:1 — we only need the model resident, not a real answer.
      const r = await fetch(`${base}/chat/completions`, {
        method: 'POST', headers, signal: controller.signal,
        body: JSON.stringify({ model: config.model, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }),
      });
      await r.text().catch(() => {});
    } finally { clearTimeout(timer); }
  } catch { /* best effort */ }
}

module.exports = {
  defaults, getPublicConfig, saveConfig, loadRaw, decryptKey, ask, isConfigured, PROVIDERS, warmup,
  addPersonaPreset, removePersonaPreset,
  loadThread, saveThread, clearThread,
  listSessions, activeThread, saveActiveThread, newSession, switchSession, renameSession, deleteSession, clearActiveThread,
};
