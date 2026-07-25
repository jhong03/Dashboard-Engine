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

const FILE = 'assistant.json';
const PROVIDERS = ['openai']; // single OpenAI-compatible provider (local or hosted)
const MAX_PERSONA = 4000;
const MAX_MODEL = 80;
const MAX_URL = 300;
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
      'You are JARVIS, a calm, impeccably polite AI assistant with dry British wit. '
      + 'Address the user as "sir". Be concise — two to four sentences unless a task needs more. '
      + 'Never use markdown, bullet points, or emoji; reply in plain spoken sentences, as your words are read aloud.',
    maxTokens: 1024,
    speak: true,
    voiceProfile: '', // '' → the engine's default voice profile
  };
}

function clampInt(v, min, max, fallback) {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
}

function str(value, maxLen, fallback) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim().slice(0, maxLen) : fallback;
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

// ── The AI call ─────────────────────────────────────────────────────────────

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
  const text = data && data.choices && data.choices[0] && data.choices[0].message
    ? String(data.choices[0].message.content || '').trim()
    : '';
  return text ? { ok: true, text } : { ok: false, error: 'The model returned no text.' };
}

async function callOpenAICompatible(config, key, messages, signal) {
  const base = (config.baseUrl && config.baseUrl.trim()) || 'https://api.openai.com/v1';
  const url = `${base.replace(/\/+$/, '')}/chat/completions`;
  const headers = { 'content-type': 'application/json' };
  if (key) headers.authorization = `Bearer ${key}`; // key is OPTIONAL (local servers need none)
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: config.model,
      max_tokens: config.maxTokens,
      messages: [{ role: 'system', content: config.persona }, ...messages],
    }),
    signal,
  });
  const data = await res.json().catch(() => null);
  return parseOpenAIShape(res.status, res.ok, data);
}

/** Ask the configured model. `messages` is the running conversation. */
async function ask(userDir, messages) {
  const { config, keyEnc } = loadRaw(userDir);
  if (!isConfigured(config, keyEnc !== null)) {
    return {
      ok: false,
      needsSetup: true,
      error: 'The assistant isn’t set up yet. Open Manager → Assistant and add an endpoint — a local model (Ollama/LM Studio, no key), a free-tier key (OpenRouter/Groq), or your own OpenAI key.',
    };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await callOpenAICompatible(config, decryptKey(keyEnc), messages, controller.signal);
  } catch (err) {
    if (err.name === 'AbortError') return { ok: false, error: 'The AI endpoint took too long to respond.' };
    return { ok: false, error: `Could not reach the AI endpoint: ${err.message}` };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { defaults, getPublicConfig, saveConfig, loadRaw, decryptKey, ask, isConfigured, PROVIDERS };
