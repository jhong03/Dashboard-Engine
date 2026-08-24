#!/usr/bin/env python3
"""
MeloTTS engine sidecar for Dashboard Engine (full MeloTTS / PyTorch).

Runs REAL MeloTTS (myshell-ai) so the audio is exactly the quality MeloTTS
produces — it does its own sentence splitting, g2p, BERT and VITS synthesis.
This is the "A" quality; an onnx conversion was a touch below it, so we ship the
real thing. One engine binary serves all languages; a voice's model directory
holds that language's MeloTTS checkpoint + config + BERT.

Protocol (binary-framed so PCM can't be mangled):

  Request  (Node -> sidecar): one line of UTF-8 JSON, newline-terminated:
      {"modelDir":"…","text":"…","lang":"EN","sid":0,
       "speed":1.0,"noiseScale":0.6,"noiseScaleW":0.8}
    Text travels INSIDE the JSON on stdin — never on a command line.

  Response (sidecar -> Node): a binary frame:
      byte 0      status   0 = ok, 1 = error
      ok:  uint32 LE sampleRate, uint32 LE pcmLen, then pcmLen bytes s16le mono
      err: uint32 LE msgLen,     then msgLen bytes UTF-8 message
"""

import json
import os
import struct
import sys
import types

import numpy as np

# Per-language config. melo.text.get_bert() imports EVERY language's frontend AND
# its *_bert helper on each call, and MANY load a tokenizer / gruut data AT IMPORT
# (the english/spanish/french frontends + the english_bert/spanish_bert/french_bert
# helpers each `AutoTokenizer.from_pretrained(<hub id>)` at module top; chinese_mix
# loads bert-base-multilingual and imports the english + chinese frontends). A
# frozen, OFFLINE engine synthesizes ONE language, so we KEEP only the modules that
# language actually touches and STUB the rest — otherwise those module-top loads
# reach for the network / a HF cache the user's machine doesn't have and CRASH.
#
# Each entry: (MeloTTS language string, [frontend modules to keep],
#              [*_bert loader modules to keep], [(hf_bert_id, pack_subdir)] redirects)
#
# Subtleties learned the hard way:
#  - KR: get_bert imports the feature from the korean FRONTEND, but that delegates
#    to japanese_bert.get_bert_feature (the generic loader) with Korean's model_id.
#  - ZH: MeloTTS remaps language "ZH" -> "ZH_MIX_EN" (api.py), so the real frontend
#    is chinese_mix (NOT chinese). chinese_mix imports the english + chinese
#    frontends and loads bert-base-multilingual-uncased (via chinese_bert), NOT the
#    roberta. english's module-top tokenizer (bert-base-uncased) is redirected to
#    the SAME multilingual dir so its subword counts match chinese_bert's — keeping
#    them consistent AND meaning the pack ships just one bert dir.
LANG_CFG = {
    "EN": ("EN", ["english"], ["english_bert"],
           [("bert-base-uncased", "bert")]),
    "ES": ("ES", ["spanish"], ["spanish_bert"],
           [("dccuchile/bert-base-spanish-wwm-uncased", "bert")]),
    "FR": ("FR", ["french"], ["french_bert"],
           [("dbmdz/bert-base-french-europeana-cased", "bert")]),
    "ZH": ("ZH", ["chinese_mix", "chinese", "english"], ["chinese_bert"],
           [("bert-base-multilingual-uncased", "bert"), ("bert-base-uncased", "bert")]),
    "JP": ("JP", ["japanese"], ["japanese_bert"],
           [("tohoku-nlp/bert-base-japanese-v3", "bert")]),
    "KR": ("KR", ["korean"], ["japanese_bert"],
           [("kykim/bert-kor-base", "bert")]),
}

_FRONTENDS = ["chinese", "japanese", "english", "chinese_mix", "korean", "french", "spanish"]
_BERT_MODULES = ["chinese_bert", "japanese_bert", "english_bert", "french_bert", "spanish_bert"]


