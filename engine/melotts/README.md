# MeloTTS engine (HD voices)

This is the optional, opt-in **HD voice** engine for Dashboard Engine. Standard
voices render through Piper (bundled, small); HD voices render through MeloTTS —
a higher-quality neural TTS — via a small **sherpa-onnx** sidecar that is
downloaded on demand, exactly like a Piper voice model.

Nothing here changes the voice-tuning feature: a profile drives the same
rate / expressiveness / steadiness, and the ffmpeg DSP chain runs afterwards
unchanged. See `lib/melotts.js` for the Node side and `lib/voicebank.js` for the
manifest + downloader.

## Pieces

- `melotts_sidecar.py` — the worker. A long-lived process that loads a
  sherpa-onnx `melo-vits` model once and answers synthesis requests over a
  binary stdin/stdout protocol (JSON request line in, framed s16le PCM out).
  User text travels inside the JSON on **stdin** — never on a command line.
- The **model** (per language) is a directory of `model.onnx` + `lexicon.txt` +
  `tokens.txt` in sherpa-onnx `melo-vits` format. The English pack is pinned in
  `voices/voices.json` and hosted on Hugging Face (MiaoMint/MeloTTS-ONNX). It is
  BERT-free (~167 MB) — the model's `bert`/`ja_bert` inputs were dropped at
  export, so no separate 500 MB BERT is needed.
- The **engine binary** is this sidecar frozen with PyInstaller.

## Building the engine binary

Requires Python 3.12 (see `requirements.txt`).

```bash
python -m venv .venv && . .venv/Scripts/activate      # or source .venv/bin/activate
pip install -r engine/melotts/requirements.txt pyinstaller
pyinstaller --noconfirm --onefile --name melotts-engine \
    --collect-all sherpa_onnx engine/melotts/melotts_sidecar.py
# -> dist/melotts-engine.exe  (~31 MB, single file, no Python needed to run)
```

The result is a single, self-contained `melotts-engine.exe` (Windows).

## Delivery

The binary is **not** committed (see `.gitignore` `bin/`) and **not** bundled in
the installer. It is fetched on demand into
`%APPDATA%/dashboard-engine/bin/melotts/` the first time a user installs an HD
voice — the same place and mechanism as Piper.

To enable that download, host `melotts-engine.exe` on a `huggingface.co` repo and
set the `engines.melotts.url` field in `voices/voices.json` (the `sha256` and
`sizeBytes` are already pinned for the build committed here). Until it's hosted,
drop the file into `%APPDATA%/dashboard-engine/bin/melotts/melotts-engine.exe`
by hand and HD voices work immediately.

## Protocol (for reference)

Request (Node → sidecar), one UTF-8 JSON line, newline-terminated:

```json
{"modelDir":"…","text":"…","sid":0,"speed":1.0,"noiseScale":0.6,"noiseScaleW":0.8}
```

Response (sidecar → Node), one binary frame:

```
byte 0      status   0 = ok, 1 = error
ok:  uint32 LE sampleRate, uint32 LE pcmLen, then pcmLen bytes s16le mono
err: uint32 LE msgLen,     then msgLen bytes UTF-8 message
```
