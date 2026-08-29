#!/usr/bin/env python3
"""Unit tests for the annotation validator.

Run from the repository root:
  python3 -m unittest discover -s ml/scripts -p 'test_*.py'
"""
import json
import re
import unittest
from pathlib import Path

from validate_annotations import TECHNIQUES, validate


REPO_ROOT = Path(__file__).resolve().parents[2]
ANNOTATION_SCHEMA = REPO_ROOT / "ml" / "annotations" / "annotation.schema.json"
MANIFEST_SCHEMA = REPO_ROOT / "ml" / "datasets" / "manifest.schema.json"
TAXONOMY_SOURCE = REPO_ROOT / "packages" / "shared-types" / "src" / "pickleballTaxonomy.ts"


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
            {"key": "prepare", "start_ms": 300, "end_ms": 700, "observable": True},
            {"key": "accelerate", "start_ms": 700, "end_ms": 1000, "observable": True},
            {"key": "contact", "start_ms": 1000, "end_ms": 1090, "observable": True},
            {
                "key": "follow_through",
                "start_ms": 1090,
                "end_ms": 1400,
                "observable": True,
            },
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


def negative_doc(outcome: str) -> dict:
    doc = valid_doc()
    doc["annotation_outcome"] = outcome
    doc["technique"] = None
    doc["checkpoint_labels"] = []
    return doc


class ValidateAnnotationsTest(unittest.TestCase):
    def test_valid_recognized_document_passes(self):
        self.assertEqual(validate(valid_doc(), "x"), [])

    def test_schema_validator_and_typescript_share_exact_61_techniques(self):
        schema = json.loads(ANNOTATION_SCHEMA.read_text(encoding="utf-8"))
        schema_techniques = set(schema["$defs"]["canonicalTechnique"]["enum"])
        source = TAXONOMY_SOURCE.read_text(encoding="utf-8")
        technique_block = source.split("export const PICKLEBALL_TECHNIQUES = [", 1)[1].split(
            "] as const", 1
        )[0]
        typescript_techniques = set(re.findall(r'slug: "([^"]+)"', technique_block))
        self.assertEqual(len(typescript_techniques), 61)
        self.assertEqual(schema_techniques, typescript_techniques)
        self.assertEqual(TECHNIQUES, typescript_techniques)

    def test_every_canonical_technique_is_accepted(self):
        for technique in TECHNIQUES:
            with self.subTest(technique=technique):
                doc = valid_doc()
                doc["technique"] = technique
                self.assertEqual(validate(doc, "x"), [])

    def test_legacy_broad_shot_class_is_rejected(self):
        doc = valid_doc()
        doc["technique"] = "forehand_drive"
        self.assertTrue(any("canonical technique" in error for error in validate(doc, "x")))

    def test_unknown_technique_abstains_without_guessing(self):
        doc = negative_doc("unknown_technique")
        doc["phases"] = []
        doc["contact_range_ms"] = None
        self.assertEqual(validate(doc, "x"), [])

    def test_unknown_technique_rejects_invented_class(self):
        doc = negative_doc("unknown_technique")
        doc["technique"] = "drive_forehand"
        self.assertTrue(any("must not guess" in error for error in validate(doc, "x")))

    def test_no_stroke_negative_passes_only_without_stroke_data(self):
        doc = negative_doc("no_stroke")
        doc["stroke_start_ms"] = None
        doc["stroke_end_ms"] = None
        doc["phases"] = []
        doc["contact_range_ms"] = None
        doc["attributes"] = {key: None for key in attributes()}
        self.assertEqual(validate(doc, "x"), [])

    def test_no_stroke_rejects_fabricated_temporal_and_attribute_labels(self):
        doc = negative_doc("no_stroke")
        problems = validate(doc, "x")
        self.assertTrue(any("null stroke boundaries" in error for error in problems))
        self.assertTrue(any("attributes" in error for error in problems))
        self.assertTrue(any("phase spans" in error for error in problems))

    def test_partial_motion_may_abstain_from_technique(self):
        doc = negative_doc("partial")
        doc["stroke_end_ms"] = 900
        doc["phases"] = doc["phases"][:2]
        doc["contact_range_ms"] = None
        self.assertEqual(validate(doc, "x"), [])

    def test_aborted_motion_may_have_no_reliable_boundaries(self):
        doc = negative_doc("aborted")
        doc["stroke_start_ms"] = None
        doc["stroke_end_ms"] = None
        doc["phases"] = []
        doc["contact_range_ms"] = None
        self.assertEqual(validate(doc, "x"), [])

    def test_missing_required_field(self):
        doc = valid_doc()
        del doc["annotator"]
        self.assertTrue(any("annotator" in error for error in validate(doc, "x")))

    def test_out_of_order_phases_rejected(self):
        doc = valid_doc()
        doc["phases"][1], doc["phases"][2] = doc["phases"][2], doc["phases"][1]
        self.assertTrue(any("canonical order" in error for error in validate(doc, "x")))

    def test_overlapping_phases_rejected(self):
        doc = valid_doc()
        doc["phases"][1]["start_ms"] = 200
        self.assertTrue(any("non-overlapping" in error for error in validate(doc, "x")))

    def test_fault_requires_direction(self):
        doc = valid_doc()
        del doc["checkpoint_labels"][0]["fault_direction"]
        self.assertTrue(any("fault_direction" in error for error in validate(doc, "x")))

    def test_severity_range(self):
        doc = valid_doc()
        doc["checkpoint_labels"][0]["fault_severity"] = 1.4
        self.assertTrue(any("[0,1]" in error for error in validate(doc, "x")))

    def test_clean_quality_flag_is_exclusive(self):
        doc = valid_doc()
        doc["quality_flags"] = ["clean", "motion_blur"]
        self.assertTrue(any("cannot be combined" in error for error in validate(doc, "x")))

    def test_manifest_excludes_synthetic_and_requires_clearance(self):
        schema = json.loads(MANIFEST_SCHEMA.read_text(encoding="utf-8"))
        item = schema["$defs"]["item"]
        self.assertEqual(
            set(item["properties"]["source"]["enum"]),
            {"consented_first_party_capture", "commissioned_capture", "licensed_media"},
        )
        self.assertNotIn("synthetic", item["properties"]["source"]["enum"])
        self.assertTrue({"consent", "rights", "human_review", "athlete_group_id"} <= set(item["required"]))
        self.assertIs(schema["$defs"]["consent"]["properties"]["commercial_model_training"]["const"], True)
        self.assertIs(
            schema["$defs"]["rights"]["properties"]["commercial_model_training_permitted"]["const"],
            True,
        )


if __name__ == "__main__":
    unittest.main()