def _distribute_phone(n_phone, n_word):
    ppw = [0] * n_word
    for _ in range(n_phone):
        m = min(ppw)
        ppw[ppw.index(m)] += 1
    return ppw


def _stub_dummy(*a, **k):
    raise NotImplementedError("a stubbed MeloTTS frontend was called")


def _stub_frontends(keep_names):
    """Stub every frontend + *_bert helper EXCEPT the ones the target language
    needs (keep_names), so a frozen/offline engine never loads a model it won't
    use."""
    keep = set(keep_names)
    for name in _FRONTENDS + _BERT_MODULES:
        if name in keep:
            continue
        key = f"melo.text.{name}"
        if key in sys.modules:
            continue
        mod = types.ModuleType(key)
        # get_bert does `from .<name> import get_bert_feature` for every language;
        # a dummy for any attribute makes those imports succeed. Only the kept
        # target module's real get_bert_feature is ever CALLED.
        mod.__getattr__ = lambda attr: _stub_dummy
        if name == "japanese":
            mod.distribute_phone = _distribute_phone  # english.g2p imports + calls it
        sys.modules[key] = mod


def _asset_dir():
    return getattr(sys, "_MEIPASS", None) or os.path.dirname(os.path.abspath(__file__))


ASSET_DIR = _asset_dir()
os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
# MeloTTS @torch.jit.script helpers need .py source to compile — a frozen build
# has none, so run them eagerly. (lib/melotts.js also sets this when spawning.)
os.environ.setdefault("PYTORCH_JIT", "0")

try:
    # inflect (via g2p_en) uses typeguard's @typechecked which calls
    # inspect.getsource at import -> fails frozen. No-op it.
    try:
        import typeguard

        def _noop_typechecked(*a, **k):
            if len(a) == 1 and callable(a[0]) and not k:
                return a[0]
            return lambda f: f

        typeguard.typechecked = _noop_typechecked
    except Exception:
        pass

    import torch
    torch.set_num_threads(max(1, (os.cpu_count() or 2) - 1))
    from transformers import AutoModelForMaskedLM, AutoTokenizer

    try:
        import nltk
        _nd = os.path.join(ASSET_DIR, "nltk_data")
        if os.path.isdir(_nd):
            nltk.data.path.insert(0, _nd)
    except Exception:
        pass
except Exception as exc:  # pragma: no cover
    import traceback
    sys.stderr.write(f"melotts-sidecar: base init failed: {exc}\n{traceback.format_exc()}")
    sys.stderr.flush()
    sys.exit(3)


# ── Load one MeloTTS model (locks to one language), from a pack ─────────────
_LANG = None
_TTS = None


def _redirect_bert(redirects, model_dir):
    """Point MeloTTS's BERT + tokenizer loads at the bundled copies in the pack (so
    nothing phones home). `redirects` is a list of (hf_bert_id, pack_subdir); more
    than one id can map to the same dir (e.g. ZH points both the multilingual bert
    and the english tokenizer at bert/)."""
    mapping = {}
    for bert_id, subdir in redirects:
        d = os.path.join(model_dir, subdir)
        if os.path.isdir(d):
            mapping[bert_id] = d
    if not mapping:
        return
    for cls in (AutoModelForMaskedLM, AutoTokenizer):
        _orig = cls.from_pretrained

        def _patched(name, *a, __orig=_orig, __map=mapping, **k):
            if name in __map:
                name = __map[name]
            return __orig(name, *a, **k)

        cls.from_pretrained = staticmethod(_patched)


