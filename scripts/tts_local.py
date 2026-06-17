#!/usr/bin/env python3
"""Local Kokoro TTS helper for RankForge.

Reads a JSON batch of jobs from stdin and writes a WAV per job. Loading the
model once per invocation keeps batch synthesis fast.

Usage:
    tts_local.py --voice am_adam --speed 1.0
    stdin: [{"text": "...", "out": "/abs/path.wav"}, ...]
    stdout: one line per job -> "OK <out>"  or  "ERR <out> <message>"
"""
import argparse
import json
import sys


def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--voice", default="am_adam")
    ap.add_argument("--speed", type=float, default=1.0)
    ap.add_argument("--lang", default="a")  # 'a' = American English
    args = ap.parse_args()

    try:
        jobs = json.load(sys.stdin)
    except Exception as e:  # noqa: BLE001
        log(f"FATAL bad json: {e}")
        return 2
    if not isinstance(jobs, list) or not jobs:
        log("FATAL no jobs")
        return 2

    # Imported here so --help stays fast and import errors are reported clearly.
    import numpy as np
    import soundfile as sf
    from kokoro import KPipeline

    log(f"kokoro: loading pipeline (voice={args.voice})…")
    pipeline = KPipeline(lang_code=args.lang)

    rc = 0
    for job in jobs:
        text = str(job.get("text", "")).strip()
        out = job.get("out")
        if not text or not out:
            log(f"ERR {out} empty text/out")
            rc = 1
            continue
        try:
            chunks = []
            for _, _, audio in pipeline(text, voice=args.voice, speed=args.speed):
                chunks.append(audio)
            if not chunks:
                raise RuntimeError("no audio produced")
            full = np.concatenate(chunks) if len(chunks) > 1 else chunks[0]
            sf.write(out, full, 24000)
            print(f"OK {out}", flush=True)
        except Exception as e:  # noqa: BLE001
            log(f"ERR {out} {e}")
            print(f"ERR {out} {e}", flush=True)
            rc = 1
    return rc


if __name__ == "__main__":
    sys.exit(main())
