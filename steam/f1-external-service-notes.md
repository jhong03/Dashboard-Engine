# F1 — external/cloud AI service removed (local models only)

Valve F1: *the build depends on the player setting up an external service (a
third-party OpenAI-compatible service) that requires payment and management outside
of Steam.*

Fix: the assistant now connects **only to a local model on the player's own machine
or local network** (Ollama / LM Studio). There is **no cloud service, no account, and
no API key anywhere in the app.** Nothing about the assistant requires payment or
management outside Steam. Voice synthesis is the bundled on-device Kokoro model,
unaffected.

## What was removed
- **The API key, entirely.** Deleted the encrypted-key storage (`safeStorage`
  encrypt/decrypt, `keyEnc`), the `apiKey` config path, `hasKey`, and the **API key
  field + hints** in the Assistant tab. Local models need no key.
- **The cloud default and cloud references.** `baseUrl` no longer falls back to
  `api.openai.com`; the `provider` field, the `Bearer` auth header, the cloud
  error copy (401 "invalid key" / 402 "out of credits / add billing"), and the dead
  cloud "model list" IPC (`aegis:assistant:models`) are gone. All UI copy naming
  OpenRouter / Groq / OpenAI was rewritten (7 locales; zero cloud references remain).

## What remains, and the restriction
- A **configurable Base URL + Model id** for a **local** OpenAI-compatible server.
- The Base URL is **validated in main** (`isLocalUrl`, not the renderer) to loopback /
  private ranges: `localhost` / `*.local`, `127.0.0.0/8`, `10.0.0.0/8`,
  `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16`, `::1`, `fc00::/7`, `fe80::/10`.
  A **public / cloud host is rejected** at save time with a clear message ("only a
  model on your own machine or local network"), and again defensively before every
  request. A stored cloud URL is dropped on read and by the migration.
- **Graceful degrade:** with no local model set/running, the assistant states plainly
  that it needs a local model (Ollama / LM Studio) and points to Manager → Assistant —
  never a spinner or a raw error.

## Migration (existing profiles)
One-time, fail-soft, on engine start (`assistant.migrateToLocalOnly`): if a profile
still carries an encrypted API key, a `provider` field, or a non-local `baseUrl` from
the old BYO version, they are **deleted from `assistant.json`** and the removal is
logged (`assistant: removed …`). Nothing else is touched.

## Verified
19-case unit test (local URLs accepted; `api.openai.com` / OpenRouter / Groq / public
IPs rejected; config carries no key; cloud `baseUrl` dropped on read; migration strips
key/provider/cloud-URL and is idempotent; exports no longer expose key helpers).
node -c clean; `packs validate` + `smoke` green; locales 1299×7 with zero cloud refs.

## Paste-ready reviewer note
> The external OpenAI-compatible cloud option has been removed entirely. The assistant
> now connects only to a language model the player runs locally on their own hardware
> or local network (e.g. Ollama or LM Studio) — the endpoint is validated in-app to
> loopback / private-network ranges and any public or cloud address is rejected. There
> is no API key, no account, and no external service anywhere in the app. Voice
> synthesis uses the bundled on-device Kokoro model. Nothing requires payment or
> management outside of Steam.
