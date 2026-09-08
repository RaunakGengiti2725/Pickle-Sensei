"""Unit tests for the scientific validation protocol package (W06-06).

All fixtures below are synthetic, in-memory or written to a temporary directory
created by the test itself. Nothing here is a real label, a real coach or a real
measurement, and nothing is committed under datasets/.
"""
from __future__ import annotations

import copy
import hashlib
import io
import json
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path

from validation_protocol import (
    CORPUS_REGISTRY_PATH,
    DEFAULT_INPUT_ROOT,
    EXTERNAL_INPUT_IDS,
    INPUT_KINDS,
    PROTECTED_HOLDOUT_IDS,
    PROTECTED_MEDIA_SHA256,
    PROTECTED_SESSION_IDS,
    PROTOCOL_SCHEMA_VERSION,
    REPO_ROOT,
    SCHEMAS,
    build_report,
    is_protected_identifier,
    load_inputs,
    main,
    protected_identity,
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
        "media_sha256": hashlib.sha256(clip.encode("utf-8")).hexdigest(),
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
        "credential_ref": f"credential-ref-{reviewer_id}",
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
        "submitted_at": "2026-09-10T00:00:00Z",
    }


def adjudication(clip: str = "clip-test-0001", rating: int = 3) -> dict:
    return {
        "clip_id": clip,
        "adjudicator_id": "adjudicator-test-0001",
        "review_ids": [f"{clip}.reviewer-test-0001", f"{clip}.reviewer-test-0002"],
        "resolved_rating": rating,
        "rationale": "reviewers disagreed on follow-through; adjudicated from the blinded frames",
        "submitted_at": "2026-09-11T00:00:00Z",
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
        errors = validate_record("consent", adult, "c")
        self.assertTrue(any("guardian_release_id" in e for e in errors))

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
        errors = validate_record("review", doc, "rv")
        self.assertTrue(any("model_output_disclosed" in e for e in errors))
        doc = review()
        doc["review_id"] = "wrong-id-0001"
        self.assertTrue(any("review_id" in e for e in validate_record("review", doc, "rv")))
        doc = review(rating=None)
        self.assertEqual(validate_record("review", doc, "rv"), [])
        doc["quality_rating"] = 3
        self.assertTrue(any("cannot_evaluate" in e for e in validate_record("review", doc, "rv")))
        doc = review()
        doc["cannot_evaluate_reason"] = "but also rated"
        errors = validate_record("review", doc, "rv")
        self.assertTrue(any("cannot_evaluate_reason" in e for e in errors))
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
        errors = validate_record("protocol", doc, "p")
        self.assertTrue(any("frozen_before_evaluation" in e for e in errors))
        doc = protocol()
        doc["minimum_reviewers_per_clip"] = 1
        errors = validate_record("protocol", doc, "p")
        self.assertTrue(any("minimum_reviewers_per_clip" in e for e in errors))
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


def report_for(root: Path) -> dict:
    return build_report(load_inputs(root))


def strict_json_loads(text: str) -> object:
    def refuse(constant: str) -> object:
        raise ValueError(f"non-finite JSON constant {constant}")

    return json.loads(text, parse_constant=refuse)


class ProtectedHoldoutIdentityTest(unittest.TestCase):
    """Protected footage is refused by content identity and by id alias, as the
    benchmark release gate (packages/evaluation/src/benchmarkRelease.ts) does."""

    def test_protected_media_hash_under_fresh_ids_is_refused(self) -> None:
        self.assertGreaterEqual(len(PROTECTED_MEDIA_SHA256), 7)
        for digest in sorted(PROTECTED_MEDIA_SHA256):
            with self.subTest(digest=digest[:12]):
                doc = footage(clip="clip-recut-0001")
                doc["session_id"] = "session-recut-0001"
                doc["media_sha256"] = digest
                errors = validate_record("footage", doc, "footage/clip-recut-0001")
                self.assertTrue(any("protected" in e.lower() for e in errors), errors)

    def test_protected_hashes_mirror_the_corpus_registry(self) -> None:
        registry = REPO_ROOT / CORPUS_REGISTRY_PATH
        self.assertTrue(registry.is_file(), registry)
        recordings = json.loads(registry.read_text(encoding="utf-8"))
        from_registry = {
            record["sha256"]
            for record in recordings
            if record.get("sessionKey") in PROTECTED_SESSION_IDS
        }
        self.assertTrue(from_registry)
        identity = protected_identity()
        self.assertTrue(from_registry <= identity.media_sha256)
        self.assertTrue(PROTECTED_MEDIA_SHA256 <= identity.media_sha256)
        # The pinned constant and the registry must agree; drift in either
        # direction means one of the two gates is out of date.
        self.assertEqual(from_registry, set(PROTECTED_MEDIA_SHA256))
        for alias in ("afn-vic-rally1", "afn-provic", "wm-dink-nearplayer", "wm-pickleball-game"):
            self.assertIn(alias, identity.aliases, alias)

    def test_protected_id_aliases_are_refused_case_and_prefix_insensitively(self) -> None:
        aliases: list[str] = []
        for protected in sorted(PROTECTED_HOLDOUT_IDS):
            aliases.append(protected.upper())
            aliases.append(protected + "-recut-0001")
            aliases.append("copy-of-" + protected)
        aliases.extend(["wm-dink-nearplayer", "AFN-PROVIC-crop-01", "rec-024decaeb66e"])
        for alias in aliases:
            with self.subTest(alias=alias):
                self.assertTrue(is_protected_identifier(alias), alias)
                doc = footage(clip=alias)
                errors = validate_record("footage", doc, f"footage/{alias}")
                self.assertTrue(any("protected" in e.lower() for e in errors), errors)
        for field_name in ("session_id", "athlete_id", "athlete_group_id"):
            doc = footage()
            doc[field_name] = "Session-WM-Tournament-2014-b"
            errors = validate_record("footage", doc, "footage/x")
            self.assertTrue(any("protected" in e.lower() for e in errors), field_name)
        for fresh in ("clip-test-0001", "session-test-0001", "athlete-test-0001", "wm-2026-open"):
            self.assertFalse(is_protected_identifier(fresh), fresh)
        self.assertEqual(validate_record("footage", footage(), "footage/fresh"), [])


class AdjudicatorIndependenceTest(unittest.TestCase):
    def test_adjudicator_who_authored_any_review_of_the_clip_is_refused(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            write_complete_inputs(root)
            # The adjudicator also reviewed clip-test-0002 but the adjudication
            # record omits their own review from review_ids.
            write_json(
                root / "reviews" / "clip-test-0002.adjudicator-test-0001.json",
                review(clip="clip-test-0002", reviewer_id="adjudicator-test-0001", rating=5),
            )
            report = report_for(root)
        self.assertEqual(report["status"], "INVALID_INPUT", report)
        self.assertTrue(
            any("adjudicator" in e and "review" in e for e in report["validation_errors"]),
            report["validation_errors"],
        )

    def test_adjudication_must_cover_every_review_of_the_clip(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            write_complete_inputs(root)
            write_json(
                root / "reviewers" / "reviewer-test-0003.json", reviewer("reviewer-test-0003")
            )
            write_json(
                root / "reviews" / "clip-test-0002.reviewer-test-0003.json",
                review(clip="clip-test-0002", reviewer_id="reviewer-test-0003", rating=1),
            )
            report = report_for(root)
        self.assertEqual(report["status"], "INVALID_INPUT", report)
        self.assertTrue(
            any("clip-test-0002.reviewer-test-0003" in e for e in report["validation_errors"]),
            report["validation_errors"],
        )


class CoachQualificationPolicyV1Test(unittest.TestCase):
    def test_self_assessed_reviewer_is_refused(self) -> None:
        doc = reviewer()
        doc["qualification"]["assessed_by"] = doc["reviewer_id"]
        errors = validate_record("reviewer", doc, "reviewers/self")
        self.assertTrue(any("assessed_by" in e for e in errors), errors)

    def test_synthetic_identities_are_refused_in_every_record(self) -> None:
        doc = reviewer("SYNTHETIC-reviewer-0001")
        doc["credential_ref"] = "SYNTHETIC-cred-0001"
        errors = validate_record("reviewer", doc, "reviewers/synthetic")
        self.assertTrue(any("reviewer_id" in e for e in errors), errors)
        self.assertTrue(any("credential_ref" in e for e in errors), errors)
        doc = reviewer()
        doc["qualification"]["assessed_by"] = "synthetic-admin-0001"
        errors = validate_record("reviewer", doc, "reviewers/assessor")
        self.assertTrue(any("assessed_by" in e for e in errors), errors)
        doc = footage()
        doc["metadata_verification"]["verified_by"] = "Synthetic-verifier-0001"
        self.assertTrue(validate_record("footage", doc, "footage/x"))
        doc = adjudication()
        doc["adjudicator_id"] = "SYNTHETIC-adjudicator-0001"
        self.assertTrue(validate_record("adjudication", doc, "adjudications/x"))
        doc = review()
        doc["reviewer_id"] = "SYNTHETIC-reviewer-0001"
        doc["review_id"] = f"{doc['clip_id']}.{doc['reviewer_id']}"
        self.assertTrue(validate_record("review", doc, "reviews/x"))
        doc = protocol()
        doc["ratified_by"] = ["SYNTHETIC-owner-0001"]
        self.assertTrue(validate_record("protocol", doc, "protocol.json"))

    def test_synthetic_assessor_in_complete_inputs_never_computes(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            write_complete_inputs(root)
            doc = reviewer("reviewer-test-0002")
            doc["qualification"]["assessed_by"] = "SYNTHETIC-admin-0001"
            write_json(root / "reviewers" / "reviewer-test-0002.json", doc)
            report = report_for(root)
        self.assertEqual(report["status"], "INVALID_INPUT", report["status"])
        self.assertIsNone(report["results"])


class BoundaryValueTest(unittest.TestCase):
    def test_non_finite_numbers_are_invalid_and_json_output_is_strict(self) -> None:
        doc = protocol()
        doc["targets"]["player_weighted_mae_maximum"] = float("inf")
        doc["targets"]["median_width_maximum"] = float("nan")
        self.assertTrue(validate_record("protocol", doc, "protocol.json"))
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            write_complete_inputs(root)
            (root / "protocol.json").write_text(json.dumps(doc), encoding="utf-8")
            clip = footage()
            clip["capture"]["fps"] = float("nan")
            (root / "footage" / "clip-test-0001.json").write_text(
                json.dumps(clip), encoding="utf-8"
            )
            report = report_for(root)
            out = io.StringIO()
            with redirect_stdout(out):
                code = main(["--report", "--json", "--inputs", str(root)])
        self.assertEqual(report["status"], "INVALID_INPUT", report["status"])
        self.assertIsNone(report["results"])
        self.assertEqual(code, 1)
        self.assertEqual(strict_json_loads(out.getvalue())["status"], "INVALID_INPUT")

    def test_huge_integers_are_invalid_not_a_crash(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            write_complete_inputs(root)
            doc = protocol()
            doc["rating_scale"] = {"id": "scale-huge", "minimum": -(10**400), "maximum": 10**400}
            (root / "protocol.json").write_text(json.dumps(doc), encoding="utf-8")
            pred = prediction()
            pred["prediction"]["lower"] = -(10**400)
            pred["prediction"]["upper"] = 10**400
            (root / "predictions" / "clip-test-0001.json").write_text(
                json.dumps(pred), encoding="utf-8"
            )
            report = report_for(root)
        self.assertEqual(report["status"], "INVALID_INPUT", report["status"])

    def test_null_and_deeply_nested_records_are_invalid_not_silently_absent(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            write_complete_inputs(root)
            (root / "footage" / "corrupt-null.json").write_text("null", encoding="utf-8")
            (root / "predictions" / "clip-test-0001.json").write_text("null", encoding="utf-8")
            report = report_for(root)
            self.assertEqual(report["status"], "INVALID_INPUT", report)
            self.assertTrue(any("corrupt-null.json" in e for e in report["validation_errors"]))
            self.assertEqual(report["record_counts"]["footage"], 3)
            write_complete_inputs(root)
            (root / "footage" / "corrupt-null.json").unlink()
            (root / "footage" / "deep.json").write_text(
                "[" * 100_000 + "]" * 100_000, encoding="utf-8"
            )
            report = report_for(root)
        self.assertEqual(report["status"], "INVALID_INPUT", report["status"])
        self.assertTrue(any("deep.json" in e for e in report["validation_errors"]))

    def test_invalid_calendar_timestamps_are_refused(self) -> None:
        doc = consent()
        doc["signed_at"] = "9999-99-99T99:99:99Z"
        self.assertTrue(any("signed_at" in e for e in validate_record("consent", doc, "c")))
        doc = consent()
        doc["signed_at"] = "2026-02-30T00:00:00Z"
        self.assertTrue(any("signed_at" in e for e in validate_record("consent", doc, "c")))
        doc = consent()
        doc["signed_at"] = "2026-08-01T00:00:00+05:30"
        self.assertEqual(validate_record("consent", doc, "c"), [])


class IndependenceAndProvenanceTest(unittest.TestCase):
    def test_reviewers_sharing_a_credential_are_not_independent(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            write_complete_inputs(root)
            doc = reviewer("reviewer-test-0002")
            doc["credential_ref"] = reviewer()["credential_ref"]
            write_json(root / "reviewers" / "reviewer-test-0002.json", doc)
            report = report_for(root)
        self.assertEqual(report["status"], "INVALID_INPUT", report["status"])
        self.assertTrue(any("credential_ref" in e for e in report["validation_errors"]))

    def test_footage_sharing_media_bytes_is_one_clip_not_two(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            write_complete_inputs(root)
            doc = footage(
                clip="clip-test-0002", athlete="athlete-test-0002", release="release-test-0002"
            )
            doc["media_sha256"] = footage()["media_sha256"]
            write_json(root / "footage" / "clip-test-0002.json", doc)
            report = report_for(root)
        self.assertEqual(report["status"], "INVALID_INPUT", report["status"])
        self.assertTrue(any("media_sha256" in e for e in report["validation_errors"]))

    def test_predictions_from_two_candidates_are_not_pooled(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            write_complete_inputs(root)
            doc = prediction("clip-test-0002", 1.0, 2.0)
            doc["subject"]["model_version"] = "model-test-v2"
            write_json(root / "predictions" / "clip-test-0002.json", doc)
            report = report_for(root)
        self.assertEqual(report["status"], "INVALID_INPUT", report["status"])
        self.assertTrue(any("subject" in e for e in report["validation_errors"]))

    def test_adjudicator_only_reviewer_is_not_a_blinded_reviewer(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            write_complete_inputs(root)
            write_json(
                root / "reviewers" / "reviewer-test-0002.json",
                reviewer("reviewer-test-0002", ["adjudicator"]),
            )
            report = report_for(root)
        self.assertNotEqual(report["status"], "COMPUTED", report["status"])
        missing = {entry["input"]: entry for entry in report["missing_inputs"]}
        self.assertIn("blinded_reviews", missing)
        self.assertIn("reviewer-test-0002", missing["blinded_reviews"]["what_is_missing"])

    def test_reviewer_with_a_conflict_of_interest_is_refused(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            write_complete_inputs(root)
            doc = footage()
            doc["metadata_verification"]["verified_by"] = "reviewer-test-0001"
            doc["rights"]["verified_by"] = "reviewer-test-0001"
            write_json(root / "footage" / "clip-test-0001.json", doc)
            report = report_for(root)
            self.assertEqual(report["status"], "INVALID_INPUT", report["status"])
            self.assertTrue(any("reviewer-test-0001" in e for e in report["validation_errors"]))
            write_complete_inputs(root)
            write_json(
                root / "footage" / "clip-test-0002.json",
                footage(
                    clip="clip-test-0002", athlete="reviewer-test-0002", release="release-test-0002"
                ),
            )
            write_json(
                root / "consent" / "release-test-0002.json",
                consent(athlete="reviewer-test-0002", release="release-test-0002"),
            )
            report = report_for(root)
        self.assertEqual(report["status"], "INVALID_INPUT", report["status"])
        self.assertTrue(any("reviewer-test-0002" in e for e in report["validation_errors"]))


class TemporalAndConsentTest(unittest.TestCase):
    def test_review_before_ratification_or_consent_is_refused(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            write_complete_inputs(root)
            doc = review()
            doc["submitted_at"] = "2020-01-01T00:00:00Z"
            write_json(root / "reviews" / "clip-test-0001.reviewer-test-0001.json", doc)
            report = report_for(root)
            self.assertEqual(report["status"], "INVALID_INPUT", report["status"])
            self.assertTrue(any("submitted_at" in e for e in report["validation_errors"]))
            write_complete_inputs(root)
            doc = adjudication("clip-test-0002", 4)
            doc["submitted_at"] = "2026-09-09T00:00:00Z"  # before the reviews it adjudicates
            write_json(root / "adjudications" / "clip-test-0002.json", doc)
            report = report_for(root)
        self.assertEqual(report["status"], "INVALID_INPUT", report["status"])

    def test_withdrawn_consent_is_not_bypassed_by_a_second_release(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            write_complete_inputs(root)
            withdrawn = consent()
            withdrawn["state"] = "withdrawn"
            write_json(root / "consent" / "release-test-0001.json", withdrawn)
            write_json(
                root / "consent" / "release-test-0009.json", consent(release="release-test-0009")
            )
            write_json(
                root / "footage" / "clip-test-0001.json", footage(release="release-test-0009")
            )
            report = report_for(root)
        self.assertNotEqual(report["status"], "COMPUTED", report["status"])
        missing = {entry["input"]: entry for entry in report["missing_inputs"]}
        self.assertIn("consented_footage", missing)
        self.assertIn("clip-test-0001", missing["consented_footage"]["what_is_missing"])

    def test_clip_every_reviewer_could_not_evaluate_is_not_scored_from_the_adjudicator(self) -> None:
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
            report = report_for(root)
            self.assertEqual(report["status"], "INVALID_INPUT", report["status"])
            self.assertTrue(any("clip-test-0002" in e for e in report["validation_errors"]))
            (root / "adjudications" / "clip-test-0002.json").unlink()
            report = report_for(root)
        self.assertEqual(report["status"], "COMPUTED", report)
        self.assertEqual(report["results"]["clips"]["resolved"], 1)
        self.assertEqual(report["results"]["clips"]["unevaluable"], 1)
        self.assertEqual(report["results"]["reviewer_agreement"]["reviewer_abstentions"], 2)


if __name__ == "__main__":
    unittest.main()
