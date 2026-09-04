#!/usr/bin/env python3
"""Structural audit: student_lib.extract_frames vs detect_paddle's frame clock.

detect_paddle.frame_iter labels frame k as `start_time + k/fps` (pinned by
test_timestamp_alignment.py). student_lib.extract_frames maps a tMs back to a
frame with `round(tMs * fps / 1000)` — no start_time term. The two agree only
for streams whose start_time is 0. afn-sasebo-rally1 (a committed dev clip and
the student's TRAIN session) has start_time = 1 frame, so a detector timestamp
for frame k resolves to the pixels of frame k+1.

The check feeds detect_paddle's own (t_ms, rgb) pairs into extract_frames and
requires the returned pixels to be identical.

Run from tools/paddle-lab with the venv (numpy + torch + pillow + ffmpeg):
  .venv/bin/python -W ignore::ResourceWarning -m unittest test_audit_extract_frames_clock -v
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import detect_paddle  # noqa: E402
from student_lib import extract_frames  # noqa: E402

REPO = Path(__file__).resolve().parents[2]
CLIPS = {
    "afn-sasebo-rally1": REPO / "datasets/paddle-bench/bundles/afn-sasebo-rally1/clip.mp4",
    "wm-volley-02": REPO / "datasets/paddle-bench/bundles/wm-volley-02/clip.mp4",
}


def detector_frames(video: Path, start_ms: float, end_ms: float) -> list[tuple[int, float, np.ndarray]]:
    width, height, fps, _, start_time_ms = detect_paddle.ffprobe_meta(str(video))
    return [
        (idx, t_ms, rgb)
        for idx, t_ms, rgb in detect_paddle.frame_iter(
            str(video), start_ms, end_ms, width, height, fps, start_time_ms=start_time_ms
        )
    ]


class ExtractFramesClockTest(unittest.TestCase):
    def _check(self, name: str, start_ms: float, end_ms: float) -> None:
        video = CLIPS[name]
        self.assertTrue(video.exists(), video)
        det = detector_frames(video, start_ms, end_ms)
        self.assertGreater(len(det), 3, "detector window decoded no frames")
        wanted = [t for _, t, _ in det]
        got = extract_frames(video, wanted)
        mismatches = []
        for _, t_ms, rgb in det:
            student = got.get(t_ms)
            if student is None:
                mismatches.append(f"tMs={t_ms:.2f}: extract_frames returned nothing")
            elif student.shape != rgb.shape or not np.array_equal(student, rgb):
                mismatches.append(f"tMs={t_ms:.2f}: pixels differ from detect_paddle's frame at that tMs")
        self.assertEqual(mismatches[:3], [], f"{name}: {len(mismatches)}/{len(det)} frames disagree; " + "; ".join(mismatches[:3]))

    def test_control_zero_start_time_clip_agrees(self):
        self._check("wm-volley-02", 1000.0, 1400.0)

    def test_nonzero_start_time_train_clip_agrees(self):
        _, _, _, _, start_time_ms = detect_paddle.ffprobe_meta(str(CLIPS["afn-sasebo-rally1"]))
        self.assertGreater(start_time_ms, 0, "precondition: clip has non-zero start_time")
        self._check("afn-sasebo-rally1", 1000.0, 1400.0)


if __name__ == "__main__":
    unittest.main()
