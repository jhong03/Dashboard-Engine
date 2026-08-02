#!/usr/bin/env python3
"""
MeloTTS engine sidecar for Dashboard Engine (torch-free, onnxruntime).

A long-lived synthesis worker. The Node side (lib/melotts.js) keeps ONE alive
and streams requests, so the model loads once and every later clip is fast.

Quality note: MeloTTS English relies on BERT for correct pronunciation, so this
engine runs the FULL pipeline — MeloTTS's own text frontend (g2p), a BERT feature
model, and the VITS model — all as ONNX via onnxruntime (no PyTorch). A voice's
model directory holds `model.onnx` (VITS, with BERT inputs) and `bert.onnx`
(the sentence BERT); the English frontend + BERT tokenizer are bundled with the
engine.

Protocol (binary-framed so PCM can't be mangled):

  Request  (Node -> sidecar): one line of UTF-8 JSON, newline-terminated:
      {"modelDir":"…","text":"…","sid":0,
       "speed":1.0,"noiseScale":0.6,"noiseScaleW":0.8}
    Text travels INSIDE the JSON on stdin — never on a command line.

  Response (sidecar -> Node): a binary frame:
      byte 0      status   0 = ok, 1 = error
      ok:  uint32 LE sampleRate, uint32 LE pcmLen, then pcmLen bytes s16le mono
      err: uint32 LE msgLen,     then msgLen bytes UTF-8 message

No network, no shell, no eval. It only reads the model files in the directory the
Node side hands it, and writes audio back. Any single failure returns an error
frame and the worker keeps running (fail soft).
"""

import json
import os
import struct
import sys
import types

import numpy as np


# ── Bundled-asset resolution (works frozen or from source) ──────────────────
def _asset_dir():
    # PyInstaller unpacks bundled data under sys._MEIPASS.
    base = getattr(sys, "_MEIPASS", None) or os.path.dirname(os.path.abspath(__file__))
    return base


ASSET_DIR = _asset_dir()
BERT_TOKENIZER_DIR = os.path.join(ASSET_DIR, "bert_tokenizer")

# Keep everything offline: the frontend must never phone home for a tokenizer.
os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")

try:
    # inflect (pulled in by g2p_en) decorates functions with typeguard's
    # @typechecked, which calls inspect.getsource at import — that fails in a
    # frozen build (no .py source). Neuter it to a no-op before anything imports
    # inflect; it's only runtime type-checking, not behaviour.
    try:
        import typeguard

        def _noop_typechecked(*args, **kwargs):
            if len(args) == 1 and callable(args[0]) and not kwargs:
                return args[0]
            return lambda f: f

        typeguard.typechecked = _noop_typechecked
    except Exception:
        pass

    import onnxruntime as ort
    from transformers import AutoTokenizer

    # MeloTTS's english.py loads AutoTokenizer("bert-base-uncased") at import.
    # Redirect that to the bundled tokenizer so there's no network / cache miss.
    _orig_from_pretrained = AutoTokenizer.from_pretrained

    def _patched_from_pretrained(name, *a, **k):
        if name == "bert-base-uncased":
            name = BERT_TOKENIZER_DIR
        return _orig_from_pretrained(name, *a, **k)

    AutoTokenizer.from_pretrained = staticmethod(_patched_from_pretrained)

    # Stub the Japanese frontend (only distribute_phone is needed by english.py)
    # so importing the English frontend doesn't drag in pyopenjtalk.
    _jp = types.ModuleType("melo.text.japanese")

    def _distribute_phone(n_phone, n_word):
        ppw = [0] * n_word
        for _ in range(n_phone):
            m = min(ppw)
            ppw[ppw.index(m)] += 1
        return ppw

    _jp.distribute_phone = _distribute_phone
    sys.modules["melo.text.japanese"] = _jp

    # g2p_en uses nltk's POS tagger; when frozen, the corpora ride along in the
    # bundle. Point nltk at them before the frontend imports g2p_en.
    try:
        import nltk
        _nd = os.path.join(ASSET_DIR, "nltk_data")
        if os.path.isdir(_nd):
            nltk.data.path.insert(0, _nd)
    except Exception:
        pass

    from melo.text import english, cleaned_text_to_sequence
    BERT_TOKENIZER = AutoTokenizer.from_pretrained(BERT_TOKENIZER_DIR)
    english.tokenizer = BERT_TOKENIZER
except Exception as exc:  # pragma: no cover
    import traceback
    sys.stderr.write(f"melotts-sidecar: init failed: {exc}\n")
    sys.stderr.write(traceback.format_exc())
    sys.stderr.flush()
    sys.exit(3)


# ── Frontend (English) ──────────────────────────────────────────────────────
def _intersperse(lst, item=0):
    out = [item] * (len(lst) * 2 + 1)
    out[1::2] = lst
    return out


