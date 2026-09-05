"""Adversarial neighbourhood test for pkg-swing-lab::ADJ-01.

ADJ-01 fixed `rightsForLicense()` in packages/swing-lab/src/engine/rights.ts so
that CC BY-NC / BY-ND / BY-NC-ND strings no longer inherit the CC BY profile
and "NOT public domain — all rights reserved" no longer substring-matches
"public domain". `tools/paddle-lab/distill_export.py::license_rule` is an
independent Python re-implementation of the same rule used as the FALLBACK
when a paddle-bench video has no corpus rights record (`resolve_rights` →
`rightsRecord: None`; three shipped bench videos take that path today). It
still carries the original defect: `lic.startswith("cc-by")` accepts
"cc-by-nc-nd 3.0" and `"public domain" in lic` accepts the negated phrase, so
a restrictive licence would be exported as training-eligible.

This file is NOT part of the candidate's changed code (no regression against
f702f0f8); it is recorded here so the coordinator can decide whether to fold it
into ADJ-01 or open a sibling finding. Behaviour is deterministic and
stdlib-only.

Run from the repo root:
  python3 -m unittest tools/paddle-lab/test_attack_adj01_license_rule.py
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from distill_export import license_rule  # noqa: E402

RESTRICTIVE = [
    "cc-by-nc-nd 3.0",
    "cc-by-nc 4.0",
    "cc-by-nd 4.0",
    "cc-by-nc-sa 4.0",
    "NOT public domain — all rights reserved",
    "Not in the public domain",
    "This material is not in the public domain and may not be copied",
]

POSITIVE = {
    "CC BY 4.0": "yes_with_attribution",
    "CC BY 3.0": "yes_with_attribution",
    "Public domain (U.S. federal government work, PD-USGov)": "yes",
}


class LicenseRuleNeverUpgradesRestrictiveLicences(unittest.TestCase):
    def test_restrictive_variants_are_not_cleared(self) -> None:
        for lic in RESTRICTIVE:
            with self.subTest(license=lic):
                train, basis = license_rule(lic)
                self.assertEqual(
                    train,
                    "not_cleared",
                    f"license_rule({lic!r}) -> ({train!r}, {basis!r}); "
                    "a NonCommercial / NoDerivatives / negated string must never be training-eligible",
                )

    def test_positive_controls_unchanged(self) -> None:
        for lic, expected in POSITIVE.items():
            with self.subTest(license=lic):
                train, _basis = license_rule(lic)
                self.assertEqual(train, expected)

    def test_missing_license_is_not_cleared(self) -> None:
        self.assertEqual(license_rule(None)[0], "not_cleared")
        self.assertEqual(license_rule("")[0], "not_cleared")


if __name__ == "__main__":
    unittest.main()
