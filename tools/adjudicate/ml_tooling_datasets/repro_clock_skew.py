"""Adjudication repro: do ball_candidates.py, detect_paddle.frame_iter and
student_lib.extract_frames agree on WHICH absolute frame a given tMs names?

Ground truth = pixel identity. Every emitted frame is hashed and matched
against a full-clip CFR decode (same filter chain) to recover its absolute
source index k; the clip's true pts for frame k is start_time + k/fps (the
model detect_paddle.frame_iter documents and test_timestamp_alignment.py
already proves for detect_paddle).

Exit 0 iff all three tools agree within TOLERANCE_MS; exit 1 otherwise.

Usage: adj-venv/bin/python repro_clock_skew.py [--start-ms 1234]
"""

from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import sys
from pathlib import Path

import numpy as np

REPO_ROOT = Path(__file__).resolve().parents[3]
PADDLE_LAB = REPO_ROOT / "tools" / "paddle-lab"
sys.path.insert(0, str(PADDLE_LAB))

import ball_candidates  # noqa: E402
import detect_paddle  # noqa: E402
import student_lib  # noqa: E402

TOLERANCE_MS = 0.51
CLIPS = [
    REPO_ROOT / "datasets/paddle-bench/bundles/wm-volley-02/clip.mp4",
    REPO_ROOT / "datasets/paddle-bench/bundles/afn-sasebo-rally1/clip.mp4",
]


def gray_full_decode_hashes(video: str, out_w: int, out_h: int) -> list[str]:
    proc = subprocess.Popen(
        ["ffmpeg", "-v", "error", "-i", video, "-vf", f"scale={out_w}:{out_h}",
         "-f", "rawvideo", "-pix_fmt", "gray", "-"],
        stdout=subprocess.PIPE,
    )
    assert proc.stdout is not None
    size = out_w * out_h
    hashes = []
    while True:
        chunk = proc.stdout.read(size)
        if len(chunk) < size:
            break
        hashes.append(hashlib.sha256(chunk).hexdigest())
    proc.wait()
    return hashes


def rgb_full_decode_hashes(video: str, w: int, h: int) -> list[str]:
    proc = subprocess.Popen(
        ["ffmpeg", "-v", "error", "-i", video, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
        stdout=subprocess.PIPE,
    )
    assert proc.stdout is not None
    size = w * h * 3
    hashes = []
    while True:
        chunk = proc.stdout.read(size)
        if len(chunk) < size:
            break
        hashes.append(hashlib.sha256(chunk).hexdigest())
    proc.wait()
    return hashes


def probe(video: str) -> tuple[int, int, float, float, float]:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=width,height,avg_frame_rate,duration,start_time", "-of", "json", video],
        capture_output=True, text=True, check=True,
    )
    s = json.loads(out.stdout)["streams"][0]
    num, den = s["avg_frame_rate"].split("/")
    return (int(s["width"]), int(s["height"]), float(num) / float(den),
            float(s.get("duration", 0)) * 1000, float(s.get("start_time", 0)) * 1000)


def check_ball_candidates(video: Path, start_ms: float, report: dict) -> bool:
    width, height, fps, duration_ms, start_time_ms = probe(str(video))
    scale = 0.5
    out_w, out_h = int(width * scale) // 2 * 2, int(height * scale) // 2 * 2
    truth = {h: k for k, h in enumerate(gray_full_decode_hashes(str(video), out_w, out_h))}
    frame_ms = 1000.0 / fps
    worst = 0.0
    rows = []
    # gray_frames yields (absolute index, tMs, frame) — the same clock ball_candidates.py stamps on its output.
    for piped, (index, emitted, frame) in enumerate(ball_candidates.gray_frames(
        str(video), start_ms, 0, out_w, out_h, fps=fps, start_time_ms=start_time_ms, duration_ms=duration_ms,
    )):
        digest = hashlib.sha256(frame.astype(np.uint8).tobytes()).hexdigest()
        k = truth.get(digest)
        true_pts = None if k is None else start_time_ms + k * frame_ms
        delta = None if true_pts is None else emitted - true_pts
        if delta is not None:
            worst = max(worst, abs(delta))
        if piped < 3:
            rows.append({"pipedIndex": piped, "yieldedIndex": index, "absoluteIndex": k,
                         "ballCandidatesTMs": round(emitted, 3),
                         "truePtsMs": None if true_pts is None else round(true_pts, 3),
                         "skewMs": None if delta is None else round(delta, 3)})
        if k is None or index != k:
            worst = max(worst, frame_ms)
        if piped >= 30:
            break
    report[f"ball_candidates:{video.parent.name}"] = {
        "startMs": start_ms, "fps": fps, "startTimeMs": start_time_ms, "worstSkewMs": round(worst, 3), "first": rows,
    }
    return worst <= TOLERANCE_MS


def check_extract_frames(video: Path, report: dict) -> bool:
    width, height, fps, _duration_ms, start_time_ms = probe(str(video))
    truth = {h: k for k, h in enumerate(rgb_full_decode_hashes(str(video), width, height))}
    # tMs values exactly as detect_paddle.frame_iter emits them: start_time + k/fps
    wanted_k = [10, 37, 61, 90]
    t_list = [start_time_ms + k * 1000.0 / fps for k in wanted_k]
    frames = student_lib.extract_frames(video, t_list)
    rows = []
    ok = True
    for k, t in zip(wanted_k, t_list):
        img = frames.get(t)
        got = None if img is None else truth.get(hashlib.sha256(np.ascontiguousarray(img).tobytes()).hexdigest())
        rows.append({"detectorFrameIndex": k, "tMs": round(t, 3), "extractFramesReturnedIndex": got,
                     "indexFormula": round(t * fps / 1000.0)})
        ok = ok and got == k
    report[f"extract_frames:{video.parent.name}"] = {"fps": fps, "startTimeMs": start_time_ms, "rows": rows, "agree": ok}
    return ok


def check_run_crops_index(video: Path, report: dict) -> bool:
    """run_crops maps crop tMs -> detect_paddle.frame_index_for_t_ms(tMs, fps, start_time),
    then decode_frames_at decodes ABSOLUTE frame k."""
    width, height, fps, _duration_ms, start_time_ms = probe(str(video))
    wanted_k = [10, 37, 61]
    rows = []
    ok = True
    for k in wanted_k:
        t = start_time_ms + k * 1000.0 / fps  # detector-emitted absolute tMs for frame k
        idx = detect_paddle.frame_index_for_t_ms(t, fps, start_time_ms)
        rows.append({"detectorFrameIndex": k, "tMs": round(t, 3), "runCropsIndex": idx})
        ok = ok and idx == k
    report[f"run_crops_index:{video.parent.name}"] = {"fps": fps, "startTimeMs": start_time_ms, "rows": rows, "agree": ok}
    return ok


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--start-ms", type=float, default=1234.0)
    parser.add_argument("--out", default=None)
    args = parser.parse_args()
    report: dict = {}
    ok = True
    for clip in CLIPS:
        ok &= check_ball_candidates(clip, args.start_ms, report)
        ok &= check_extract_frames(clip, report)
        ok &= check_run_crops_index(clip, report)
    text = json.dumps(report, indent=2)
    print(text)
    if args.out:
        Path(args.out).write_text(text)
    print("RESULT:", "AGREE" if ok else "CLOCK SKEW")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
