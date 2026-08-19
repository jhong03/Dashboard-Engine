'use strict';

// AI assistant bridge — LOCAL MODELS ONLY. The user points it at an
// OpenAI-compatible /chat/completions endpoint running on their OWN machine or
// local network (e.g. Ollama / LM Studio at http://localhost:11434/v1). There is
// NO cloud service, NO account, and NO API key anywhere in the app: the endpoint
// is validated to loopback / private ranges (see isLocalUrl) and any public host
// is rejected in main, at save time and again before every request. All network
// calls live here in main and fail soft.

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
const MAX_PERSONA = 4000;
const MAX_MODEL = 80;
const MAX_URL = 300;
// User-saved personas (their own prompts, kept to reuse). Just text — no secrets.
const MAX_PRESETS = 24;
const MAX_PRESET_NAME = 40;
const REQUEST_TIMEOUT_MS = 60 * 1000;

// The assistant connects to LOCAL models only — an endpoint on the user's own
// machine or local network. isLocalUrl validates a base URL's host against
// loopback + RFC1918 / link-local ranges; anything else (a public / cloud host) is
// rejected at save time and again before every request. No cloud, ever.
function isPrivateHost(host) {
  if (!host) return false;
  const h = String(host).toLowerCase().replace(/^\[|\]$/g, ''); // strip IPv6 [brackets]
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local')) return true;
  if (h === '::1' || h === '::' || h === '0.0.0.0') return true;
  if (/^127\./.test(h)) return true;                       // 127.0.0.0/8 loopback
  if (/^10\./.test(h)) return true;                        // 10.0.0.0/8
  if (/^192\.168\./.test(h)) return true;                  // 192.168.0.0/16
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;   // 172.16.0.0/12
  if (/^169\.254\./.test(h)) return true;                  // 169.254.0.0/16 link-local
  if (/^f[cd][0-9a-f]{2}:/.test(h)) return true;           // fc00::/7 unique-local IPv6
  if (/^fe80:/.test(h)) return true;                       // fe80::/10 link-local IPv6
  return false;
}

function isLocalUrl(baseUrl) {
  if (!baseUrl || !String(baseUrl).trim()) return false;
  try { return isPrivateHost(new URL(String(baseUrl).trim()).hostname); } catch { return false; }
}

function configFile(userDir) {
  return path.join(userDir, FILE);
}

function defaults() {
  return {
    model: '', // the local model's name, e.g. llama3.1 / qwen2.5 — blank = not set up yet
    baseUrl: '', // a LOCAL OpenAI-compatible URL, e.g. http://localhost:11434/v1 (Ollama)
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
    return { config: clean };
  }
  if (typeof raw !== 'object' || raw === null) return { config: clean };
  clean.model = str(raw.model, MAX_MODEL, clean.model);
  // Only keep a stored base URL if it's LOCAL; a leftover cloud URL is treated as
  // unset so the assistant reads as "not set up" until a local one is entered.
  clean.baseUrl = isLocalUrl(raw.baseUrl) ? str(raw.baseUrl, MAX_URL, '') : '';
  clean.persona = str(raw.persona, MAX_PERSONA, clean.persona);
  clean.maxTokens = clampInt(raw.maxTokens, 64, 4096, clean.maxTokens);
  clean.speak = typeof raw.speak === 'boolean' ? raw.speak : clean.speak;
  clean.voiceProfile = str(raw.voiceProfile, 80, '');
  clean.personaPresets = sanitizePresets(raw.personaPresets);
  clean.contextLimit = clampInt(raw.contextLimit, MIN_CONTEXT_LIMIT, MAX_CONTEXT_LIMIT, clean.contextLimit);
  return { config: clean };
}

// Enough to make a call: a model id plus a LOCAL base URL. No key exists.
function isConfigured(config) {
  const hasModel = !!(config.model && config.model.trim());
  return hasModel && isLocalUrl(config.baseUrl);
}

/** Public view for a renderer — the config plus a `configured` flag. */
function getPublicConfig(userDir) {
  const { config } = loadRaw(userDir);
  return { ...config, configured: isConfigured(config) };
}

