"""Pins the distill_export rights fallback (license_rule) to a strict allow-list.

The fallback runs only for a source with NO corpus rights record, so it must
fail closed: a negated, unverified, restricted (NC/ND/SA) or unknown license
string must never clear commercial training. Also pins that every committed
paddle-bench registry license resolves through the fallback to the same answer
its human-reviewed corpus rights record gives, so the allow-list cannot drift
away from the ledger.

Run from the repository root:
  python3 -m unittest tools/paddle-lab/test_distill_export.py
"""

from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import distill_export  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parents[2]

NOT_CLEARED_NEGATED_OR_UNVERIFIED = [
    "Not public domain; all rights reserved",
    "Public domain? unverified",
    "Public domain?",
    "Public domain (claimed by uploader, unverified)",
    "Public domain mark (plainly false; license-laundering example)",
    "not PD-USGov",
    "no license recorded",
    "All rights reserved",
    "Standard YouTube License",
    "Pexels License",
    "unknown",
    "TBD",
    "MIT",
]

NOT_CLEARED_RESTRICTED_CC = [
    "cc-by-nc 4.0",
    "CC BY-NC 4.0",
    "CC BY-NC-ND 4.0",
    "CC BY-ND 4.0",
    "CC BY-NC-SA 3.0",
    "CC-BY-ND-4.0",
    "CC BY 4.0 (non-commercial use only)",
    "CC BY 3.0 (NoDerivatives)",
]

# ShareAlike puts a licensing obligation on the redistributed dataset that the
# release manifest does not track, so the unreviewed fallback must not clear it;
# an explicit corpus rights record is the only path for a CC BY-SA source.
NOT_CLEARED_SHAREALIKE = [
    "CC BY-SA 4.0",
    "cc-by-sa 3.0",
    "CC BY-SA",
]

PUBLIC_DOMAIN_YES = [
    "PD-USGov",
    "pd-usgov",
    "Public domain",
    "Public Domain",
    "Public domain (U.S. federal government work, PD-USGov)",
    "Public domain (U.S. federal government work, PD-USGov; DVIDS)",
    "CC0",
    "CC0 1.0",
    "CC0 1.0 Universal",
]

CC_BY_WITH_ATTRIBUTION = [
    "CC BY 3.0",
    "CC BY 4.0",
    "cc by 4.0",
    "CC-BY-4.0",
    "CC-BY 2.0",
    "CC BY",
    "CC BY 3.0 Unported",
    "CC BY 4.0 International",
]


class LicenseRuleTable(unittest.TestCase):
    def assert_train(self, license_str, expected):
        train, basis = distill_export.license_rule(license_str)
        self.assertEqual(
            train,
            expected,
            f"license_rule({license_str!r}) -> ({train!r}, {basis!r}); expected train={expected!r}",
        )
        self.assertIsInstance(basis, str)
        self.assertTrue(basis, "basis must explain the decision")

    def test_missing_license_not_cleared(self):
        self.assert_train(None, "not_cleared")
        self.assert_train("", "not_cleared")
        self.assert_train("   ", "not_cleared")

    def test_negated_or_unverified_public_domain_not_cleared(self):
        for s in NOT_CLEARED_NEGATED_OR_UNVERIFIED:
            with self.subTest(license=s):
                self.assert_train(s, "not_cleared")

    def test_restricted_cc_variants_not_cleared(self):
        for s in NOT_CLEARED_RESTRICTED_CC:
            with self.subTest(license=s):
                self.assert_train(s, "not_cleared")

    def test_sharealike_requires_rights_record(self):
        for s in NOT_CLEARED_SHAREALIKE:
            with self.subTest(license=s):
                self.assert_train(s, "not_cleared")

    def test_public_domain_allow_list_clears(self):
        for s in PUBLIC_DOMAIN_YES:
            with self.subTest(license=s):
                self.assert_train(s, "yes")

    def test_cc_by_allow_list_clears_with_attribution(self):
        for s in CC_BY_WITH_ATTRIBUTION:
            with self.subTest(license=s):
                self.assert_train(s, "yes_with_attribution")

    def test_cleared_outcomes_are_the_only_training_ok_values(self):
        cleared = {
            distill_export.license_rule(s)[0] for s in PUBLIC_DOMAIN_YES + CC_BY_WITH_ATTRIBUTION
        }
        self.assertEqual(cleared, distill_export.TRAIN_OK)
        self.assertNotIn("not_cleared", distill_export.TRAIN_OK)


class FallbackAgreesWithCommittedLedger(unittest.TestCase):
    """Every committed registry license string must resolve through the fallback
    to exactly the answer its reviewed corpus rights record gives."""

    def test_registry_licenses_match_corpus_rights(self):
        by_url, by_source_id, by_source_key = distill_export.build_rights_index(REPO_ROOT)
        checked = 0
        for source_key, reg in by_source_key.items():
            corpus = by_url.get(distill_export.norm_url(reg.get("source")))
            if corpus is None:
                corpus = by_source_id.get(f"src-{source_key}")
            if corpus is None or "rights" not in corpus:
                continue
            checked += 1
            with self.subTest(sourceKey=source_key, license=reg.get("license")):
                train, _basis = distill_export.license_rule(reg.get("license"))
                self.assertEqual(train, corpus["rights"]["train"])
        self.assertGreater(checked, 0, "no registry video has a corpus rights record")


class ResolveRightsFallbackQuarantines(unittest.TestCase):
    """A source absent from the corpus ledger with a non-permissive license
    must be quarantined end to end (resolve_rights -> gate_example)."""

    def resolve(self, license_str):
        by_source_key = {
            "fake-src": {"id": "fake-src", "source": "https://example.invalid/v", "license": license_str}
        }
        return distill_export.resolve_rights("fake-src", {}, {}, by_source_key)

    def test_non_permissive_fallback_quarantines_example(self):
        case = {"caseId": "fake-case", "sourceKey": "fake-src", "sessionKey": "s", "role": "development"}
        for s in ["Not public domain; all rights reserved", "cc-by-nc 4.0", "CC BY-ND 4.0"]:
            with self.subTest(license=s):
                rights = self.resolve(s)
                self.assertIsNone(rights["rightsRecord"])
                self.assertEqual(rights["train"], "not_cleared")
                eligible, reasons = distill_export.gate_example(case, rights, None, set())
                self.assertFalse(eligible)
                self.assertIn("rights_not_cleared:not_cleared", reasons)

    def test_permissive_fallback_clears_development_example(self):
        case = {"caseId": "fake-case", "sourceKey": "fake-src", "sessionKey": "s", "role": "development"}
        rights = self.resolve("CC BY 3.0")
        self.assertEqual(rights["train"], "yes_with_attribution")
        eligible, reasons = distill_export.gate_example(case, rights, None, set())
        self.assertTrue(eligible)
        self.assertEqual(reasons, [])

    def test_committed_release_uses_rights_records_only(self):
        examples_path = REPO_ROOT / "datasets/releases/paddle-distill-v0.1/examples.jsonl"
        with open(examples_path) as f:
            examples = [json.loads(line) for line in f if line.strip()]
        self.assertTrue(examples)
        for e in examples:
            self.assertIsNotNone(
                e["rights"]["rightsRecord"],
                f"{e['exampleId']} resolved through the license fallback instead of a rights record",
            )


if __name__ == "__main__":
    unittest.main()
