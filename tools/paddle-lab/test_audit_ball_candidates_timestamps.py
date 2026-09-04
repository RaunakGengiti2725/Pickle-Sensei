#!/usr/bin/env python3
"""Structural audit: are ball_candidates.py frame timestamps on the absolute CFR clock?

detect_paddle.py labels every frame as start_time + absolute_index / fps (pinned by
test_timestamp_alignment.py). ballTracker.ts joins ball candidates to paddle
detections with a 60 ms gate, which presumes both artifacts share that clock.
ball_candidates.py instead labels frames as `--start-ms + window_index * frame_ms`
after an `ffmpeg -ss` seek, which is only correct when --start-ms lands exactly
on a frame boundary and the stream's start_time is 0.

Two independent checks:
  1. Synthetic lossless clip whose only moving blob sits at x = f(frame index), so
     each emitted candidate reveals the absolute source frame it came from.
  2. Committed dev bundle clips (never the held-out cases): window-decoded frames
     are matched by pixel hash to a full-clip decode of the same scale/gray
     pipeline, giving the absolute index and therefore the true timestamp.

Run from tools/paddle-lab with the venv (needs numpy + scipy + ffmpeg):
  .venv/bin/python -W ignore::ResourceWarning -m unittest test_audit_ball_candidates_timestamps -v
"""
from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import ball_candidates  # noqa: E402

REPO = Path(__file__).resolve().parents[2]
BALL_CANDIDATES = Path(__file__).resolve().parent / "ball_candidates.py"
DEV_CLIPS = [
    REPO / "datasets/paddle-bench/bundles/afn-sasebo-rally1/clip.mp4",  # start_time 0.033s @29.97
    REPO / "datasets/paddle-bench/bundles/wm-volley-02/clip.mp4",  # start_time 0 @25
]
TOLERANCE_MS = 1.0

FPS = 30
W, H = 320, 240
FRAMES = 90
BLOB = 12
STEP = 16  # > BLOB so consecutive blob positions never overlap (single motion component)
COLS = 18  # blob walks a COLS-wide grid: position uniquely encodes the source frame index


def blob_origin(n: int) -> tuple[int, int]:
    return 4 + STEP * (n % COLS), 4 + STEP * (n // COLS)


def make_synthetic_clip(path: Path) -> None:
    raw = bytearray()
    for n in range(FRAMES):
        frame = np.zeros((H, W), dtype=np.uint8)
        x0, y0 = blob_origin(n)
        frame[y0 : y0 + BLOB, x0 : x0 + BLOB] = 255
        raw += frame.tobytes()
    subprocess.run(
        [
            "ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "gray",
            "-s", f"{W}x{H}", "-r", str(FPS), "-i", "-",
            "-c:v", "libx264", "-qp", "0", "-pix_fmt", "yuv420p", "-g", "15", str(path),
        ],
        input=bytes(raw), check=True,
    )


def run_ball_candidates(video: Path, out: Path, start_ms: float, end_ms: float = 0) -> dict:
    subprocess.run(
        [
            sys.executable, str(BALL_CANDIDATES), "--video", str(video), "--out", str(out),
            "--start-ms", str(start_ms), "--end-ms", str(end_ms), "--scale", "0.5",
            "--min-area", "3", "--max-area", "700",
        ],
        check=True, capture_output=True,
    )
    return json.loads(out.read_text())


def blob_index_from_candidate(candidate: dict) -> int:
    # normalized centre is scale-invariant: (x0 + BLOB/2) / W, (y0 + BLOB/2) / H
    col = int(round((candidate["x"] * W - BLOB / 2 - 4) / STEP))
    row = int(round((candidate["y"] * H - BLOB / 2 - 4) / STEP))
    return row * COLS + col


def ffprobe_start_time_fps(video: Path) -> tuple[float, float]:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=avg_frame_rate,start_time", "-of", "json", str(video)],
        capture_output=True, text=True, check=True,
    )
    stream = json.loads(out.stdout)["streams"][0]
    num, den = stream["avg_frame_rate"].split("/")
    return float(stream.get("start_time", 0.0)) * 1000.0, float(num) / float(den)


class SyntheticClockTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.video = Path(cls.tmp.name) / "synthetic.mp4"
        make_synthetic_clip(cls.video)

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def _check_window(self, start_ms: float, end_ms: float = 0) -> list[dict]:
        payload = run_ball_candidates(self.video, Path(self.tmp.name) / "out.json", start_ms, end_ms)
        rows = []
        for frame in payload["frames"]:
            self.assertEqual(len(frame["candidates"]), 1, frame)
            n = blob_index_from_candidate(frame["candidates"][0])
            true_ms = n * 1000.0 / FPS
            rows.append({"emittedTMs": frame["tMs"], "absoluteIndex": n, "trueTMs": round(true_ms, 3),
                         "errorMs": round(frame["tMs"] - true_ms, 3)})
        self.assertGreater(len(rows), 5)
        return rows

    def test_frame_aligned_start_is_on_the_absolute_clock(self):
        rows = self._check_window(start_ms=1000.0)
        worst = max(abs(r["errorMs"]) for r in rows)
        self.assertLessEqual(worst, TOLERANCE_MS, rows[:3])

    def test_non_frame_aligned_start_is_on_the_absolute_clock(self):
        # analyzeVideo.ts passes window.startMs - 1200 — arbitrary, never frame aligned.
        rows = self._check_window(start_ms=1010.0)
        worst = max(abs(r["errorMs"]) for r in rows)
        self.assertLessEqual(
            worst, TOLERANCE_MS,
            f"ball_candidates tMs drifts from the absolute CFR clock by up to {worst} ms; first rows: {rows[:3]}",
        )

    def test_late_non_aligned_start_is_on_the_absolute_clock(self):
        rows = self._check_window(start_ms=1030.0)
        worst = max(abs(r["errorMs"]) for r in rows)
        self.assertLessEqual(worst, TOLERANCE_MS, rows[:3])


class CommittedDevClipClockTest(unittest.TestCase):
    """Window frames matched by pixel hash to the full decode of the same pipeline."""

    def _full_decode_hashes(self, video: Path, out_w: int, out_h: int) -> dict[str, int]:
        hashes: dict[str, int] = {}
        for index, frame in ball_candidates.gray_frames(str(video), 0, 0, out_w, out_h):
            hashes.setdefault(hashlib.sha1(frame.astype(np.uint8).tobytes()).hexdigest(), index)
        return hashes

    def _check(self, video: Path, start_ms: float) -> list[dict]:
        width, height, fps, _ = ball_candidates.ffprobe_meta(str(video))
        start_time_ms, _ = ffprobe_start_time_fps(video)
        out_w, out_h = int(width * 0.5) // 2 * 2, int(height * 0.5) // 2 * 2
        full = self._full_decode_hashes(video, out_w, out_h)
        with tempfile.TemporaryDirectory() as tmp:
            payload = run_ball_candidates(video, Path(tmp) / "out.json", start_ms, start_ms + 800)
        window = list(ball_candidates.gray_frames(str(video), start_ms, start_ms + 800, out_w, out_h))
        # main() emits one row per 3-frame window centred on the middle frame (window index j+1)
        self.assertEqual(len(payload["frames"]), max(0, len(window) - 2))
        rows = []
        for j, entry in enumerate(payload["frames"]):
            _, frame = window[j + 1]
            absolute = full.get(hashlib.sha1(frame.astype(np.uint8).tobytes()).hexdigest())
            self.assertIsNotNone(absolute, "window frame pixels not found in full decode")
            true_ms = start_time_ms + absolute * 1000.0 / fps
            rows.append({"emittedTMs": entry["tMs"], "absoluteIndex": absolute,
                         "trueTMs": round(true_ms, 3), "errorMs": round(entry["tMs"] - true_ms, 3)})
        self.assertGreater(len(rows), 3)
        return rows

    def test_dev_clips_windows_are_on_the_detect_paddle_clock(self):
        report = {}
        failures = []
        for clip in DEV_CLIPS:
            if not clip.exists():
                self.fail(f"missing committed clip {clip}")
            _, fps = ffprobe_start_time_fps(clip)
            frame_ms = 1000.0 / fps
            for start_ms in (0.0, round(30 * frame_ms, 3), round(30 * frame_ms + 10, 3), 1234.0):
                rows = self._check(clip, start_ms)
                worst = max(abs(r["errorMs"]) for r in rows)
                report[f"{clip.parent.name}@{start_ms}"] = {"worstAbsErrorMs": worst, "rows": rows[:4]}
                if worst > TOLERANCE_MS:
                    failures.append(f"{clip.parent.name} start_ms={start_ms}: worst |error| {worst} ms (e.g. {rows[0]})")
        artifact = os.environ.get("AUDIT_ARTIFACT_DIR")
        if artifact:
            Path(artifact).mkdir(parents=True, exist_ok=True)
            (Path(artifact) / "ball_candidates_clock_report.json").write_text(json.dumps(report, indent=1))
        self.assertEqual(failures, [], "\n".join(failures))


if __name__ == "__main__":
    unittest.main()
