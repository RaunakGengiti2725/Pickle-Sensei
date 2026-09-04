"""S4 — wave-g g03 multi-paddle miner: determinism + missing pose track.

The miner derives REPO from its own file location and writes to
<REPO>/datasets/mining/wave-g-g03, so each scratch root gets a verbatim copy of
the script at tools/mining/ plus only the inputs it reads (module docstring).

 1. run twice (--no-crops) into two scratch roots -> cmp all three outputs.
 2. scratch output vs the COMMITTED datasets/mining/wave-g-g03 (crops aside).
 3. delete one committed pose track (runs-wave-a/wavea-944403-dink/people.json)
    in a scratch root -> expect a hard error, NOT a silently smaller queue.
 4. corrupt a pose track (truncated JSON) -> error?
 5. held-out leakage probe: inject a held-out ownership annotation with
    'other' paddles and a held-out queue entry; confirm nothing leaks.

Run: python3 -m unittest discover -s tools/paddle-lab/attack3 -p 'test_miner*.py' -v
"""

from __future__ import annotations

import filecmp
import json
import shutil
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import _scratch  # noqa: E402

MINER_REL = "tools/mining/wave_g_g03_multi_paddle_miner.py"
OUT_REL = "datasets/mining/wave-g-g03"
OUTPUTS = ["candidates.json", "annotation-queue.json", "label-schema.json"]
POSE_REL = "datasets/paddle-bench/runs-wave-a/wavea-944403-dink/people.json"


def run_miner(root: Path):
    return _scratch.run([sys.executable, str(root / MINER_REL), "--no-crops"], cwd=str(root))


def load(root: Path, name: str) -> dict:
    return json.loads((root / OUT_REL / name).read_text())


