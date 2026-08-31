# Third-Party Notices — Dashboard Engine

Dashboard Engine is built on, and distributes, third-party software and assets.
This file lists them with their licenses and the attributions those licenses
require. Full license texts are available at the linked URLs.

Last updated: 2026-08-07.

---

## Application runtime

**Electron / Chromium / Node.js** — the application shell bundles the Electron
runtime, which itself contains the Chromium browser engine and the Node.js
runtime.

- **Electron** — MIT License — © GitHub, Inc. and Electron contributors — https://github.com/electron/electron
- **Chromium** — BSD 3-Clause and others — © The Chromium Authors — https://www.chromium.org
- **Node.js** — MIT-style license — © Node.js contributors and Joyent, Inc. — https://nodejs.org

Electron ships its own bundled license texts alongside the executable
(`LICENSE.electron.txt` and `LICENSES.chromium.html` in the application folder).

---

## Voice synthesis engines

**MeloTTS** — the neural engine behind the "HD" (female) voices in every
language.

- **MeloTTS** — MIT License — © 2023 MyShell.ai and contributors — https://github.com/myshell-ai/MeloTTS

The bundled MeloTTS engine is a frozen (PyInstaller) Python program that itself
incorporates open-source libraries under permissive licenses, including
**PyTorch** (BSD 3-Clause, © Meta Platforms, Inc.), **Hugging Face Transformers**
(Apache License 2.0), **NumPy** (BSD 3-Clause), and the **Python standard
library** (Python Software Foundation License). Each is distributed under its
respective license.

**Piper** — the neural engine behind the male voices.

- **Piper** — MIT License — © 2023 Michael Hansen (rhasspy) — https://github.com/rhasspy/piper

**espeak-ng** — used by Piper to convert text to phonemes; the espeak-ng data is
bundled alongside the Piper component. **This component is licensed under the
GNU General Public License, version 3.**

- **espeak-ng** — GNU General Public License v3.0 (GPL-3.0) — © 2015–2024 Reece H. Dunn and contributors — https://github.com/espeak-ng/espeak-ng

> **Written offer / source availability (GPL-3.0).** The complete corresponding
> source code for espeak-ng (and for Piper) is publicly available at the URLs
> above, and you may obtain it there. You may also request a copy from the
> developer via the Dashboard Engine Steam store page. The espeak-ng program is
> invoked as a **separate executable** (via standard input/output) and is neither
> statically nor dynamically linked into Dashboard Engine's own code, so only the
> espeak-ng/Piper component itself is covered by the GPL; the rest of Dashboard
> Engine is not a derivative work of it.

**FFmpeg** — used by the voice DSP chain to apply each profile's timbre, character,
and loudness stages to the synthesized audio. A prebuilt `ffmpeg.exe` is **bundled**
with Dashboard Engine (in `bin/ffmpeg/`). **This component is licensed under the GNU
General Public License, version 3.**

- **FFmpeg** — GNU General Public License v3.0 (GPL-3.0) — © 2000–2026 the FFmpeg developers — https://ffmpeg.org · https://www.ffmpeg.org/legal.html
  (Bundled build: `ffmpeg 8.1.1-full_build` by Gyan Doshi — https://www.gyan.dev/ffmpeg/builds/)

> **Written offer / source availability (GPL-3.0).** The complete corresponding
> source code for FFmpeg is publicly available at https://ffmpeg.org and (for this
> exact build) via https://www.gyan.dev/ffmpeg/builds/. You may also request a copy
> from the developer via the Dashboard Engine Steam store page. FFmpeg is invoked as
> a **separate executable** (spawned as a child process, with audio passed over
> standard input/output); it is neither statically nor dynamically linked into
> Dashboard Engine's own code, so only the FFmpeg component itself is covered by the
> GPL; the rest of Dashboard Engine is not a derivative work of it.

---

## Voice models and datasets

The voices are trained on the datasets below. Attribution is provided as
required by each license.

| Voice | Source | License |
| --- | --- | --- |
| English / Spanish / French / Chinese / Japanese / Korean — HD (female) | MeloTTS pretrained models by MyShell.ai | MIT |
| English — Male | CSTR VCTK Corpus, speaker **p226** — © The Centre for Speech Technology Research, University of Edinburgh | **CC BY 4.0** — https://creativecommons.org/licenses/by/4.0/ |
| Spanish — Male | "davefx" Spanish dataset (OHF-Voice / voice-datasets) | **CC0 1.0** (public-domain dedication) — https://creativecommons.org/publicdomain/zero/1.0/ |
| French — Male | UPMC "Pierre" corpus (via MaryTTS), speaker **pierre** | **CC BY-SA 4.0** — https://creativecommons.org/licenses/by-sa/4.0/ |

The Piper voice models are obtained from the official `rhasspy/piper-voices`
repository: https://huggingface.co/rhasspy/piper-voices

---

## Fonts

- **Rajdhani** — SIL Open Font License 1.1 — © Indian Type Foundry — https://fonts.google.com/specimen/Rajdhani
- **Share Tech Mono** — SIL Open Font License 1.1 — © Carrois Apostrophe (Ralph du Carrois) — https://fonts.google.com/specimen/Share+Tech+Mono

The SIL Open Font License 1.1 text is available at https://openfontlicense.org.

---

## Steam integration

- **steamworks.js** — MIT License — © ceifa and contributors — https://github.com/ceifa/steamworks.js
- The **Steamworks SDK** is © Valve Corporation, used under the Steamworks SDK
  Access Agreement.

---

## AI assistant (local language model)

The built-in AI assistant runs entirely on the user's own machine — no cloud, no
account, no network calls for AI. It bundles:

- **llama.cpp** (`llama-server` + `ggml`) — MIT License — © Georgi Gerganov and the llama.cpp / ggml contributors — https://github.com/ggml-org/llama.cpp
- **Qwen2.5-1.5B-Instruct** (GGUF) — the bundled language model — Apache License 2.0 — © Alibaba Cloud (Qwen team) — https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct · https://www.apache.org/licenses/LICENSE-2.0

---

Questions about licensing, or requests for the corresponding source of any
GPL-licensed component, can be directed to the developer via the Dashboard
Engine Steam store page.
