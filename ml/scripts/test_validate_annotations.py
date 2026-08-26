#!/usr/bin/env python3
"""Unit tests for the annotation validator. Run: python3 -m unittest discover ml/scripts"""
import unittest

from validate_annotations import validate


def valid_doc() -> dict:
    return {
        "clip_id": "clip-0001-forehand",
        "shot_type": "forehand_drive",
        "handedness": "right",
        "camera_view": "side",
        "stroke_start_ms": 0,
        "stroke_end_ms": 2000,
        "phases": [
            {"key": "ready", "start_ms": 0, "end_ms": 300},
            {"key": "prepare", "start_ms": 300, "end_ms": 700},
            {"key": "accelerate", "start_ms": 700, "end_ms": 1000},
            {"key": "contact", "start_ms": 1000, "end_ms": 1090},
            {"key": "follow_through", "start_ms": 1090, "end_ms": 1400},
            {"key": "recover", "start_ms": 1400, "end_ms": 2000},
        ],
        "checkpoint_labels": [
            {"checkpoint": "contact_position", "verdict": "major_fault", "fault_direction": "late", "fault_severity": 0.6}
        ],
        "quality_flags": ["clean"],
        "annotator": "coach-a",
        "revision": 1,
    }


class ValidateAnnotationsTest(unittest.TestCase):
    def test_valid_document_passes(self):
        self.assertEqual(validate(valid_doc(), "x"), [])

    def test_missing_required_field(self):
        doc = valid_doc()
        del doc["annotator"]
        self.assertTrue(any("annotator" in e for e in validate(doc, "x")))

    def test_out_of_order_phases_rejected(self):
        doc = valid_doc()
        doc["phases"][1], doc["phases"][2] = doc["phases"][2], doc["phases"][1]
        self.assertTrue(any("canonical order" in e for e in validate(doc, "x")))

    def test_overlapping_phases_rejected(self):
        doc = valid_doc()
        doc["phases"][1]["start_ms"] = 200  # overlaps ready
        self.assertTrue(any("non-overlapping" in e for e in validate(doc, "x")))

    def test_fault_requires_direction(self):
        doc = valid_doc()
        del doc["checkpoint_labels"][0]["fault_direction"]
        self.assertTrue(any("fault_direction" in e for e in validate(doc, "x")))

    def test_severity_range(self):
        doc = valid_doc()
        doc["checkpoint_labels"][0]["fault_severity"] = 1.4
        self.assertTrue(any("[0,1]" in e for e in validate(doc, "x")))

    def test_unknown_shot_type(self):
        doc = valid_doc()
        doc["shot_type"] = "smash"
        self.assertTrue(any("shot_type" in e for e in validate(doc, "x")))


if __name__ == "__main__":
    unittest.main()
