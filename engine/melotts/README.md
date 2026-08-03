# MeloTTS engine (HD voices) — full MeloTTS / PyTorch

The voice engine. The whole voice bank is now **real MeloTTS (PyTorch)** — six
languages (English, Spanish, French, Chinese, Japanese, Korean), each exactly
MeloTTS quality. (An onnx conversion was tried first; it was a touch below MeloTTS
and was rejected, so we ship the real thing. Piper was removed 2026-08-03.) English
HD ships in the Steam depot for an instant first-run voice; the other five download
on demand.

Voice tuning is unchanged: a profile's rate / expressiveness / steadiness map to
MeloTTS's `speed` / `noise_scale` / `noise_scale_w`, and the ffmpeg DSP chain runs
afterwards. See `lib/melotts.js` and `lib/voicebank.js`.

## Pieces

- `melotts_sidecar.py` — a long-lived worker. On a request it loads that
  language's MeloTTS from the pack and calls `tts.tts_to_file(text, sid, None, …)`
  (MeloTTS splits sentences itself — this is the full quality). It **locks to one
  language per process**; `lib/melotts.js` keys the warm process by engine+language
  so switching language respawns. The sidecar stubs the non-target `melo.text`
  frontends so a frozen/offline engine never loads models it won't use.
- **One engine binary** for all languages (`engineId: melotts_full`) — this
  sidecar frozen with PyInstaller `--onefile` (~520 MB, bundles torch + MeloTTS +
  the en/ja/ko frontends). `PYTORCH_JIT=0` is required (a frozen build has no .py
  source for TorchScript) — set both here and by `lib/melotts.js` when spawning.
- **Per-language pack** (downloaded): a directory with
  - `checkpoint.pth` — MeloTTS VITS checkpoint (~208 MB)
  - `config.json` — MeloTTS config
  - `bert/` — that language's sentence-BERT (config + pytorch_model.bin/safetensors
    + tokenizer). EN bert-base-uncased, ES dccuchile/bert-base-spanish-wwm-uncased,
    FR dbmdz/bert-base-french-europeana-cased, ZH **bert-base-multilingual-uncased**
    (MeloTTS-Chinese is a ZH_MIX_EN model → the chinese_mix frontend uses the
    multilingual bert, NOT the roberta), JP tohoku-nlp/bert-base-japanese-v3,
    KR kykim/bert-kor-base. ~620–880 MB/pack.

## Building the engine (Python 3.12)

```bash
python -m venv .venv && . .venv/Scripts/activate
pip install torch torchaudio --index-url https://download.pytorch.org/whl/cpu
pip install --no-deps "git+https://github.com/myshell-ai/MeloTTS.git"
pip install -r engine/melotts/requirements.txt pyinstaller
python -c "import nltk; [nltk.download(p) for p in ('averaged_perceptron_tagger','averaged_perceptron_tagger_eng','cmudict')]"

pyinstaller --noconfirm --onefile --name melotts-engine \
  --collect-all torch --collect-all torchaudio \
  --collect-submodules melo --collect-data melo --collect-all librosa \
  --collect-all g2p_en \
  --collect-all pyopenjtalk --collect-all fugashi --collect-all unidic_lite --collect-all mecab \
  --collect-all g2pkk --collect-all eunjeon --collect-all jamo --collect-all pykakasi --collect-submodules jaconv \
  --collect-all gruut --collect-all gruut_ipa --collect-all gruut_lang_en --collect-all gruut_lang_es --collect-all gruut_lang_fr \
  --collect-all jieba --collect-all cn2an --collect-all pypinyin --collect-all babel \
  --collect-submodules transformers --collect-data transformers --collect-submodules tokenizers --collect-data tokenizers \
  --collect-submodules num2words --hidden-import pkg_resources --collect-submodules pkg_resources \
  --add-data "<nltk_data>/corpora;nltk_data/corpora" --add-data "<nltk_data>/taggers;nltk_data/taggers" \
  --exclude-module matplotlib --exclude-module tkinter \
  engine/melotts/melotts_sidecar.py
```

Build with `NLTK_DISABLE_IMPORT_SECURITY=1` set (nltk's CWD guard breaks the
PyInstaller nltk hook otherwise). gruut (es/fr) and jieba/cn2an/pypinyin (zh) are
now bundled — the engine synthesizes all six languages. `scripts/freeze_engine.sh`
in the build tree runs exactly this command.

## Building a pack

Point MeloTTS at the language once so it downloads to the HF cache, then copy
`checkpoint.pth` + `config.json` from `myshell-ai/MeloTTS-<Language>` and the
BERT snapshot (config + model weights + tokenizer files) into `<lang>_hd/bert/`.

## Delivery

Neither the engine nor packs are committed (`bin/` gitignored) or bundled. Host
the engine (`melotts-engine-torch.exe`) and each pack folder on a `huggingface.co`
repo and set the urls in `voices/voices.json` (sha256/sizes pinned). Until
downloaded, place the engine at `%APPDATA%/dashboard-engine/bin/melotts_full/` and
packs at `%APPDATA%/dashboard-engine/voices/<lang>_hd/`.

## Protocol

Request (Node → sidecar), one UTF-8 JSON line:

```json
{"modelDir":"…","text":"…","lang":"EN","sid":0,"speed":1.0,"noiseScale":0.6,"noiseScaleW":0.8}
```

Response (sidecar → Node): `status` byte (0 ok / 1 err); ok → uint32 LE sampleRate,
uint32 LE pcmLen, then s16le mono PCM; err → uint32 LE msgLen, then UTF-8 message.
