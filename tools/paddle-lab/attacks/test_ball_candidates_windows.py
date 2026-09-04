"""S4 / S5 / S6 (+extras) — tools/paddle-lab/ball_candidates.py under hostile
scales, contradictory area bounds, windows outside the clip, tiny per-frame caps,
degenerate media, and a per-frame tMs diff against detect_paddle's absolute CFR
timestamp model and the container's real frame pts.

All runs are the REAL script as a subprocess with a hard timeout. Clips are the
committed paddle-bench bundles (wm-volley-02: 1000x1080 @ 25 fps, 8 s;
afn-sasebo-rally1: 1920x1080 @ 29.97 fps, ~4.4 s).
"""
from __future__ import annotations

import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

from attack_common import (
    AFN_SASEBO_RALLY1, ARTIFACT_DIR, BALL_CANDIDATES, PADDLE_LAB, WM_VOLLEY_02,
    ffmpeg_available, ffprobe_video_pts_ms, load_json, make_audio_only_mp4,
    make_empty_mp4, py, torch_importable,
)

WM_FPS = 25.0
WM_DURATION_MS = 8000.0


def _strip_timing(payload: dict) -> dict:
    p = json.loads(json.dumps(payload))
    p.pop("timing", None)
    return p


@unittest.skipUnless(ffmpeg_available(), "ffmpeg/ffprobe required")
class BallCandidatesWindowTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="ball-candidates-attack-"))
        self.out = self.tmp / "out.json"

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _bc(self, *args: str, timeout: float = 120):
        return py(BALL_CANDIDATES, "--out", str(self.out), *args, timeout=timeout)

    # ---- S4 -----------------------------------------------------------------

    def test_scale_033_on_1080p_decodes_even_dimensions(self) -> None:
        r = self._bc("--video", str(AFN_SASEBO_RALLY1), "--scale", "0.33", "--end-ms", "1500")
        r.record("s4_bc_scale_033")
        self.assertFalse(r.timed_out)
        self.assertEqual(r.returncode, 0, r)
        self.assertNotIn("Traceback", r.stderr)
        payload = load_json(self.out)
        self.assertGreater(payload["timing"]["framesProcessed"], 0, payload["timing"])
        # 1920*0.33 = 633.6 -> 632 ; 1080*0.33 = 356.4 -> 356 (both even for swscale)
        self.assertEqual((int(1920 * 0.33) // 2 * 2, int(1080 * 0.33) // 2 * 2), (632, 356))
        self.assertTrue(all(0 <= c["x"] <= 1 and 0 <= c["y"] <= 1
                            for f in payload["frames"] for c in f["candidates"]))

    def test_inverted_area_bounds_are_rejected_not_silently_empty(self) -> None:
        """FINDING on 4d812e1a: --min-area 500 --max-area 100 is accepted; every
        component is filtered (area < 500 or area > 100 is always true) and the
        tool exits 0 with 0 candidates in every frame while rawComponentCount
        proves motion was found — a silent-empty artifact."""
        r = self._bc("--video", str(WM_VOLLEY_02), "--min-area", "500", "--max-area", "100",
                     "--end-ms", "1500")
        r.record("s4_bc_inverted_area")
        self.assertFalse(r.timed_out)
        if r.returncode == 0:
            payload = load_json(self.out)
            total_candidates = sum(len(f["candidates"]) for f in payload["frames"])
            total_raw = sum(f["rawComponentCount"] for f in payload["frames"])
            r.record("s4_bc_inverted_area", totalCandidates=total_candidates, totalRaw=total_raw,
                     frames=payload["timing"]["framesProcessed"])
            self.fail(
                f"contradictory bounds accepted: exit 0, {payload['timing']['framesProcessed']} frames, "
                f"{total_candidates} candidates from {total_raw} raw components, no warning"
            )
        self.assertEqual(r.returncode, 2, r)

    def test_scale_below_one_pixel_terminates(self) -> None:
        """FINDING on 4d812e1a: --scale 0.001 -> out_w = out_h = 0 -> ffmpeg
        `scale=0:0`; `gray_frames` computes size = 0 so `read(0)` returns b''
        and `len(b'') < 0` is False -> the generator yields empty frames FOREVER.
        The process never exits and never writes --out (harness kills it)."""
        r = self._bc("--video", str(WM_VOLLEY_02), "--scale", "0.001", "--end-ms", "300", timeout=20)
        r.record("s4_bc_scale_0001")
        self.assertFalse(r.timed_out, "ball_candidates hung on --scale 0.001")
        self.assertNotEqual(r.returncode, 0, "sub-pixel scale must be rejected")

    def test_scale_zero_and_negative_are_argparse_errors(self) -> None:
        for value in ("0", "-0.5"):
            with self.subTest(scale=value):
                r = self._bc("--video", str(WM_VOLLEY_02), "--scale", value, "--end-ms", "300", timeout=20)
                r.record(f"s4_bc_scale_{value.replace('-', 'neg')}")
                self.assertFalse(r.timed_out, f"hung on --scale {value}")
                self.assertEqual(r.returncode, 2, r)
                self.assertNotIn("Traceback", r.stderr, r)

    def test_scale_above_one_upscales_and_exits_zero(self) -> None:
        r = self._bc("--video", str(WM_VOLLEY_02), "--scale", "1.5", "--end-ms", "400", timeout=120)
        r.record("s4_bc_scale_15")
        self.assertFalse(r.timed_out)
        self.assertEqual(r.returncode, 0, r)
        self.assertGreater(load_json(self.out)["timing"]["framesProcessed"], 0)

    # ---- S5 -----------------------------------------------------------------

    def test_window_past_clip_end_is_empty_and_exit_zero(self) -> None:
        r = self._bc("--video", str(WM_VOLLEY_02), "--start-ms", "59900", "--end-ms", "70000")
        r.record("s5_bc_past_end")
        self.assertFalse(r.timed_out)
        self.assertEqual(r.returncode, 0, r)
        self.assertNotIn("Traceback", r.stderr)
        payload = load_json(self.out)
        self.assertEqual(payload["frames"], [])
        self.assertEqual(payload["timing"]["framesProcessed"], 0)
        # Noted, not failed: the artifact records the REQUESTED window verbatim
        # (endMs 70000 on an 8000 ms clip) and nothing marks it as out of range.
        self.assertEqual(payload["window"], {"startMs": 59900.0, "endMs": 70000.0})
        self.assertEqual(payload["video"]["durationMs"], WM_DURATION_MS)

    def test_inverted_window_exits_zero_with_empty_frames(self) -> None:
        """start > end: ffmpeg refuses (`-to value smaller than -ss`) but
        `gray_frames` ignores its exit status, so the script exits 0 with an
        empty artifact. Compared below with detect_paddle's behaviour on the
        same window."""
        r = self._bc("--video", str(WM_VOLLEY_02), "--start-ms", "3000", "--end-ms", "1000")
        r.record("s5_bc_inverted_window")
        self.assertFalse(r.timed_out)
        payload = load_json(self.out) if self.out.exists() else None
        r.record("s5_bc_inverted_window", frames=None if payload is None else len(payload["frames"]))
        self.assertNotEqual(r.returncode, 0, f"start>end accepted silently: {r}")

    # ---- per-frame cap ------------------------------------------------------

    def test_max_per_frame_is_an_upper_bound(self) -> None:
        """FINDING on 4d812e1a: `big_pool = candidates[: max_per_frame - 15]`
        becomes a NEGATIVE slice for --max-per-frame < 15 (5 -> candidates[:-10]
        = everything but the 10 weakest), so a frame carries hundreds of
        candidates against a requested cap of 5."""
        for cap in ("5", "15", "16", "40"):
            with self.subTest(cap=cap):
                r = self._bc("--video", str(WM_VOLLEY_02), "--max-per-frame", cap, "--end-ms", "600")
                r.record(f"s4_bc_max_per_frame_{cap}")
                self.assertEqual(r.returncode, 0, r)
                payload = load_json(self.out)
                worst = max(len(f["candidates"]) for f in payload["frames"])
                r.record(f"s4_bc_max_per_frame_{cap}", worstFrameCandidates=worst)
                self.assertLessEqual(worst, int(cap), f"--max-per-frame {cap} but a frame has {worst}")

    def test_max_per_frame_zero_yields_no_candidates(self) -> None:
        r = self._bc("--video", str(WM_VOLLEY_02), "--max-per-frame", "0", "--end-ms", "600")
        r.record("s4_bc_max_per_frame_0")
        self.assertEqual(r.returncode, 0, r)
        payload = load_json(self.out)
        worst = max(len(f["candidates"]) for f in payload["frames"])
        self.assertEqual(worst, 0, f"--max-per-frame 0 but a frame has {worst} candidates")

    # ---- degenerate media ---------------------------------------------------

    def test_zero_byte_and_audio_only_media_fail_cleanly(self) -> None:
        """Same ffprobe_meta shape as detect_paddle: CalledProcessError on a
        0-byte file, IndexError on an audio-only container — both tracebacks."""
        for name, path in (("zero_byte", make_empty_mp4(self.tmp)),
                           ("audio_only", make_audio_only_mp4(self.tmp))):
            with self.subTest(media=name):
                r = self._bc("--video", str(path), timeout=30)
                r.record(f"s3_bc_{name}")
                self.assertFalse(r.timed_out)
                self.assertNotEqual(r.returncode, 0)
                self.assertNotIn("Traceback", r.stderr, r)

    # ---- determinism ----------------------------------------------------------

    def test_two_runs_are_byte_identical_modulo_timing(self) -> None:
        a = self.tmp / "a.json"
        b = self.tmp / "b.json"
        for out in (a, b):
            r = py(BALL_CANDIDATES, "--video", str(WM_VOLLEY_02), "--out", str(out),
                   "--start-ms", "617", "--end-ms", "1500", timeout=120)
            self.assertEqual(r.returncode, 0, r)
        self.assertEqual(_strip_timing(load_json(a)), _strip_timing(load_json(b)))

    # ---- S6: per-frame tMs vs detect_paddle's CFR model and real pts ---------

    @unittest.skipUnless(torch_importable(), "torch required to import detect_paddle")
    def test_tms_agrees_with_detect_paddle_cfr_model_617_1500(self) -> None:
        """FINDING (F1) on 4d812e1a: ball_candidates stamps
        tMs = start_ms + i*frame_ms with start_ms = the REQUESTED 617, but ffmpeg
        `-ss 0.617` emits the first frame with pts >= 617 ms, i.e. frame 16 at
        640 ms. detect_paddle (plan_window_seek + frame_iter) stamps the absolute
        pts 640, 680, ... — every frame disagrees by 23 ms on this clip, and the
        frame the two tools call "the same tMs" is a different picture."""
        sys.path.insert(0, str(PADDLE_LAB))
        import detect_paddle  # noqa: WPS433

        r = self._bc("--video", str(WM_VOLLEY_02), "--start-ms", "617", "--end-ms", "1500")
        self.assertEqual(r.returncode, 0, r)
        bc = load_json(self.out)
        bc_tms = [f["tMs"] for f in bc["frames"]]
        self.assertTrue(bc_tms)

        width, height, fps, duration_ms, start_time_ms = detect_paddle.ffprobe_meta(str(WM_VOLLEY_02))
        first_index, seek_sec = detect_paddle.plan_window_seek(617.0, fps, start_time_ms)
        dp_tms = [t for _, t, _ in detect_paddle.frame_iter(
            str(WM_VOLLEY_02), 617.0, 1500.0, width, height, fps, start_time_ms=start_time_ms)]
        real_pts = ffprobe_video_pts_ms(WM_VOLLEY_02, 0.617, 1.5)

        # ball_candidates drops the first two piped frames (3-frame differencing
        # window), so its frame i corresponds to piped frame i+1 (the middle one).
        pairs = list(zip(bc_tms, dp_tms[1:1 + len(bc_tms)]))
        diffs = [round(b - d, 3) for b, d in pairs]
        table = {
            "clip": str(WM_VOLLEY_02), "fps": fps, "startTimeMs": start_time_ms,
            "requestedStartMs": 617, "planWindowSeek": {"firstIndex": first_index, "seekSec": seek_sec},
            "ballCandidatesFrames": len(bc_tms), "detectPaddleFrames": len(dp_tms),
            "ffprobePtsFrames": len(real_pts),
            "ballCandidatesTMs": bc_tms, "detectPaddleTMs": [round(t, 3) for t in dp_tms],
            "ffprobePtsMs": [round(t, 3) for t in real_pts],
            "perFrameDiffMs_bcMinusDp": diffs,
        }
        (ARTIFACT_DIR / "s6_tms_diff_617_1500.json").write_text(json.dumps(table, indent=2))

        # Ground truth: detect_paddle's model must match the container pts.
        self.assertEqual(len(dp_tms), len(real_pts), table)
        for d, p in zip(dp_tms, real_pts):
            self.assertLess(abs(d - p), 0.5, ("detect_paddle vs container pts", d, p))
        # The attack assertion: both tools must stamp the same frame the same.
        worst = max(abs(x) for x in diffs)
        self.assertLess(worst, 1.0, f"ball_candidates vs detect_paddle tMs differ by up to {worst} ms: {diffs[:5]}...")

    def test_tms_matches_container_pts_when_start_is_frame_aligned(self) -> None:
        """Control: start on a frame boundary (640 ms = frame 16 @ 25 fps). If the
        617 case fails but this passes, the F1 error is exactly the seek-rounding
        offset (requested start minus first emitted pts)."""
        r = self._bc("--video", str(WM_VOLLEY_02), "--start-ms", "640", "--end-ms", "1500")
        self.assertEqual(r.returncode, 0, r)
        bc_tms = [f["tMs"] for f in load_json(self.out)["frames"]]
        real_pts = ffprobe_video_pts_ms(WM_VOLLEY_02, 0.640, 1.5)
        pairs = list(zip(bc_tms, real_pts[1:1 + len(bc_tms)]))
        (ARTIFACT_DIR / "s6_tms_control_640.json").write_text(json.dumps(
            {"pairs": pairs, "maxAbsDiffMs": max(abs(b - p) for b, p in pairs)}, indent=2))
        for b, p in pairs:
            self.assertLess(abs(b - p), 0.5, (b, p))


if __name__ == "__main__":
    unittest.main()
