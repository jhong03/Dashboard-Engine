"""Kokoro TTS sidecar — a persistent synth server for the Dashboard Engine voice
bank, speaking the SAME stdout binary protocol as the MeloTTS engine so the JS
client (lib/kokoro.js) can reuse that framing.

  argv: <kokoro-v1.0.onnx> <voices-v1.0.bin>
  stdin:  one JSON request per line: {"text","voice","speed","lang"}
  stdout: per request, either
    ok:  0x00, uint32-LE sampleRate, uint32-LE pcmLen, pcmLen bytes s16le mono
    err: 0x01, uint32-LE msgLen, msgLen bytes utf-8
  All logging goes to stderr so stdout stays a clean binary channel.
"""
import sys
import os
import json
import struct


def log(*a):
    print("[kokoro-sidecar]", *a, file=sys.stderr, flush=True)


def main():
    # Force UTF-8 on the request pipe so non-ASCII text (accented Spanish now, and
    # CJK if misaki is added later) survives the round trip regardless of the OS
    # locale codepage. The binary PCM reply goes through sys.stdout.buffer, which is
    # unaffected by any text-layer encoding.
    try:
        sys.stdin.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

    if len(sys.argv) < 3:
        log("usage: kokoro_sidecar.py <model.onnx> <voices.bin>")
        sys.exit(2)
    model_path, voices_path = sys.argv[1], sys.argv[2]
    for p in (model_path, voices_path):
        if not os.path.isfile(p):
            log("missing model file:", p)
            sys.exit(2)

    import numpy as np
    from kokoro_onnx import Kokoro

    # Load once so the process is "warm" — the first real request only pays
    # synthesis time, not model load.
    kok = Kokoro(model_path, voices_path)
    log("ready")

    out = sys.stdout.buffer

    def send_ok(sample_rate, pcm_bytes):
        out.write(b"\x00")
        out.write(struct.pack("<I", int(sample_rate)))
        out.write(struct.pack("<I", len(pcm_bytes)))
        out.write(pcm_bytes)
        out.flush()

    def send_err(msg):
        b = str(msg).encode("utf-8")[:400]
        out.write(b"\x01")
        out.write(struct.pack("<I", len(b)))
        out.write(b)
        out.flush()

    # Line-buffered request loop. readline() returns '' only at EOF (stdin closed
    # → the JS client went away), which ends the process cleanly.
    while True:
        line = sys.stdin.readline()
        if line == "":
            break
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            text = req.get("text", "")
            voice = req.get("voice", "bm_george")
            speed = float(req.get("speed", 1.0))
            lang = req.get("lang", "en-us")
            if not text.strip():
                send_err("empty text")
                continue
            samples, sr = kok.create(text, voice=voice, speed=speed, lang=lang)
            # Kokoro returns float32 in [-1, 1]; convert to s16le mono.
            pcm = (np.clip(samples, -1.0, 1.0) * 32767.0).astype("<i2").tobytes()
            send_ok(sr, pcm)
        except Exception as ex:  # noqa: BLE001 — one bad request must not kill the server
            try:
                send_err(repr(ex))
            except Exception:
                pass


if __name__ == "__main__":
    main()
