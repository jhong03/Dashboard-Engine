'use strict';

// AI assistant bridge. Bring-your-own API key — Anthropic (Claude Messages
// API) or any OpenAI-compatible endpoint (OpenAI, OpenRouter, a local
// Ollama/LM Studio server). The key is SECRET personal data: stored
// OS-encrypted via Electron safeStorage, never handed to a renderer (they
// only learn hasKey), and never written into a pack or export.
//
// All network calls live here in main. Everything is validated and fails
// soft with a human message — a missing key, a 401, or no network never
// crash the engine.

const fs = require('fs');
const path = require('path');

const FILE = 'assistant.json';
const PROVIDERS = ['anthropic', 'openai'];
const MAX_PERSONA = 4000;
const MAX_MODEL = 80;
const MAX_URL = 300;
const REQUEST_TIMEOUT_MS = 60 * 1000;

// safeStorage is only available in the main process after app is ready.
// Required lazily so this module still loads in plain-node tooling.
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
    provider: 'anthropic',
    model: 'claude-sonnet-5',
    baseUrl: '', // OpenAI-compatible only; blank → api.openai.com
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

/** Load config (never throws). Secret key stays encrypted on disk. */
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

/** Public view for the renderer — config plus hasKey, but NEVER the key. */
function getPublicConfig(userDir) {
  const { config, keyEnc } = loadRaw(userDir);
  return { ...config, hasKey: keyEnc !== null };
}

// Decrypt the stored key for a network call. Returns '' if none/unavailable.
function decryptKey(keyEnc) {
  if (!keyEnc) return '';
  const ss = safeStorage();
  try {
    if (ss && ss.isEncryptionAvailable()) {
      return ss.decryptString(Buffer.from(keyEnc, 'base64'));
    }
    // Fallback store (no OS crypto): base64 only. Best effort.
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
 * Save config. `patch` may include a string `apiKey` to set a new key, an
 * empty string to clear it, or omit it to leave the stored key untouched.
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

async function callAnthropic(config, key, messages, signal) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: config.model,
      max_tokens: config.maxTokens,
      system: config.persona,
      messages,
    }),
    signal,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const detail = data && data.error && data.error.message ? data.error.message : `HTTP ${res.status}`;
    return { ok: false, error: detail };
  }
  const text = data && Array.isArray(data.content)
    ? data.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim()
    : '';
  return text ? { ok: true, text } : { ok: false, error: 'The model returned no text.' };
}

async function callOpenAICompatible(config, key, messages, signal) {
  const base = (config.baseUrl && config.baseUrl.trim()) || 'https://api.openai.com/v1';
  const url = `${base.replace(/\/+$/, '')}/chat/completions`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model: config.model,
      max_tokens: config.maxTokens,
      messages: [{ role: 'system', content: config.persona }, ...messages],
    }),
    signal,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const detail = data && data.error && data.error.message ? data.error.message : `HTTP ${res.status}`;
    return { ok: false, error: detail };
  }
  const text = data && data.choices && data.choices[0] && data.choices[0].message
    ? String(data.choices[0].message.content || '').trim()
    : '';
  return text ? { ok: true, text } : { ok: false, error: 'The model returned no text.' };
}

/**
 * Ask the configured model. `messages` is the running conversation
 * ([{role:'user'|'assistant', content}]). Returns { ok, text } | { ok:false, error }.
 */
async function ask(userDir, messages) {
  const { config, keyEnc } = loadRaw(userDir);
  const key = decryptKey(keyEnc);
  if (!key) {
    return { ok: false, error: 'No API key set. Add one in the manager under Assistant.' };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const runner = config.provider === 'openai' ? callOpenAICompatible : callAnthropic;
    return await runner(config, key, messages, controller.signal);
  } catch (err) {
    if (err.name === 'AbortError') return { ok: false, error: 'The model took too long to respond.' };
    return { ok: false, error: `Could not reach the model: ${err.message}` };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { defaults, getPublicConfig, saveConfig, loadRaw, decryptKey, ask, PROVIDERS };
