#!/usr/bin/env python3
"""Long-run leak lens for the ml/ tooling, as a unittest (stress_long_run_leak.py).

Run from the repository root:
  python3 -m unittest discover -s ml/scripts -p 'test_*.py'
  STRESS_ITER=5000 python3 -m unittest ml/scripts/test_stress_long_run_leak.py

Default scale is STRESS_ITER (500) iterations per campaign in this one process;
heap/handles/threads are sampled after every 50 iterations with a forced gc.
Every failing seed is replayable with
  python3 ml/scripts/stress_long_run_leak.py --campaign <name> --replay-seed <seed>
"""
from __future__ import annotations

import contextlib
import io
import json
import tempfile
import unittest
from pathlib import Path

import stress_long_run_leak as harness
import validate_annotations

ITERATIONS = max(harness.DEFAULT_ITERATIONS, 500)


class LongRunLeakTest(unittest.TestCase):
    """Lens invariants that HELD on 1fb0efd7: heap slope, handles, threads, drift, determinism."""

    @classmethod
    def setUpClass(cls) -> None:
        cls._tmp = tempfile.TemporaryDirectory(prefix="ml-long-run-leak-")
        out_dir = Path(cls._tmp.name)
        cls.reports = {
            name: harness.run_campaign(name, ITERATIONS, harness.DEFAULT_SEED, out_dir) for name in harness.CAMPAIGNS
        }

    @classmethod
    def tearDownClass(cls) -> None:
        cls._tmp.cleanup()

    def _verdict(self, campaign: str, key: str) -> dict:
        report = self.reports[campaign]
        self.assertEqual(report["iterations_executed"], ITERATIONS, report["outcome_counts"])
        return report["verdicts"][key]

    def test_heap_does_not_grow_monotonically(self) -> None:
        for campaign in harness.CAMPAIGNS:
            for key in ("heap_unit_retained", "heap_total_traced"):
                with self.subTest(campaign=campaign, metric=key):
                    verdict = self._verdict(campaign, key)
                    self.assertTrue(verdict["held"], verdict)

    def test_no_uncollectable_garbage(self) -> None:
        for campaign in harness.CAMPAIGNS:
            with self.subTest(campaign=campaign):
                self.assertEqual(self._verdict(campaign, "gc_objects")["garbage_final"], 0)

    def test_open_fds_and_threads_return_to_baseline(self) -> None:
        for campaign in harness.CAMPAIGNS:
            for key in ("open_fds", "threads"):
                with self.subTest(campaign=campaign, resource=key):
                    verdict = self._verdict(campaign, key)
                    self.assertEqual(verdict["final"], verdict["initial"], verdict)

    def test_invocation_time_does_not_drift(self) -> None:
        for campaign in harness.CAMPAIGNS:
            with self.subTest(campaign=campaign):
                verdict = self._verdict(campaign, "time_drift")
                self.assertLessEqual(verdict["ratio"], harness.TIME_DRIFT_LIMIT, verdict)

    def test_validator_is_deterministic_and_does_not_mutate_input(self) -> None:
        verdict = self._verdict("validate_loop", "determinism")
        self.assertEqual(verdict["nondeterministic_rows"], 0, verdict)
        self.assertEqual(verdict["input_mutated_rows"], 0, verdict)

    def test_rows_never_contain_nan_or_infinity(self) -> None:
        for campaign in harness.CAMPAIGNS:
            with self.subTest(campaign=campaign):
                self.assertEqual(self._verdict(campaign, "no_nan_inf")["rows_with_nan"], 0)

    def test_cli_exit_code_matches_per_file_expectation(self) -> None:
        verdict = self._verdict("cli_loop", "cli_contract")
        self.assertTrue(verdict["held"], verdict)

    def test_unmutated_documents_are_always_valid_and_abstentions_pass(self) -> None:
        counts = self.reports["validate_loop"]["outcome_counts"]
        self.assertFalse([k for k in counts if k.startswith("unexpected_")], counts)
        self.assertGreater(counts.get("valid", 0), 0)
        self.assertGreater(counts.get("invalid", 0), 0)

    def test_module_reload_rebuilds_identical_state(self) -> None:
        counts = self.reports["reload_loop"]["outcome_counts"]
        self.assertEqual(counts.get("reloaded"), ITERATIONS, counts)
        self.assertEqual(len(validate_annotations.TECHNIQUES), 61)

    def test_geometry_helpers_hold_their_properties(self) -> None:
        counts = self.reports["helpers_loop"]["outcome_counts"]
        self.assertEqual(counts.get("property_violation", 0), 0, counts)
        self.assertEqual(counts.get("exception", 0), 0, counts)

    def test_every_seed_is_replayable(self) -> None:
        for seed in harness.seeds_for(harness.DEFAULT_SEED, 50):
            with self.subTest(seed=seed):
                self.assertEqual(harness.generate_case(seed), harness.generate_case(seed))

    def test_summary_is_json_serialisable_without_nan(self) -> None:
        json.dumps(self.reports, allow_nan=False)


class KnownValidatorRobustnessGaps(unittest.TestCase):
    """Findings recorded by the long-run-leak campaign on 1fb0efd7 (identical on origin/main).

    Each test asserts the CORRECT behaviour and is marked expectedFailure so the
    suite stays green while the defect exists; once fixed the unexpected success
    fails the run, prompting removal of the decorator.
    """

    @unittest.expectedFailure
    def test_validate_reports_unhashable_json_values_instead_of_raising(self) -> None:
        # Minimised from validate_loop seed 1604047494 (TypeError: unhashable type: 'list').
        doc = harness.generate_valid_doc(harness.random.Random(1))
        doc["technique"] = ["drive_forehand"]
        errors = validate_annotations.validate(doc, "x")
        self.assertTrue(any("technique" in error for error in errors), errors)

    @unittest.expectedFailure
    def test_cli_reports_non_utf8_file_as_invalid_instead_of_raising(self) -> None:
        # Minimised from cli_loop seed 1604047545 (UnicodeDecodeError escapes main()).
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "binary.json"
            path.write_bytes(b"\xff\xfe\x00garbage")
            stdout = io.StringIO()
            with contextlib.redirect_stdout(stdout):
                code = validate_annotations.main([str(path)])
            self.assertEqual(code, 1)
            self.assertIn("INVALID", stdout.getvalue())


if __name__ == "__main__":
    unittest.main()
