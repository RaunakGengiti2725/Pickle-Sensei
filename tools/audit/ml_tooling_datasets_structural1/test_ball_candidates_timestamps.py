"""Audit: tools/paddle-lab/ball_candidates.py frame timestamps vs detect_paddle's clock.

ball_candidates.main labels the i-th frame emitted after `ffmpeg -ss start_ms`
as `start_ms + i * frame_ms`, and ffprobe_meta never reads the container
start_time. detect_paddle.frame_iter (guarded by test_timestamp_alignment.py)
labels frame k as `start_time_ms + k * 1000/fps`. ballTracker.ts matches ball
and paddle observations with a 60 ms gate, so both scripts must be on the same
clock.

This test decodes a seeked window with ball_candidates.gray_frames (exactly the
call main() makes), identifies each emitted frame by pixel hash against an
unseeked full decode, and compares the tMs main() would assign with the
absolute CFR/pts time of the frame that was actually emitted.

Run: python3 -m unittest tools/audit/ml_tooling_datasets_structural1/test_ball_candidates_timestamps.py
Requires: numpy, ffmpeg/ffprobe on PATH.
"""

from __future__ import annotations

import hashlib
import unittest

import numpy as np

from _support import (
    AFN_RALLY1, WM_VOLLEY, add_paddle_lab_to_path, ffprobe_frame_pts_ms, ffprobe_stream,
    fps_of, full_decode_hashes,
)

add_paddle_lab_to_path()
import ball_candidates as bc  # noqa: E402

HALF_FRAME_TOLERANCE = 0.51  # ms; anything beyond this is a different frame


def emitted_labels(video, start_ms: float, end_ms: float, scale: int):
    """Replicate main(): (label_ms_main_would_emit, absolute_frame_index) per frame."""
    stream = ffprobe_stream(video)
    fps = fps_of(stream)
    w, h = int(stream["width"]), int(stream["height"])
    out_w, out_h = w // scale, h // scale
    frame_ms = 1000.0 / fps
    full = full_decode_hashes(video, f"scale={out_w}:{out_h}", "gray", out_w * out_h)
    index_of = {hsh: i for i, hsh in enumerate(full)}
    assert len(index_of) == len(full), "duplicate frames; hash matching ambiguous"
    rows = []
    for local_index, frame in bc.gray_frames(str(video), start_ms, end_ms, out_w, out_h):
        raw = frame.astype(np.uint8).tobytes()
        absolute = index_of[hashlib.sha256(raw).hexdigest()]
        rows.append((start_ms + local_index * frame_ms, absolute))
    return rows, fps, float(stream.get("start_time", 0.0)) * 1000.0


class BallCandidatesTimestampClock(unittest.TestCase):
    def check(self, video, start_ms: float, end_ms: float):
        rows, fps, start_time_ms = emitted_labels(video, start_ms, end_ms, scale=4)
        pts = ffprobe_frame_pts_ms(video)
        self.assertTrue(rows, "window decoded no frames")
        skews = []
        for label_ms, absolute in rows:
            cfr_ms = start_time_ms + absolute * 1000.0 / fps
            self.assertAlmostEqual(cfr_ms, pts[absolute], delta=HALF_FRAME_TOLERANCE)
            skews.append(label_ms - cfr_ms)
        worst = max(skews, key=abs)
        self.assertLessEqual(
            abs(worst), HALF_FRAME_TOLERANCE,
            f"{video.name} window start={start_ms}ms: ball_candidates would label frames "
            f"{worst:+.2f} ms away from their absolute CFR/pts time (first emitted frame is "
            f"absolute index {rows[0][1]} at {pts[rows[0][1]]:.2f} ms but gets tMs={rows[0][0]:.2f})",
        )

    def test_wm_volley_02_frame_aligned_window_is_on_clock(self):
        # 25 fps, start_time 0, start on a frame boundary: the one case that is exact.
        self.check(WM_VOLLEY, start_ms=2520.0, end_ms=3000.0)

    def test_wm_volley_02_unaligned_window(self):
        # analyzeVideo.ts passes window.startMs - 1200 — arbitrary, not frame aligned.
        self.check(WM_VOLLEY, start_ms=2500.0, end_ms=3000.0)

    def test_afn_sasebo_rally1_ignores_container_start_time(self):
        # 29.97 fps with start_time 33.367 ms: even a "frame aligned" start_ms drifts.
        self.check(AFN_RALLY1, start_ms=1001.0, end_ms=2000.0)

    def test_afn_sasebo_rally1_unaligned_window(self):
        self.check(AFN_RALLY1, start_ms=1000.0, end_ms=2000.0)


if __name__ == "__main__":
    unittest.main()
