"""Adversarial regression tests for the MLT-1/2/3 frame-clock fix (round 4).

Each test pins a concrete failure reproduced against
origin/devin/fix3-mlt-legacy-clock-truncation (2d3f5bd7) merged onto 1fb0efd7.
The round-2 attacks (test_attack_fix2_mlt.py) are green there; these go further.

* MLT-2 false positive (P1): `min_decoded_frames` demands the exact
  duration-derived count for a whole-clip decode, but a stream-copied time crop
  (`ffmpeg -ss 1.3 -to 4.3 -i clip.mp4 -c copy`) legitimately carries a
  container duration that is not a whole number of frame periods (3.100 s at
  25 fps -> 77.5 -> round() = 78) while ffmpeg cleanly yields 77 frames with
  exit 0 and an empty stderr. ball_candidates (and detect_paddle.frame_iter,
  same rule) now refuse the complete clip as "truncated or partial media";
  the base commit processes it.
* MLT-2 false positive (P1): Matroska/WebM containers report the stream
  duration as N/A (only the format duration is known). `probe_stream` turns
  that into duration_ms=0 and `window_frame_range` raises "open-ended window on
  a stream with unknown duration" for a plain whole-clip run; the base commit
  processes the same file. The corpus sources are .webm.
* MLT-1 label collision: the legacy tolerance is applied per LABEL, not per
  clip. paddle-distill-v0.1 labels afn-sasebo-rally1 at tMs 0.0 (legacy frame
  0) AND 33.37 (legacy frame 1); the candidate maps both to absolute frame 0,
  so `extract_frames` hands two distinct labels the same pixels — 124 release
  labels collapse to 123 frames (a duplicated training sample whose box was
  drawn on the other frame). The base commit returned distinct frames. The
  fix decides the clock per CLIP (`frame_clock.frame_indices_for_labelled_clip`,
  the path `student_lib.extract_frames` runs for every release clip), so the
  test pins that API on the real release labels; the per-label primitive
  `frame_index_for_labelled_t_ms` keeps its tolerance contract in
  test_student_lib.FrameClockHelpers.
* MLT-3: `--end-ms 1e308` is finite, so the validators pass it, and
  `window_frame_range` dies with an uncaught OverflowError traceback
  (math.ceil(inf)) instead of the contract's clean argparse exit 2.

Run from the repo root:
  .venv/bin/python -m unittest tools/paddle-lab/test_attack_fix4_mlt.py
"""

from __future__ import annotations

import hashlib
import json
import subprocess
import sys
import tempfile
import unittest
import warnings
from pathlib import Path

import numpy as np

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


def ffprobe_stream(video: Path, entries: str) -> dict:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", f"stream={entries}", "-of", "json", str(video)],
        capture_output=True, text=True, check=True,
    )
    return json.loads(out.stdout)["streams"][0]


def piped_gray_frame_count(video: Path, width: int, height: int) -> tuple[int, int, str]:
    """(frames, exit status, stderr) of the exact rawvideo pipe ball_candidates.gray_frames runs."""
    proc = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", str(video), "-vf", f"scale={width}:{height}", "-f", "rawvideo", "-pix_fmt", "gray", "-"],
        capture_output=True,
    )
    return len(proc.stdout) // (width * height), proc.returncode, proc.stderr.decode("utf-8", "replace").strip()


def stream_copy_crop(src: Path, dst: Path, start_sec: float, end_sec: float) -> Path:
    """The everyday clip-making command: input-side -ss/-to with -c copy."""
    ffmpeg("-ss", f"{start_sec}", "-to", f"{end_sec}", "-i", str(src), "-c", "copy", str(dst))
    return dst


