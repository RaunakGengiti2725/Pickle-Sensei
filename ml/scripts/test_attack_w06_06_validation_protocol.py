"""Adversarial tests for W06-06 (validation_protocol.py at 385cd06d).

Each test encodes the behaviour the protocol package MUST have at a failure
boundary; a failing test is a confirmed break of the candidate.  Fixtures are
the candidate's own synthetic in-memory helpers (no labels, coaches or metrics
are committed).  Attack categories:

  A1  protected-holdout bypass (media hash / substring / case)
  A2  adjudicator authored a review of the clip they adjudicate
  A3  NaN / Infinity boundary values reach gates and the JSON report
  A4  duplicate identities (credential_ref, media_sha256) counted as independent
  A5  coach-qualification policy v1 (self-assessment, SYNTHETIC identities)
  A6  temporal boundaries (review before consent/ratification, invalid calendar)
  A7  role enforcement (adjudicator-only reviewer counted as blinded reviewer)
  A8  corrupt / partial persisted state (null record, deep nesting, big ints)
  A9  frozen-candidate mixing (multiple model versions pooled into one result)
  A10 consent withdrawal bypass via a second release record
  A11 conflict of interest (reviewer verified the footage / is the athlete)
  A12 zero-rating clips scored from adjudicator alone
"""

from __future__ import annotations

import io
import json
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path

from test_validation_protocol import (
    consent,
    footage,
    prediction,
    protocol,
    review,
    reviewer,
    write_complete_inputs,
    write_json,
)
from validation_protocol import (
    PROTECTED_HOLDOUT_IDS,
    build_report,
    load_inputs,
    main,
    validate_record,
)

# Source hashes the existing benchmark release gate (packages/evaluation/src/
# benchmarkRelease.ts, protectedSourceHashes) refuses; both resolve to protected
# sessions in datasets/corpus/recordings.json.
PROTECTED_MEDIA_SHA256 = (
    "024decaeb66e7eacd2b4d98673aa3adc02d00af591afcc5ccc851a679836a05c",  # afn-vic-rally1
    "7d396a6d65669fc3b7fc3c33988e257be08f830e93ca20c51f38171fca0959a7",  # wm-tournament-2014
)


def run_report(root: Path) -> dict:
    return build_report(load_inputs(root))


def run_cli_json(root: Path) -> tuple[int, str]:
    out = io.StringIO()
    with redirect_stdout(out):
        code = main(["--report", "--json", "--inputs", str(root)])
    return code, out.getvalue()


def strict_json_loads(text: str) -> object:
    def refuse(constant: str) -> object:
        raise ValueError(f"non-finite JSON constant {constant}")

    return json.loads(text, parse_constant=refuse)


def missing_ids(report: dict) -> set[str]:
    return {entry["input"] for entry in report["missing_inputs"]}


class A1ProtectedHoldoutBypass(unittest.TestCase):
    def test_protected_media_hash_under_fresh_clip_id_is_refused(self) -> None:
        for digest in PROTECTED_MEDIA_SHA256:
            with self.subTest(digest=digest[:12]):
                doc = footage(clip="clip-recut-0001")
                doc["session_id"] = "session-recut-0001"
                doc["media_sha256"] = digest
                errors = validate_record("footage", doc, "footage/clip-recut-0001")
                self.assertTrue(
                    any("protected" in e.lower() for e in errors),
                    f"protected source hash accepted under alias: {errors}",
                )

    def test_protected_id_as_prefix_or_case_variant_is_refused(self) -> None:
        variants = []
        for protected in sorted(PROTECTED_HOLDOUT_IDS):
            variants.append(protected.upper())
            variants.append(protected + "-recut-0001")
        for alias in variants:
            with self.subTest(alias=alias):
                doc = footage(clip=alias)
                errors = validate_record("footage", doc, f"footage/{alias}")
                self.assertTrue(
                    any("protected" in e.lower() for e in errors),
                    f"protected holdout alias {alias!r} accepted: {errors}",
                )


