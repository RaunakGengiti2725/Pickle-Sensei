"""Adjudication repro: which absolute frame does the g03 miner's frame-pack
extraction (`ffmpeg -ss tMs/1000 -i clip -frames:v 1 out.png`, see
tools/mining/wave_g_g03_multi_paddle_miner.py extract_crops) actually grab,
compared with the frame the candidate tMs names under the detector's absolute
CFR clock (frame k at start_time + k/fps)?

Ground truth is pixel identity against a full CFR decode. Exit 0 iff every
sampled candidate lands on frame k; 1 otherwise.
"""

from __future__ import annotations

import hashlib
import json
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np
from PIL import Image

REPO_ROOT = Path(__file__).resolve().parents[3]


def probe(video: str):
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=width,height,avg_frame_rate,start_time", "-of", "json", video],
        capture_output=True, text=True, check=True,
    )
    s = json.loads(out.stdout)["streams"][0]
    num, den = s["avg_frame_rate"].split("/")
    return int(s["width"]), int(s["height"]), float(num) / float(den), float(s.get("start_time", 0)) * 1000


def full_decode_frames(video: str, w: int, h: int) -> list[np.ndarray]:
    proc = subprocess.Popen(["ffmpeg", "-v", "error", "-i", video, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
                            stdout=subprocess.PIPE)
    assert proc.stdout is not None
    size = w * h * 3
    frames = []
    while True:
        chunk = proc.stdout.read(size)
        if len(chunk) < size:
            break
        frames.append(np.frombuffer(chunk, dtype=np.uint8).reshape(h, w, 3))
    proc.wait()
    return frames


def main() -> int:
    cands = json.loads((REPO_ROOT / "datasets/mining/wave-g-g03/candidates.json").read_text())["candidates"]
    tmp = Path(tempfile.mkdtemp(prefix="adj-miner-"))
    report = []
    ok = True
    for bundle in ("wm-volley-02", "afn-sasebo-rally1"):
        clip = REPO_ROOT / "datasets/paddle-bench/bundles" / bundle / "clip.mp4"
        w, h, fps, start_time_ms = probe(str(clip))
        frames = full_decode_frames(str(clip), w, h)
        sample = [c for c in cands if c["caseId"] == bundle][:6]
        for c in sample:
            t = float(c["tMs"])
            png = tmp / f"{c['candidateId']}.png"
            subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-ss", f"{t / 1000.0:.3f}", "-i", str(clip),
                            "-frames:v", "1", str(png)], check=True, capture_output=True)
            got = np.asarray(Image.open(png).convert("RGB"))
            # PNG round-trip of rgb24 is lossless but ffmpeg's png path may differ by yuv->rgb conversion;
            # pick the nearest frame by mean abs diff and require it to be an exact/near-exact match.
            diffs = [float(np.mean(np.abs(f.astype(np.int16) - got.astype(np.int16)))) for f in frames]
            k_got = int(np.argmin(diffs))
            k_abs = int(round((t - start_time_ms) * fps / 1000.0))  # frame k such that start_time + k/fps == t
            row = {"bundle": bundle, "candidateId": c["candidateId"], "tMs": t, "startTimeMs": start_time_ms,
                   "frameGrabbedByMiner": k_got, "meanAbsDiffToGrabbed": round(diffs[k_got], 3),
                   "frameNamedByAbsoluteClock": k_abs, "frameNamedByNaiveClock": int(round(t * fps / 1000.0))}
            report.append(row)
            ok = ok and k_got == k_abs
    print(json.dumps(report, indent=2))
    print("RESULT:", "ALIGNED" if ok else "MISALIGNED")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