class StreamCopiedCropIsNotTruncatedMedia(unittest.TestCase):
    """MLT-2: a complete stream-copied crop must not be rejected as truncated."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.tmp = tempfile.TemporaryDirectory()
        cls.crop = stream_copy_crop(WM_CLIP, Path(cls.tmp.name) / "wm-volley-02-1.3-4.3.mp4", 1.3, 4.3)
        cls.meta = frame_clock.probe_stream(str(cls.crop))

    @classmethod
    def tearDownClass(cls) -> None:
        cls.tmp.cleanup()

    def test_fixture_is_a_clean_complete_decode(self) -> None:
        """Precondition: ffmpeg decodes the crop with exit 0, no stderr, and the
        container duration is not a whole number of frame periods."""
        width, height = self.meta.width // 4 // 2 * 2, self.meta.height // 4 // 2 * 2
        frames, status, stderr = piped_gray_frame_count(self.crop, width, height)
        self.assertEqual(status, 0, stderr)
        self.assertEqual(stderr, "")
        self.assertIsNone(frame_clock.corruption_marker(stderr))
        implied = self.meta.duration_ms * self.meta.fps / 1000.0
        self.assertNotAlmostEqual(implied, round(implied), places=3, msg=f"duration implies {implied} frames")
        self.assertEqual(frames, int(implied), f"decoded {frames} frames, duration implies {implied}")

    def test_whole_clip_rule_accepts_the_decoded_frame_count(self) -> None:
        width, height = self.meta.width // 4 // 2 * 2, self.meta.height // 4 // 2 * 2
        frames, _, _ = piped_gray_frame_count(self.crop, width, height)
        first, last_exclusive = frame_clock.window_frame_range(0, 0, self.meta.fps, self.meta.start_time_ms, self.meta.duration_ms)
        required = frame_clock.min_decoded_frames(last_exclusive - first)
        self.assertLessEqual(
            required, frames,
            f"whole-clip rule demands {required} frames but a clean decode of the complete crop yields {frames}",
        )

    def test_ball_candidates_processes_the_complete_crop(self) -> None:
        out = Path(self.tmp.name) / "crop.json"
        result = run_ball_candidates(video=self.crop, out=out)
        self.assertEqual(result.returncode, 0, f"stdout={result.stdout!r}\nstderr={result.stderr!r}")
        self.assertNotIn("truncated or partial media", result.stderr)
        payload = json.loads(out.read_text())
        # 77 decoded frames, 3-frame differencing -> 75 processed.
        self.assertEqual(payload["timing"]["framesProcessed"], 75)


class MatroskaWholeClipDecode(unittest.TestCase):
    """MLT-2: a container without a per-stream duration (MKV/WebM) must still
    allow a whole-clip run; the format duration is known."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.tmp = tempfile.TemporaryDirectory()
        cls.mkv = Path(cls.tmp.name) / "wm-volley-02.mkv"
        ffmpeg("-i", str(WM_CLIP), "-c", "copy", str(cls.mkv))

    @classmethod
    def tearDownClass(cls) -> None:
        cls.tmp.cleanup()

    def test_fixture_has_format_duration_but_no_stream_duration(self) -> None:
        stream = ffprobe_stream(self.mkv, "duration,nb_frames")
        self.assertNotIn("duration", stream, stream)
        fmt = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "json", str(self.mkv)],
            capture_output=True, text=True, check=True,
        )
        self.assertAlmostEqual(float(json.loads(fmt.stdout)["format"]["duration"]), 8.0, places=1)

    def test_probe_stream_knows_the_clip_duration(self) -> None:
        meta = frame_clock.probe_stream(str(self.mkv))
        self.assertAlmostEqual(meta.duration_ms, 8000.0, delta=50.0, msg=f"probe_stream returned {meta}")

    def test_ball_candidates_processes_the_whole_mkv(self) -> None:
        out = Path(self.tmp.name) / "mkv.json"
        result = run_ball_candidates(video=self.mkv, out=out)
        self.assertEqual(result.returncode, 0, f"stdout={result.stdout!r}\nstderr={result.stderr!r}")
        self.assertNotIn("unknown duration", result.stderr)
        payload = json.loads(out.read_text())
        self.assertEqual(payload["timing"]["framesProcessed"], 198)


