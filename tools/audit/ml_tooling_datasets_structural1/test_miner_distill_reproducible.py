"""Audit: are the committed mining / distillation artifacts reproducible and held-out clean?

Neither tools/mining/wave_g_g03_multi_paddle_miner.py nor
tools/paddle-lab/distill_export.py has a repo test. Both derive their repo root
from their own file location (miner) or --repo-root (distill), so each is
re-run against a scratch root that symlinks the committed INPUT trees read-only
and gives the tool a private OUTPUT tree. The committed datasets are never
written.

Assertions:
  - re-run output is byte-identical to the committed artifact (determinism);
  - no held-out case id / role appears in miner candidates or in any
    trainingEligible distillation example.

Run: python3 -m unittest tools/audit/ml_tooling_datasets_structural1/test_miner_distill_reproducible.py
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from _support import REPO_ROOT

MINER = REPO_ROOT / "tools" / "mining" / "wave_g_g03_multi_paddle_miner.py"
DISTILL = REPO_ROOT / "tools" / "paddle-lab" / "distill_export.py"
HELD_OUT_CASES = {"wm-dink-01", "afn-vic-rally1"}
HELD_OUT_ROLES = {"held_out", "test_held_out"}


def scratch_root(tmp: Path, private_dirs: list[str]) -> Path:
    """Symlink every top-level datasets/ entry read-only except the private ones."""
    root = tmp / "root"
    (root / "datasets").mkdir(parents=True)
    for entry in (REPO_ROOT / "datasets").iterdir():
        rel = f"datasets/{entry.name}"
        if rel in private_dirs:
            (root / rel).mkdir(parents=True)
        else:
            os.symlink(entry, root / rel)
    return root


class MinerReproducible(unittest.TestCase):
    def test_miner_rerun_matches_committed_candidates_and_excludes_held_out(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = scratch_root(Path(tmp), ["datasets/mining"])
            (root / "tools" / "mining").mkdir(parents=True)
            shutil.copy(MINER, root / "tools" / "mining" / MINER.name)
            proc = subprocess.run(
                [sys.executable, str(root / "tools" / "mining" / MINER.name)],
                capture_output=True, text=True, cwd=str(root),
            )
            self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
            out_dir = root / "datasets" / "mining" / "wave-g-g03"
            committed_dir = REPO_ROOT / "datasets" / "mining" / "wave-g-g03"
            rerun = json.loads((out_dir / "candidates.json").read_text())
            committed = json.loads((committed_dir / "candidates.json").read_text())
            self.assertEqual(rerun["candidates"], committed["candidates"], "candidate list differs from committed")
            self.assertEqual(rerun["meta"]["countsPerScenario"], committed["meta"]["countsPerScenario"])
            self.assertEqual(
                (out_dir / "annotation-queue.json").read_bytes(),
                (committed_dir / "annotation-queue.json").read_bytes(),
                "annotation-queue.json differs from committed",
            )
            leaked = [c for c in rerun["candidates"] if c["caseId"] in HELD_OUT_CASES]
            self.assertEqual(leaked, [])
            candidates_text = json.dumps(rerun["candidates"]) + json.dumps(rerun["meta"]["provenance"])
            for stem in HELD_OUT_CASES:
                self.assertNotIn(stem, candidates_text, f"held-out id {stem} appears in candidate/provenance records")


class DistillReproducible(unittest.TestCase):
    def test_distill_rerun_matches_committed_release_and_quarantines_held_out(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = scratch_root(Path(tmp), ["datasets/releases"])
            proc = subprocess.run(
                [sys.executable, str(DISTILL), "--repo-root", str(root)],
                capture_output=True, text=True, cwd=str(root),
            )
            self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
            out_dir = root / "datasets" / "releases" / "paddle-distill-v0.1"
            committed_dir = REPO_ROOT / "datasets" / "releases" / "paddle-distill-v0.1"
            self.assertEqual(
                (out_dir / "examples.jsonl").read_bytes(), (committed_dir / "examples.jsonl").read_bytes(),
                "examples.jsonl differs from committed",
            )
            rerun_manifest = json.loads((out_dir / "manifest.json").read_text())
            committed_manifest = json.loads((committed_dir / "manifest.json").read_text())
            self.assertEqual(rerun_manifest, committed_manifest, "manifest.json differs from committed")
            examples = [json.loads(line) for line in (out_dir / "examples.jsonl").read_text().splitlines()]
            self.assertTrue(examples)
            for e in examples:
                if e["role"] in HELD_OUT_ROLES or e["caseId"] in HELD_OUT_CASES:
                    self.assertFalse(e["trainingEligible"], e["exampleId"])
                    self.assertTrue(any(r.startswith("held_out_case:") for r in e["quarantineReasons"]), e["exampleId"])
            ids = [e["exampleId"] for e in examples]
            self.assertEqual(len(ids), len(set(ids)), "duplicate exampleId")


if __name__ == "__main__":
    unittest.main()