def _ensure(lang, model_dir):
    global _LANG, _TTS
    if _TTS is not None:
        if _LANG != lang:
            raise ValueError(f"this engine instance serves {_LANG}, not {lang}")
        return _TTS
    if lang not in LANG_CFG:
        raise ValueError(f"unsupported language {lang}")
    melo_lang, keep_frontends, keep_berts, redirects = LANG_CFG[lang]
    _redirect_bert(redirects, model_dir)
    _stub_frontends(keep_frontends + keep_berts)
    from melo.api import TTS
    ckpt = os.path.join(model_dir, "checkpoint.pth")
    cfg = os.path.join(model_dir, "config.json")
    if not (os.path.isfile(ckpt) and os.path.isfile(cfg)):
        raise FileNotFoundError("missing checkpoint.pth / config.json in model dir")
    _TTS = TTS(language=melo_lang, device="cpu", use_hf=False, config_path=cfg, ckpt_path=ckpt)
    _LANG = lang
    return _TTS


def _synthesize(req):
    lang = req.get("lang", "EN")
    model_dir = req["modelDir"]
    tts = _ensure(lang, model_dir)
    text = req.get("text", "")
    if not isinstance(text, str) or text.strip() == "":
        raise ValueError("empty text")
    sid = int(req.get("sid", 0))
    # A single-speaker MeloTTS model may NOT put its speaker at id 0 — MeloTTS-
    # Chinese uses id 1 ({"ZH": 1}). Synthesizing with an id that isn't in the
    # model's speaker map produces a garbage speaker embedding = gibberish, so map
    # an out-of-range request to a real speaker id.
    try:
        valid_ids = sorted(set(tts.hps.data.spk2id.values()))
        if valid_ids and sid not in valid_ids:
            sid = valid_ids[0]
    except Exception:
        pass
    speed = max(0.3, min(3.0, float(req.get("speed", 1.0))))
    noise_scale = float(req.get("noiseScale", 0.6))
    noise_scale_w = float(req.get("noiseScaleW", 0.8))
    # tts_to_file with output_path=None returns the numpy waveform. It does its
    # own sentence splitting — this IS full MeloTTS quality.
    audio = tts.tts_to_file(text, sid, None, sdp_ratio=0.2, noise_scale=noise_scale,
                            noise_scale_w=noise_scale_w, speed=speed, quiet=True)
    sr = tts.hps.data.sampling_rate
    pcm = (np.clip(np.asarray(audio, dtype=np.float32), -1.0, 1.0) * 32767.0).astype("<i2").tobytes()
    return sr, pcm


# ── stdin/stdout protocol ───────────────────────────────────────────────────
def _write_ok(out, sample_rate, pcm):
    out.write(b"\x00"); out.write(struct.pack("<II", int(sample_rate), len(pcm))); out.write(pcm); out.flush()


def _write_err(out, message):
    data = str(message).encode("utf-8", "replace")
    out.write(b"\x01"); out.write(struct.pack("<I", len(data))); out.write(data); out.flush()


def main():
    stdin, stdout = sys.stdin.buffer, sys.stdout.buffer
    if os.name == "nt":
        import msvcrt
        msvcrt.setmode(stdin.fileno(), os.O_BINARY)
        msvcrt.setmode(stdout.fileno(), os.O_BINARY)
    for raw in stdin:
        line = raw.strip()
        if not line:
            continue
        try:
            req = json.loads(line.decode("utf-8"))
        except Exception as exc:
            _write_err(stdout, f"bad request json: {exc}")
            continue
        try:
            sr, pcm = _synthesize(req)
            _write_ok(stdout, sr, pcm)
        except Exception as exc:
            # Write the FULL traceback to stderr (lib/melotts.js captures it and
            # logs it on the error) so an intermittent synth fault — e.g. the
            # Korean "exceptions must derive from BaseException" — reveals its exact
            # Python line/module instead of only str(exc). The base-init path above
            # already does this; the synth path swallowed it until now.
            import traceback
            sys.stderr.write("melotts-sidecar: synth failed: " + repr(exc) + "\n" + traceback.format_exc())
            sys.stderr.flush()
            _write_err(stdout, exc)


if __name__ == "__main__":
    main()
