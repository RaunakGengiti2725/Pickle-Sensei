"""Audit: detect_paddle.run_crops maps tMs -> frame index without the container start_time.

frame_iter (guarded by test_timestamp_alignment.py) labels source frame k as
`start_time_ms + k*1000/fps` — "constant_frame_rate_absolute_from_t0", the
same clock ffprobe reports per-frame pts on. run_crops receives crop requests
keyed by tMs on that clock, but discards `_start_time_ms` from ffprobe_meta and
computes `index = round(tMs * fps / 1000)`. For a clip whose start_time is one
frame period (afn-sasebo-rally1: 33.367 ms at 29.97 fps — a common YouTube /
re-encode layout; several datasets/pickleball clips share it) every crop
request is decoded from frame k+1 while the emitted record still says tMs(k).

The test feeds run_crops the exact (index, tMs) pairs frame_iter emitted for
the same clip and asserts the frames decode_frames_at is asked for are those
indices. No model is run: processor/model are inert fakes and decode_frames_at
is replaced with a recorder, so the only code under test is the index mapping.

Run: python3 -m unittest tools/audit/ml_tooling_datasets_structural1/test_detect_paddle_crops_start_time.py
"""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

import numpy as np

from _support import AFN_RALLY1, WM_VOLLEY, add_paddle_lab_to_path, install_torch_stub_if_missing

install_torch_stub_if_missing()
add_paddle_lab_to_path()
import detect_paddle as dp  # noqa: E402


class _InertProcessor:
    def __call__(self, images, return_tensors):  # noqa: D401 - fake
        return self

    def to(self, device):
        return {}

    def post_process_object_detection(self, outputs, target_sizes, threshold):
        empty = np.zeros((0, 4), dtype=np.float32)

        class _T:
            def __init__(self, a):
                self.a = a

            def detach(self):
                return self

            def cpu(self):
                return self

            def numpy(self):
                return self.a

        return [{"boxes": _T(empty), "scores": _T(empty[:, 0]), "labels": _T(empty[:, 0])}]


class _InertModel:
    class config:
        id2label = {}

    def __call__(self, **inputs):
        return None


def frame_iter_pairs(video: Path, start_ms: float, end_ms: float) -> list[tuple[int, float]]:
    width, height, fps, duration_ms, start_time_ms = dp.ffprobe_meta(str(video))
    first_index, _seek = dp.plan_window_seek(start_ms, fps, start_time_ms)
    # frame_iter yields window-relative source indices; absolute = first_index + rel.
    return [
        (first_index + rel_index, t_ms)
        for rel_index, t_ms, _rgb in dp.frame_iter(
            str(video), start_ms, end_ms, width, height, fps, stride=1, start_time_ms=start_time_ms
        )
    ]


class RunCropsFrameIndexClock(unittest.TestCase):
    def run_crops_requested_indices(self, video: Path, pairs: list[tuple[int, float]]) -> list[int]:
        requested: list[int] = []
        real = dp.decode_frames_at

        def recorder(v, frame_indices, width, height, fps):
            requested.extend(sorted(set(frame_indices)))
            for idx in sorted(set(frame_indices)):
                yield idx, np.zeros((height, width, 3), dtype=np.uint8)

        dp.decode_frames_at = recorder
        try:
            with tempfile.TemporaryDirectory() as tmp:
                crops = Path(tmp) / "crops.json"
                crops.write_text(json.dumps({
                    "crops": [{"tMs": t, "rects": [[0, 0, 64, 64]]} for _idx, t in pairs]
                }))
                dp.run_crops(_InertProcessor(), _InertModel(), video=str(video),
                             crops_path=str(crops), out=str(Path(tmp) / "out.json"))
        finally:
            dp.decode_frames_at = real
        return requested

    def test_wm_volley_02_start_time_zero_round_trips(self):
        pairs = frame_iter_pairs(WM_VOLLEY, 2000.0, 2400.0)
        self.assertTrue(pairs)
        self.assertEqual(self.run_crops_requested_indices(WM_VOLLEY, pairs), [i for i, _ in pairs])

    def test_afn_sasebo_rally1_nonzero_start_time_round_trips(self):
        pairs = frame_iter_pairs(AFN_RALLY1, 1000.0, 1400.0)
        self.assertTrue(pairs)
        got = self.run_crops_requested_indices(AFN_RALLY1, pairs)
        want = [i for i, _ in pairs]
        self.assertEqual(
            got, want,
            f"run_crops decodes frames {got} for the tMs values frame_iter emitted for frames {want} "
            f"(start_time={dp.ffprobe_meta(str(AFN_RALLY1))[4]:.3f} ms is ignored by run_crops)",
        )


if __name__ == "__main__":
    unittest.main()
