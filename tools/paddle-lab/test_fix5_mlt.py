"""Round-5 pins for the MLT-1/2/3 frame-clock fixes (additive; nothing here
replaces an existing test).

* MLT-2: whole-clip expected count = min(nb_frames, floor(duration * fps)); a
  stream-copied crop is complete; a Matroska remux uses the FORMAT duration;
  a container with no duration at all decodes open-ended with one warning and
  still refuses an empty decode.
* MLT-1: the legacy relative clock is decided per CLIP and applied to every
  label of that clip (0.0 -> frame 0, 33.37 -> frame 1); a lone tolerated
  pre-start label still maps to frame 0; earlier labels still raise.
* MLT-3: window_frame_range raises ValueError (never OverflowError) and the
  argparse validators bound --start-ms/--end-ms/--scale before ffmpeg spawns.

Run from tools/paddle-lab:  python3 -m pytest -q test_fix5_mlt.py
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import tempfile
import unittest
import warnings
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import frame_clock  # noqa: E402
import student_lib  # noqa: E402

REPO_ROOT = HERE.parents[1]
BUNDLES = REPO_ROOT / "datasets/paddle-bench/bundles"
AFN_CLIP = BUNDLES / "afn-sasebo-rally1/clip.mp4"  # start_time 33.367 ms, 29.97 fps, 132 frames
WM_CLIP = BUNDLES / "wm-volley-02/clip.mp4"  # start_time 0, 25 fps, 8.0 s, 200 frames
RELEASE_EXAMPLES = REPO_ROOT / "datasets/releases/paddle-distill-v0.1/examples.jsonl"
PYTHON = sys.executable


def run_ball_candidates(*extra: str, video: Path, out: Path) -> subprocess.CompletedProcess:
    return subprocess.run(
        [PYTHON, str(HERE / "ball_candidates.py"), "--video", str(video), "--out", str(out), "--scale", "0.25", *extra],
        capture_output=True, text=True, timeout=300,
    )


def ffmpeg(*args: str) -> None:
    subprocess.run(["ffmpeg", "-v", "error", "-y", *args], check=True)


class ExpectedFrameCount(unittest.TestCase):
    def test_clip_frame_count_is_min_of_nb_frames_and_floored_duration(self) -> None:
        self.assertEqual(frame_clock.clip_frame_count(25.0, 8000.0, 200), 200)  # clean CFR mp4
        self.assertEqual(frame_clock.clip_frame_count(25.0, 8000.0), 200)  # mkv: duration only
        self.assertEqual(frame_clock.clip_frame_count(25.0, 3100.0, 110), 77)  # -c copy cut: 77.5 periods, pre-roll stored
        self.assertEqual(frame_clock.clip_frame_count(25.0, 3100.0), 77)
        self.assertEqual(frame_clock.clip_frame_count(30000 / 1001, 4404.4, 132), 132)  # 131.99999 -> 132
        self.assertEqual(frame_clock.clip_frame_count(25.0, 0.0, 150), 150)  # nb_frames only
        self.assertEqual(frame_clock.clip_frame_count(25.0, 0.0), 0)  # nothing known

    def test_exact_shortfall_rule_is_unchanged(self) -> None:
        self.assertEqual(frame_clock.min_decoded_frames(200), 200)
        self.assertEqual(frame_clock.min_decoded_frames(200, bounded_end=True), 199)
        self.assertEqual(frame_clock.window_frame_range(0.0, 0.0, 25.0, 0.0, 8000.0, 200), (0, 200))
        self.assertEqual(frame_clock.window_frame_range(0.0, 0.0, 25.0, 0.0, 3100.0, 110), (0, 77))
        self.assertEqual(frame_clock.window_frame_range(0.0, 0.0, 25.0, 0.0, 0.0), (0, None))  # unknown: open-ended
        self.assertEqual(frame_clock.window_frame_range(1000.0, 2000.0, 25.0, 0.0, 0.0), (25, 50))


class StreamCopyCropIsComplete(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.tmp = tempfile.TemporaryDirectory()
        cls.crop = Path(cls.tmp.name) / "crop.mp4"
        ffmpeg("-ss", "1.3", "-to", "4.3", "-i", str(WM_CLIP), "-c", "copy", str(cls.crop))
        cls.meta = frame_clock.probe_stream(str(cls.crop))

    @classmethod
    def tearDownClass(cls) -> None:
        cls.tmp.cleanup()

    def test_probe_reports_frame_metadata(self) -> None:
        self.assertEqual(self.meta.nb_frames, 110)
        self.assertEqual(self.meta.duration_source, "stream")
        self.assertEqual(frame_clock.clip_frame_count(self.meta.fps, self.meta.duration_ms, self.meta.nb_frames), 77)

    def test_ball_candidates_processes_the_crop(self) -> None:
        out = Path(self.tmp.name) / "crop.json"
        result = run_ball_candidates(video=self.crop, out=out)
        self.assertEqual(result.returncode, 0, result.stderr)
        payload = json.loads(out.read_text())
        self.assertEqual(payload["timing"]["framesProcessed"], 75)  # 77 decoded, 3-frame differencing


class MatroskaUsesFormatDuration(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.tmp = tempfile.TemporaryDirectory()
        cls.mkv = Path(cls.tmp.name) / "x.mkv"
        ffmpeg("-i", str(WM_CLIP), "-c", "copy", str(cls.mkv))
        cls.raw = Path(cls.tmp.name) / "x.h264"
        ffmpeg("-i", str(WM_CLIP), "-c", "copy", "-bsf:v", "h264_mp4toannexb", "-f", "h264", str(cls.raw))

    @classmethod
    def tearDownClass(cls) -> None:
        cls.tmp.cleanup()

    def test_parse_seconds_accepts_numbers_and_matroska_tags(self) -> None:
        self.assertEqual(frame_clock._parse_seconds("8.000000"), 8.0)
        self.assertEqual(frame_clock._parse_seconds("00:00:08.000000000"), 8.0)
        self.assertEqual(frame_clock._parse_seconds("01:02:03.5"), 3723.5)
        for bad in ("N/A", "", None, "nan", "inf", "-1", "1:2:3:4"):
            self.assertIsNone(frame_clock._parse_seconds(bad), bad)

    def test_probe_falls_back_to_format_duration(self) -> None:
        meta = frame_clock.probe_stream(str(self.mkv))
        self.assertAlmostEqual(meta.duration_ms, 8000.0, delta=50.0)
        self.assertIn(meta.duration_source, ("stream_tag", "format"))
        self.assertEqual(frame_clock.window_frame_range(0.0, 0.0, meta.fps, meta.start_time_ms, meta.duration_ms, meta.nb_frames), (0, 200))

    def test_ball_candidates_processes_the_mkv(self) -> None:
        out = Path(self.tmp.name) / "mkv.json"
        result = run_ball_candidates(video=self.mkv, out=out)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(out.read_text())["timing"]["framesProcessed"], 198)
        self.assertNotIn("cannot be detected", result.stderr)

    def test_unknown_duration_decodes_open_ended_with_one_warning(self) -> None:
        meta = frame_clock.probe_stream(str(self.raw))
        self.assertEqual(meta.duration_ms, 0.0)
        self.assertIsNone(meta.duration_source)
        out = Path(self.tmp.name) / "raw.json"
        result = run_ball_candidates(video=self.raw, out=out)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(out.read_text())["timing"]["framesProcessed"], 198)
        self.assertEqual(result.stderr.count("truncated file cannot be detected"), 1, result.stderr)

    def test_unknown_duration_still_refuses_an_empty_decode(self) -> None:
        out = Path(self.tmp.name) / "raw-late.json"
        result = run_ball_candidates("--start-ms", "20000", video=self.raw, out=out)
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertFalse(out.exists(), "an empty artifact was written")
        self.assertNotIn("Traceback", result.stderr)


class LegacyClockIsDecidedPerClip(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.meta = frame_clock.probe_stream(str(AFN_CLIP))
        rows = [json.loads(line) for line in RELEASE_EXAMPLES.read_text().splitlines() if line.strip()]
        cls.afn_t_ms = sorted({
            float(row["tMs"]) for row in rows
            if row["media"].get("bundleClip") == "datasets/paddle-bench/bundles/afn-sasebo-rally1/clip.mp4"
        })

    def test_release_afn_labels_map_to_distinct_consecutive_frames(self) -> None:
        index_for_t, legacy = frame_clock.frame_indices_for_labelled_clip(self.afn_t_ms, self.meta.fps, self.meta.start_time_ms)
        self.assertEqual(legacy, [0.0])
        self.assertEqual(len(set(index_for_t.values())), len(self.afn_t_ms))
        self.assertEqual([index_for_t[t] for t in self.afn_t_ms[:3]], [0, 1, 2])
        self.assertLess(max(index_for_t.values()), self.meta.nb_frames)

    def test_absolute_clip_is_untouched_and_lone_pre_start_label_maps_to_zero(self) -> None:
        fps, start = self.meta.fps, self.meta.start_time_ms
        period = 1000.0 / fps
        absolute = [start, start + 7 * period]
        index_for_t, legacy = frame_clock.frame_indices_for_labelled_clip(absolute, fps, start)
        self.assertEqual((legacy, [index_for_t[t] for t in absolute]), ([], [0, 7]))
        index_for_t, legacy = frame_clock.frame_indices_for_labelled_clip([start - period], fps, start)
        self.assertEqual((legacy, list(index_for_t.values())), ([start - period], [0]))
        with self.assertRaises(ValueError):
            frame_clock.frame_indices_for_labelled_clip([start - 1.01 * period, start], fps, start)
        with self.assertRaises(ValueError):
            frame_clock.frame_indices_for_labelled_clip([float("nan")], fps, start)

    def test_extract_frames_warns_once_per_clip(self) -> None:
        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter("always")
            frames = student_lib.extract_frames(AFN_CLIP, self.afn_t_ms[:4])
        legacy = [w for w in caught if issubclass(w.category, frame_clock.LegacyClockWarning)]
        self.assertEqual(len(legacy), 1, [str(w.message) for w in caught])
        self.assertIn("1 label timestamp(s)", str(legacy[0].message))
        digests = {frames[t].tobytes() for t in self.afn_t_ms[:4]}
        self.assertEqual(len(digests), 4)


class WindowBoundsAreTypedErrors(unittest.TestCase):
    def test_window_frame_range_never_overflows(self) -> None:
        for start_ms, end_ms in ((0.0, 1e308), (1e308, 0.0), (0.0, float("inf")), (float("nan"), 0.0), (-1.0, 0.0), (5000.0, 4000.0)):
            with self.subTest(start_ms=start_ms, end_ms=end_ms), self.assertRaises(ValueError):
                frame_clock.window_frame_range(start_ms, end_ms, 25.0, 0.0, 8000.0, 200)
        with self.assertRaises(ValueError):
            frame_clock.window_frame_range(0.0, 0.0, 25.0, 0.0, float("inf"))
        with self.assertRaises(ValueError):
            frame_clock.window_frame_range(0.0, 0.0, float("nan"), 0.0, 8000.0)
        self.assertEqual(frame_clock.window_frame_range(0.0, frame_clock.MAX_TIME_MS, 25.0, 0.0, 8000.0, 200), (0, 200))

    def test_argparse_validators_bound_time_and_scale(self) -> None:
        self.assertEqual(frame_clock.time_ms("1500"), 1500.0)
        self.assertEqual(frame_clock.time_ms(str(frame_clock.MAX_TIME_MS)), frame_clock.MAX_TIME_MS)
        for bad in ("1e308", "1e400", "inf", "nan", "-1", "1e13", "abc"):
            with self.subTest(bad=bad), self.assertRaises((argparse.ArgumentTypeError, ValueError)):
                frame_clock.time_ms(bad)
        self.assertEqual(frame_clock.scale_factor("0.5"), 0.5)
        for bad in ("0", "-0.5", "1e6", "inf", "nan", str(frame_clock.MAX_SCALE * 2)):
            with self.subTest(bad=bad), self.assertRaises(argparse.ArgumentTypeError):
                frame_clock.scale_factor(bad)

    def test_cli_rejects_huge_values_before_ffmpeg(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "o.json"
            for extra in (("--end-ms", "1e308"), ("--scale", "1e6"), ("--start-ms", "5000", "--end-ms", "4000")):
                with self.subTest(extra=extra):
                    result = run_ball_candidates(*extra, video=WM_CLIP, out=out)
                    self.assertEqual(result.returncode, 2, result.stderr)
                    self.assertFalse(out.exists())
                    self.assertNotIn("Traceback", result.stderr)
                    self.assertNotIn("ffmpeg", result.stderr)


if __name__ == "__main__":
    unittest.main()
