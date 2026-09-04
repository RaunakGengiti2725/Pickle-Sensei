#!/usr/bin/env python3
"""Structural audit: same-machine reproducibility of train_student.py.

Runs the student trainer twice with the default seed (1706) and a short
schedule into two scratch directories and requires byte-identical weights and
identical loss histories. Cross-machine / cross-torch-version reproducibility is
NOT established by this test (seeding covers torch + numpy RNG only).

Run from tools/paddle-lab with the venv (numpy + torch + ffmpeg):
  .venv/bin/python -m unittest test_audit_train_student_determinism -v
"""
from __future__ import annotations

import hashlib
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
EPOCHS = "3"


def _train(out_dir: Path) -> tuple[str, list[dict]]:
    subprocess.run(
        [sys.executable, str(HERE / "train_student.py"), "--epochs", EPOCHS, "--out-dir", str(out_dir)],
        cwd=HERE,
        check=True,
        capture_output=True,
    )
    weights = hashlib.sha256((out_dir / "student-paddle-v0.pt").read_bytes()).hexdigest()
    report = json.loads((out_dir / "training-report.json").read_text(encoding="utf-8"))
    return weights, report["history"]


class TrainStudentDeterminismTest(unittest.TestCase):
    def test_two_seeded_runs_are_bitwise_identical(self):
        with tempfile.TemporaryDirectory() as tmp:
            a = _train(Path(tmp) / "a")
            b = _train(Path(tmp) / "b")
        self.assertEqual(a[1], b[1], "loss history differs between identical seeded runs")
        self.assertEqual(a[0], b[0], "student-paddle-v0.pt differs between identical seeded runs")


if __name__ == "__main__":
    unittest.main()