/**
 * Save config. The base URL, if set, MUST be a local / private host — a public
 * (cloud) URL is rejected here in main. There is no API key.
 */
function saveConfig(userDir, patch) {
  const source = typeof patch === 'object' && patch !== null ? patch : {};
  const { config: current } = loadRaw(userDir);
  // Validate the endpoint BEFORE writing: local models only, never a cloud host.
  if (source.baseUrl !== undefined) {
    const url = str(source.baseUrl, MAX_URL, '');
    if (url && !isLocalUrl(url)) {
      return { ok: false, error: 'The assistant only connects to a model on your own machine or local network (localhost, 127.x, 10.x, 172.16–31.x, 192.168.x). A public or cloud URL isn’t allowed.' };
    }
  }
  const next = {
    model: str(source.model, MAX_MODEL, current.model),
    baseUrl: source.baseUrl === undefined ? current.baseUrl : str(source.baseUrl, MAX_URL, ''),
    persona: str(source.persona, MAX_PERSONA, current.persona),
    maxTokens: source.maxTokens === undefined ? current.maxTokens : clampInt(source.maxTokens, 64, 4096, current.maxTokens),
    speak: typeof source.speak === 'boolean' ? source.speak : current.speak,
    voiceProfile: source.voiceProfile === undefined ? current.voiceProfile : str(source.voiceProfile, 80, ''),
    personaPresets: source.personaPresets === undefined ? current.personaPresets : sanitizePresets(source.personaPresets),
    contextLimit: source.contextLimit === undefined ? current.contextLimit : clampInt(source.contextLimit, MIN_CONTEXT_LIMIT, MAX_CONTEXT_LIMIT, current.contextLimit),
  };

  fs.mkdirSync(userDir, { recursive: true });
  const tmp = `${configFile(userDir)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, configFile(userDir));
  return { ok: true, config: { ...next, configured: isConfigured(next) } };
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
    if (status === 401 || status === 403) msg = `Rejected (${status}): the local server refused the request — check the Base URL and Model id in Manager → Assistant.`;
    else if (status === 404) msg = 'Not found (404): double-check the Base URL and the Model id in Manager → Assistant.';
    else if (status === 429) msg = 'Busy (429): the local server is overloaded — wait a moment and retry.';
    else msg = detail || `The local AI endpoint returned HTTP ${status}.`;
    return { ok: false, error: msg.slice(0, 300) };
  }
  const msg = data && data.choices && data.choices[0] && data.choices[0].message;
  const text = stripThink(msg ? msg.content : '').trim();
  if (text) return { ok: true, text };
  // Empty answer — most often a reasoning model that spent its whole reply budget
  // "thinking", or one that refused. Say so instead of a bare failure.
  return { ok: false, error: 'The model returned no text — if it is a reasoning model it may have used its reply budget thinking; raise the reply length or use a non-reasoning model.' };
}

async function callOpenAICompatible(config, messages, signal) {
  // Local only — the base URL is required and validated to a private host.
  if (!isLocalUrl(config.baseUrl)) return { ok: false, error: 'No local model endpoint is set. Add a local URL (e.g. http://localhost:11434/v1) in Manager → Assistant.' };
  const url = `${config.baseUrl.trim().replace(/\/+$/, '')}/chat/completions`;
  // Reasoning models (Qwen3, DeepSeek-R1, …) emit a long hidden reasoning stream
  // BEFORE the answer; at a small token ceiling they hit it mid-thought and
  // return EMPTY content (finish_reason "length") — the "model returned no text"
  // bug. max_tokens is only a CEILING, so a generous floor lets the answer fit
  // while non-reasoning models still stop at their short reply (finish "stop").
  const budget = Math.max(Number(config.maxTokens) || 1024, 4096);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
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
async function streamOpenAICompatible(config, messages, signal, onDelta) {
  if (!isLocalUrl(config.baseUrl)) return { ok: false, error: 'No local model endpoint is set. Add a local URL (e.g. http://localhost:11434/v1) in Manager → Assistant.' };
  const url = `${config.baseUrl.trim().replace(/\/+$/, '')}/chat/completions`;
  const budget = Math.max(Number(config.maxTokens) || 1024, 4096);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
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
  const { config } = loadRaw(userDir);
  if (!isConfigured(config)) {
    return {
      ok: false,
      needsSetup: true,
      error: 'The assistant needs a local model. Open Manager → Assistant and set the URL of a model running on your machine (Ollama or LM Studio, e.g. http://localhost:11434/v1) and the model’s name.',
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
      return await streamOpenAICompatible(config, windowed, controller.signal, (part) => {
        arm();
        onDelta(part);
      });
    }
    return await callOpenAICompatible(config, windowed, controller.signal);
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
// request — a slow cold start. When the assistant is configured, we preload it
// ahead of the user's first message so that first reply is fast. Fire-and-forget;
// never throws — a failed warmup just means the first real reply pays the cold
// start, exactly as before.
async function warmup(userDir) {
  try {
    const { config } = loadRaw(userDir);
    if (!isConfigured(config)) return; // model + local URL both required
    const base = config.baseUrl.trim().replace(/\/+$/, '');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), WARMUP_TIMEOUT_MS);
    try {
      // max_tokens:1 — we only need the model resident, not a real answer.
      const r = await fetch(`${base}/chat/completions`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, signal: controller.signal,
        body: JSON.stringify({ model: config.model, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }),
      });
      await r.text().catch(() => {});
    } finally { clearTimeout(timer); }
  } catch { /* best effort */ }
}

// One-time F1 migration: the external cloud AI path was removed. If a profile
// still carries an encrypted API key, a `provider` field, or a non-local base URL
// (from the old BYO version), strip them — they can no longer be used and must
// not linger. Returns a short description of what was removed (for a one-line
// log), or '' if there was nothing to clean. Fail-soft; touches nothing else.
function migrateToLocalOnly(userDir) {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(configFile(userDir), 'utf8')); } catch { return ''; }
  if (!raw || typeof raw !== 'object') return '';
  const removed = [];
  if (typeof raw.keyEnc === 'string' && raw.keyEnc) removed.push('stored API key');
  if (raw.provider !== undefined) removed.push('provider field');
  const cloudUrl = typeof raw.baseUrl === 'string' && raw.baseUrl.trim() && !isLocalUrl(raw.baseUrl);
  if (cloudUrl) removed.push('cloud base URL');
  if (removed.length === 0) return '';
  delete raw.keyEnc; delete raw.provider;
  if (cloudUrl) raw.baseUrl = '';
  try {
    const tmp = `${configFile(userDir)}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(raw, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, configFile(userDir));
  } catch { return ''; }
  return removed.join(', ');
}

