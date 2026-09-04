"""Audit: distill_export.license_rule — the fallback rights gate used when a source has
no corpus rights record.

The rule must never clear a NonCommercial / NoDerivatives / ShareAlike-only
licence for commercial model training, and must not be fooled by strings that
merely contain a permissive phrase.

Run: python3 -m unittest tools/audit/ml_tooling_datasets_structural1/test_distill_license_rule.py
"""

from __future__ import annotations

import unittest

from _support import add_paddle_lab_to_path

add_paddle_lab_to_path()
import distill_export as de  # noqa: E402


class LicenseRuleGate(unittest.TestCase):
    def test_public_domain_and_cc_by_clear(self):
        self.assertEqual(de.license_rule("Public domain (U.S. federal government work, PD-USGov)")[0], "yes")
        self.assertEqual(de.license_rule("CC BY 3.0")[0], "yes_with_attribution")
        self.assertEqual(de.license_rule("CC BY 4.0")[0], "yes_with_attribution")

    def test_missing_or_unknown_not_cleared(self):
        self.assertEqual(de.license_rule(None)[0], "not_cleared")
        self.assertEqual(de.license_rule("")[0], "not_cleared")
        self.assertEqual(de.license_rule("Standard YouTube License")[0], "not_cleared")

    def test_nc_nd_sa_variants_not_cleared(self):
        for lic in ("CC BY-NC 4.0", "CC BY-NC-SA 4.0", "CC BY-ND 4.0", "CC BY-NC-ND 3.0",
                    "cc-by-nc 4.0", "CC BY SA 4.0", "CC BY-SA 3.0"):
            train, _basis = de.license_rule(lic)
            self.assertEqual(train, "not_cleared", lic)

    def test_public_domain_phrase_inside_restrictive_text_not_cleared(self):
        train, _ = de.license_rule("All rights reserved; NOT public domain")
        self.assertEqual(train, "not_cleared")

    def test_train_ok_set_matches_rule_outputs(self):
        self.assertEqual(de.TRAIN_OK, {"yes", "yes_with_attribution"})


if __name__ == "__main__":
    unittest.main()
