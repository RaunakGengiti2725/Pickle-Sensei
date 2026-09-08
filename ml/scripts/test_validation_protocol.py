"""Unit tests for the scientific validation protocol package (W06-06).

All fixtures below are synthetic, in-memory or written to a temporary directory
created by the test itself. Nothing here is a real label, a real coach or a real
measurement, and nothing is committed under datasets/.
"""
from __future__ import annotations

import copy
import io
import json
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path

from validation_protocol import (
    DEFAULT_INPUT_ROOT,
    EXTERNAL_INPUT_IDS,
    INPUT_KINDS,
    PROTECTED_HOLDOUT_IDS,
    PROTOCOL_SCHEMA_VERSION,
    SCHEMAS,
    build_report,
    load_inputs,
    main,
    render_report,
    validate_record,
)


def protocol() -> dict:
    return {
        "schema_version": PROTOCOL_SCHEMA_VERSION,
        "protocol_id": "test-protocol-0001",
        "status": "ratified",
        "ratified_by": ["owner-test-0001", "adjudicator-test-0001"],
        "ratified_at": "2026-09-01T00:00:00Z",
        "frozen_before_evaluation": True,
        "rubric_version": "technique-quality-5pt-v1",
        "blind_protocol_version": "blind-review-v1",
        "rating_scale": {"id": "technique-quality-5pt-v1", "minimum": 1, "maximum": 5},
        "minimum_reviewers_per_clip": 2,
        "minimum_independent_athletes": 1,
        "targets": {
            "coach_exact_agreement_minimum": 0.5,
            "player_weighted_mae_maximum": 1.0,
            "range_coverage_minimum": 0.5,
            "median_width_maximum": 2.0,
        },
        "excluded_case_ids": [],
    }


def consent(athlete: str = "athlete-test-0001", release: str = "release-test-0001") -> dict:
    return {
        "participant_release_id": release,
        "athlete_id": athlete,
        "terms_version": "consent-terms-v1",
        "signed_at": "2026-08-01T00:00:00Z",
        "age_class": "adult",
        "guardian_release_id": None,
        "permissions": {
            "product_evaluation": True,
            "internal_human_review": True,
            "derived_features": True,
            "commercial_model_training": False,
        },
        "withdrawal_process_version": "withdrawal-v1",
        "state": "active",
    }


def footage(
    clip: str = "clip-test-0001",
    athlete: str = "athlete-test-0001",
    release: str = "release-test-0001",
) -> dict:
    return {
        "clip_id": clip,
        "media_sha256": "a" * 64,
        "athlete_id": athlete,
        "athlete_group_id": "group-test-0001",
        "session_id": "session-test-0001",
        "source": "consented_first_party_capture",
        "participant_release_id": release,
        "capture": {
            "recorded_at": "2026-08-02T00:00:00Z",
            "device_os": "ios",
            "camera_view": "dominant_side",
            "fps": 60,
            "resolution": "1920x1080",
            "capture_conditions": "indoor_court",
            "handedness": "right",
        },
        "metadata_verification": {
            "verified_by": "verifier-test-0001",
            "verified_at": "2026-08-03T00:00:00Z",
            "method": "device_log_confirmed",
        },
        "rights": {
            "rights_holder_id": "rights-holder-test-0001",
            "commercial_training_grant_id": None,
            "evidence_ref": "evidence-ref-test-0001",
            "verified_by": "verifier-test-0001",
            "verified_at": "2026-08-03T00:00:00Z",
            "state": "cleared",
        },
        "player_rating": None,
    }


def reviewer(reviewer_id: str = "reviewer-test-0001", roles: list[str] | None = None) -> dict:
    return {
        "reviewer_id": reviewer_id,
        "roles": roles or ["reviewer"],
        "qualification_policy_version": "coach-qualification-policy-v1",
        "credential_ref": "credential-ref-test-0001",
        "qualification": {
            "verdict": "qualified",
            "satisfied_criteria": ["criterion.certification"],
            "evidence": [
                {"criterion": "criterion.certification", "verification_method": "issuer_confirmed"}
            ],
            "assessed_by": "admin-test-0001",
            "assessed_at": "2026-07-01T00:00:00Z",
        },
    }


