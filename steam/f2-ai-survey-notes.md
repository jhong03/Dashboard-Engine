# F2 — AI Content Survey: audit + final wording

Valve F2: a discrepancy between the **default installation of the Kokoro TTS model** and
the AI section of the Content Survey. Fix = make the survey accurately disclose every AI
source, led by the default-on neural TTS. **No build change** — disclosure only.

## AI-source audit (everything in the app that uses AI/ML)
1. **Neural text-to-speech — DEFAULT-ON.** MeloTTS + Kokoro on-device models. An English
   voice is bundled/default-installed; other languages download on demand. Generates
   spoken audio at runtime (assistant replies, spoken system alerts, voice previews).
   Survey category = **Voice**. No voice recordings are stored or uploaded — a "voice
   profile" is tuning parameters referencing a licensed base voice.
2. **AI assistant (LLM) — OPTIONAL, OFF by default.** User-supplied **local** model
   (Ollama / LM Studio); endpoint validated to loopback/private ranges, public/cloud
   rejected. Generates conversational text at runtime. Survey category = **Text**. (Can
   emit code *as text* if asked; the app never executes it.)
3. **Procedural wallpaper generation — NOT AI.** Plain algorithmic PNG synthesis (zlib
   encoder), no ML model. Not disclosed as AI-generated.
4. Everything else (weather, telemetry, components, background music = user's own files)
   — no AI.

## Survey answers (final, as submitted)
- **"Does this game use AI to generate content or code during gameplay?"** → **Yes**
- **Live-generated content types** → **Text** (assistant) + **Voice** (TTS). *Not* Code,
  Textures, 3D Models, Sound Effects, Music.
- **Pre-generated AI content** → **None** (nothing AI-made ships in the build).
- **"Connect to an external, third-party AI service during gameplay?"** (External
  Services) → **No** (local-only, enforced in the build — public/cloud URLs are rejected).

### Public "About This Game" AI message
> Dashboard Engine uses AI only at runtime, on your own device, and bundles no
> pre-generated AI content.
>
> On-device neural text-to-speech (installed by default): the app includes neural TTS
> voices (MeloTTS and Kokoro) that synthesize spoken audio from text locally on your PC.
> An English voice is bundled and installed by default; other languages download on
> demand. These voices produce speech at runtime — for the assistant's replies, spoken
> system alerts, and voice previews. They are used purely as speech output: a "voice
> profile" is a small set of tuning settings that reference a licensed base voice, and
> the app stores or uploads no voice recordings of any kind.
>
> Optional AI assistant (off by default): if you turn it on, you connect it to a language
> model you run locally on your own machine or local network (for example Ollama or LM
> Studio). Your typed messages are sent to that local model to generate conversational
> replies in real time, which can be read aloud by the on-device TTS above. There is no
> cloud AI service, account, or API key — nothing leaves your PC.
>
> All AI output is generated live from your own input and your own local models, so it is
> not authored or reviewed by the developer. No AI-generated content is pre-created or
> bundled with the app.

### Code sub-answer
> The app does not use AI to generate or execute code. The optional AI assistant is a
> general-purpose chat model; if a user explicitly asks, it can return code as plain text
> in the chat, but the app only displays that text — it never compiles, interprets, or
> runs any assistant output. The only code the app executes is designer-authored "module"
> widgets inside a pack, which are hand-written (not AI-generated) and run in a
> locked-down sandbox with no network, filesystem, or system access.

### Copyright sub-answer
> The assistant runs on a language model the user supplies and runs locally on their own
> machine or local network, responding to the user's own prompts. All output is private
> to that single user — it is never shared, published, or redistributed through the app,
> so no generated content reaches other players or is republished anywhere. We do not use
> a third-party copyright-protection service; because the app neither hosts a model nor
> distributes its output, there is no shared surface on which infringing material could
> be exposed to others.

### Moderation sub-answer
> The assistant is single-user and private: each person converses only with their own
> locally configured model, and the output is shown only to them — nothing is generated
> for, or visible to, other players. The built-in persona presets instruct plain,
> helpful, non-harmful responses. Because the model is user-supplied and runs on the
> user's own hardware, we do not post-filter its raw output, but the private,
> self-directed nature means no user is ever exposed to content they did not themselves
> request. The neural text-to-speech only vocalizes text — the assistant's own replies or
> fixed interface strings — so it introduces no new content beyond this. The AI assistant
> is optional and off until the user enables and configures it, and Steam's standard
> reporting tools remain available.