def _frontend(text):
    """text -> (norm_text, phone_ids, tone_ids, lang_ids, word2ph) with add_blank."""
    norm = english.text_normalize(text)
    phones, tones, word2ph = english.g2p(norm)
    phone_ids, tone_ids, lang_ids = cleaned_text_to_sequence(phones, tones, "EN")
    phone_ids = _intersperse(phone_ids, 0)
    tone_ids = _intersperse(tone_ids, 0)
    lang_ids = _intersperse(lang_ids, 0)
    w2p = [w * 2 for w in word2ph]
    w2p[0] += 1
    return norm, phone_ids, tone_ids, lang_ids, w2p


# ── Per-model ONNX sessions (loaded once, cached) ───────────────────────────
_SESS = {}
_SESS_LIMIT = 3


def _sessions(model_dir):
    key = os.path.abspath(model_dir)
    got = _SESS.get(key)
    if got is None:
        model = os.path.join(model_dir, "model.onnx")
        bert = os.path.join(model_dir, "bert.onnx")
        for p in (model, bert):
            if not os.path.isfile(p):
                raise FileNotFoundError(f"missing {os.path.basename(p)} in model dir")
        so = ort.SessionOptions()
        so.intra_op_num_threads = 2
        got = (
            ort.InferenceSession(model, sess_options=so, providers=["CPUExecutionProvider"]),
            ort.InferenceSession(bert, sess_options=so, providers=["CPUExecutionProvider"]),
        )
        if len(_SESS) >= _SESS_LIMIT:
            _SESS.pop(next(iter(_SESS)))
        _SESS[key] = got
    return got


def _ja_bert(bert_sess, norm, w2p):
    enc = BERT_TOKENIZER(norm, return_tensors="np")
    feat = bert_sess.run(["feature"], {
        "input_ids": enc["input_ids"].astype(np.int64),
        "attention_mask": enc["attention_mask"].astype(np.int64),
        "token_type_ids": enc["token_type_ids"].astype(np.int64),
    })[0][0]  # [seq, 768]
    if feat.shape[0] != len(w2p):
        # Extremely rare tokenization edge; pad/truncate so we still speak.
        n = min(feat.shape[0], len(w2p))
        feat = feat[:n]
        w2p = w2p[:n]
    per_phone = np.concatenate([np.tile(feat[i], (w2p[i], 1)) for i in range(len(w2p))], axis=0)
    return per_phone.T.astype(np.float32)  # [768, L]


def _synthesize(req):
    model_dir = req["modelDir"]
    text = req.get("text", "")
    if not isinstance(text, str) or text.strip() == "":
        raise ValueError("empty text")
    sid = int(req.get("sid", 0))
    speed = max(0.3, min(3.0, float(req.get("speed", 1.0))))
    noise_scale = float(req.get("noiseScale", 0.6))
    noise_scale_w = float(req.get("noiseScaleW", 0.8))

    tts_sess, bert_sess = _sessions(model_dir)
    norm, phone_ids, tone_ids, lang_ids, w2p = _frontend(text)
    L = len(phone_ids)
    ja_bert = _ja_bert(bert_sess, norm, w2p)
    if ja_bert.shape[1] != L:
        # Align defensively; the model requires bert seq == phone seq.
        L = min(L, ja_bert.shape[1])
        phone_ids = phone_ids[:L]; tone_ids = tone_ids[:L]; lang_ids = lang_ids[:L]
        ja_bert = ja_bert[:, :L]
    bert = np.zeros((1024, L), dtype=np.float32)

    feeds = {
        "x": np.array([phone_ids], dtype=np.int64),
        "x_lengths": np.array([L], dtype=np.int64),
        "tones": np.array([tone_ids], dtype=np.int64),
        "lang_ids": np.array([lang_ids], dtype=np.int64),
        "bert": bert[None],
        "ja_bert": ja_bert[None],
        "sid": np.array([sid], dtype=np.int64),
        "noise_scale": np.array([noise_scale], dtype=np.float32),
        "length_scale": np.array([1.0 / speed], dtype=np.float32),
        "noise_scale_w": np.array([noise_scale_w], dtype=np.float32),
    }
    y = tts_sess.run(["y"], feeds)[0][0, 0]
    pcm = (np.clip(y, -1.0, 1.0) * 32767.0).astype("<i2").tobytes()
    return 44100, pcm


# ── stdin/stdout protocol ───────────────────────────────────────────────────
def _write_ok(out, sample_rate, pcm):
    out.write(b"\x00")
    out.write(struct.pack("<II", int(sample_rate), len(pcm)))
    out.write(pcm)
    out.flush()


def _write_err(out, message):
    data = str(message).encode("utf-8", "replace")
    out.write(b"\x01")
    out.write(struct.pack("<I", len(data)))
    out.write(data)
    out.flush()


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
            _write_err(stdout, exc)


if __name__ == "__main__":
    main()