def review(
    clip: str = "clip-test-0001",
    reviewer_id: str = "reviewer-test-0001",
    rating: int | None = 3,
) -> dict:
    return {
        "review_id": f"{clip}.{reviewer_id}",
        "clip_id": clip,
        "reviewer_id": reviewer_id,
        "blinding": {
            "protocol_version": "blind-review-v1",
            "model_output_disclosed": False,
            "other_reviews_disclosed": False,
            "athlete_identity_disclosed": False,
        },
        "rubric_version": "technique-quality-5pt-v1",
        "outcome": "rated" if rating is not None else "cannot_evaluate",
        "technique": "drive_forehand",
        "quality_rating": rating,
        "cannot_evaluate_reason": None if rating is not None else "occluded contact",
        "confidence": 0.8,
        "submitted_at": "2026-08-10T00:00:00Z",
    }


def adjudication(clip: str = "clip-test-0001", rating: int = 3) -> dict:
    return {
        "clip_id": clip,
        "adjudicator_id": "adjudicator-test-0001",
        "review_ids": [f"{clip}.reviewer-test-0001", f"{clip}.reviewer-test-0002"],
        "resolved_rating": rating,
        "rationale": "reviewers disagreed on follow-through; adjudicated from the blinded frames",
        "submitted_at": "2026-08-11T00:00:00Z",
    }


def prediction(clip: str = "clip-test-0001", lower: float = 2.5, upper: float = 3.5) -> dict:
    return {
        "clip_id": clip,
        "subject": {
            "pipeline_version": "pipeline-test-v1",
            "scoring_definition_version": "scoring-test-v1",
            "model_version": "model-test-v1",
        },
        "prediction": {"status": "range", "lower": lower, "upper": upper, "reason": None},
    }


def write_json(path: Path, doc: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(doc, indent=2) + "\n", encoding="utf-8")


def write_complete_inputs(root: Path) -> None:
    write_json(root / "protocol.json", protocol())
    write_json(root / "consent" / "release-test-0001.json", consent())
    write_json(
        root / "consent" / "release-test-0002.json",
        consent(athlete="athlete-test-0002", release="release-test-0002"),
    )
    write_json(root / "footage" / "clip-test-0001.json", footage())
    write_json(
        root / "footage" / "clip-test-0002.json",
        footage(clip="clip-test-0002", athlete="athlete-test-0002", release="release-test-0002"),
    )
    write_json(root / "reviewers" / "reviewer-test-0001.json", reviewer())
    write_json(root / "reviewers" / "reviewer-test-0002.json", reviewer("reviewer-test-0002"))
    write_json(
        root / "reviewers" / "adjudicator-test-0001.json",
        reviewer("adjudicator-test-0001", ["reviewer", "adjudicator"]),
    )
    write_json(root / "reviews" / "clip-test-0001.reviewer-test-0001.json", review())
    write_json(
        root / "reviews" / "clip-test-0001.reviewer-test-0002.json",
        review(reviewer_id="reviewer-test-0002", rating=3),
    )
    write_json(
        root / "reviews" / "clip-test-0002.reviewer-test-0001.json",
        review(clip="clip-test-0002", rating=2),
    )
    write_json(
        root / "reviews" / "clip-test-0002.reviewer-test-0002.json",
        review(clip="clip-test-0002", reviewer_id="reviewer-test-0002", rating=4),
    )
    write_json(root / "adjudications" / "clip-test-0002.json", adjudication("clip-test-0002", 4))
    write_json(root / "predictions" / "clip-test-0001.json", prediction())
    write_json(root / "predictions" / "clip-test-0002.json", prediction("clip-test-0002", 1.0, 2.0))


