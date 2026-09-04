#!/usr/bin/env python3
"""Structural audit: does validate_annotations.py enforce what annotation.schema.json declares?

The validator docstring says the executable check "cannot silently drift from the
JSON contract". Only the technique enum is read from the schema; every other
rule is hand-copied. Each test below derives its expectation from the schema
document itself (stdlib only, no JSON-Schema engine) and asserts the validator
rejects a document the schema rejects.

Run from the repository root:
  python3 -m unittest ml/scripts/test_audit_validator_schema_drift.py
"""
import json
import unittest
from pathlib import Path

from validate_annotations import validate

REPO_ROOT = Path(__file__).resolve().parents[2]
SCHEMA = json.loads(
    (REPO_ROOT / "ml" / "annotations" / "annotation.schema.json").read_text(encoding="utf-8")
)


def attributes() -> dict:
    return {
        "side": "forehand",
        "spin": "flat",
        "direction": "straight",
        "origin_zone": "baseline",
        "target_zone": "baseline",
        "contact_state": "after_bounce",
        "intent": "attack",
        "rally_outcome": "in_play",
    }


def valid_doc() -> dict:
    return {
        "clip_id": "clip-0001-forehand",
        "annotation_outcome": "recognized_technique",
        "technique": "drive_forehand",
        "attributes": attributes(),
        "handedness": "right",
        "camera_view": "dominant_side",
        "stroke_start_ms": 0,
        "stroke_end_ms": 2000,
        "phases": [
            {"key": "ready", "start_ms": 0, "end_ms": 300, "observable": True},
            {"key": "contact", "start_ms": 1000, "end_ms": 1090, "observable": True},
            {"key": "recover", "start_ms": 1400, "end_ms": 2000, "observable": True},
        ],
        "contact_range_ms": {"start_ms": 1000, "end_ms": 1090},
        "checkpoint_labels": [
            {
                "checkpoint": "contact_position",
                "verdict": "major_fault",
                "fault_direction": "late",
                "fault_severity": 0.6,
            }
        ],
        "acceptable_alternative_mechanics": False,
        "quality_flags": ["clean"],
        "annotator": "coach-a",
        "revision": 1,
    }


class ValidatorSchemaDriftTest(unittest.TestCase):
    def test_baseline_document_is_valid(self):
        self.assertEqual(validate(valid_doc(), "base"), [])

    def test_clip_id_shorter_than_schema_minLength_is_rejected(self):
        min_len = SCHEMA["properties"]["clip_id"]["minLength"]
        doc = valid_doc()
        doc["clip_id"] = "x" * (min_len - 1)
        errors = validate(doc, "short-clip-id")
        self.assertTrue(errors, f"schema requires clip_id minLength={min_len}; validator accepted {doc['clip_id']!r}")

    def test_empty_clip_id_is_rejected(self):
        doc = valid_doc()
        doc["clip_id"] = ""
        self.assertTrue(validate(doc, "empty-clip-id"), "schema requires a non-empty clip_id")

    def test_non_string_clip_id_is_rejected(self):
        self.assertEqual(SCHEMA["properties"]["clip_id"]["type"], "string")
        doc = valid_doc()
        doc["clip_id"] = 12345678
        self.assertTrue(validate(doc, "int-clip-id"), "schema requires clip_id to be a string")

    def test_checkpoint_label_with_unknown_key_is_rejected(self):
        item_schema = SCHEMA["properties"]["checkpoint_labels"]["items"]
        self.assertIs(item_schema["additionalProperties"], False)
        doc = valid_doc()
        doc["checkpoint_labels"][0]["fault_sevrity"] = 0.9  # typo'd key silently accepted?
        errors = validate(doc, "checkpoint-extra-key")
        self.assertTrue(errors, "schema forbids additional checkpoint keys; validator accepted one")

    def test_checkpoint_note_longer_than_schema_maxLength_is_rejected(self):
        max_len = SCHEMA["properties"]["checkpoint_labels"]["items"]["properties"]["note"]["maxLength"]
        doc = valid_doc()
        doc["checkpoint_labels"][0]["note"] = "n" * (max_len + 1)
        self.assertTrue(validate(doc, "checkpoint-long-note"), f"schema caps note at {max_len} chars")

    def test_player_bbox_outside_unit_square_is_rejected(self):
        bbox_schema = SCHEMA["properties"]["player_bbox"]["oneOf"][0]
        self.assertEqual(bbox_schema["properties"]["x"]["maximum"], 1)
        doc = valid_doc()
        doc["player_bbox"] = {"x": 1.5, "y": -0.2, "width": 0.3, "height": 0.4}
        self.assertTrue(validate(doc, "bbox-out-of-range"), "schema bounds player_bbox to [0,1]")

    def test_player_bbox_wrong_type_is_rejected(self):
        doc = valid_doc()
        doc["player_bbox"] = "not-a-box"
        self.assertTrue(validate(doc, "bbox-string"), "schema requires player_bbox object|null")

    def test_keyframe_arrays_must_be_arrays(self):
        for field in ("pose_keyframes", "paddle_keyframes", "ball_keyframes"):
            self.assertEqual(SCHEMA["properties"][field]["type"], "array")
            doc = valid_doc()
            doc[field] = {"not": "an array"}
            with self.subTest(field=field):
                self.assertTrue(validate(doc, field), f"schema requires {field} to be an array")

    def test_primary_coaching_priority_must_be_string_or_null(self):
        self.assertEqual(SCHEMA["properties"]["primary_coaching_priority"]["type"], ["string", "null"])
        doc = valid_doc()
        doc["primary_coaching_priority"] = 42
        self.assertTrue(validate(doc, "priority-int"), "schema requires string|null")

    def test_partial_outcome_boundaries_must_be_integers_not_bool(self):
        # JSON Schema `integer` excludes booleans; python bool is an int subclass.
        doc = valid_doc()
        doc["annotation_outcome"] = "partial"
        doc["stroke_start_ms"] = False
        doc["stroke_end_ms"] = 2000
        self.assertTrue(validate(doc, "bool-boundary"))

    def test_validator_keeps_all_hand_copied_enums_in_sync_with_schema(self):
        import validate_annotations as va

        props = SCHEMA["properties"]
        self.assertEqual(set(props["annotation_outcome"]["enum"]), va.ANNOTATION_OUTCOMES)
        self.assertEqual(props["phases"]["items"]["properties"]["key"]["enum"], va.PHASES)
        cp = props["checkpoint_labels"]["items"]["properties"]
        self.assertEqual(set(cp["checkpoint"]["enum"]), va.CHECKPOINTS)
        self.assertEqual(set(cp["verdict"]["enum"]), va.VERDICTS)
        self.assertEqual(set(cp["fault_direction"]["enum"]), va.FAULT_DIRECTIONS)
        self.assertEqual(set(props["quality_flags"]["items"]["enum"]), va.QUALITY_FLAGS)
        attrs = SCHEMA["$defs"]["attributes"]["properties"]
        self.assertEqual(set(attrs), set(va.ATTRIBUTE_VALUES))
        for key, spec in attrs.items():
            self.assertEqual(set(spec["enum"]), va.ATTRIBUTE_VALUES[key], key)
        self.assertEqual(set(SCHEMA["required"]), va.REQUIRED)
        self.assertEqual(set(props) - set(SCHEMA["required"]), va.OPTIONAL)


if __name__ == "__main__":
    unittest.main()
