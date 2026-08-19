# Dashboard Engine — Steam re-review checklist

Rejection of BuildID **24777826** (2026-08-19), five failures F1–F5. This tracks the
remediation and the resubmission. Full per-item detail: `steam/f{1..5}-*.md`.

## Reviewer cover note (paste into the resubmission notes / reply to Valve)

> Thank you for the detailed review. We've addressed all five points:
>
> **1. External service dependency (AI).** Removed. The optional AI assistant no longer
> connects to any external/third-party service. It connects only to a language model the
> player runs locally (e.g. Ollama or LM Studio); the endpoint is validated in-app to
> loopback/private-network ranges and any public or cloud URL is rejected. There is no
> account, no API key, and no external service anywhere in the app. Voice synthesis uses
> the bundled on-device Kokoro/MeloTTS models.
>
> **2. AI Content Survey vs. Kokoro TTS.** Corrected. The survey now discloses the
> default-installed on-device neural TTS (MeloTTS + Kokoro) as a first-class, default AI
> feature that generates speech at runtime, alongside the optional local assistant.
> Content types: Voice and Text; no pre-generated AI content; no external AI service.
>
> **3. Workshop / UGC moderation.** Prevention: every downloaded pack is validated against
> a strict schema (no code is executed from pack data), any designer script runs in a
> network-less sandboxed iframe with no OS/IPC access, the installer is
> zip-slip/zip-bomb-proof, and the voice format stores parameters only — never audio.
> Detection: every Workshop item has an in-app Report action that opens Steam's report
> flow and our review email; Steam-native reporting is fully available. Response:
> confirmed violations are added to a bundled blocklist that refuses to install the item
> on every machine in the next update, and we request Valve remove it — reports are
> triaged within 72 hours, with illegal content escalated to Valve and the authorities
> immediately.
>
> **4. Third-party IP.** Removed. The built-in pack that resembled a superhero-franchise
> AI was renamed to "Aegis" and differentiated — a ring-clock centrepiece instead of a
> reactor HUD, a neutral mission-control persona, and no franchise references in its
> name, art, voice, or our store assets. No third-party IP is incorporated in the app or
> store page.
>
> **5. Online Interactivity.** Unchecked. The app has no online multiplayer or
> player-to-player interaction; its only community feature is asynchronous Steam Workshop
> sharing. The flag has been removed from the Content Survey to match the build.

## Steamworks dashboard checklist (owner)
- [ ] Store page → About This Software: local-only AI section pasted.
- [ ] Store page → short description: "voice-enabled local AI" version pasted.
- [ ] System Requirements → Additional Notes: local-AI internet line pasted.
- [ ] Content Survey → AI message + 3 sub-answers pasted; **Yes** + **Text/Voice**;
      External Services = **No**.
- [ ] Online Interactivity **unchecked**.  ✅ done
- [ ] Regenerated Aegis store assets uploaded (06-voice-tuning, 07-assistant, VA-trailer).
- [ ] No "JARVIS" text or art anywhere on the live store page.

## Build checklist
- [ ] Confirm no `Dashboard Engine` / `melotts-engine` / `kokoro-engine` process running.
- [ ] `rm -rf dist && npm run dist`
- [ ] Re-place `steam_appid.txt`=5066330 in `dist/win-unpacked` (local testing only).
- [ ] SteamPipe upload → Depot 5066331 → set build live.
- [ ] Resubmit for review with the cover note above.

## Code fixes shipping in this build (committed to origin/master)
- F4 rename JARVIS → Aegis + persona/pack migrations: `260aeec`, `0cb0ba7`
- F1 assistant local-only (cloud path removed + enforced): `cdfa7e9`
- F3 Workshop moderation (Report + blocklist): `3ecec13`
- Store copy (gitignored local source) updated local-only.
