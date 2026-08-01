#!/usr/bin/env python3
"""
MeloTTS engine sidecar for Dashboard Engine.

A long-lived, torch-free synthesis worker built on sherpa-onnx. The Node side
(lib/melotts.js) keeps ONE of these alive and streams requests to it, so the
170 MB model loads once and every subsequent clip is fast — the assistant reads
a reply sentence-by-sentence without reloading.

Protocol (deliberately dumb + binary-framed so PCM can't be mangled):

  Request  (Node -> sidecar): one line of UTF-8 JSON, newline-terminated:
      {"id":N,"modelDir":"...","text":"...","sid":0,
       "speed":1.0,"noiseScale":0.6,"noiseScaleW":0.8}
    The text travels INSIDE the JSON on stdin — never on a command line
    (CLAUDE.md: user text never becomes an argv element).

  Response (sidecar -> Node): a binary frame:
      byte 0      status   0 = ok, 1 = error
      ok:  uint32 LE sampleRate, uint32 LE pcmLen, then pcmLen bytes s16le mono
      err: uint32 LE msgLen,     then msgLen bytes UTF-8 message

Security: no network, no shell, no eval. It only ever reads model files whose
directory the Node side hands it, and writes raw audio back. If anything goes
wrong it returns an error frame and keeps running (fail soft).
"""

import json
import os
import struct
import sys

import numpy as np

try:
    import sherpa_onnx
except Exception as exc:  # pragma: no cover - import guard
    # Can't synthesize without the engine; report once on stderr and exit so the
    # Node side falls back to Piper/system voice instead of hanging.
    sys.stderr.write(f"melotts-sidecar: sherpa_onnx unavailable: {exc}\n")
    sys.stderr.flush()
    sys.exit(3)

# One OfflineTts per (modelDir, noiseScale, noiseScaleW). sherpa bakes the two
# noise params into the model config at construction, so a change in
# expressiveness/steadiness rebuilds — but speed is per-call, and a given
# profile reuses the same handle across every clip.
_CACHE = {}
_CACHE_LIMIT = 4  # a couple of profiles' worth; MeloTTS handles are ~heavy


def _make_tts(model_dir, noise_scale, noise_scale_w):
    model = os.path.join(model_dir, "model.onnx")
    lexicon = os.path.join(model_dir, "lexicon.txt")
    tokens = os.path.join(model_dir, "tokens.txt")
    for path in (model, lexicon, tokens):
        if not os.path.isfile(path):
            raise FileNotFoundError(f"missing {os.path.basename(path)} in model dir")
    # dict_dir/data_dir stay empty: MeloTTS uses a lexicon frontend, not espeak.
    cfg = sherpa_onnx.OfflineTtsConfig(
        model=sherpa_onnx.OfflineTtsModelConfig(
            vits=sherpa_onnx.OfflineTtsVitsModelConfig(
                model=model,
                lexicon=lexicon,
                tokens=tokens,
                noise_scale=float(noise_scale),
                noise_scale_w=float(noise_scale_w),
                length_scale=1.0,  # real rate control is per-call via `speed`
            ),
            num_threads=2,
            provider="cpu",
        ),
        # Let long assistant replies flow as one utterance; Node already splits
        # into sentence clips upstream, so keep this modest.
        max_num_sentences=2,
    )
    if hasattr(cfg, "validate") and not cfg.validate():
        raise ValueError("invalid sherpa-onnx config for model dir")
    return sherpa_onnx.OfflineTts(cfg)


def _get_tts(model_dir, noise_scale, noise_scale_w):
    key = (os.path.abspath(model_dir), round(float(noise_scale), 4), round(float(noise_scale_w), 4))
    tts = _CACHE.get(key)
    if tts is None:
        tts = _make_tts(model_dir, noise_scale, noise_scale_w)
        if len(_CACHE) >= _CACHE_LIMIT:
            # Drop an arbitrary old handle to bound memory.
            _CACHE.pop(next(iter(_CACHE)))
        _CACHE[key] = tts
    return tts


def _write_ok(out, sample_rate, pcm_bytes):
    out.write(b"\x00")
    out.write(struct.pack("<II", int(sample_rate), len(pcm_bytes)))
    out.write(pcm_bytes)
    out.flush()


def _write_err(out, message):
    data = str(message).encode("utf-8", "replace")
    out.write(b"\x01")
    out.write(struct.pack("<I", len(data)))
    out.write(data)
    out.flush()


def _synthesize(req):
    model_dir = req["modelDir"]
    text = req.get("text", "")
    sid = int(req.get("sid", 0))
    speed = float(req.get("speed", 1.0))
    noise_scale = float(req.get("noiseScale", 0.6))
    noise_scale_w = float(req.get("noiseScaleW", 0.8))
    if not isinstance(text, str) or text.strip() == "":
        raise ValueError("empty text")
    # Clamp speed to sane bounds (sherpa maps length_scale = 1/speed).
    speed = max(0.3, min(3.0, speed))

    tts = _get_tts(model_dir, noise_scale, noise_scale_w)
    audio = tts.generate(text, sid=sid, speed=speed)
    samples = np.asarray(audio.samples, dtype=np.float32)
    pcm = np.clip(samples, -1.0, 1.0)
    pcm = (pcm * 32767.0).astype("<i2").tobytes()
    return audio.sample_rate, pcm


def main():
    stdin = sys.stdin.buffer
    stdout = sys.stdout.buffer
    # On Windows, make the streams binary so \r\n translation can't corrupt PCM.
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
            sample_rate, pcm = _synthesize(req)
            _write_ok(stdout, sample_rate, pcm)
        except Exception as exc:  # keep the worker alive on any single failure
            _write_err(stdout, exc)


if __name__ == "__main__":
    main()
