"""Decode-path latency bench for detect_paddle frame extraction (D4-03).

Measures wall-clock of the two ffmpeg extraction paths in detect_paddle.py
WITHOUT any model inference, so decode cost is isolated:

  - frame_iter: windowed decode (run_window's path) — full clip, event-window,
    and stride cases.
  - decode_frames_at: sparse exact-frame decode (run_crops' path) — a late
    cluster of frames, where decode-from-t0 cost dominates.

Every timed iteration also sha256-hashes each yielded frame; the per-scenario
digest (order-sensitive hash of frame hashes + emitted indices/tMs) is printed
so before/after runs can prove BYTE-IDENTICAL extraction content.

Usage:
  .venv/bin/python bench_decode.py [--runs 7] [--clips a.mp4 b.mp4 ...] [--verify]
Prints one JSON document to stdout. `--verify` additionally checks every
decode_frames_at cluster's pixels frame-by-frame against a direct full-clip
decode (exits non-zero on any mismatch); frame_iter identity is covered by
test_timestamp_alignment.py.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import statistics
import subprocess
import time
from pathlib import Path

from detect_paddle import decode_frames_at, ffprobe_meta, frame_iter

REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_CLIPS = [
    str(REPO_ROOT / "datasets/paddle-bench/bundles/wm-volley-02/clip.mp4"),
    str(REPO_ROOT / "datasets/paddle-bench/bundles/afn-sasebo-rally1/clip.mp4"),
]


def run_frame_iter(video, start_ms, end_ms, width, height, fps, stride, start_time_ms):
    digest = hashlib.sha256()
    count = 0
    for source_index, t_ms, rgb in frame_iter(
        video, start_ms, end_ms, width, height, fps,
        stride=stride, start_time_ms=start_time_ms,
    ):
        digest.update(f"{source_index}:{t_ms:.3f}:".encode())
        digest.update(hashlib.sha256(rgb.tobytes()).digest())
        count += 1
    return count, digest.hexdigest()


def run_decode_frames_at(video, indices, width, height, fps):
    digest = hashlib.sha256()
    count = 0
    for frame_index, rgb in decode_frames_at(video, indices, width, height, fps):
        digest.update(f"{frame_index}:".encode())
        digest.update(hashlib.sha256(rgb.tobytes()).digest())
        count += 1
    return count, digest.hexdigest()


def full_decode_hashes(video: str, width: int, height: int) -> list[str]:
    proc = subprocess.Popen(
        ["ffmpeg", "-v", "error", "-i", video, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
        stdout=subprocess.PIPE,
    )
    frame_bytes = width * height * 3
    hashes = []
    assert proc.stdout is not None
    while True:
        chunk = proc.stdout.read(frame_bytes)
        if len(chunk) < frame_bytes:
            break
        hashes.append(hashlib.sha256(chunk).hexdigest())
    proc.wait()
    return hashes


def verify_decode_frames_at(clip: str, clusters: list[list[int]], width: int, height: int, fps: float) -> list[str]:
    full = full_decode_hashes(clip, width, height)
    failures = []
    for cluster in clusters:
        got = {}
        for idx, rgb in decode_frames_at(clip, cluster, width, height, fps):
            got[idx] = hashlib.sha256(rgb.tobytes()).hexdigest()
        if sorted(got) != sorted(set(cluster)):
            failures.append(f"{clip} cluster {cluster[0]}..{cluster[-1]}: yielded {sorted(got)}")
            continue
        for idx, digest in got.items():
            if digest != full[idx]:
                failures.append(f"{clip} frame {idx}: NOT byte-identical to direct full-clip decode")
    return failures


def bench(fn, runs):
    walls = []
    frames = None
    content = None
    for _ in range(runs):
        started = time.perf_counter()
        count, digest = fn()
        walls.append(time.perf_counter() - started)
        if content is None:
            frames, content = count, digest
        else:
            assert (count, digest) == (frames, content), "non-deterministic extraction"
    return {
        "framesYielded": frames,
        "contentDigest": content,
        "runs": runs,
        "medianWallSec": round(statistics.median(walls), 4),
        "minWallSec": round(min(walls), 4),
        "maxWallSec": round(max(walls), 4),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--runs", type=int, default=7)
    parser.add_argument("--clips", nargs="*", default=DEFAULT_CLIPS)
    parser.add_argument("--verify", action="store_true")
    args = parser.parse_args()
    verify_failures: list[str] = []

    report = {"bench": "bench_decode-v1", "platform": "LINUX-CPU", "scenarios": []}
    for clip in args.clips:
        width, height, fps, duration_ms, start_time_ms = ffprobe_meta(clip)
        frame_ms = 1000.0 / fps
        total_frames = int(duration_ms / frame_ms)
        name = Path(clip).parent.name

        # Event-window analogue: runPaddleStage pads the event peak by -250ms
        # and decodes ~74 frames; place it in the middle of the clip.
        mid_start = (duration_ms / 2) - 250.0
        mid_end = min(duration_ms - frame_ms, mid_start + 74 * frame_ms)

        scenarios = [
            ("frame_iter full clip stride1",
             lambda: run_frame_iter(clip, 0.0, 0.0, width, height, fps, 1, start_time_ms)),
            ("frame_iter mid window stride1",
             lambda: run_frame_iter(clip, mid_start, mid_end, width, height, fps, 1, start_time_ms)),
            ("frame_iter mid window stride3",
             lambda: run_frame_iter(clip, mid_start, mid_end, width, height, fps, 3, start_time_ms)),
        ]

        # Crop-mode analogue: densify ±10 frames around a LATE event peak
        # (crop recovery targets blind slices anywhere in the clip).
        late_center = int(total_frames * 0.8)
        late_cluster = [late_center + d for d in range(-10, 11)]
        late_cluster = [i for i in late_cluster if 0 <= i < total_frames]
        scenarios.append((
            "decode_frames_at late cluster (21 frames @80%)",
            lambda: run_decode_frames_at(clip, late_cluster, width, height, fps),
        ))
        early_cluster = [i for i in range(5, 26)]
        scenarios.append((
            "decode_frames_at early cluster (21 frames @start)",
            lambda: run_decode_frames_at(clip, early_cluster, width, height, fps),
        ))

        if args.verify:
            sparse = sorted({3, 17, total_frames // 3, total_frames // 2, int(total_frames * 0.75), total_frames - 2})
            clusters = [late_cluster, early_cluster, sparse, [total_frames - 1]]
            failures = verify_decode_frames_at(clip, clusters, width, height, fps)
            verify_failures += failures
            print(f"  {name} · decode_frames_at byte-identity vs full decode: "
                  f"{'OK' if not failures else 'FAIL'}", flush=True)

        for label, fn in scenarios:
            entry = {"clip": name, "scenario": label}
            entry.update(bench(fn, args.runs))
            report["scenarios"].append(entry)
            print(f"  {name} · {label}: median {entry['medianWallSec']}s "
                  f"({entry['framesYielded']} frames)", flush=True)

    if args.verify:
        report["verify"] = {"failures": verify_failures}
    print(json.dumps(report, indent=2))
    for failure in verify_failures:
        print(f"  {failure}", flush=True)
    if verify_failures:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
