# Notes to the Review Team — Dashboard Engine (re-review)

Thank you for the review of BuildID **24906980**. Your note found that the AI assistant
relied on an LLM that isn't installed automatically during the Steam install, and that the
app let the player choose between multiple LLMs. **We've fixed this exactly as
recommended:** the assistant now ships a **single, specific model bundled and installed
directly with the app**, and the model-choice UI has been removed. A new build with this
change has been uploaded. (The five items from the earlier review of BuildID 24777826
remain addressed — summarized below for completeness.)

**About the app (context):** Dashboard Engine is a single-user **desktop live-wallpaper
application** (Utilities → Design & Illustration), not a game. It renders an interactive
dashboard onto the Windows desktop. There is no gameplay and no multiplayer. On first
launch it opens the **Manager** window with the default **"Aegis"** pack active.

---

## 1) AI/LLM dependency — NOW BUNDLED, SINGLE MODEL, NO CHOICE
**Finding:** the AI depended on an LLM that isn't installed automatically during the Steam
installation, and the app allowed the player to choose between multiple LLMs.

**What changed:** the assistant now runs a **single, specific language model that is bundled
in the app and installed automatically with it via Steam** — no external software, no
account, no network, and **no model choice**. It bundles the **Qwen2.5-1.5B** model
(Apache-2.0) served by **llama.cpp** (MIT), both included directly in the depot. The model
loads on the user's own machine and generates replies entirely **on-device / offline**. The
previous "enter your own local endpoint / model" fields have been **removed** — there is no
way for the player to select or point at a different model. The assistant works out of the
box on a clean install with nothing else installed.

**How to verify (~1 min):** on a fresh Steam install (nothing else installed), open the chat
(the "Ask anything…" prompt on the wallpaper, or Manager → **Assistant** → **Test
connection**) and send a message — the assistant **replies out of the box**. Manager →
**Assistant** shows a persona and a voice, plus a note that the model is "built-in… no
setup"; there is **no Base URL or Model-id field and no way to choose a model**.

## 2) Kokoro TTS vs. Content Survey — SURVEY CORRECTED
**Finding:** a discrepancy between the default-installed Kokoro TTS model and the AI
section of the Content Survey.

**What changed:** the Content Survey now accurately discloses the default-installed neural
TTS. The build bundles two on-device neural TTS engines — **MeloTTS** (English female) and
**Kokoro** (English male, `bm_daniel`) — and the **default "Aegis" pack speaks with
Kokoro**. The public AI disclosure names both engines, states they are installed by
default, and explains they generate spoken audio at runtime. Structured answers now read:
*uses AI to generate content = **Yes***; content types = **Text** (assistant replies) +
**Voice** (neural TTS); **no** pre-generated AI content is bundled; **no** external AI
service.

Facts reflected in the disclosure: all AI runs **on-device**; the app stores/uploads **no
voice recordings** (a "voice profile" is only tuning parameters referencing a licensed base
voice); nothing speaks unprompted on a fresh install (the assistant is off and spoken
system alerts are off by default) — the TTS produces speech when the player previews a
voice, enables spoken alerts, or uses the assistant.

**How to verify (~1 min):** the Kokoro + MeloTTS engines are present in a default install.
Tray icon → **Voice Tuning**, then click **Synthesize** to hear the bundled on-device TTS.

## 3) Workshop / UGC moderation — PLAN + IN-APP TOOLS
**Question:** the moderation plan for Workshop content.

- **Prevention:** every downloaded pack is validated against a strict schema (no code is
  executed from pack data — zero `eval`); any designer-authored script runs in a
  network-less sandboxed iframe with no OS / IPC / filesystem access; the installer is
  zip-slip- and zip-bomb-proof; the voice format stores parameters only, never audio.
- **Detection:** every Workshop item has an in-app **Report** action that opens the item's
  Steam page (where your Report control lives) and surfaces our review email; Steam-native
  reporting remains fully available.
- **Response:** confirmed violations are added to a bundled blocklist that **refuses to
  install** the item on every machine in the next app update, and we request removal via
  Valve — reports are triaged within **72 hours**, with illegal content escalated to Valve
  and the authorities immediately.

**How to verify:** Manager → **Browse** → select any Workshop pack or voice → the detail
panel shows a **Report** button next to "View on Steam."

## 4) Third-party IP (the JARVIS-like pack) — REMOVED
**Finding:** a built-in assistant pack shared the appearance and title of a super-hero-
franchise AI.

**What changed / our assurance:** the pack has been **renamed to "Aegis"** and its
appearance **differentiated** — a ring-clock centrepiece (not a reactor-style HUD), a
neutral "mission-control" persona (no butler mannerisms, no "sir," no "dry British wit"),
and **no franchise reference in the name, art, voice, persona, or any store asset**. All
store screenshots and both trailers were regenerated with the Aegis pack. We are the sole
authors of all built-in packs, and the wallpapers are procedurally generated original art.
**No third-party IP is incorporated in the app or on the store page.** This takes the
"remove this content from the app's design" path in your note.

**How to verify:** on a fresh install the default pack is **"Aegis"** (a sci-fi HUD with a
ring clock). Manager → Assistant shows the persona "You are Aegis, a calm, precise
mission-control operator…". No "JARVIS" appears anywhere a player can see.

*Internal note (not player-visible): the code contains two migration references that name
the old value only to convert an existing user's saved pack id / persona to "Aegis" on
upgrade. This is cleanup code that erases the old value; it is never displayed.*

## 5) Online Interactivity — FLAG REMOVED
**Finding:** the survey indicated Online Interactivity that isn't in the build.

**What changed:** the app has **no** online multiplayer or player-to-player interaction. Its
only community feature is Steam Workshop — asynchronous sharing of packs / voice profiles
through Valve's UGC system, which is not online interactivity. We have **unchecked** the
Online Interactivity flag in the Content Survey so it matches the build. There is no online
mode to access.

---

All five items are resolved in the uploaded build and the updated store page / Content
Survey. Please let us know if anything is unclear — we're happy to provide more detail.
