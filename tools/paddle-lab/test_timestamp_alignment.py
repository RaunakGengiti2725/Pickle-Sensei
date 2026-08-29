"""Regression guard for detect_paddle frame extraction timestamps.

Proves, against real committed bundle clips, that frame_iter's emitted tMs
matches ABSOLUTE constant-frame-rate indexing (frame k at k/fps seconds,
cross-checked against ffprobe per-frame pts) and that the pixel content of
every extracted frame is byte-identical to a direct full-clip CFR decode.

This guards the W12 forensic discovery: `ffmpeg -ss <start>` emits the first
frame whose pts >= start, so labeling that frame `start_ms` (the pre-fix
behavior) stamps every frame up to one frame (~33ms at 30fps) early whenever
start_ms is not exactly a frame boundary.

Usage:
  .venv/bin/python test_timestamp_alignment.py [clip.mp4 ...]
Defaults to two committed bundle clips. Exits non-zero on any mismatch.
"""

from __future__ import annotations

import hashlib
import json
import subprocess
import sys
from pathlib import Path

from detect_paddle import ffprobe_meta, frame_iter

REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_CLIPS = [
    REPO_ROOT / "datasets/paddle-bench/bundles/wm-volley-02/clip.mp4",
    REPO_ROOT / "datasets/paddle-bench/bundles/afn-sasebo-rally1/clip.mp4",
]
TOLERANCE_MS = 0.51  # ffprobe prints pts_time at microsecond precision; CFR model must agree well under a frame


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


def ffprobe_frame_times_ms(video: str) -> list[float]:
    out = subprocess.run(
        [
            "ffprobe", "-v", "error", "-select_streams", "v:0",
            "-show_entries", "frame=best_effort_timestamp_time", "-of", "json", video,
        ],
        capture_output=True, text=True, check=True,
    )
    return [float(f["best_effort_timestamp_time"]) * 1000.0 for f in json.loads(out.stdout)["frames"]]


def check_clip(video: str) -> list[str]:
    width, height, fps, duration_ms, start_time_ms = ffprobe_meta(video)
    full = full_decode_hashes(video, width, height)
    pts_ms = ffprobe_frame_times_ms(video)
    hash_to_index = {h: i for i, h in enumerate(full)}
    assert len(hash_to_index) == len(full), "clip has duplicate frames; hash matching is ambiguous"
    frame_ms = 1000.0 / fps
    failures: list[str] = []

    # Deliberately non-frame-aligned starts (the runPaddleStage -250ms padding
    # produces exactly these), plus an aligned start and a stride case.
    windows = [
        (0.0, min(duration_ms, 12 * frame_ms), 1),
        (2.5 * frame_ms, 9.5 * frame_ms, 1),
        (617.0, 617.0 + 10 * frame_ms, 1),
        (5 * frame_ms, 15 * frame_ms, 1),
        (7.25 * frame_ms, 20 * frame_ms, 3),
    ]
    for start_ms, end_ms, stride in windows:
        n = 0
        for _, t_ms, rgb in frame_iter(video, start_ms, end_ms, width, height, fps, stride=stride, start_time_ms=start_time_ms):
            n += 1
            digest = hashlib.sha256(rgb.tobytes()).hexdigest()
            absolute = hash_to_index.get(digest)
            if absolute is None:
                failures.append(f"{video} window({start_ms:.1f},{end_ms:.1f},s{stride}): frame at tMs={t_ms:.2f} has pixels not byte-identical to any direct-decode frame")
                continue
            expected_ms = start_time_ms + absolute * 1000.0 / fps
            if abs(t_ms - expected_ms) > TOLERANCE_MS:
                failures.append(
                    f"{video} window({start_ms:.1f},{end_ms:.1f},s{stride}): emitted tMs={t_ms:.2f} but pixels are absolute frame {absolute} (CFR {expected_ms:.2f}ms, ffprobe pts {pts_ms[absolute]:.2f}ms) — off by {t_ms - expected_ms:+.2f}ms"
                )
            if abs(expected_ms - pts_ms[absolute]) > TOLERANCE_MS:
                failures.append(
                    f"{video}: CFR model disagrees with container pts at frame {absolute}: {expected_ms:.2f} vs {pts_ms[absolute]:.2f}"
                )
        if n == 0:
            failures.append(f"{video} window({start_ms:.1f},{end_ms:.1f},s{stride}): no frames emitted")
    return failures


def main() -> int:
    clips = sys.argv[1:] or [str(p) for p in DEFAULT_CLIPS]
    all_failures: list[str] = []
    for clip in clips:
        failures = check_clip(clip)
        status = "OK" if not failures else f"FAIL ({len(failures)})"
        print(f"{clip}: {status}")
        all_failures += failures
    for f in all_failures:
        print(f"  {f}", file=sys.stderr)
    return 1 if all_failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
