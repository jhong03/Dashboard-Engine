"""Freeze the Kokoro sidecar into bin/kokoro/kokoro-engine(.exe) with PyInstaller.

Run from the repo root with the dev venv's Python:

    engine/kokoro/.venv/Scripts/python engine/kokoro/freeze.py      (Windows)
    engine/kokoro/.venv/bin/python      engine/kokoro/freeze.py      (macOS/Linux)

Produces a self-contained --onedir bundle at bin/kokoro/ (kokoro-engine.exe +
_internal/). lib/kokoro.js finds that binary first, so once it exists the app
uses it instead of this venv. The Kokoro MODEL (voices/kokoro/*.onnx + *.bin) is
NOT frozen in — it is passed as argv and shipped alongside via build.files.

The --collect-all list is the hard-won part: PyInstaller's automatic hooks miss
the DATA files of the phonemizer-fork dependency chain (espeak-ng-data, the
language_tags/csvw/segments/rdflib/babel JSON+locale data). Missing any of them
imports fine on the dev box but FileNotFound-crashes on a clean machine, so every
data-bearing package in the runtime chain is collected explicitly. Validate a
change by running the sidecar from an isolated, venv-less environment.
"""
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", ".."))
OUT = os.path.join(REPO, "bin", "kokoro")
WORK = os.path.join(HERE, ".build", "work")
SPEC = os.path.join(HERE, ".build")

# Every package that carries data files the runtime import chain touches.
COLLECT = [
    "kokoro_onnx",       # config.json
    "espeakng_loader",   # espeak-ng.dll + espeak-ng-data/ (364 files) — phonemisation
    "phonemizer",        # phonemize.scm
    "onnxruntime",       # native providers
    "language_tags",     # data/json/*.json (crashes clean machines if missing)
    "csvw", "segments", "rdflib", "babel",   # the segments/csvw orthography chain
    "isodate", "uritemplate", "rfc3986",
    "jsonschema", "jsonschema_specifications",
]

def main():
    args = [
        sys.executable, "-m", "PyInstaller", "--noconfirm", "--onedir",
        "--name", "kokoro-engine",
        "--distpath", OUT + os.sep + "_dist",   # PyInstaller makes <dist>/kokoro-engine/
        "--workpath", WORK,
        "--specpath", SPEC,
    ]
    for pkg in COLLECT:
        args += ["--collect-all", pkg]
    args.append(os.path.join(HERE, "kokoro_sidecar.py"))

    subprocess.check_call(args)

    # Flatten <OUT>/_dist/kokoro-engine/* up to <OUT>/ so the exe lands at
    # bin/kokoro/kokoro-engine.exe (where lib/kokoro.js looks).
    import shutil
    built = os.path.join(OUT, "_dist", "kokoro-engine")
    for name in os.listdir(built):
        dst = os.path.join(OUT, name)
        if os.path.exists(dst):
            (shutil.rmtree if os.path.isdir(dst) else os.remove)(dst)
        shutil.move(os.path.join(built, name), dst)
    shutil.rmtree(os.path.join(OUT, "_dist"), ignore_errors=True)
    print("\nFrozen engine ready at", OUT)

if __name__ == "__main__":
    main()