class LegacyLabelsMustNotCollide(unittest.TestCase):
    """MLT-1: two distinct labels of one clip must never resolve to one frame."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.meta = frame_clock.probe_stream(str(AFN_CLIP))
        rows = [json.loads(line) for line in RELEASE_EXAMPLES.read_text().splitlines() if line.strip()]
        cls.afn_t_ms = sorted({
            float(row["tMs"]) for row in rows
            if row["media"].get("bundleClip") == "datasets/paddle-bench/bundles/afn-sasebo-rally1/clip.mp4"
        })

    def test_release_has_the_two_leading_legacy_labels(self) -> None:
        """Precondition: the shipped release labels legacy frames 0 and 1 of afn-sasebo-rally1."""
        self.assertEqual(self.afn_t_ms[:2], [0.0, 33.37])
        self.assertEqual(len(self.afn_t_ms), 124)

    def test_release_labels_map_to_distinct_frames(self) -> None:
        fps, start = self.meta.fps, self.meta.start_time_ms
        index_for_t, pre_start = frame_clock.frame_indices_for_labelled_clip(self.afn_t_ms, fps, start)
        indices = [index_for_t[t] for t in self.afn_t_ms]
        collisions = {i: [t for t, k in zip(self.afn_t_ms, indices) if k == i] for i in set(indices) if indices.count(i) > 1}
        self.assertEqual(collisions, {}, f"{len(self.afn_t_ms)} labels -> {len(set(indices))} frames; collisions: {collisions}")
        self.assertEqual(len(set(indices)), len(self.afn_t_ms))
        self.assertEqual(len(self.afn_t_ms), 124)
        self.assertEqual((index_for_t[0.0], index_for_t[33.37]), (0, 1))
        # tMs=0.0 (one period before start_time 33.367 ms) is what flags the clip as legacy-relative.
        self.assertEqual(pre_start, [0.0])
        self.assertEqual(indices, sorted(indices))
        self.assertEqual(indices, [round(t * fps / 1000.0) for t in self.afn_t_ms])

    def test_extract_frames_maps_the_release_clip_to_distinct_pixels_with_one_warning(self) -> None:
        """The loader path real releases use: 124 labels -> 124 distinct decoded
        frames, 0.0 -> frame 0 and 33.37 -> frame 1, exactly one legacy warning."""
        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter("always")
            frames = student_lib.extract_frames(AFN_CLIP, self.afn_t_ms)
        legacy = [w for w in caught if issubclass(w.category, frame_clock.LegacyClockWarning)]
        self.assertEqual(len(legacy), 1, [str(w.message) for w in caught])
        self.assertIn("124 label(s)", str(legacy[0].message))
        self.assertEqual(sorted(frames), self.afn_t_ms)
        digests = [hashlib.sha256(np.ascontiguousarray(frames[t]).tobytes()).hexdigest() for t in self.afn_t_ms]
        self.assertEqual(len(set(digests)), 124, "two release labels received the same pixels")
        width, height = self.meta.width, self.meta.height
        proc = subprocess.run(
            ["ffmpeg", "-v", "error", "-i", str(AFN_CLIP), "-frames:v", "2", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
            capture_output=True, check=True,
        )
        frame_bytes = width * height * 3
        first_two = [hashlib.sha256(proc.stdout[i * frame_bytes : (i + 1) * frame_bytes]).hexdigest() for i in range(2)]
        self.assertEqual(digests[:2], first_two, "tMs 0.0 / 33.37 must be decoded frames 0 / 1")

    def test_extract_frames_returns_distinct_pixels_for_distinct_labels(self) -> None:
        frames = student_lib.extract_frames(AFN_CLIP, [0.0, 33.37])
        self.assertFalse(
            np.array_equal(frames[0.0], frames[33.37]),
            "extract_frames returned the same frame for release labels tMs=0.0 and tMs=33.37",
        )


class HugeFiniteEndMsFailsCleanly(unittest.TestCase):
    """MLT-3: a finite but astronomically large --end-ms must fail the way the
    other bad windows do (usage exit 2, or the `ball_candidates: invalid
    window` exit 1), not die with an OverflowError traceback."""

    def test_end_ms_1e308_is_a_usage_error(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "o.json"
            result = run_ball_candidates("--end-ms", "1e308", video=WM_CLIP, out=out)
            self.assertFalse(out.exists(), "an artifact was written")
            self.assertNotIn("Traceback", result.stderr, result.stderr)
            self.assertNotIn("OverflowError", result.stderr, result.stderr)
            self.assertIn(result.returncode, (1, 2), result.stderr)
            self.assertRegex(result.stderr, r"ball_candidates(\.py)?: ")

    def test_window_frame_range_rejects_overflowing_end(self) -> None:
        with self.assertRaises(ValueError):
            frame_clock.window_frame_range(0.0, 1e308, 25.0, 0.0, 8000.0)


if __name__ == "__main__":
    unittest.main()
