# MeloTTS engine (HD voices)

The optional, opt-in **HD voice** engine for Dashboard Engine. Standard voices
render through Piper (bundled, small); HD voices render through MeloTTS — a
higher-quality neural TTS — via a torch-free **onnxruntime** sidecar that is
downloaded on demand, like a Piper voice model.

Nothing here changes voice tuning: a profile drives the same
rate / expressiveness / steadiness, mapped to the model's per-call
`length_scale` / `noise_scale` / `noise_scale_w` inputs, and the ffmpeg DSP
chain runs afterwards unchanged. See `lib/melotts.js` and `lib/voicebank.js`.

## Why BERT (and why not sherpa-onnx)

MeloTTS English leans on a sentence BERT for correct pronunciation — without it,
words are mispronounced (a bert-free sherpa-onnx export was tried and rejected on
listening). So the engine runs the **full pipeline**: MeloTTS's own text frontend
(g2p) + a BERT feature model + the VITS model, all as ONNX. For English the VITS
`bert` (1024-d) input is zeros and the real feature goes into `ja_bert` (768-d) —
that's just how MeloTTS routes English.

## Pieces

- `melotts_sidecar.py` — the worker. Loads a voice's `model.onnx` + `bert.onnx`
  once and answers requests over a binary stdin/stdout protocol. The English text
  frontend and the BERT tokenizer are bundled INTO the engine.
- The **voice pack** (per language, downloaded): a directory with
  - `model.onnx` — MeloTTS VITS, exported keeping the BERT inputs (fp32, ~170 MB)
  - `bert.onnx` — the sentence BERT (`bert-base-uncased`), int8 (~95 MB)
- The **engine binary** — this sidecar frozen with PyInstaller (~106 MB).

## Building the models (from the MeloTTS torch model)

See the export scripts kept with the spike, in short:
1. Export `TTS(language="EN").model.infer` to ONNX **keeping** `bert`/`ja_bert`
   as inputs (legacy tracer: `torch.onnx.export(..., dynamo=False)`).
2. Export `bert-base-uncased` (AutoModelForMaskedLM) returning `hidden_states[-3]`.
3. `onnxruntime.quantization.quantize_dynamic(bert.onnx, bert.onnx, QInt8)`.
   (Leave the VITS model fp32 — quantizing it hurts audio quality.)

## Building the engine binary (Python 3.12, torch-free)

```bash
python -m venv .venv && . .venv/Scripts/activate
pip install onnxruntime numpy transformers tokenizers g2p_en nltk inflect \
    unidecode anyascii eng_to_ipa num2words pyinstaller
pip install --no-deps "git+https://github.com/myshell-ai/MeloTTS.git"   # frontend only
python -c "import nltk; [nltk.download(p) for p in ('averaged_perceptron_tagger','averaged_perceptron_tagger_eng','cmudict')]"

pyinstaller --noconfirm --onefile --name melotts-engine \
  --collect-all onnxruntime --collect-submodules melo --collect-data melo \
  --collect-all g2p_en --collect-submodules transformers --collect-data transformers \
  --collect-data tokenizers --collect-submodules tokenizers \
  --add-data "engine/melotts/bert_tokenizer;bert_tokenizer" \
  --add-data "<nltk_data>/taggers;nltk_data/taggers" \
  --add-data "<nltk_data>/corpora;nltk_data/corpora" \
  --exclude-module torch --exclude-module torchaudio --exclude-module scipy \
  --exclude-module librosa --exclude-module matplotlib --exclude-module pandas \
  engine/melotts/melotts_sidecar.py
```

Notes: build with `NLTK_DISABLE_IMPORT_SECURITY=1` set (nltk's CWD guard breaks
the PyInstaller nltk hook otherwise). `inflect`'s typeguard decorators are neutered
at runtime by the sidecar so `inspect.getsource` isn't called in the frozen app.

## Delivery

Neither the engine binary nor the voice pack is committed (`bin/` is gitignored)
or bundled in the installer. Host `melotts-engine.exe` and the pack
(`model.onnx`, `bert.onnx`) on a `huggingface.co` repo and set the `url`s in
`voices/voices.json` (`engines.melotts` + the `en_us_hd` files; sha256/sizes are
pinned). Until hosted, drop them in `%APPDATA%/dashboard-engine/bin/melotts/`
and `%APPDATA%/dashboard-engine/voices/en_us_hd/` by hand and HD voices work.

## Protocol

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
