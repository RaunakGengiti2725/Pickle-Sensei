"""Adversarial regression tests for the MLT-1/2/3 frame-clock fix (round 2).

Each test pins a concrete failure reproduced against the fix merged onto the
integration head:

* MLT-1 neighbourhood: the committed paddle-distill-v0.1 release labels
  afn-sasebo-rally1 at tMs=0.0 while the stream starts at 33.367 ms. The new
  strict pre-stream rejection in student_lib.extract_frames makes
  train_student.py / student_bench.py abort on the shipped dataset (the
  integration head trained and benchmarked it).
* MLT-2 variant: media truncated by exactly ONE frame still probes as complete
  (duration/nb_frames unchanged) and the one-frame tolerance lets the whole-
  clip decode (no -to, so no boundary drop is possible) finish silently with a
  short artifact.
* MLT-3 variant: `nan` / `inf` window and scale values pass the new argparse
  validators; `--end-ms nan` exits 0 and writes `"endMs": NaN`, which is not
  JSON (the TypeScript consumers' JSON.parse rejects it).

Run from the repo root:
  .venv/bin/python -m unittest tools/paddle-lab/test_attack_fix2_mlt.py
"""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import frame_clock  # noqa: E402
import student_lib  # noqa: E402
from detect_paddle import frame_iter  # noqa: E402

REPO_ROOT = HERE.parents[1]
BUNDLES = REPO_ROOT / "datasets/paddle-bench/bundles"
AFN_CLIP = BUNDLES / "afn-sasebo-rally1/clip.mp4"  # start_time 33.367 ms, 29.97 fps
WM_CLIP = BUNDLES / "wm-volley-02/clip.mp4"  # start_time 0, 25 fps, 8.0 s
RELEASE = REPO_ROOT / "datasets/releases/paddle-distill-v0.1"
PYTHON = sys.executable


def run_ball_candidates(*extra: str, video: Path = WM_CLIP, out: Path) -> subprocess.CompletedProcess:
    return subprocess.run(
        [PYTHON, str(HERE / "ball_candidates.py"), "--video", str(video), "--out", str(out), *extra],
        capture_output=True, text=True, timeout=180,
    )


def make_one_frame_truncated(src: Path, tmp: Path) -> Path:
    """Faststart, B-frame-free re-encode of `src` with exactly the last video packet cut off."""
    full = tmp / "nobf.mp4"
    subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-i", str(src), "-an", "-c:v", "libx264", "-preset", "veryfast",
         "-bf", "0", "-g", "25", "-movflags", "+faststart", str(full)],
        check=True,
    )
    probe = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "packet=pos", "-of", "csv=p=0", str(full)],
        capture_output=True, text=True, check=True,
    )
    last_pos = max(int(line) for line in probe.stdout.split() if line)
    trunc = tmp / "one_frame_short.mp4"
    trunc.write_bytes(full.read_bytes()[:last_pos])
    return trunc


class CommittedDatasetStillTrains(unittest.TestCase):
    """MLT-1 neighbourhood: extract_frames must accept the shipped release labels."""

    def test_extract_frames_accepts_committed_afn_release_timestamps(self) -> None:
        examples = student_lib.load_examples(RELEASE)
        afn = [
            e for e in examples
            if e["trainingEligible"] and e["media"]["pixelsCommitted"] and e["teacher"] is not None
            and (e["media"].get("bundleClip") or "").endswith("afn-sasebo-rally1/clip.mp4")
        ]
        self.assertTrue(afn, "release dataset lost its afn-sasebo-rally1 examples")
        t_ms = sorted({e["tMs"] for e in afn})
        self.assertIn(0.0, t_ms, "fixture drift: committed labels no longer include tMs=0.0")
        frames = student_lib.extract_frames(AFN_CLIP, t_ms)
        self.assertEqual(set(frames), set(t_ms))


class OneFrameTruncationIsDetected(unittest.TestCase):
    """MLT-2 variant: a clip missing its last frame must not decode 'successfully'."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.tmp = tempfile.TemporaryDirectory()
        cls.trunc = make_one_frame_truncated(WM_CLIP, Path(cls.tmp.name))
        cls.meta = frame_clock.probe_stream(str(cls.trunc))
        cls.expected = frame_clock.clip_frame_count(cls.meta.fps, cls.meta.duration_ms)

    @classmethod
    def tearDownClass(cls) -> None:
        cls.tmp.cleanup()

    def test_frame_iter_raises_when_one_frame_is_missing(self) -> None:
        m = self.meta
        self.assertEqual(self.expected, 200, "fixture drift: probe should still report the full clip")
        with self.assertRaises(RuntimeError):
            for _ in frame_iter(str(self.trunc), 0, 0, m.width, m.height, m.fps,
                                start_time_ms=m.start_time_ms, duration_ms=m.duration_ms):
                pass

    def test_ball_candidates_fails_on_one_frame_short_media(self) -> None:
        out = Path(self.tmp.name) / "cand.json"
        proc = run_ball_candidates(video=self.trunc, out=out)
        self.assertNotEqual(proc.returncode, 0, f"exit 0 on truncated media; stderr={proc.stderr[-300:]}")
        self.assertFalse(out.exists(), "partial artifact written for truncated media")


class NonFiniteArgumentsAreRejected(unittest.TestCase):
    """MLT-3 variant: nan/inf must be refused by argparse (exit 2, no artifact)."""

    def test_nan_end_ms_is_rejected_before_ffmpeg(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "nan.json"
            proc = run_ball_candidates("--end-ms", "nan", out=out)
            self.assertEqual(proc.returncode, 2, f"stdout={proc.stdout[-200:]} stderr={proc.stderr[-200:]}")
            self.assertFalse(out.exists(), "artifact written for --end-ms nan")

    def test_written_artifact_is_strict_json(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "nan.json"
            proc = run_ball_candidates("--start-ms", "7000", "--end-ms", "nan", out=out)
            if proc.returncode != 0:
                return  # rejected up front: nothing to inspect
            text = out.read_text()
            self.assertNotIn("NaN", text, "artifact contains a non-JSON NaN literal")
            json.loads(text, parse_constant=lambda tok: self.fail(f"non-JSON constant {tok} in artifact"))

    def test_inf_values_exit_2_not_traceback(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            for flag, value in (("--scale", "inf"), ("--scale", "1e400"), ("--end-ms", "inf")):
                out = Path(tmp) / "inf.json"
                proc = run_ball_candidates(flag, value, out=out)
                self.assertEqual(proc.returncode, 2, f"{flag} {value}: rc={proc.returncode} stderr={proc.stderr[-200:]}")
                self.assertNotIn("Traceback", proc.stderr, f"{flag} {value} crashed with a traceback")
                self.assertFalse(out.exists())


if __name__ == "__main__":
    unittest.main()