class SchemaContractTest(unittest.TestCase):
    def test_every_input_kind_has_a_schema_and_owner(self) -> None:
        self.assertEqual(
            set(SCHEMAS),
            {
                "protocol",
                "consent",
                "footage",
                "reviewer",
                "review",
                "adjudication",
                "prediction",
            },
        )
        for kind in INPUT_KINDS:
            self.assertIn(kind["schema"], SCHEMAS)
            self.assertIn(kind["owner"], {"external", "internal"})
        self.assertEqual(DEFAULT_INPUT_ROOT, Path("datasets/validation-protocol"))
        self.assertTrue(PROTECTED_HOLDOUT_IDS >= {"wm-dink-01", "afn-vic-rally1"})

    def test_valid_fixtures_pass_every_validator(self) -> None:
        self.assertEqual(validate_record("protocol", protocol(), "p"), [])
        self.assertEqual(validate_record("consent", consent(), "c"), [])
        self.assertEqual(validate_record("footage", footage(), "f"), [])
        self.assertEqual(validate_record("reviewer", reviewer(), "r"), [])
        self.assertEqual(validate_record("review", review(), "rv"), [])
        self.assertEqual(validate_record("adjudication", adjudication(), "a"), [])
        self.assertEqual(validate_record("prediction", prediction(), "pr"), [])

    def test_unknown_and_missing_fields_are_rejected(self) -> None:
        doc = consent()
        doc["email"] = "someone@example.com"
        errors = validate_record("consent", doc, "c")
        self.assertTrue(any("unknown field" in e and "email" in e for e in errors))
        doc = footage()
        del doc["media_sha256"]
        errors = validate_record("footage", doc, "f")
        self.assertTrue(any("missing required field" in e and "media_sha256" in e for e in errors))
        self.assertTrue(validate_record("footage", ["not", "an", "object"], "f"))

    def test_identifiers_must_be_opaque(self) -> None:
        doc = consent()
        doc["athlete_id"] = "jane.doe@example.com"
        errors = validate_record("consent", doc, "c")
        self.assertTrue(any("athlete_id" in e for e in errors))
        doc = footage()
        doc["media_sha256"] = "not-a-hash"
        self.assertTrue(any("media_sha256" in e for e in validate_record("footage", doc, "f")))

    def test_minor_consent_requires_guardian_release(self) -> None:
        doc = consent()
        doc["age_class"] = "minor"
        errors = validate_record("consent", doc, "c")
        self.assertTrue(any("guardian_release_id" in e for e in errors))
        doc["guardian_release_id"] = "guardian-release-test-0001"
        self.assertEqual(validate_record("consent", doc, "c"), [])
        adult = consent()
        adult["guardian_release_id"] = "guardian-release-test-0001"
        self.assertTrue(any("guardian_release_id" in e for e in validate_record("consent", adult, "c")))

    def test_protected_holdouts_are_refused_as_footage(self) -> None:
        for protected in sorted(PROTECTED_HOLDOUT_IDS):
            doc = footage(clip=protected)
            errors = validate_record("footage", doc, "f")
            self.assertTrue(any("protected holdout" in e for e in errors), protected)
        doc = footage()
        doc["session_id"] = "afn-vic-2025"
        self.assertTrue(any("protected holdout" in e for e in validate_record("footage", doc, "f")))

    def test_footage_rejects_third_party_or_unknown_sources(self) -> None:
        doc = footage()
        doc["source"] = "third_party_broadcast"
        self.assertTrue(any("source" in e for e in validate_record("footage", doc, "f")))
        doc = footage()
        doc["capture"]["camera_view"] = "broadcast"
        self.assertTrue(any("camera_view" in e for e in validate_record("footage", doc, "f")))

    def test_reviewer_qualification_needs_verified_evidence(self) -> None:
        doc = reviewer()
        doc["qualification"]["evidence"][0]["verification_method"] = "unverified_disclosed"
        errors = validate_record("reviewer", doc, "r")
        self.assertTrue(any("unverified_disclosed" in e for e in errors))
        doc = reviewer()
        doc["qualification"]["satisfied_criteria"] = ["criterion.professional-coaching-history"]
        errors = validate_record("reviewer", doc, "r")
        self.assertTrue(any("criterion.professional-coaching-history" in e for e in errors))
        doc = reviewer()
        doc["qualification"]["verdict"] = "qualified"
        doc["qualification"]["satisfied_criteria"] = []
        self.assertTrue(validate_record("reviewer", doc, "r"))

    def test_review_must_be_blinded_and_internally_consistent(self) -> None:
        doc = review()
        doc["blinding"]["model_output_disclosed"] = True
        self.assertTrue(any("model_output_disclosed" in e for e in validate_record("review", doc, "rv")))
        doc = review()
        doc["review_id"] = "wrong-id-0001"
        self.assertTrue(any("review_id" in e for e in validate_record("review", doc, "rv")))
        doc = review(rating=None)
        self.assertEqual(validate_record("review", doc, "rv"), [])
        doc["quality_rating"] = 3
        self.assertTrue(any("cannot_evaluate" in e for e in validate_record("review", doc, "rv")))
        doc = review()
        doc["cannot_evaluate_reason"] = "but also rated"
        self.assertTrue(any("cannot_evaluate_reason" in e for e in validate_record("review", doc, "rv")))
        doc = review()
        doc["quality_rating"] = None
        self.assertTrue(any("quality_rating" in e for e in validate_record("review", doc, "rv")))
        doc = review()
        doc["technique"] = "tennis_serve"
        self.assertTrue(any("technique" in e for e in validate_record("review", doc, "rv")))
        doc = review()
        doc["confidence"] = 1.5
        self.assertTrue(any("confidence" in e for e in validate_record("review", doc, "rv")))

    def test_prediction_range_must_be_ordered_and_abstention_needs_reason(self) -> None:
        doc = prediction(lower=4, upper=2)
        self.assertTrue(any("lower" in e for e in validate_record("prediction", doc, "pr")))
        doc = prediction()
        doc["prediction"] = {"status": "abstained", "lower": None, "upper": None, "reason": None}
        self.assertTrue(any("reason" in e for e in validate_record("prediction", doc, "pr")))
        doc["prediction"]["reason"] = "unsupported camera view"
        self.assertEqual(validate_record("prediction", doc, "pr"), [])

    def test_protocol_ratification_requires_signatories_and_freeze(self) -> None:
        doc = protocol()
        doc["ratified_by"] = []
        self.assertTrue(any("ratified_by" in e for e in validate_record("protocol", doc, "p")))
        doc = protocol()
        doc["frozen_before_evaluation"] = False
        self.assertTrue(any("frozen_before_evaluation" in e for e in validate_record("protocol", doc, "p")))
        doc = protocol()
        doc["minimum_reviewers_per_clip"] = 1
        self.assertTrue(any("minimum_reviewers_per_clip" in e for e in validate_record("protocol", doc, "p")))
        proposed = protocol()
        proposed.update({"status": "proposed", "ratified_by": [], "ratified_at": None})
        self.assertEqual(validate_record("protocol", proposed, "p"), [])


