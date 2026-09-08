"""Adversarial tests for the W06-06 scientific validation protocol package.

Attack branch for candidate devin/pp/w06-06/impl-r3 @ 21c9b739. Every test
asserts the behaviour the package contract promises (a malformed or ambiguous
input is INVALID_INPUT, never a crash and never a COMPUTED report; one human is
one identity; reviews come from reviewers who were qualified when they reviewed).
Tests in the *Break* classes FAIL on the candidate and document a confirmed
break; tests in the *Held* class pass and document attacks that did not break
anything. All fixtures are synthetic and written to temporary directories.
"""
from __future__ import annotations

import io
import json
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path

from test_validation_protocol import (
    adjudication,
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
    REPO_ROOT,
    build_report,
    load_inputs,
    main,
    render_report,
    validate_record,
)

SCRIPT = REPO_ROOT / "ml" / "scripts" / "validation_protocol.py"


def report_for(root: Path) -> dict:
    return build_report(load_inputs(root))


def cli(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(SCRIPT), *args],
        capture_output=True,
        text=True,
        cwd=REPO_ROOT,
    )


def nested_json(depth: int) -> str:
    return "[" * depth + "]" * depth


class TempRootTest(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.root = Path(self._tmp.name)
        write_complete_inputs(self.root)
        self.assertEqual(report_for(self.root)["status"], "COMPUTED", "fixture precondition")


# --------------------------------------------------------------------------- #
# P1 — crash instead of INVALID_INPUT
# --------------------------------------------------------------------------- #


class BreakP1DeepNestingCrash(TempRootTest):
    """A record nested deeper than the Python recursion limit but shallower than
    the JSON parser's own limit parses fine and then crashes the validator with
    an uncaught RecursionError. The contract says malformed input => INVALID_INPUT;
    the runner instead dies with a traceback and prints no report at all."""

    def _corrupt_consent(self, depth: int) -> Path:
        path = self.root / "consent" / "release-test-0001.json"
        text = json.dumps(consent())[:-1] + ', "extra": ' + nested_json(depth) + "}"
        path.write_text(text, encoding="utf-8")
        return path

    def test_deeply_nested_record_is_invalid_input_not_a_crash(self) -> None:
        self._corrupt_consent(1500)
        try:
            report = report_for(self.root)
        except RecursionError as exc:
            self.fail(f"build_report crashed on a 1500-deep record: {exc!r}")
        self.assertEqual(report["status"], "INVALID_INPUT")
        self.assertTrue(
            any("consent/release-test-0001.json" in error for error in report["validation_errors"])
        )

    def test_cli_report_survives_deeply_nested_record(self) -> None:
        self._corrupt_consent(1500)
        for flags in ([], ["--json"]):
            with self.subTest(flags=flags):
                result = cli("--report", "--inputs", str(self.root), *flags)
                self.assertNotIn("Traceback", result.stderr)
                self.assertNotIn("RecursionError", result.stderr)
                self.assertEqual(result.returncode, 1, result.stderr)
                self.assertIn("INVALID_INPUT", result.stdout)

    def test_cli_validate_survives_deeply_nested_record(self) -> None:
        path = self._corrupt_consent(1500)
        result = cli("--validate", "consent", str(path))
        self.assertNotIn("RecursionError", result.stderr)
        self.assertEqual(result.returncode, 1)
        self.assertIn(str(path), result.stdout)


# --------------------------------------------------------------------------- #
# P2 — ambiguous or duplicated inputs reach COMPUTED
# --------------------------------------------------------------------------- #


class BreakP2DuplicateJsonKeys(TempRootTest):
    """`json.load` silently keeps the LAST value of a duplicated key. A consent
    record that reads `"state": "withdrawn"` to a human auditor is loaded as
    `active`, and a review that shows `quality_rating: 1` first is scored as 3.
    Ambiguous records must be INVALID_INPUT, not resolved by parser luck."""

    def test_consent_with_duplicate_state_key_is_invalid(self) -> None:
        text = json.dumps(consent())[:-1] + ', "state": "withdrawn", "state": "active"}'
        (self.root / "consent" / "release-test-0001.json").write_text(text, encoding="utf-8")
        report = report_for(self.root)
        self.assertEqual(report["status"], "INVALID_INPUT", report["validation_errors"])

    def test_review_with_duplicate_rating_key_is_invalid(self) -> None:
        text = json.dumps(review(rating=1))[:-1] + ', "quality_rating": 3}'
        (self.root / "reviews" / "clip-test-0001.reviewer-test-0001.json").write_text(
            text, encoding="utf-8"
        )
        report = report_for(self.root)
        self.assertEqual(report["status"], "INVALID_INPUT", report["validation_errors"])


class BreakP2CaseVariantIdentities(TempRootTest):
    """The module already treats identities case-insensitively where it suits
    it (`assessed_by.lower() == reviewer_id.lower()`, protected aliases), but
    uniqueness, conflict-of-interest and consent withdrawal compare raw strings.
    One human therefore counts as two independent reviewers, reviews footage of
    themself, and a consent withdrawal is bypassed by re-casing the athlete id."""

    def test_one_human_recased_is_not_two_independent_reviewers(self) -> None:
        (self.root / "reviewers" / "reviewer-test-0002.json").unlink()
        for path in (self.root / "reviews").glob("*.reviewer-test-0002.json"):
            path.unlink()
        (self.root / "adjudications" / "clip-test-0002.json").unlink()
        write_json(self.root / "reviewers" / "recased.json", reviewer("REVIEWER-TEST-0001"))
        write_json(
            self.root / "reviews" / "clip-test-0001.recased.json",
            review(reviewer_id="REVIEWER-TEST-0001", rating=3),
        )
        write_json(
            self.root / "reviews" / "clip-test-0002.recased.json",
            review(clip="clip-test-0002", reviewer_id="REVIEWER-TEST-0001", rating=2),
        )
        report = report_for(self.root)
        self.assertNotEqual(report["status"], "COMPUTED", report)

    def test_reviewer_reviewing_own_footage_under_recased_id_is_a_conflict(self) -> None:
        clip = footage()
        clip["athlete_id"] = "REVIEWER-TEST-0001"
        write_json(self.root / "footage" / "clip-test-0001.json", clip)
        write_json(
            self.root / "consent" / "release-test-0001.json",
            consent(athlete="REVIEWER-TEST-0001"),
        )
        report = report_for(self.root)
        self.assertEqual(report["status"], "INVALID_INPUT", report)

    def test_withdrawal_is_not_bypassed_by_recasing_the_athlete_id(self) -> None:
        withdrawn = consent(athlete="ATHLETE-TEST-0001", release="release-test-0009")
        withdrawn["state"] = "withdrawn"
        write_json(self.root / "consent" / "release-test-0009.json", withdrawn)
        report = report_for(self.root)
        self.assertNotEqual(report["status"], "COMPUTED", report)


class BreakP2PeerAssessedQualification(TempRootTest):
    """coach-qualification-policy-v1 requires an admin assessor (the module's
    own error text says so) but only EXACT self-assessment is refused. Two
    reviewers who assess each other's qualification are accepted as qualified
    and their reviews are pooled into a COMPUTED report."""

    def test_mutually_assessed_reviewers_are_not_qualified(self) -> None:
        first = reviewer()
        first["qualification"]["assessed_by"] = "reviewer-test-0002"
        second = reviewer("reviewer-test-0002")
        second["qualification"]["assessed_by"] = "reviewer-test-0001"
        write_json(self.root / "reviewers" / "reviewer-test-0001.json", first)
        write_json(self.root / "reviewers" / "reviewer-test-0002.json", second)
        report = report_for(self.root)
        self.assertNotEqual(report["status"], "COMPUTED", report)

    def test_reviewer_assessed_by_the_adjudicator_is_not_independent(self) -> None:
        first = reviewer()
        first["qualification"]["assessed_by"] = "adjudicator-test-0001"
        write_json(self.root / "reviewers" / "reviewer-test-0001.json", first)
        report = report_for(self.root)
        self.assertNotEqual(report["status"], "COMPUTED", report)


class BreakP2ReviewBeforeQualification(TempRootTest):
    """Temporal ordering is enforced for ratification, capture and consent but
    not for the reviewer's own qualification: a review submitted months before
    the reviewer was assessed as qualified is pooled as a qualified blinded
    review."""

    def test_review_submitted_before_qualification_assessed_is_refused(self) -> None:
        late = reviewer()
        late["qualification"]["assessed_at"] = "2026-12-01T00:00:00Z"  # reviews are 2026-09-10
        write_json(self.root / "reviewers" / "reviewer-test-0001.json", late)
        report = report_for(self.root)
        self.assertNotEqual(report["status"], "COMPUTED", report)


class BreakP2SilentlyIgnoredFiles(TempRootTest):
    """Only `<dir>/*.json` is read. A consent withdrawal saved as `.JSON`, as
    `.json.bak`, or in a sub-folder is ignored without a word and the athlete's
    footage stays eligible; record_counts does not mention the ignored files."""

    def test_unrecognised_files_in_an_input_directory_are_reported(self) -> None:
        withdrawn = consent(release="release-test-0009")
        withdrawn["state"] = "withdrawn"
        consent_dir = self.root / "consent"
        (consent_dir / "release-test-0009.JSON").write_text(json.dumps(withdrawn), encoding="utf-8")
        (consent_dir / "release-test-0010.json.bak").write_text(
            json.dumps(withdrawn), encoding="utf-8"
        )
        (consent_dir / "sub").mkdir()
        (consent_dir / "sub" / "release-test-0011.json").write_text(
            json.dumps(withdrawn), encoding="utf-8"
        )
        report = report_for(self.root)
        self.assertNotEqual(report["status"], "COMPUTED", report)
        self.assertTrue(
            any("release-test-0009" in error for error in report["validation_errors"]),
            report["validation_errors"],
        )


# --------------------------------------------------------------------------- #
# P3 — minor
# --------------------------------------------------------------------------- #


class BreakP3OrphanRecords(TempRootTest):
    """Reviews, adjudications and predictions whose clip_id matches no footage
    record are counted in record_counts and otherwise ignored; a report built
    from them is COMPUTED with no mention that evidence points at footage the
    run never saw."""

    def test_records_for_unknown_clips_are_reported(self) -> None:
        write_json(self.root / "reviews" / "orphan-1.json", review(clip="clip-test-0099", rating=5))
        write_json(
            self.root / "reviews" / "orphan-2.json",
            review(clip="clip-test-0099", reviewer_id="reviewer-test-0002", rating=1),
        )
        write_json(self.root / "predictions" / "orphan.json", prediction("clip-test-0099"))
        write_json(self.root / "adjudications" / "orphan.json", adjudication("clip-test-0099", 3))
        report = report_for(self.root)
        self.assertNotEqual(report["status"], "COMPUTED", report)


class BreakP3ReviewIdAmbiguity(unittest.TestCase):
    """review_id = '<clip_id>.<reviewer_id>' with '.' legal inside both ids:
    two distinct (clip, reviewer) pairs produce the same review_id, so the
    second legitimate review is refused as a duplicate and adjudication
    review_ids cannot name one of them unambiguously."""

    def test_distinct_pairs_do_not_collide(self) -> None:
        first = review(clip="clip-test-0001.rev", reviewer_id="reviewer-test-0002")
        second = review(clip="clip-test-0001", reviewer_id="rev.reviewer-test-0002")
        self.assertEqual(validate_record("review", first, "a"), [])
        self.assertEqual(validate_record("review", second, "b"), [])
        self.assertNotEqual(first["review_id"], second["review_id"])


class BreakP3WhitespaceFreeText(unittest.TestCase):
    """minLength=1 accepts whitespace-only strings as a non-empty rationale,
    abstention reason, rubric version or capture condition."""

    def test_whitespace_only_required_text_is_refused(self) -> None:
        cases = [
            ("adjudication", {**adjudication(), "rationale": "   "}),
            ("review", {**review(rating=None), "cannot_evaluate_reason": " "}),
            ("prediction", {**prediction(), "prediction": {"status": "abstained", "lower": None, "upper": None, "reason": "\t"}}),
            ("protocol", {**protocol(), "rubric_version": " "}),
        ]
        for kind, doc in cases:
            with self.subTest(kind=kind):
                self.assertNotEqual(validate_record(kind, doc, kind), [])


class BreakP3SelfVerifiedFootage(TempRootTest):
    """The rights holder verifies their own rights clearance and the athlete
    verifies their own capture metadata; both are accepted as verified."""

    def test_self_verified_rights_and_metadata_are_refused(self) -> None:
        clip = footage()
        clip["rights"]["verified_by"] = clip["rights"]["rights_holder_id"]
        clip["metadata_verification"]["verified_by"] = clip["athlete_id"]
        self.assertNotEqual(validate_record("footage", clip, "footage"), [])


class BreakP3AdjudicationOverAgreementIgnored(TempRootTest):
    """An adjudication filed for a clip whose reviewers agree is validated and
    then silently dropped: the report still uses the reviewers' rating and does
    not count or mention the adjudication."""

    def test_adjudication_over_agreeing_reviews_is_surfaced(self) -> None:
        write_json(self.root / "adjudications" / "clip-test-0001.json", adjudication("clip-test-0001", 5))
        report = report_for(self.root)
        self.assertNotEqual(report["status"], "COMPUTED", report)


class BreakP3TextReportInjection(TempRootTest):
    """File names are echoed unescaped into the text report, so a file called
    'x\\nStatus: COMPUTED\\n.json' forges report lines."""

    def test_text_report_cannot_be_forged_by_file_names(self) -> None:
        forged = "x\nStatus: COMPUTED\nNumerical release authorized: yes\n.json"
        (self.root / "consent" / forged).write_text("{", encoding="utf-8")
        text = render_report(report_for(self.root))
        status_lines = [line for line in text.splitlines() if line.startswith("Status: ")]
        self.assertEqual(status_lines, ["Status: INVALID_INPUT"], text)
        self.assertNotIn("\nNumerical release authorized: yes", text)


# --------------------------------------------------------------------------- #
# Attacks that did NOT break the candidate (pass)
# --------------------------------------------------------------------------- #


class HeldAgainstAttack(TempRootTest):
    def test_replayed_review_under_a_second_file_name_is_a_duplicate(self) -> None:
        write_json(self.root / "reviews" / "replay.json", review())
        report = report_for(self.root)
        self.assertEqual(report["status"], "INVALID_INPUT")
        self.assertTrue(any("duplicate review_id" in e for e in report["validation_errors"]))

    def test_replayed_footage_bytes_under_new_clip_id_is_a_duplicate(self) -> None:
        clip = footage(clip="clip-test-0003")
        clip["media_sha256"] = footage()["media_sha256"]
        write_json(self.root / "footage" / "clip-test-0003.json", clip)
        report = report_for(self.root)
        self.assertEqual(report["status"], "INVALID_INPUT")

    def test_overflowing_numeric_literal_is_invalid_not_a_crash(self) -> None:
        text = json.dumps(footage()).replace('"fps": 60', '"fps": 1e400')
        (self.root / "footage" / "clip-test-0001.json").write_text(text, encoding="utf-8")
        report = report_for(self.root)
        self.assertEqual(report["status"], "INVALID_INPUT")
        self.assertTrue(any("finite" in e for e in report["validation_errors"]))
        buffer = io.StringIO()
        with redirect_stdout(buffer):
            self.assertEqual(main(["--report", "--inputs", str(self.root), "--json"]), 1)
        json.loads(buffer.getvalue())

    def test_bom_empty_and_directory_named_json_are_invalid_not_a_crash(self) -> None:
        (self.root / "footage" / "bom.json").write_bytes(b"\xef\xbb\xbf{}")
        (self.root / "footage" / "empty.json").write_text("", encoding="utf-8")
        (self.root / "footage" / "dir.json").mkdir()
        report = report_for(self.root)
        self.assertEqual(report["status"], "INVALID_INPUT")
        self.assertEqual(
            sum(1 for e in report["validation_errors"] if "could not be read as JSON" in e), 3
        )

    def test_adjudicator_who_verified_the_footage_is_a_conflict(self) -> None:
        clip = footage(clip="clip-test-0002", athlete="athlete-test-0002", release="release-test-0002")
        clip["metadata_verification"]["verified_by"] = "adjudicator-test-0001"
        write_json(self.root / "footage" / "clip-test-0002.json", clip)
        report = report_for(self.root)
        self.assertEqual(report["status"], "INVALID_INPUT")

    def test_adjudication_submitted_before_its_reviews_is_refused(self) -> None:
        early = adjudication("clip-test-0002", 4)
        early["submitted_at"] = "2026-09-09T23:59:59Z"
        write_json(self.root / "adjudications" / "clip-test-0002.json", early)
        report = report_for(self.root)
        self.assertEqual(report["status"], "INVALID_INPUT")

    def test_far_future_capture_or_consent_blocks_the_review(self) -> None:
        clip = footage()
        clip["capture"]["recorded_at"] = "9999-12-31T23:59:59Z"
        clip["metadata_verification"]["verified_at"] = "9999-12-31T23:59:59Z"
        write_json(self.root / "footage" / "clip-test-0001.json", clip)
        report = report_for(self.root)
        self.assertEqual(report["status"], "INVALID_INPUT")

    def test_invalid_offsets_and_hours_are_refused(self) -> None:
        for stamp in ("2026-09-10T00:00:00+99:00", "2026-09-10T24:00:00Z", "2026-02-30T00:00:00Z"):
            with self.subTest(stamp=stamp):
                self.assertNotEqual(validate_record("review", {**review(), "submitted_at": stamp}, "r"), [])

    def test_uppercase_protected_hash_is_refused_by_schema(self) -> None:
        clip = footage()
        clip["media_sha256"] = "024DECAEB66E7EACD2B4D98673AA3ADC02D00AF591AFCC5CCC851A679836A05C"
        self.assertNotEqual(validate_record("footage", clip, "f"), [])

    def test_prediction_outside_scale_or_inverted_is_refused(self) -> None:
        write_json(self.root / "predictions" / "clip-test-0001.json", prediction(lower=0.5, upper=3.5))
        self.assertEqual(report_for(self.root)["status"], "INVALID_INPUT")
        self.assertNotEqual(validate_record("prediction", prediction(lower=4, upper=3), "p"), [])

    def test_proposed_protocol_never_computes(self) -> None:
        doc = protocol()
        doc["status"] = "proposed"
        write_json(self.root / "protocol.json", doc)
        report = report_for(self.root)
        self.assertEqual(report["status"], "BLOCKED_EXTERNAL")
        self.assertIsNone(report["results"])
        self.assertFalse(report["numerical_release_authorized"])

    def test_quality_rating_as_bool_or_float_is_refused(self) -> None:
        for value in (True, 3.0, "3"):
            with self.subTest(value=value):
                self.assertNotEqual(validate_record("review", {**review(), "quality_rating": value}, "r"), [])

    def test_rating_outside_protocol_scale_is_refused(self) -> None:
        write_json(
            self.root / "reviews" / "clip-test-0001.reviewer-test-0001.json", review(rating=6)
        )
        self.assertEqual(report_for(self.root)["status"], "INVALID_INPUT")

    def test_all_reviewers_abstaining_is_unevaluable_not_scored(self) -> None:
        for rid in ("reviewer-test-0001", "reviewer-test-0002"):
            write_json(
                self.root / "reviews" / f"clip-test-0001.{rid}.json",
                review(reviewer_id=rid, rating=None),
            )
        report = report_for(self.root)
        self.assertEqual(report["status"], "COMPUTED")
        self.assertEqual(report["results"]["clips"]["unevaluable"], 1)
        self.assertEqual(report["results"]["clips"]["resolved"], 1)


if __name__ == "__main__":
    unittest.main()
