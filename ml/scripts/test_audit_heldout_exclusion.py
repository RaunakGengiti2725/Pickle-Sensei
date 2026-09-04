"""Structural audit: held-out split discipline across the ML tooling (static checks).

Pins, from committed artifacts and tool constants only (no reruns):
  * miner, student_bench and distill exporter agree on which case IDs are held out;
  * the committed miner output and frame-pack directory never reference them;
  * every held-out example in the distill release is quarantined (trainingEligible false);
  * the release manifest's quarantine counts equal the per-example truth.

Run:  python3 -m unittest discover -s ml/scripts -p 'test_audit_heldout_exclusion.py' -v
"""

from __future__ import annotations

import json
import re
import unittest
from collections import Counter
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
MINER = (REPO / "tools/mining/wave_g_g03_multi_paddle_miner.py").read_text(encoding="utf-8")
STUDENT_BENCH = (REPO / "tools/paddle-lab/student_bench.py").read_text(encoding="utf-8")
DISTILL = (REPO / "tools/paddle-lab/distill_export.py").read_text(encoding="utf-8")
RELEASE = REPO / "datasets/releases/paddle-distill-v0.1"
MINING = REPO / "datasets/mining/wave-g-g03"


def _set_literal(src: str, name: str) -> set[str]:
    m = re.search(rf"^{name} = [\(\{{]([^\)\}}]*)[\)\}}]", src, re.M)
    assert m, f"{name} not found"
    return set(re.findall(r'"([^"]+)"', m.group(1)))


HELD_OUT_MINER = _set_literal(MINER, "HELD_OUT")
HELD_OUT_BENCH = _set_literal(STUDENT_BENCH, "HELD_OUT")


def _examples() -> list[dict]:
    with (RELEASE / "examples.jsonl").open(encoding="utf-8") as f:
        return [json.loads(line) for line in f]


class HeldOutConstantsTest(unittest.TestCase):
    def test_miner_and_student_bench_agree_on_held_out_ids(self):
        self.assertEqual(HELD_OUT_MINER, HELD_OUT_BENCH)
        self.assertEqual(HELD_OUT_MINER, {"wm-dink-01", "afn-vic-rally1"})

    def test_distill_exporter_quarantines_both_held_out_roles(self):
        self.assertEqual(_set_literal(DISTILL, "HELD_OUT_ROLES"), {"held_out", "test_held_out"})


class MinerOutputTest(unittest.TestCase):
    def test_committed_candidates_reference_no_held_out_case(self):
        data = json.loads((MINING / "candidates.json").read_text(encoding="utf-8"))
        cases = {c["caseId"] for c in data["candidates"]}
        self.assertEqual(cases & HELD_OUT_MINER, set())
        self.assertEqual(set(data["meta"]["heldOutExcluded"]), HELD_OUT_MINER)

    def test_frame_packs_and_queue_reference_no_held_out_case(self):
        names = {p.name for p in (MINING / "frame-packs").rglob("*")}
        leaked = {n for n in names if any(h in n for h in HELD_OUT_MINER)}
        self.assertEqual(leaked, set())
        queue = (MINING / "annotation-queue.json").read_text(encoding="utf-8")
        for h in HELD_OUT_MINER:
            self.assertNotIn(f'"{h}"', queue)


class DistillReleaseTest(unittest.TestCase):
    def test_held_out_examples_are_all_quarantined(self):
        for e in _examples():
            if e["caseId"] in HELD_OUT_MINER or e["role"] in {"held_out", "test_held_out"}:
                self.assertFalse(e["trainingEligible"], e["exampleId"])
                self.assertTrue(
                    any(r.startswith("held_out_case:") for r in e["quarantineReasons"]), e["exampleId"]
                )

    def test_no_training_eligible_example_has_held_out_role(self):
        bad = [e["exampleId"] for e in _examples() if e["trainingEligible"] and e["role"] != "development"]
        self.assertEqual(bad, [])

    def test_manifest_counts_match_examples(self):
        manifest = json.loads((RELEASE / "manifest.json").read_text(encoding="utf-8"))
        ex = _examples()
        counts = manifest["counts"]
        self.assertEqual(counts["examples"], len(ex))
        self.assertEqual(counts["quarantined"], sum(not e["trainingEligible"] for e in ex))
        self.assertEqual(counts["trainingEligible"], sum(bool(e["trainingEligible"]) for e in ex))
        reasons = Counter(r for e in ex for r in e["quarantineReasons"])
        self.assertEqual(counts["quarantineReasons"], dict(reasons))
        by_case = Counter(e["caseId"] for e in ex)
        self.assertEqual({k: v["total"] for k, v in counts["byCase"].items()}, dict(by_case))


if __name__ == "__main__":
    unittest.main()
