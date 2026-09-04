"""Extras — tools/mining/wave_g_g03_multi_paddle_miner.py: held-out leakage,
determinism, and reproducibility of the COMMITTED candidates.json.

The miner writes into <REPO>/datasets/mining/wave-g-g03 relative to its own
file, so every run here happens in a scratch tree that mirrors the repo layout
(script + the JSON inputs it reads, no clips, `--no-crops`). The committed
datasets/ tree is never written.
"""
from __future__ import annotations

import copy
import glob
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from attack_common import REPO_ROOT, run

MINER_REL = Path("tools/mining/wave_g_g03_multi_paddle_miner.py")
HELD_OUT = {"wm-dink-01", "afn-vic-rally1"}
INPUT_GLOBS = [
    "datasets/paddle-bench/ownership-review/queue.json",
    "datasets/paddle-bench/bundles/*/annotation/devin-visual-v2-waveC-ownership.json",
    "datasets/paddle-bench/runs-wave-a/*/people.json",
]


def _strip_volatile(doc: dict) -> dict:
    d = copy.deepcopy(doc)
    d.get("meta", {}).pop("provenance", None)
    return d


class MinerScratchTree:
    def __init__(self) -> None:
        self.root = Path(tempfile.mkdtemp(prefix="miner-attack-"))
        for pattern in INPUT_GLOBS:
            for src in glob.glob(str(REPO_ROOT / pattern)):
                rel = Path(src).relative_to(REPO_ROOT)
                dst = self.root / rel
                dst.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy(src, dst)
        (self.root / MINER_REL).parent.mkdir(parents=True, exist_ok=True)
        shutil.copy(REPO_ROOT / MINER_REL, self.root / MINER_REL)

    @property
    def out_dir(self) -> Path:
        return self.root / "datasets/mining/wave-g-g03"

    def run(self, timeout: float = 120):
        return run([sys.executable, str(self.root / MINER_REL), "--no-crops"], timeout=timeout, cwd=self.root)

    def candidates(self) -> dict:
        return json.loads((self.out_dir / "candidates.json").read_text())

    def queue(self) -> dict:
        return json.loads((self.out_dir / "annotation-queue.json").read_text())

    def cleanup(self) -> None:
        shutil.rmtree(self.root, ignore_errors=True)


class MinerHeldOutDeterminismTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tree = MinerScratchTree()

    def tearDown(self) -> None:
        self.tree.cleanup()

    def test_committed_candidates_are_reproducible_from_committed_inputs(self) -> None:
        r = self.tree.run()
        r.record("x_miner_reproduce_committed")
        self.assertEqual(r.returncode, 0, r)
        fresh = self.tree.candidates()
        committed = json.loads((REPO_ROOT / "datasets/mining/wave-g-g03/candidates.json").read_text())
        self.assertEqual(_strip_volatile(fresh)["meta"], _strip_volatile(committed)["meta"])
        self.assertEqual(fresh["candidates"], committed["candidates"])
        # Provenance sha256 of inputs must match too (the inputs are committed).
        self.assertEqual(fresh["meta"]["provenance"], committed["meta"]["provenance"])

    def test_two_runs_are_byte_identical(self) -> None:
        r1 = self.tree.run()
        self.assertEqual(r1.returncode, 0, r1)
        a = (self.tree.out_dir / "candidates.json").read_bytes()
        qa = (self.tree.out_dir / "annotation-queue.json").read_bytes()
        r2 = self.tree.run()
        self.assertEqual(r2.returncode, 0, r2)
        self.assertEqual(a, (self.tree.out_dir / "candidates.json").read_bytes())
        self.assertEqual(qa, (self.tree.out_dir / "annotation-queue.json").read_bytes())

    def test_no_held_out_case_in_any_output(self) -> None:
        r = self.tree.run()
        self.assertEqual(r.returncode, 0, r)
        blob = (self.tree.out_dir / "candidates.json").read_text() + (self.tree.out_dir / "annotation-queue.json").read_text()
        for held in HELD_OUT:
            # The ID may appear ONLY in meta.heldOutExcluded / heldOutStatement.
            doc = self.tree.candidates()
            self.assertTrue(all(c["caseId"] != held for c in doc["candidates"]))
            self.assertTrue(all(p["input"].find(held) < 0 for p in doc["meta"]["provenance"]), doc["meta"]["provenance"])
            self.assertTrue(all(e["caseId"] != held for e in self.tree.queue()["entries"]))
        self.assertIn("wm-dink-01", blob)  # the exclusion statement itself

    def test_injected_held_out_records_never_leak(self) -> None:
        """Plant loud, high-score records for both held-out cases in every input
        source (detector queue, ownership points, pose tracks) and require zero
        trace of them in the outputs and unchanged candidate list."""
        base = self.tree.run()
        self.assertEqual(base.returncode, 0, base)
        baseline = self.tree.candidates()["candidates"]

        # 1) detector queue: copy an existing multi-box frame under a held-out caseId
        qpath = self.tree.root / "datasets/paddle-bench/ownership-review/queue.json"
        q = json.loads(qpath.read_text())
        donor = next(fr for fr in q["frames"] if len(fr.get("boxes", [])) >= 2)
        for held in HELD_OUT:
            fake = copy.deepcopy(donor)
            fake["caseId"] = held
            for b in fake["boxes"]:
                b["score"] = 0.99
            q["frames"].append(fake)
        qpath.write_text(json.dumps(q))

        # 2) ownership points: a held-out bundle annotation with target+other points
        for held in HELD_OUT:
            ann_dir = self.tree.root / f"datasets/paddle-bench/bundles/{held}/annotation"
            ann_dir.mkdir(parents=True, exist_ok=True)
            (ann_dir / "devin-visual-v2-waveC-ownership.json").write_text(json.dumps({
                "paddleFrames": [{"tMs": 1000, "x": 0.5, "y": 0.5, "visibility": "visible"}],
                "otherPaddleFrames": [{"tMs": 1000, "x": 0.52, "y": 0.5, "visibility": "visible"}],
            }))

        # 3) pose tracks: two fully overlapping people under a held-out run dir
        donor_people = next(iter(glob.glob(str(self.tree.root / "datasets/paddle-bench/runs-wave-a/*/people.json"))))
        for held in HELD_OUT:
            d = self.tree.root / f"datasets/paddle-bench/runs-wave-a/{held}"
            d.mkdir(parents=True, exist_ok=True)
            shutil.copy(donor_people, d / "people.json")

        r = self.tree.run()
        r.record("x_miner_injected_held_out")
        self.assertEqual(r.returncode, 0, r)
        after = self.tree.candidates()
        self.assertEqual(after["candidates"], baseline, "held-out injection changed the candidate list")
        for held in HELD_OUT:
            self.assertTrue(all(c["caseId"] != held for c in after["candidates"]))
            self.assertTrue(all(held not in p["input"] for p in after["meta"]["provenance"]))
        self.assertGreater(
            len(json.loads(qpath.read_text())["frames"]), len(q["frames"]) - 3,
            "sanity: injected frames are on disk")

    def test_miner_survives_clock_and_locale(self) -> None:
        """Outputs carry no wall-clock or locale-dependent field: run with TZ/LANG
        changed and a faked date via faketime-less env (the miner never reads the
        clock, so this must be byte-identical to the default run)."""
        r1 = self.tree.run()
        self.assertEqual(r1.returncode, 0, r1)
        a = (self.tree.out_dir / "candidates.json").read_bytes()
        env = dict(os.environ, TZ="Asia/Kolkata", LANG="tr_TR.UTF-8", LC_ALL="tr_TR.UTF-8", PYTHONHASHSEED="12345")
        r2 = subprocess.run([sys.executable, str(self.tree.root / MINER_REL), "--no-crops"],
                            capture_output=True, text=True, env=env, timeout=120, cwd=self.tree.root)
        self.assertEqual(r2.returncode, 0, r2.stderr)
        self.assertEqual(a, (self.tree.out_dir / "candidates.json").read_bytes())

    def test_missing_detector_queue_fails_loudly(self) -> None:
        (self.tree.root / "datasets/paddle-bench/ownership-review/queue.json").unlink()
        r = self.tree.run()
        r.record("x_miner_missing_queue")
        self.assertNotEqual(r.returncode, 0)
        self.assertFalse((self.tree.out_dir / "candidates.json").exists(),
                         "no partial artifact may be written when an input is missing")


if __name__ == "__main__":
    unittest.main()