class ReportTest(unittest.TestCase):
    def test_missing_root_reports_blocked_external_with_every_owner_input(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "does-not-exist"
            inputs = load_inputs(root)
            report = build_report(inputs)
        self.assertEqual(report["status"], "BLOCKED_EXTERNAL")
        self.assertFalse(report["numerical_release_authorized"])
        self.assertIsNone(report["results"])
        missing_ids = {entry["input"] for entry in report["missing_inputs"]}
        self.assertTrue(EXTERNAL_INPUT_IDS <= missing_ids)
        for entry in report["missing_inputs"]:
            self.assertIn(entry["owner"], {"external", "internal"})
            self.assertTrue(entry["what_is_missing"])
            self.assertTrue(entry["expected_path"])
        self.assertEqual(report["record_counts"]["footage"], 0)
        self.assertEqual(report["record_counts"]["reviews"], 0)
        text = render_report(report)
        self.assertIn("BLOCKED_EXTERNAL", text)
        for name in (
            "consented footage",
            "verified capture metadata",
            "qualified blinded reviewers",
            "adjudication",
            "ratified protocol",
        ):
            self.assertIn(name, text)

    def test_default_root_in_repo_has_zero_labels_and_blocks(self) -> None:
        repo_root = Path(__file__).resolve().parents[2]
        report = build_report(load_inputs(repo_root / DEFAULT_INPUT_ROOT))
        self.assertEqual(report["status"], "BLOCKED_EXTERNAL")
        self.assertEqual(sum(report["record_counts"].values()), 0)

    def test_cli_report_exits_zero_and_prints_missing_inputs(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            out = io.StringIO()
            with redirect_stdout(out):
                code = main(["--report", "--inputs", str(Path(tmp) / "empty")])
            text = out.getvalue()
            self.assertEqual(code, 0)
            self.assertIn("Status: BLOCKED_EXTERNAL", text)
            self.assertIn("consented footage", text)
            self.assertIn("adjudication", text)
            out = io.StringIO()
            with redirect_stdout(out):
                code = main(["--report", "--json", "--inputs", str(Path(tmp) / "empty")])
            self.assertEqual(code, 0)
            parsed = json.loads(out.getvalue())
            self.assertEqual(parsed["status"], "BLOCKED_EXTERNAL")

    def test_partial_inputs_name_exactly_what_is_still_missing(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            write_json(root / "protocol.json", protocol())
            write_json(root / "consent" / "release-test-0001.json", consent())
            write_json(root / "footage" / "clip-test-0001.json", footage())
            write_json(root / "reviewers" / "reviewer-test-0001.json", reviewer())
            report = build_report(load_inputs(root))
        self.assertEqual(report["status"], "BLOCKED_EXTERNAL")
        missing = {entry["input"]: entry for entry in report["missing_inputs"]}
        self.assertNotIn("ratified_protocol", missing)
        self.assertNotIn("consented_footage", missing)
        self.assertNotIn("verified_capture_metadata", missing)
        self.assertIn("qualified_blinded_reviewers", missing)
        self.assertIn("blinded_reviews", missing)
        self.assertIn("clip-test-0001", missing["blinded_reviews"]["what_is_missing"])
        self.assertIn("candidate_predictions", missing)
        self.assertEqual(missing["candidate_predictions"]["owner"], "internal")

    def test_unverified_metadata_and_withdrawn_consent_are_named(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            write_json(root / "protocol.json", protocol())
            withdrawn = consent()
            withdrawn["state"] = "withdrawn"
            write_json(root / "consent" / "release-test-0001.json", withdrawn)
            clip = footage()
            clip["metadata_verification"] = None
            clip["rights"]["state"] = "pending"
            write_json(root / "footage" / "clip-test-0001.json", clip)
            report = build_report(load_inputs(root))
        missing = {entry["input"]: entry for entry in report["missing_inputs"]}
        self.assertIn("clip-test-0001", missing["consented_footage"]["what_is_missing"])
        self.assertIn("clip-test-0001", missing["verified_capture_metadata"]["what_is_missing"])
        self.assertIn("clip-test-0001", missing["rights_clearance"]["what_is_missing"])
        self.assertEqual(report["status"], "BLOCKED_EXTERNAL")

    def test_disagreement_without_adjudication_blocks(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            write_complete_inputs(root)
            (root / "adjudications" / "clip-test-0002.json").unlink()
            report = build_report(load_inputs(root))
        missing = {entry["input"]: entry for entry in report["missing_inputs"]}
        self.assertEqual(report["status"], "BLOCKED_EXTERNAL")
        self.assertEqual(set(missing), {"adjudication"})
        self.assertIn("clip-test-0002", missing["adjudication"]["what_is_missing"])

    def test_adjudicator_must_not_be_one_of_the_blinded_reviewers(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            write_complete_inputs(root)
            doc = adjudication("clip-test-0002", 4)
            doc["adjudicator_id"] = "reviewer-test-0001"
            write_json(root / "adjudications" / "clip-test-0002.json", doc)
            report = build_report(load_inputs(root))
        self.assertEqual(report["status"], "INVALID_INPUT")
        self.assertTrue(any("adjudicator" in e for e in report["validation_errors"]))

    def test_unqualified_reviewer_does_not_count(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            write_complete_inputs(root)
            doc = reviewer("reviewer-test-0002")
            doc["qualification"]["verdict"] = "not_qualified"
            doc["qualification"]["satisfied_criteria"] = []
            doc["qualification"]["evidence"] = []
            write_json(root / "reviewers" / "reviewer-test-0002.json", doc)
            report = build_report(load_inputs(root))
        missing = {entry["input"]: entry for entry in report["missing_inputs"]}
        self.assertEqual(report["status"], "BLOCKED_EXTERNAL")
        self.assertIn("blinded_reviews", missing)
        self.assertIn("reviewer-test-0002", missing["blinded_reviews"]["what_is_missing"])

    def test_malformed_input_is_invalid_not_blocked(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            write_complete_inputs(root)
            (root / "footage" / "broken.json").write_text("{not json", encoding="utf-8")
            inputs = load_inputs(root)
            report = build_report(inputs)
            out = io.StringIO()
            with redirect_stdout(out):
                code = main(["--report", "--inputs", str(root)])
        self.assertEqual(report["status"], "INVALID_INPUT")
        self.assertFalse(report["numerical_release_authorized"])
        self.assertTrue(any("broken.json" in e for e in report["validation_errors"]))
        self.assertEqual(code, 1)
        self.assertIn("INVALID_INPUT", out.getvalue())

    def test_complete_inputs_compute_results_without_authorizing_release(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            write_complete_inputs(root)
            report = build_report(load_inputs(root))
        self.assertEqual(report["status"], "COMPUTED")
        self.assertEqual(report["missing_inputs"], [])
        self.assertFalse(report["numerical_release_authorized"])
        self.assertEqual(report["release_decision"], "human")
        results = report["results"]
        self.assertEqual(results["clips"]["eligible"], 2)
        self.assertEqual(results["clips"]["resolved"], 2)
        self.assertEqual(results["clips"]["independent_athletes"], 2)
        agreement = results["reviewer_agreement"]
        self.assertEqual(agreement["clips_with_multiple_reviews"], 2)
        self.assertEqual(agreement["exact_agreement_rate"], 0.5)
        self.assertEqual(agreement["mean_absolute_difference"], 1.0)
        self.assertEqual(agreement["adjudicated_clips"], 1)
        candidate = results["candidate"]
        self.assertEqual(candidate["numerical_outputs"], 2)
        self.assertEqual(candidate["abstentions"], 0)
        # clip 1 target 3 inside [2.5, 3.5]; clip 2 adjudicated target 4 outside [1, 2]
        self.assertEqual(candidate["range_coverage_pooled"], 0.5)
        self.assertEqual(candidate["range_coverage_player_weighted"], 0.5)
        self.assertEqual(candidate["mae_pooled"], 1.25)
        self.assertEqual(candidate["mae_player_weighted"], 1.25)
        self.assertEqual(candidate["median_width"], 1.0)
        self.assertIsNone(candidate["confidence_intervals"])
        gates = {gate["id"]: gate for gate in results["gates"]}
        self.assertEqual(gates["coach_agreement"]["verdict"], "MET")
        self.assertEqual(gates["primary_error"]["verdict"], "NOT_MET")
        self.assertEqual(gates["range_coverage"]["verdict"], "MET")
        self.assertEqual(gates["useful_width"]["verdict"], "MET")
        subgroups = results["subgroups"]
        self.assertIn("camera_view", subgroups)
        self.assertEqual(subgroups["camera_view"]["dominant_side"]["clips"], 2)

    def test_gates_without_preregistered_targets_are_not_evaluable(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            write_complete_inputs(root)
            doc = protocol()
            doc["targets"] = {key: None for key in doc["targets"]}
            write_json(root / "protocol.json", doc)
            report = build_report(load_inputs(root))
        self.assertEqual(report["status"], "COMPUTED")
        for gate in report["results"]["gates"]:
            self.assertEqual(gate["verdict"], "NOT_EVALUABLE")

    def test_abstentions_are_counted_not_scored(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            write_complete_inputs(root)
            doc = prediction("clip-test-0002")
            doc["prediction"] = {
                "status": "abstained",
                "lower": None,
                "upper": None,
                "reason": "unsupported capture",
            }
            write_json(root / "predictions" / "clip-test-0002.json", doc)
            report = build_report(load_inputs(root))
        candidate = report["results"]["candidate"]
        self.assertEqual(candidate["abstentions"], 1)
        self.assertEqual(candidate["numerical_outputs"], 1)
        self.assertEqual(candidate["range_coverage_pooled"], 1.0)
        self.assertEqual(candidate["mae_pooled"], 0.0)

    def test_report_is_deterministic(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            write_complete_inputs(root)
            first = build_report(load_inputs(root))
            second = build_report(load_inputs(root))
        self.assertEqual(copy.deepcopy(first), second)


if __name__ == "__main__":
    unittest.main()