// The pre-rename default persona named JARVIS (a super-hero-franchise AI). If a
// profile still stores that EXACT old default — a user who never edited it — replace
// it with the current (Aegis) default. ANY other persona is the user's own writing
// and is left untouched. Fail-soft; returns true only if it migrated.
const LEGACY_JARVIS_PERSONA =
  'Always reply in English, whatever language the user writes in; never switch languages. '
  + 'You are JARVIS, a calm, impeccably polite AI assistant with dry British wit. '
  + 'Address the user as "sir". Be concise — two to four sentences unless a task needs more. '
  + 'Never use markdown, bullet points, or emoji; reply in plain spoken sentences, as your words are read aloud.';

function migrateDefaultPersona(userDir) {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(configFile(userDir), 'utf8')); } catch { return false; }
  if (!raw || typeof raw !== 'object' || raw.persona !== LEGACY_JARVIS_PERSONA) return false;
  raw.persona = defaults().persona;
  try {
    const tmp = `${configFile(userDir)}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(raw, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, configFile(userDir));
  } catch { return false; }
  return true;
}

module.exports = {
  defaults, getPublicConfig, saveConfig, loadRaw, ask, isConfigured, warmup, migrateToLocalOnly, migrateDefaultPersona,
  addPersonaPreset, removePersonaPreset,
  loadThread, saveThread, clearThread,
  listSessions, activeThread, saveActiveThread, newSession, switchSession, renameSession, deleteSession, clearActiveThread,
};
