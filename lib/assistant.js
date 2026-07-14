'use strict';

// AI assistant bridge. Two ways to connect, both free by default:
//   • free    — a keyless community endpoint (Pollinations). Works out of the
//               box, no account, no charge; model list is fetched live.
//   • openai  — any OpenAI-compatible endpoint (base URL + OPTIONAL key):
//               a local Ollama/LM Studio (no key), or a free-tier account like
//               OpenRouter/Groq (a free, non-billed key) to unlock a bigger
//               model menu (Gemini, Qwen, Llama, DeepSeek, …).
//
// If a key is used it is SECRET: stored OS-encrypted via Electron safeStorage,
// never handed to a renderer (they learn only hasKey), never written into a
// pack or export. All network calls live here in main and fail soft.

const fs = require('fs');
const path = require('path');

const FILE = 'assistant.json';
const PROVIDERS = ['free', 'openai'];
const FREE_ENDPOINT = 'https://text.pollinations.ai/openai';
const FREE_MODELS_URL = 'https://text.pollinations.ai/models';
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
    provider: 'free',
    model: 'openai', // Pollinations alias for its open GPT-OSS model
    baseUrl: '', // openai provider only; blank → api.openai.com
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

/** Public view for a renderer — config plus hasKey, but NEVER the key. */
function getPublicConfig(userDir) {
  const { config, keyEnc } = loadRaw(userDir);
  return { ...config, hasKey: keyEnc !== null };
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

// ── Free model list (live) ──────────────────────────────────────────────────

const FREE_FALLBACK = [{ id: 'openai', label: 'GPT-OSS 20B (OpenAI)' }];

/** Models the keyless free endpoint currently offers. Never throws. */
async function listFreeModels() {
  try {
    const res = await fetch(FREE_MODELS_URL, { signal: AbortSignal.timeout(12000) });
    if (!res.ok) return FREE_FALLBACK;
    const data = await res.json();
    if (!Array.isArray(data)) return FREE_FALLBACK;
    const models = data
      .filter((m) => m && typeof m.name === 'string')
      .map((m) => ({ id: m.name, label: m.description ? `${m.name} — ${String(m.description).slice(0, 60)}` : m.name }));
    return models.length ? models : FREE_FALLBACK;
  } catch {
    return FREE_FALLBACK;
  }
}

// ── The AI call ─────────────────────────────────────────────────────────────

function parseOpenAIShape(status, ok, data) {
  if (!ok) {
    const detail = data && data.error && (data.error.message || data.error) ? (data.error.message || data.error) : `HTTP ${status}`;
    return { ok: false, error: String(detail).slice(0, 300) };
  }
  const text = data && data.choices && data.choices[0] && data.choices[0].message
    ? String(data.choices[0].message.content || '').trim()
    : '';
  return text ? { ok: true, text } : { ok: false, error: 'The model returned no text.' };
}

async function callFree(config, messages, signal) {
  const res = await fetch(FREE_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: config.model || 'openai',
      messages: [{ role: 'system', content: config.persona }, ...messages],
      max_tokens: config.maxTokens,
      referrer: 'dashboard-engine',
    }),
    signal,
  });
  const data = await res.json().catch(() => null);
  return parseOpenAIShape(res.status, res.ok, data);
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
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    if (config.provider === 'openai') {
      return await callOpenAICompatible(config, decryptKey(keyEnc), messages, controller.signal);
    }
    return await callFree(config, messages, controller.signal);
  } catch (err) {
    if (err.name === 'AbortError') return { ok: false, error: 'The model took too long to respond.' };
    return { ok: false, error: `Could not reach the model: ${err.message}` };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { defaults, getPublicConfig, saveConfig, loadRaw, decryptKey, ask, listFreeModels, PROVIDERS };
