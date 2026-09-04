"""S2 — distill_export.py consent gate under a grant that lacks consent_version.

Attack: `--consent-export grants.json` where one grant has no consent_version
(and a second is well-formed). Expectation from the scenario: an example whose
sourceUserId lacks a valid grant is EXPORTED with quarantineReasons containing
"consent_not_granted" — never dropped from examples.jsonl.

Run: python3 -m unittest tools.paddle-lab.attack3.test_distill_consent  (or discover)
"""

from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import _scratch  # noqa: E402
import distill_export  # noqa: E402

SCRIPT = _scratch.PADDLE_LAB / "distill_export.py"


def export(root: Path, grants) -> tuple[list[dict], dict, object]:
    grants_path = root / "grants.json"
    grants_path.write_text(json.dumps(grants))
    proc = _scratch.run(
        [sys.executable, str(SCRIPT), "--repo-root", str(root), "--consent-export", str(grants_path)]
    )
    if proc.returncode != 0:
        return [], {}, proc
    out_dir = root / "datasets/releases/paddle-distill-v0.1"
    examples = [json.loads(l) for l in (out_dir / "examples.jsonl").read_text().splitlines()]
    manifest = json.loads((out_dir / "manifest.json").read_text())
    return examples, manifest, proc


class DistillConsentGate(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.root = _scratch.build_distill_root("distill-consent")
        cls.baseline_examples, cls.baseline_manifest, proc = export(cls.root, [])
        assert proc.returncode == 0, proc.stderr

    def test_baseline_matches_committed_release(self):
        """Determinism: the scratch export reproduces the committed release byte-for-byte
        (examples.jsonl) apart from nothing — same inputs, same output."""
        committed = _scratch.REPO_ROOT / "datasets/releases/paddle-distill-v0.1/examples.jsonl"
        scratch = self.root / "datasets/releases/paddle-distill-v0.1/examples.jsonl"
        self.assertEqual(committed.read_bytes(), scratch.read_bytes())

    def test_grant_without_consent_version_is_ignored_not_fatal(self):
        grants = [
            {"source_user_id": "user-no-version"},  # lacks consent_version
            {"source_user_id": "user-ok", "consent_version": "2026-01"},
        ]
        examples, manifest, proc = export(self.root, grants)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        # Nothing may be dropped relative to the no-grants baseline.
        self.assertEqual(len(examples), len(self.baseline_examples))
        self.assertEqual(
            [e["exampleId"] for e in examples],
            [e["exampleId"] for e in self.baseline_examples],
        )
        _scratch.save_artifact("s2-manifest-with-grants.json", json.dumps(manifest["counts"], indent=1))

    def test_gate_example_unit_consent_not_granted(self):
        """Unit level: a first-party example whose user has no valid grant is
        quarantined with reason consent_not_granted (and stays an example)."""
        grants = distill_export.load_consent_grants(self._write_grants([
            {"source_user_id": "user-no-version"},
            {"source_user_id": "user-ok", "consent_version": "2026-01"},
        ]))
        self.assertEqual(grants, {"user-ok"})
        case = {"role": "development"}
        rights = {"train": "yes"}
        eligible, reasons = distill_export.gate_example(case, rights, "user-no-version", grants)
        self.assertFalse(eligible)
        self.assertEqual(reasons, ["consent_not_granted"])
        eligible, reasons = distill_export.gate_example(case, rights, "user-ok", grants)
        self.assertTrue(eligible)

    def test_end_to_end_consent_gate_is_unreachable(self):
        """Documents that no example can ever carry a sourceUserId in the current
        exporter (hardcoded None at distill_export.py:298 and :334), so the
        end-to-end path to `consent_not_granted` does not exist yet. This is
        the honest limit the manifest itself declares."""
        grants = [{"source_user_id": "user-no-version"}]
        examples, manifest, proc = export(self.root, grants)
        self.assertEqual(proc.returncode, 0)
        self.assertEqual(manifest["counts"]["firstPartyExamples"], 0)
        self.assertNotIn("consent_not_granted", manifest["counts"]["quarantineReasons"])
        self.assertTrue(all(e["consent"]["sourceUserId"] is None for e in examples))

    def test_first_party_consent_granted_count_goes_null_when_grants_supplied(self):
        """manifest.counts.firstPartyConsentGranted is 0 with no grants but becomes
        null (not a count) as soon as ANY grant is supplied (distill_export.py:404)."""
        examples, manifest, proc = export(self.root, [{"source_user_id": "u", "consent_version": "v"}])
        self.assertEqual(proc.returncode, 0)
        # Record observed value; the assertion pins CURRENT behaviour so a fix flips it.
        self.assertIsNone(manifest["counts"]["firstPartyConsentGranted"])

    def test_grant_missing_source_user_id_crashes(self):
        """A grant row lacking source_user_id (but with consent_version) raises KeyError
        (distill_export.py:252) — the exporter aborts with a traceback instead of a
        structured error naming the offending row."""
        examples, manifest, proc = export(self.root, [{"consent_version": "v1"}])
        _scratch.save_artifact("s2-missing-source-user-id.stderr.txt", proc.stderr)
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("KeyError", proc.stderr)

    def test_grant_export_not_a_list_crashes(self):
        """A dict-shaped export ({"items":[...]}) iterates keys -> AttributeError traceback."""
        examples, manifest, proc = export(self.root, {"items": [{"source_user_id": "u", "consent_version": "v"}]})
        _scratch.save_artifact("s2-dict-export.stderr.txt", proc.stderr)
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("AttributeError", proc.stderr)

    def _write_grants(self, grants) -> Path:
        p = self.root / "unit-grants.json"
        p.write_text(json.dumps(grants))
        return p


if __name__ == "__main__":
    unittest.main()
