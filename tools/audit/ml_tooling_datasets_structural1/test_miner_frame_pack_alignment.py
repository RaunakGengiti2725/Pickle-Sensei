"""Audit: wave_g_g03 miner frame packs show a different frame than the candidate tMs.

tools/mining/wave_g_g03_multi_paddle_miner.py::extract_crops renders the review
image for a candidate with `ffmpeg -ss <tMs/1000:.3f> -i clip.mp4 -frames:v 1`.
ffmpeg emits the first frame whose (start_time-relative) pts >= -ss, i.e. a
ceil on the frame grid, and the seek is relative to the container start_time.
Every other tMs->frame mapping in the repo is round(): detect_paddle.run_crops,
student_lib.frame_indices_for, and the pts clock of detect_paddle.frame_iter /
test_timestamp_alignment.py. Human reviewers therefore label the paddle
ownership of a frame that is not the frame the candidate's tMs (and its
detector boxes / ownership points) refer to.

Two checks:
  1. Committed artifact: identify each committed frame-packs/<case>/*.png by
     pixel hash against a full decode of the bundle clip; compare with the
     frame whose pts is nearest the candidate's tMs.
  2. Command semantics, independent of the committed artifact: re-run the
     miner's exact ffmpeg invocation for a handful of tMs values and identify
     the produced frame the same way.

Run: python3 -m unittest tools/audit/ml_tooling_datasets_structural1/test_miner_frame_pack_alignment.py
Requires: numpy, pillow, ffmpeg/ffprobe.
"""

from __future__ import annotations

import hashlib
import json
import subprocess
import tempfile
import unittest
from collections import Counter
from pathlib import Path

import numpy as np
from PIL import Image

from _support import BUNDLES, REPO_ROOT, ffprobe_frame_pts_ms

MINING = REPO_ROOT / "datasets" / "mining" / "wave-g-g03"
CANDIDATES = MINING / "candidates.json"
CASES = ("wm-volley-02", "afn-sasebo-rally1")


def png_frame_hashes(video: Path, tmp: Path) -> dict[str, int]:
    """Decode every frame to PNG through the same swscale->png path the miner uses."""
    subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-i", str(video), "-vsync", "0", str(tmp / "f%05d.png")],
        check=True,
    )
    out = {}
    for i, p in enumerate(sorted(tmp.glob("f*.png"))):
        out[hashlib.sha256(np.asarray(Image.open(p).convert("RGB")).tobytes()).hexdigest()] = i
    return out


def hash_png(path: Path) -> str:
    return hashlib.sha256(np.asarray(Image.open(path).convert("RGB")).tobytes()).hexdigest()


def nearest_pts_index(pts_ms: list[float], t_ms: float) -> int:
    return min(range(len(pts_ms)), key=lambda k: abs(pts_ms[k] - t_ms))


class MinerFramePackAlignment(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmpdir = tempfile.TemporaryDirectory()
        cls.index_of = {}
        cls.pts = {}
        for case in CASES:
            d = Path(cls.tmpdir.name) / case
            d.mkdir()
            clip = BUNDLES / case / "clip.mp4"
            cls.index_of[case] = png_frame_hashes(clip, d)
            cls.pts[case] = ffprobe_frame_pts_ms(clip)
        cls.candidates = json.loads(CANDIDATES.read_text())["candidates"]

    @classmethod
    def tearDownClass(cls):
        cls.tmpdir.cleanup()

    def committed_offsets(self, case: str) -> list[tuple[str, float, int, int]]:
        rows = []
        for cand in self.candidates:
            if cand["caseId"] != case:
                continue
            png = MINING / "frame-packs" / case / f"{cand['candidateId']}.png"
            if not png.exists():
                continue
            shown = self.index_of[case].get(hash_png(png))
            self.assertIsNotNone(shown, f"{png} does not match any frame of {case}/clip.mp4")
            rows.append((cand["candidateId"], cand["tMs"], shown, nearest_pts_index(self.pts[case], cand["tMs"])))
        self.assertTrue(rows, f"no committed frame packs for {case}")
        return rows

    def assert_committed_packs_show_tms_frame(self, case: str):
        rows = self.committed_offsets(case)
        wrong = [(cid, t, shown, want) for cid, t, shown, want in rows if shown != want]
        offsets = Counter(shown - want for _, _, shown, want in rows)
        self.assertEqual(
            wrong, [],
            f"{case}: {len(wrong)}/{len(rows)} committed frame packs show a different frame than "
            f"the one at the candidate tMs; frame offsets (shown - expected) = {dict(offsets)}; "
            f"first: {wrong[:3]}",
        )

    def test_committed_frame_packs_wm_volley_02(self):
        self.assert_committed_packs_show_tms_frame("wm-volley-02")

    def test_committed_frame_packs_afn_sasebo_rally1(self):
        self.assert_committed_packs_show_tms_frame("afn-sasebo-rally1")

    def test_miner_ffmpeg_seek_selects_frame_at_tms(self):
        """Re-run the miner's exact ffmpeg command for a few candidate tMs values."""
        mismatches = []
        for case in CASES:
            clip = BUNDLES / case / "clip.mp4"
            sample = [c for c in self.candidates if c["caseId"] == case][:6]
            for cand in sample:
                out_png = Path(self.tmpdir.name) / f"probe-{cand['candidateId']}.png"
                cmd = [
                    "ffmpeg", "-y", "-loglevel", "error",
                    "-ss", f"{cand['tMs'] / 1000.0:.3f}",
                    "-i", str(clip),
                    "-frames:v", "1",
                    str(out_png),
                ]
                subprocess.run(cmd, check=True, capture_output=True)
                shown = self.index_of[case].get(hash_png(out_png))
                want = nearest_pts_index(self.pts[case], cand["tMs"])
                if shown != want:
                    mismatches.append((case, cand["tMs"], shown, want))
        self.assertEqual(mismatches, [], f"miner -ss seek picks a different frame than tMs designates: {mismatches}")


if __name__ == "__main__":
    unittest.main()
