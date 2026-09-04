"""Audit: does ml/scripts/validate_annotations.py agree with annotation.schema.json?

The validator's docstring says the executable check "cannot silently drift from
the JSON contract", but only the technique enum is read from the schema. Every
other rule is hand-coded. This test runs the SAME document through both the
JSON-Schema engine (jsonschema, Draft 2020-12) and validate() and asserts they
agree on accept/reject. Any disagreement is contract drift.

Run: python3 -m unittest tools/audit/ml_tooling_datasets_structural1/test_validator_schema_drift.py
Requires: pip install jsonschema
"""

from __future__ import annotations

import copy
import json
import unittest

import jsonschema

from _support import REPO_ROOT, add_ml_scripts_to_path

add_ml_scripts_to_path()
import validate_annotations as va  # noqa: E402

SCHEMA_PATH = REPO_ROOT / "ml" / "annotations" / "annotation.schema.json"
SCHEMA = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
VALIDATOR = jsonschema.Draft202012Validator(SCHEMA)


def canonical_doc() -> dict:
    return {
        "clip_id": "clip-0001-forehand-drive",
        "annotation_outcome": "recognized_technique",
        "technique": sorted(va.TECHNIQUES)[0],
        "attributes": {
            "side": "forehand",
            "spin": "topspin",
            "direction": "crosscourt",
            "origin_zone": "baseline",
            "target_zone": "backcourt",
            "contact_state": "after_bounce",
            "intent": "attack",
            "rally_outcome": "in_play",
        },
        "handedness": "right",
        "camera_view": "rear",
        "stroke_start_ms": 1000,
        "stroke_end_ms": 2000,
        "phases": [
            {"key": "prepare", "start_ms": 1000, "end_ms": 1300, "observable": True},
            {"key": "contact", "start_ms": 1300, "end_ms": 1400, "observable": True},
        ],
        "contact_range_ms": {"start_ms": 1320, "end_ms": 1380},
        "checkpoint_labels": [
            {"checkpoint": "preparation", "verdict": "good"},
            {"checkpoint": "contact_position", "verdict": "minor_fault",
             "fault_direction": "late", "fault_severity": 0.4},
        ],
        "acceptable_alternative_mechanics": False,
        "quality_flags": ["clean"],
        "annotator": "reviewer-a",
        "revision": 1,
    }


def schema_accepts(doc: dict) -> bool:
    return not list(VALIDATOR.iter_errors(doc))


def validator_accepts(doc: dict) -> bool:
    return not va.validate(doc, "doc.json")


class ValidatorSchemaAgreement(unittest.TestCase):
    def assert_agree(self, doc: dict, label: str) -> None:
        s = schema_accepts(doc)
        v = validator_accepts(doc)
        self.assertEqual(
            s, v,
            f"{label}: jsonschema accepts={s} but validate_annotations accepts={v} "
            f"(schema errors: {[e.message for e in VALIDATOR.iter_errors(doc)][:3]}; "
            f"validator errors: {va.validate(doc, 'doc.json')[:3]})",
        )

    def test_canonical_document_accepted_by_both(self):
        doc = canonical_doc()
        self.assertTrue(schema_accepts(doc), [e.message for e in VALIDATOR.iter_errors(doc)])
        self.assertTrue(validator_accepts(doc), va.validate(doc, "doc.json"))

    def test_clip_id_min_length_8(self):
        doc = canonical_doc()
        doc["clip_id"] = "abc"
        self.assert_agree(doc, "clip_id shorter than schema minLength 8")

    def test_clip_id_must_be_string(self):
        doc = canonical_doc()
        doc["clip_id"] = 12345678
        self.assert_agree(doc, "clip_id integer instead of string")

    def test_checkpoint_label_additional_properties(self):
        doc = canonical_doc()
        doc["checkpoint_labels"][0]["extra_field"] = "should be rejected"
        self.assert_agree(doc, "checkpoint label with a field outside additionalProperties:false")

    def test_checkpoint_note_max_length_500(self):
        doc = canonical_doc()
        doc["checkpoint_labels"][0]["note"] = "x" * 501
        self.assert_agree(doc, "checkpoint note longer than maxLength 500")

    def test_player_bbox_out_of_unit_range(self):
        doc = canonical_doc()
        doc["player_bbox"] = {"x": 1.5, "y": 0.1, "width": 0.2, "height": 0.2}
        self.assert_agree(doc, "player_bbox.x above schema maximum 1")

    def test_player_bbox_additional_properties(self):
        doc = canonical_doc()
        doc["player_bbox"] = {"x": 0.1, "y": 0.1, "width": 0.2, "height": 0.2, "rotation": 3}
        self.assert_agree(doc, "player_bbox with a field outside additionalProperties:false")

    def test_no_stroke_negative_case_agrees(self):
        doc = canonical_doc()
        doc.update({
            "annotation_outcome": "no_stroke", "technique": None,
            "stroke_start_ms": None, "stroke_end_ms": None, "phases": [],
            "contact_range_ms": None, "checkpoint_labels": [],
            "attributes": {k: None for k in doc["attributes"]},
        })
        self.assert_agree(doc, "canonical no_stroke")

    def test_validator_may_be_stricter_on_cross_field_rules(self):
        # Cross-field rules (phase inside stroke window) are not expressible in
        # JSON Schema; the hand validator is allowed to be stricter there. This
        # is the one direction of disagreement that is NOT drift.
        doc = canonical_doc()
        doc["phases"][1]["end_ms"] = 2500
        self.assertTrue(schema_accepts(doc))
        self.assertFalse(validator_accepts(doc))


if __name__ == "__main__":
    unittest.main()