class A2AdjudicatorAuthoredReview(unittest.TestCase):
    def test_adjudicator_who_reviewed_clip_under_omitted_review_id_is_refused(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            write_complete_inputs(root)
            # The adjudicator also reviewed clip-test-0002 but the adjudication
            # record simply omits their own review from review_ids.
            write_json(
                root / "reviews" / "clip-test-0002.adjudicator-test-0001.json",
                review(clip="clip-test-0002", reviewer_id="adjudicator-test-0001", rating=5),
            )
            report = run_report(root)
            self.assertEqual(report["status"], "INVALID_INPUT", report)
            self.assertTrue(
                any("adjudicator" in e and "review" in e for e in report["validation_errors"]),
                report["validation_errors"],
            )


class A3NonFiniteBoundaryValues(unittest.TestCase):
    def test_non_finite_protocol_targets_are_invalid(self) -> None:
        doc = protocol()
        doc["targets"]["player_weighted_mae_maximum"] = float("inf")
        doc["targets"]["median_width_maximum"] = float("nan")
        errors = validate_record("protocol", doc, "protocol.json")
        self.assertTrue(errors, "Infinity / NaN preregistered targets accepted")

    def test_non_finite_numbers_never_reach_gates_or_json_report(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            write_complete_inputs(root)
            doc = protocol()
            doc["targets"]["player_weighted_mae_maximum"] = float("inf")
            doc["targets"]["median_width_maximum"] = float("nan")
            (root / "protocol.json").write_text(json.dumps(doc))
            clip = footage()
            clip["capture"]["fps"] = float("nan")
            (root / "footage" / "clip-test-0001.json").write_text(json.dumps(clip))
            report = run_report(root)
            self.assertEqual(report["status"], "INVALID_INPUT", report["status"])
            code, text = run_cli_json(root)
            self.assertEqual(code, 1)
            strict_json_loads(text)  # RFC 8259 output: no NaN/Infinity tokens
            for gate in report.get("results", {}).get("gates", []) if report["results"] else []:
                self.assertNotEqual(gate["verdict"], "MET", gate)


class A4DuplicateIdentities(unittest.TestCase):
    def test_reviewers_sharing_credential_ref_are_not_distinct(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            write_complete_inputs(root)
            refs = {
                json.loads((root / "reviewers" / f"{rid}.json").read_text())["credential_ref"]
                for rid in ("reviewer-test-0001", "reviewer-test-0002", "adjudicator-test-0001")
            }
            self.assertEqual(len(refs), 1, "precondition: fixture reuses one credential_ref")
            report = run_report(root)
            self.assertNotEqual(
                report["status"],
                "COMPUTED",
                "three reviewer ids backed by one credential were treated as independent",
            )

    def test_footage_sharing_media_sha256_is_not_two_independent_clips(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            write_complete_inputs(root)
            first = json.loads((root / "footage" / "clip-test-0001.json").read_text())
            second = json.loads((root / "footage" / "clip-test-0002.json").read_text())
            self.assertEqual(first["media_sha256"], second["media_sha256"], "precondition")
            report = run_report(root)
            self.assertNotEqual(
                report["status"],
                "COMPUTED",
                "same media bytes under two clip ids counted as two independent clips",
            )


class A5CoachQualificationPolicyV1(unittest.TestCase):
    def test_self_assessed_reviewer_is_refused(self) -> None:
        doc = reviewer()
        doc["qualification"]["assessed_by"] = doc["reviewer_id"]
        errors = validate_record("reviewer", doc, "reviewers/self")
        self.assertTrue(errors, "reviewer certified their own qualification")

    def test_synthetic_identities_are_refused(self) -> None:
        doc = reviewer("SYNTHETIC-reviewer-0001")
        doc["credential_ref"] = "SYNTHETIC-cred-0001"
        errors = validate_record("reviewer", doc, "reviewers/synthetic")
        self.assertTrue(errors, "SYNTHETIC dev-fixture identity accepted as a coach")

    def test_synthetic_reviewer_never_yields_computed_report(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            write_complete_inputs(root)
            doc = reviewer("reviewer-test-0002")
            doc["qualification"]["assessed_by"] = "SYNTHETIC-admin-0001"
            write_json(root / "reviewers" / "reviewer-test-0002.json", doc)
            report = run_report(root)
            self.assertNotEqual(report["status"], "COMPUTED", report["status"])


class A6TemporalBoundaries(unittest.TestCase):
    def test_invalid_calendar_timestamp_is_refused(self) -> None:
        doc = consent()
        doc["signed_at"] = "9999-99-99T99:99:99Z"
        errors = validate_record("consent", doc, "consent/bad-date")
        self.assertTrue(errors, "month 99 / hour 99 accepted as a date-time")

    def test_review_submitted_before_consent_and_ratification_is_refused(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            write_complete_inputs(root)
            doc = review()
            doc["submitted_at"] = "2020-01-01T00:00:00Z"
            write_json(root / "reviews" / "clip-test-0001.reviewer-test-0001.json", doc)
            report = run_report(root)
            self.assertEqual(report["status"], "INVALID_INPUT", report["status"])


class A7RoleEnforcement(unittest.TestCase):
    def test_adjudicator_only_reviewer_does_not_count_as_blinded_reviewer(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            write_complete_inputs(root)
            write_json(
                root / "reviewers" / "reviewer-test-0002.json",
                reviewer("reviewer-test-0002", ["adjudicator"]),
            )
            report = run_report(root)
            self.assertNotEqual(report["status"], "COMPUTED", report["status"])
            self.assertTrue(
                report["validation_errors"] or "blinded_reviews" in missing_ids(report),
                report,
            )


class A8CorruptPartialState(unittest.TestCase):
    def test_null_record_file_is_invalid_not_silently_absent(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            write_complete_inputs(root)
            (root / "footage" / "corrupt-null.json").write_text("null")
            (root / "predictions" / "clip-test-0001.json").write_text("null")
            report = run_report(root)
            self.assertEqual(report["status"], "INVALID_INPUT", report)

    def test_deeply_nested_json_does_not_crash_the_runner(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            write_complete_inputs(root)
            (root / "footage" / "deep.json").write_text("[" * 100_000 + "]" * 100_000)
            try:
                report = run_report(root)
            except RecursionError as exc:
                self.fail(f"runner crashed on corrupt input: {exc!r}")
            self.assertEqual(report["status"], "INVALID_INPUT", report["status"])

    def test_huge_integer_bounds_do_not_crash_the_runner(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            write_complete_inputs(root)
            doc = protocol()
            doc["rating_scale"] = {"id": "scale-huge", "minimum": -(10**400), "maximum": 10**400}
            (root / "protocol.json").write_text(json.dumps(doc))
            pred = prediction()
            pred["prediction"]["lower"] = -(10**400)
            pred["prediction"]["upper"] = 10**400
            (root / "predictions" / "clip-test-0001.json").write_text(json.dumps(pred))
            try:
                report = run_report(root)
            except OverflowError as exc:
                self.fail(f"runner crashed on out-of-range integer: {exc!r}")
            self.assertEqual(report["status"], "INVALID_INPUT", report["status"])


class A9FrozenCandidateMixing(unittest.TestCase):
    def test_predictions_from_two_model_versions_are_not_pooled(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            write_complete_inputs(root)
            doc = prediction("clip-test-0002", 1.0, 2.0)
            doc["subject"]["model_version"] = "model-test-v2"
            write_json(root / "predictions" / "clip-test-0002.json", doc)
            report = run_report(root)
            self.assertNotEqual(
                report["status"],
                "COMPUTED",
                f"mixed subjects pooled: {report['results'] and report['results']['candidate']['subject_versions']}",
            )


class A10ConsentWithdrawalBypass(unittest.TestCase):
    def test_withdrawn_athlete_is_not_eligible_via_second_release(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            write_complete_inputs(root)
            withdrawn = consent()
            withdrawn["state"] = "withdrawn"
            withdrawn["signed_at"] = "2026-08-20T00:00:00Z"
            write_json(root / "consent" / "release-test-0001.json", withdrawn)
            write_json(root / "consent" / "release-test-0009.json", consent(release="release-test-0009"))
            write_json(root / "footage" / "clip-test-0001.json", footage(release="release-test-0009"))
            report = run_report(root)
            self.assertNotEqual(report["status"], "COMPUTED", report["status"])


class A11ConflictOfInterest(unittest.TestCase):
    def test_reviewer_cannot_be_footage_verifier_or_athlete(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            write_complete_inputs(root)
            doc = footage()
            doc["metadata_verification"]["verified_by"] = "reviewer-test-0001"
            doc["rights"]["verified_by"] = "reviewer-test-0001"
            write_json(root / "footage" / "clip-test-0001.json", doc)
            write_json(
                root / "footage" / "clip-test-0002.json",
                footage(clip="clip-test-0002", athlete="reviewer-test-0002", release="release-test-0002"),
            )
            write_json(
                root / "consent" / "release-test-0002.json",
                consent(athlete="reviewer-test-0002", release="release-test-0002"),
            )
            report = run_report(root)
            self.assertEqual(report["status"], "INVALID_INPUT", report["status"])


class A12ZeroRatingClipScored(unittest.TestCase):
    def test_clip_with_no_reviewer_rating_is_not_a_scored_target(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            write_complete_inputs(root)
            write_json(
                root / "reviews" / "clip-test-0002.reviewer-test-0001.json",
                review(clip="clip-test-0002", rating=None),
            )
            write_json(
                root / "reviews" / "clip-test-0002.reviewer-test-0002.json",
                review(clip="clip-test-0002", reviewer_id="reviewer-test-0002", rating=None),
            )
            report = run_report(root)
            if report["status"] == "COMPUTED":
                self.assertLess(
                    report["results"]["clips"]["resolved"],
                    2,
                    "clip with two abstentions became a scored target from one adjudicator",
                )


if __name__ == "__main__":
    unittest.main()
