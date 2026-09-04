"""S1 — detect_paddle.py --roi edge cases: clamp vs crash.

Needs tools/paddle-lab/.venv (torch/transformers/torchvision) and the D-FINE
weights in the HF cache (first run downloads them). Each CLI case decodes a
100 ms window of the committed wm-volley-02 dev clip (2 frames).

Run: python3 -m unittest discover -s tools/paddle-lab/attack3 -p 'test_roi*.py' -v
"""

from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import _scratch  # noqa: E402
import detect_paddle  # noqa: E402

SCRIPT = _scratch.PADDLE_LAB / "detect_paddle.py"
CLIP = _scratch.DEV_CLIPS[0]


def detect(out: Path, roi: str, optimize: bool = False):
    cmd = [_scratch.python()]
    if optimize:
        cmd.append("-O")
    cmd += [
        str(SCRIPT), "--video", str(CLIP), "--out", str(out),
        "--start-ms", "5300", "--end-ms", "5400", f"--roi={roi}",
    ]
    return _scratch.run(cmd)


class ParseRoiUnit(unittest.TestCase):
    def test_out_of_range_rejected_not_clamped(self):
        with self.assertRaises(AssertionError):
            detect_paddle.parse_roi("1.2,0.5,0.1,0.1")

    def test_negative_rejected(self):
        with self.assertRaises(AssertionError):
            detect_paddle.parse_roi("-0.1,0.2,0.5,0.5")

    def test_zero_area_and_inverted_accepted_by_parser(self):
        """parse_roi validates range only — x1<=x0 passes. run_window then
        widens the crop to 32px (detect_paddle.py:272-273, :285-286)."""
        self.assertEqual(detect_paddle.parse_roi("0.5,0.5,0.5,0.5"), [0.5, 0.5, 0.5, 0.5])
        self.assertEqual(detect_paddle.parse_roi("0.6,0.6,0.2,0.2"), [0.6, 0.6, 0.2, 0.2])

    def test_x0_equal_one_passes_parser(self):
        """x0 == 1.0 is inside the documented [0,1] contract yet maps to a
        zero-width crop that run_window cannot clamp (see CLI test below)."""
        self.assertEqual(detect_paddle.parse_roi("1.0,0.5,1.0,1.0"), [1.0, 0.5, 1.0, 1.0])

    def test_wrong_arity_rejected(self):
        with self.assertRaises(AssertionError):
            detect_paddle.parse_roi("0.1,0.2,0.3")
        with self.assertRaises(ValueError):
            detect_paddle.parse_roi("0.1,abc,0.3,0.4")


@unittest.skipUnless(_scratch.VENV_PYTHON.exists(), "tools/paddle-lab/.venv missing")
class RoiCli(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.root = _scratch.scratch_root("roi")

    def _run(self, tag: str, roi: str, optimize: bool = False):
        out = self.root / f"{tag}.json"
        proc = detect(out, roi, optimize=optimize)
        _scratch.save_artifact(f"s1-roi-{tag}.stderr.txt", f"$ {' '.join(proc.args)}\nexit={proc.returncode}\n{proc.stderr}")
        return out, proc

    def test_roi_1_2_rejected_with_assertion_traceback(self):
        out, proc = self._run("out-of-range", "1.2,0.5,0.1,0.1")
        self.assertEqual(proc.returncode, 1)
        self.assertIn("AssertionError: roi wants x0,y0,x1,y1 in [0,1]", proc.stderr)
        self.assertFalse(out.exists())

    def test_negative_roi_rejected(self):
        # NB: `--roi -0.1,...` (space-separated) is eaten by argparse as an option
        # (exit 2 "expected one argument"); `--roi=-0.1,...` reaches parse_roi.
        out, proc = self._run("negative", "-0.1,0.2,0.5,0.5")
        self.assertEqual(proc.returncode, 1)
        self.assertIn("AssertionError", proc.stderr)
        self.assertFalse(out.exists())

    def test_zero_area_roi_widened_to_32px(self):
        out, proc = self._run("zero-area", "0.5,0.5,0.5,0.5")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        payload = json.loads(out.read_text())
        self.assertEqual(payload["detector"]["roiNorm"], [0.5, 0.5, 0.5, 0.5])
        self.assertEqual(payload["timing"]["framesProcessed"], 2)

    def test_inverted_roi_widened_to_32px(self):
        out, proc = self._run("inverted", "0.6,0.6,0.2,0.2")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(json.loads(out.read_text())["timing"]["framesProcessed"], 2)

    def test_x0_equal_one_crashes_in_model_not_clamped(self):
        """BROKEN: in-contract ROI 1.0,0.5,1.0,1.0 -> crop width 0 -> torch
        RuntimeError deep in the processor instead of a clamp or a clean
        argument error (detect_paddle.py:284-287 has no upper clamp)."""
        out, proc = self._run("x0-eq-one", "1.0,0.5,1.0,1.0")
        self.assertEqual(proc.returncode, 1)
        self.assertIn("RuntimeError: shape '[3, 640, 640]' is invalid for input of size 0", proc.stderr)
        self.assertFalse(out.exists())

    def test_y0_equal_one_crashes_in_model_not_clamped(self):
        out, proc = self._run("y0-eq-one", "0.5,1.0,1.0,1.0")
        self.assertEqual(proc.returncode, 1)
        self.assertIn("RuntimeError", proc.stderr)

    def test_one_pixel_crop_runs_with_ambiguous_channel_warning(self):
        """0.999 -> 1px-wide crop is fed to the model (transformers warns the
        channel dimension is ambiguous for shape [3,540,1]); exit 0."""
        out, proc = self._run("one-px", "0.999,0.5,1.0,1.0")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("channel dimension is ambiguous", proc.stderr)

    def test_python_O_strips_roi_validation(self):
        """BROKEN (P3): validation is an `assert` (detect_paddle.py:227), so
        `python -O` accepts 1.2/-0.1 and the run crashes inside torch instead."""
        out, proc = self._run("O-out-of-range", "1.2,0.5,0.1,0.1", optimize=True)
        self.assertEqual(proc.returncode, 1)
        self.assertNotIn("AssertionError", proc.stderr)
        self.assertIn("RuntimeError", proc.stderr)
        out, proc = self._run("O-negative", "-0.1,0.2,0.5,0.5", optimize=True)
        self.assertEqual(proc.returncode, 1)
        self.assertNotIn("AssertionError", proc.stderr)


if __name__ == "__main__":
    unittest.main()