class MinerDeterminism(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.a = _scratch.build_miner_root("miner-a")
        cls.b = _scratch.build_miner_root("miner-b")
        cls.pa = run_miner(cls.a)
        cls.pb = run_miner(cls.b)
        assert cls.pa.returncode == 0, cls.pa.stderr
        assert cls.pb.returncode == 0, cls.pb.stderr
        _scratch.save_artifact("s4-miner-a.stdout.json", cls.pa.stdout)

    def test_two_runs_byte_identical(self):
        for name in OUTPUTS:
            with self.subTest(file=name):
                self.assertTrue(filecmp.cmp(self.a / OUT_REL / name, self.b / OUT_REL / name, shallow=False), name)
        self.assertEqual(self.pa.stdout, self.pb.stdout)

    def test_matches_committed_output_modulo_crops(self):
        """Committed run had crops; --no-crops only nulls cropPath in the queue."""
        committed = _scratch.REPO_ROOT / OUT_REL
        self.assertTrue(filecmp.cmp(committed / "candidates.json", self.a / OUT_REL / "candidates.json", shallow=False))
        self.assertTrue(filecmp.cmp(committed / "label-schema.json", self.a / OUT_REL / "label-schema.json", shallow=False))
        cq = json.loads((committed / "annotation-queue.json").read_text())
        sq = load(self.a, "annotation-queue.json")
        for e in cq["entries"]:
            e["cropPath"] = None
        self.assertEqual(cq, sq)

    def test_deleted_pose_track_is_silently_omitted(self):
        """BROKEN: removing a committed pose track exits 0 with FEWER candidates
        and no error/warning. load_people returns (None, None) on a missing file
        (miner:238-239) and mine_pose_tracks globs whatever exists (:425-426)."""
        root = _scratch.build_miner_root("miner-missing-pose")
        (root / POSE_REL).unlink()
        proc = run_miner(root)
        _scratch.save_artifact("s4-missing-pose.stdout.json", proc.stdout)
        _scratch.save_artifact("s4-missing-pose.stderr.txt", proc.stderr)
        base = load(self.a, "candidates.json")["meta"]
        got = load(root, "candidates.json")["meta"]
        report = {
            "exit": proc.returncode,
            "stderr": proc.stderr,
            "baselineTotal": base["totalCandidates"],
            "missingPoseTotal": got["totalCandidates"],
            "baselineCounts": base["countsPerScenario"],
            "missingPoseCounts": got["countsPerScenario"],
            "poseInputsBaseline": sorted(p["input"] for p in base["provenance"] if "people.json" in p["input"]),
            "poseInputsMissing": sorted(p["input"] for p in got["provenance"] if "people.json" in p["input"]),
        }
        _scratch.save_artifact("s4-missing-pose-report.json", json.dumps(report, indent=1))
        # Pin the CURRENT (broken) behaviour so a fix flips this test:
        self.assertEqual(proc.returncode, 0, report)
        self.assertEqual(proc.stderr, "")
        self.assertLess(got["totalCandidates"], base["totalCandidates"], report)
        self.assertNotIn(POSE_REL, report["poseInputsMissing"])
        # the ownership stage still emits candidates for the bundle, now without torso context
        self.assertIn("wavea-944403-dink", got["countsPerScenario"]["partner_or_opponent_in_frame"]["distinctCases"])

    def test_truncated_pose_track_is_a_hard_error(self):
        root = _scratch.build_miner_root("miner-corrupt-pose")
        p = root / POSE_REL
        data = p.read_bytes()
        p.write_bytes(data[: len(data) // 2])
        proc = run_miner(root)
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("JSONDecodeError", proc.stderr)
        self.assertFalse((root / OUT_REL / "candidates.json").exists())

    def test_empty_runs_dir_still_exits_zero(self):
        """All pose tracks gone -> exit 0, pose-derived scenarios vanish silently."""
        root = _scratch.build_miner_root("miner-no-pose")
        shutil.rmtree(root / "datasets/paddle-bench/runs-wave-a")
        proc = run_miner(root)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(proc.stderr, "")
        got = load(root, "candidates.json")
        sources = {c["source"] for c in got["candidates"]}
        self.assertNotIn("pose-tracks:runs-wave-a/people.json", sources)
        self.assertFalse(any("people.json" in p["input"] for p in got["meta"]["provenance"]))
        # 21 pose-track candidates disappear, plus 2 ownership-point candidates that
        # needed torso normalisation (miner:306-330) — 129 -> 106, exit 0, no stderr
        self.assertEqual(got["meta"]["totalCandidates"], 106, got["meta"]["countsPerScenario"])

    def test_held_out_injection_does_not_leak(self):
        """Give a held-out bundle (wm-dink-01) an ownership annotation with other
        paddles and a pose track; add a held-out entry to the detector queue.
        No candidate, provenance row, or count may reference it."""
        root = _scratch.build_miner_root("miner-heldout")
        src_ann = root / "datasets/paddle-bench/bundles/wavea-944403-dink/annotation/devin-visual-v2-waveC-ownership.json"
        dst_ann = root / "datasets/paddle-bench/bundles/wm-dink-01/annotation/devin-visual-v2-waveC-ownership.json"
        dst_ann.parent.mkdir(parents=True)
        shutil.copy2(src_ann, dst_ann)
        shutil.copytree(root / "datasets/paddle-bench/runs-wave-a/wavea-944403-dink",
                        root / "datasets/paddle-bench/runs-wave-a/wm-dink-01")
        qpath = root / "datasets/paddle-bench/ownership-review/queue.json"
        queue = json.loads(qpath.read_text())
        frames = queue["frames"]
        donor = next(f for f in frames if f["caseId"] not in ("wm-dink-01", "afn-vic-rally1") and len(f.get("boxes", [])) >= 2)
        clone = json.loads(json.dumps(donor))
        clone["caseId"] = "wm-dink-01"
        frames.append(clone)
        qpath.write_text(json.dumps(queue))
        proc = run_miner(root)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        base = load(self.a, "candidates.json")
        got = load(root, "candidates.json")
        # meta.heldOutExcluded / heldOutStatement legitimately name the ids; everything else must not
        blob = json.dumps({"cands": got["candidates"], "prov": got["meta"]["provenance"],
                           "counts": got["meta"]["countsPerScenario"],
                           "queue": load(root, "annotation-queue.json")["entries"]})
        self.assertNotIn("wm-dink-01", blob)
        self.assertNotIn("afn-vic-rally1", blob)
        self.assertEqual(base["candidates"], got["candidates"])
        qprov = next(p for p in got["meta"]["provenance"] if p["input"].endswith("queue.json"))
        base_q = next(p for p in base["meta"]["provenance"] if p["input"].endswith("queue.json"))
        self.assertEqual(qprov["framesSkippedHeldOut"], base_q["framesSkippedHeldOut"] + 1)  # 21 -> 22
        self.assertEqual(qprov["framesUsed"], 30)


if __name__ == "__main__":
    unittest.main()
