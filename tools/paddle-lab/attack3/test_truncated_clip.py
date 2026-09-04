"""S7 — corrupt media: bundle clip truncated to 60% of its bytes.

Two layouts matter for MP4:
  (a) as committed: moov atom at the END -> the 60% prefix has no index at
      all; ffprobe fails outright.
  (b) faststart remux (moov first; what a phone/transcoder usually writes):
      the 60% prefix still probes as a full 8.0 s / 200-frame clip but only
      ~4.5 s of samples exist.

The question: does the tooling report "decode failure" distinctly from a
timestamp mismatch / silent partial result?

Run: tools/paddle-lab/.venv/bin/python -m unittest discover -s tools/paddle-lab/attack3 -p 'test_trunc*.py' -v
"""

from __future__ import annotations

import json
import subprocess
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import _scratch  # noqa: E402

HARNESS = _scratch.PADDLE_LAB / "test_timestamp_alignment.py"
DETECT = _scratch.PADDLE_LAB / "detect_paddle.py"
SRC = _scratch.DEV_CLIPS[0]  # wm-volley-02 clip.mp4 (1000x1080, 25 fps, 8.0 s, moov at end)


def truncate(src: Path, dst: Path, fraction: float) -> None:
    data = src.read_bytes()
    dst.write_bytes(data[: int(len(data) * fraction)])


class TruncatedClip(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.root = _scratch.scratch_root("trunc")
        cls.tail_moov_60 = cls.root / "clip60.mp4"
        truncate(SRC, cls.tail_moov_60, 0.6)
        faststart = cls.root / "faststart.mp4"
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(SRC), "-c", "copy",
                        "-movflags", "+faststart", str(faststart)], check=True)
        cls.faststart_60 = cls.root / "faststart60.mp4"
        truncate(faststart, cls.faststart_60, 0.6)

    def _harness(self, clip: Path, tag: str):
        proc = _scratch.run([_scratch.python(), str(HARNESS), str(clip)])
        _scratch.save_artifact(f"s7-harness-{tag}.txt", f"exit={proc.returncode}\n--stdout--\n{proc.stdout}\n--stderr--\n{proc.stderr}")
        return proc

    def test_committed_layout_60pct_fails_at_ffprobe_with_traceback(self):
        """moov missing -> ffprobe_meta raises CalledProcessError. Exit 1 and no
        'FAIL (n)' mismatch line, so decode failure IS distinguishable from a
        mismatch — but via an unhandled traceback, and the run aborts before
        any later clip on the command line is checked."""
        proc = self._harness(self.tail_moov_60, "tail-moov-60pct")
        self.assertEqual(proc.returncode, 1)
        self.assertIn("CalledProcessError", proc.stderr)
        self.assertIn("ffprobe", proc.stderr)
        self.assertNotIn("FAIL (", proc.stdout)
        self.assertNotIn(": OK", proc.stdout)

    def test_committed_layout_aborts_before_second_clip(self):
        proc = _scratch.run([_scratch.python(), str(HARNESS), str(self.tail_moov_60), str(SRC)])
        self.assertEqual(proc.returncode, 1)
        self.assertNotIn(str(SRC), proc.stdout)  # good clip never reported

    def test_faststart_60pct_probes_as_full_length(self):
        out = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
                              "stream=duration,nb_frames", "-of", "json", str(self.faststart_60)],
                             capture_output=True, text=True, check=True).stdout
        stream = json.loads(out)["streams"][0]
        self.assertEqual(stream["duration"], "8.000000")
        self.assertEqual(stream["nb_frames"], "200")

    def test_faststart_60pct_misdiagnosed_as_duplicate_frames(self):
        """BROKEN: the partial-file decode ends in error-concealed duplicate
        frames; the harness trips its 'clip has duplicate frames' assert
        (test_timestamp_alignment.py:69) and never says the file is truncated.
        full_decode_hashes ignores ffmpeg's stderr/exit (:49) and ffmpeg itself
        exits 0 on 'partial file'."""
        proc = self._harness(self.faststart_60, "faststart-60pct")
        self.assertEqual(proc.returncode, 1)
        self.assertIn("AssertionError: clip has duplicate frames; hash matching is ambiguous", proc.stderr)
        self.assertEqual(proc.stdout, "")  # neither OK nor FAIL(n) — the clip is never reported at all

    def test_detect_paddle_returns_zero_frames_exit_zero_inside_probed_duration(self):
        """BROKEN: a window entirely inside the probed 8 s but past the last
        real sample (5300-5500 ms) yields an artifact with 0 frames and exit 0
        — no error, no warning (frame_iter only raises on ffmpeg exit != 0,
        detect_paddle.py:202, and ffmpeg exits 0 here)."""
        out = self.root / "det-5300.json"
        proc = _scratch.run([_scratch.python(), str(DETECT), "--video", str(self.faststart_60), "--out", str(out),
                             "--start-ms", "5300", "--end-ms", "5500"])
        _scratch.save_artifact("s7-detect-5300.stderr.txt", proc.stderr)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        payload = json.loads(out.read_text())
        self.assertEqual(payload["timing"]["framesProcessed"], 0)
        self.assertEqual(payload["frames"], [])

    def test_detect_paddle_silently_truncates_window_spanning_the_cut(self):
        """Window 4000-7000 ms on the same file: 14 frames (4000..4520) come back
        with exit 0; the artifact carries no indication that ~60 frames of the
        requested window were unreadable."""
        out = self.root / "det-4000.json"
        proc = _scratch.run([_scratch.python(), str(DETECT), "--video", str(self.faststart_60), "--out", str(out),
                             "--start-ms", "4000", "--end-ms", "7000"])
        self.assertEqual(proc.returncode, 0, proc.stderr)
        payload = json.loads(out.read_text())
        n = payload["timing"]["framesProcessed"]
        self.assertGreater(n, 0)
        self.assertLess(n, 75)  # 3 s at 25 fps would be 75 frames
        self.assertEqual(payload["frames"][0]["tMs"], 4000.0)
        _scratch.save_artifact("s7-detect-4000-summary.json", json.dumps(
            {"framesProcessed": n, "lastTMs": payload["frames"][-1]["tMs"], "exit": proc.returncode}, indent=1))

    def test_zero_byte_and_garbage_files_fail_at_ffprobe(self):
        empty = self.root / "empty.mp4"
        empty.write_bytes(b"")
        garbage = self.root / "garbage.mp4"
        garbage.write_bytes(bytes(range(256)) * 4096)
        for clip in (empty, garbage):
            proc = _scratch.run([_scratch.python(), str(HARNESS), str(clip)])
            self.assertEqual(proc.returncode, 1, clip)
            self.assertIn("CalledProcessError", proc.stderr, clip)


if __name__ == "__main__":
    unittest.main()
