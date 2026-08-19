# F4 — IP remediation: JARVIS pack renamed to "Aegis" and differentiated

Valve F4: *"A built-in assistant pack shares the appearance and title of an AI creation
from a super hero movie franchise."* (= J.A.R.V.I.S., Marvel/Iron Man.)

Owner decision: rename the pack to **Aegis** (an original name from our own codebase
identity, `AegisComponents`) and change the appearance/persona so neither **title nor
appearance** evokes the franchise AI. Below is what changed, surface by surface.

## Rename map (old → new)

| Surface | Old | New |
|---|---|---|
| Pack directory | `packs/jarvis/` | `packs/aegis/` |
| Pack id / slug | `jarvis` | `aegis` |
| Pack display name | `J.A.R.V.I.S` | `Aegis` |
| Persona name | `J.A.R.V.I.S` | `Aegis` |
| On-wallpaper title text | `J.A.R.V.I.S · PERSONAL INTERFACE` | `AEGIS · PERSONAL INTERFACE` |
| Voice preset file | `presets/jarvis.json` | `presets/aegis.json` |
| Voice preset id / name | `preset-jarvis` / `JARVIS (Male, cinematic)` | `preset-aegis` / `Aegis (Male)` |
| Assistant persona preset key + text (`src/manager.js`) | `jarvis:` "You are JARVIS, … dry British wit … Address the user as 'sir'." | `aegis:` "You are Aegis, a calm, precise mission-control operator for this machine." |
| Assistant DEFAULT persona (`lib/assistant.js`) | same "You are JARVIS…" | same "You are Aegis…" (neutralized) |
| Persona→voice map (`PERSONA_VOICE`) | `jarvis: 'en_male'` | `aegis: 'en_male'` (voice kept) |
| Manager persona dropdown (`manager.html`) | `JARVIS — formal butler (default)` | `Aegis — mission control (default)` |
| Locale key + label (× 7) | `manager.assistant.persona.jarvis` | `manager.assistant.persona.aegis` |
| Default-pack-id fallbacks (main.js, ipc.js, session-link.js, dashboard.js, editor.js, shot.js, manager.js) | `'jarvis'` | `'aegis'` |
| Docs (PACKS.md, i18n-template.csv) | `jarvis` | `aegis` |

The only surviving reference to `jarvis` in shipped source is the one-time **migration**
(`main.js`), which must name the old id to detect and remap it.

## Trade-dress changes (a–d)

- **(a) Palette — KEPT (owner call).** The cyan is Dashboard Engine's own brand colour /
  design language (used across all packs), not uniquely the franchise's scheme, so it
  stays. The generic dark-HUD / mono-font / corner-notch / scanline aesthetic is our own
  and is shared by every seed pack.
- **(b) Iconography — CHANGED.** The centrepiece was a `hud-clock` with concentric
  glowing "reactor rings" (arc-reactor-evocative). Replaced with the app's own
  `ring-clock` (halo style) — a clean centrepiece with no reactor-core motif. The
  `hud-clock` component remains available in the app/editor; it is simply **no longer the
  default in any built-in pack** (it was only ever used by this one pack).
- **(c) Persona / voice-line copy — NEUTRALIZED.** Removed the butler honorifics ("sir"),
  the "impeccably polite … dry British wit" character description, and the film-style
  greeting. Aegis is a calm, neutral mission-control operator. New pack lines:
  "Aegis online. All systems nominal." / "Standing by." / "Ready when you are." /
  "Interface nominal. Awaiting input." (calm-operator tone, no character echoes).
- **(d) Voice — audio KEPT, framing removed (owner call).** The base voice is a generic
  licensed British-English male neural voice — it is not a clone or imitation of any
  specific performer or character, and an accent is not ownable. The infringement risk
  was the *name + persona + the fact it was selected/labelled to evoke the character*;
  all of that is removed (preset renamed `Aegis (Male)`, persona neutralized). The audio
  itself is unchanged.

## Migration (breaking id change handled)

`main.js` runs a one-time, fail-soft alias on engine start: if a profile's stored active
pack is `jarvis`, it is rewritten to `aegis` and logged once. A user's own **forked** copy
of the old pack keeps a distinct id (e.g. `j-a-r-v-i-s`) and is never touched. If anything
is off it fails soft to the default pack.

## Owner action items (outside code)

- **Store assets — RE-SHOOT (regenerated where JARVIS appeared; gitignored, owner
  uploads to Steam).** Done in this session:
  - ✅ `screenshots/01-aegis.png` (was `01-jarvis.png`) — hero, halo ring-clock, AEGIS.
  - ✅ `screenshots/04-editor.png` — editor on the Aegis pack (clean demo data).
  - ✅ `screenshots/05-library.png` — library with the Aegis card + detail.
  - ✅ `trailer/dashboard-engine-trailer.mp4` — main trailer rebuilt with the Aegis
    opening beat (only beat that referenced JARVIS; editor beat = Neon Cyberpunk,
    hud beat = ring-clock, banner generic).
  - 02-sakura / 03-neon-cyberpunk unchanged (no JARVIS).
  Deferred to the FINAL asset pass (after R2–R5, so they reflect the finished app):
  - 🕓 `screenshots/06-voice-tuning.png` — stale (Piper/Comma-pause/Breath) + renamed preset.
  - 🕓 `screenshots/07-assistant.png` — shows the JARVIS persona AND the cloud-AI config R2 removes.
  - 🕓 `trailer/dashboard-engine-voice-assistant.mp4` — JARVIS baked into composited scenes,
    scene scripts gone → rebuild from scratch reflecting Aegis + local-only AI.
  - 🕓 Capsules (`capsules/`) — verify none feature the jarvis dashboard; regenerate if so.
- **Workshop.** If the pack was ever published to Steam Workshop under this account,
  delist or update it. (Published tab showed 0 items in prior testing — confirm.)
- **Other seed packs** (hearth, slate, sakura, pastel-dream, gothic-noir, vaporwave,
  neon-cyberpunk) are aesthetic genres, not specific franchises — reviewed clean.

## Paste-ready reviewer note

> The flagged assistant pack has been renamed to "Aegis" (an original name from our own
> codebase identity) and its appearance, iconography, persona text, and preset naming have
> been redesigned to our app's own design language — removing the resemblance in both
> title and appearance. Specifically: the pack, persona, on-screen title, voice preset,
> and assistant persona no longer reference the prior name; the arc-reactor-style
> centrepiece was replaced with our own ring-clock; and the persona/voice-line copy was
> rewritten to a neutral mission-control tone with no character honorifics. Store assets
> featuring the prior pack are being replaced.
