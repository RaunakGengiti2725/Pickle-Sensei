#!/usr/bin/env python3
"""Unit tests for the annotation validator.

Run from the repository root:
  python3 -m unittest discover -s ml/scripts -p 'test_*.py'
"""
import contextlib
import copy
import io
import json
import os
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from validate_annotations import TECHNIQUES, main, validate

try:
    import jsonschema
except ImportError:  # optional: the validator itself is stdlib-only
    jsonschema = None


REPO_ROOT = Path(__file__).resolve().parents[2]
ANNOTATION_SCHEMA = REPO_ROOT / "ml" / "annotations" / "annotation.schema.json"
MANIFEST_SCHEMA = REPO_ROOT / "ml" / "datasets" / "manifest.schema.json"
TAXONOMY_SOURCE = REPO_ROOT / "packages" / "shared-types" / "src" / "pickleballTaxonomy.ts"
VALIDATOR_SCRIPT = REPO_ROOT / "ml" / "scripts" / "validate_annotations.py"


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


def no_stroke_doc() -> dict:
    doc = negative_doc("no_stroke")
    doc["stroke_start_ms"] = None
    doc["stroke_end_ms"] = None
    doc["phases"] = []
    doc["contact_range_ms"] = None
    doc["attributes"] = {key: None for key in attributes()}
    return doc


def with_fields(**fields) -> dict:
    doc = valid_doc()
    doc.update(fields)
    return doc


def run_main(paths: list) -> tuple:
    """Invoke the CLI entry point in-process; returns (exit_code, stdout lines)."""
    buffer = io.StringIO()
    with contextlib.redirect_stdout(buffer):
        code = main([str(path) for path in paths])
    return code, buffer.getvalue().splitlines()


def run_cli(paths: list, timeout: float = 10.0) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, str(VALIDATOR_SCRIPT), *(str(path) for path in paths)],
        capture_output=True,
        text=True,
        timeout=timeout,
    )


# Every value here is wrong for the field it is assigned to. The first entries use
# unhashable containers because `value in {...}` raises TypeError for them; the rest
# cover the remaining JSON types so no field crashes on any JSON value.
TYPE_CONFUSION_CASES = {
    "outcome_list": {"annotation_outcome": []},
    "outcome_dict": {"annotation_outcome": {}},
    "technique_dict": {"technique": {"x": 1}},
    "technique_list": {"technique": ["drive_forehand"]},
    "handedness_list": {"handedness": ["right"]},
    "camera_view_list": {"camera_view": []},
    "camera_view_dict": {"camera_view": {"front": True}},
    "quality_flags_dict": {"quality_flags": {"clean": True}},
    "quality_flags_nested_list": {"quality_flags": [["clean"]]},
    "quality_flags_dict_items": {"quality_flags": [{"flag": "clean"}]},
    "quality_flags_string": {"quality_flags": "clean"},
    "attribute_value_list": {"attributes": {**attributes(), "side": []}},
    "attribute_value_dict": {"attributes": {**attributes(), "spin": {}}},
    "attributes_list": {"attributes": []},
    "phase_key_list": {"phases": [{"key": [], "start_ms": 0, "end_ms": 1, "observable": True}]},
    "phase_key_dict": {"phases": [{"key": {}, "start_ms": 0, "end_ms": 1, "observable": True}]},
    "phases_dict": {"phases": {"key": "ready"}},
    "checkpoint_label_list_fields": {
        "checkpoint_labels": [{"checkpoint": [], "verdict": [], "fault_direction": []}]
    },
    "checkpoint_label_dict_fields": {
        "checkpoint_labels": [{"checkpoint": {}, "verdict": {}, "fault_direction": {}}]
    },
    "checkpoint_severity_list": {
        "checkpoint_labels": [
            {"checkpoint": "recovery", "verdict": "good", "fault_severity": [0.5]}
        ]
    },
    "checkpoint_labels_dict": {"checkpoint_labels": {"checkpoint": "recovery"}},
    "contact_range_list": {"contact_range_ms": [1000, 1090]},
    "contact_range_list_values": {"contact_range_ms": {"start_ms": [], "end_ms": {}}},
    "stroke_start_bool": {"stroke_start_ms": True},
    "stroke_bounds_list": {"stroke_start_ms": [0], "stroke_end_ms": [2000]},
    "stroke_bounds_string": {"stroke_start_ms": "0", "stroke_end_ms": "2000"},
    "annotator_list": {"annotator": ["coach-a"]},
    "revision_list": {"revision": [1]},
    "revision_float": {"revision": 1.5},
    "mechanics_list": {"acceptable_alternative_mechanics": []},
    "clip_id_list": {"clip_id": ["clip-0001-forehand"]},
}

# Optional fields: each value violates ml/annotations/annotation.schema.json.
OPTIONAL_FIELD_GARBAGE = {
    "player_bbox": "not-a-box",
    "pose_keyframes": 42,
    "paddle_keyframes": {},
    "ball_keyframes": None,
    "court_keypoints": True,
    "primary_coaching_priority": [],
    "occlusion_notes": 1,
    "adjudicated_by": [],
    "adjudication_note": {},
}

# Optional fields: each value satisfies the schema and must be accepted.
OPTIONAL_FIELD_VALID = {
    "player_bbox": {"x": 0.1, "y": 0.2, "width": 0.5, "height": 0.75},
    "pose_keyframes": [{"t_ms": 0, "joints": {}}],
    "paddle_keyframes": [],
    "ball_keyframes": [{"t_ms": 1000}],
    "court_keypoints": None,
    "primary_coaching_priority": "contact_position",
    "occlusion_notes": None,
    "adjudicated_by": "coach-b",
    "adjudication_note": "agreed after review",
}


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


class ValidateTypeSafetyTest(unittest.TestCase):
    """Wrong JSON types must yield error strings, never an exception."""

    def test_wrong_json_type_for_any_field_is_reported_not_raised(self):
        for name, fields in TYPE_CONFUSION_CASES.items():
            with self.subTest(case=name):
                doc = copy.deepcopy(valid_doc())
                doc.update(copy.deepcopy(fields))
                problems = validate(doc, name)
                self.assertTrue(problems, "wrong type must be reported as INVALID")
                self.assertTrue(all(problem.startswith(f"{name}: ") for problem in problems))

    def test_list_valued_outcome_is_reported(self):
        problems = validate(with_fields(annotation_outcome=["recognized_technique"]), "x")
        self.assertTrue(any("annotation_outcome" in error for error in problems))

    def test_dict_valued_quality_flags_is_reported(self):
        problems = validate(with_fields(quality_flags={"clean": True}), "x")
        self.assertTrue(any("quality_flags" in error for error in problems))

    def test_wrong_type_on_every_top_level_field_at_once(self):
        doc = {key: [] for key in valid_doc()}
        problems = validate(doc, "x")
        self.assertTrue(problems)
        doc = {key: {} for key in valid_doc()}
        problems = validate(doc, "x")
        self.assertTrue(problems)

    def test_non_object_documents_are_reported(self):
        for doc in ([], "text", 3, None, True):
            with self.subTest(doc=doc):
                self.assertEqual(validate(doc, "x"), ["x: annotation must be a JSON object"])


class ValidateSchemaParityTest(unittest.TestCase):
    """Every constraint annotation.schema.json declares must also be enforced here."""

    def test_clip_id_must_be_a_string_of_at_least_8_characters(self):
        self.assertTrue(any("clip_id" in e for e in validate(with_fields(clip_id="short"), "x")))
        self.assertTrue(any("clip_id" in e for e in validate(with_fields(clip_id=12345678), "x")))
        self.assertEqual(validate(with_fields(clip_id="abcdefgh"), "x"), [])

    def test_optional_fields_with_schema_invalid_values_are_rejected(self):
        for field, value in OPTIONAL_FIELD_GARBAGE.items():
            with self.subTest(field=field):
                problems = validate(with_fields(**{field: value}), "x")
                self.assertTrue(any(field in error for error in problems), problems)

    def test_optional_fields_with_schema_valid_values_are_accepted(self):
        self.assertEqual(validate(with_fields(**OPTIONAL_FIELD_VALID), "x"), [])
        for field, value in OPTIONAL_FIELD_VALID.items():
            with self.subTest(field=field):
                self.assertEqual(validate(with_fields(**{field: value}), "x"), [])

    def test_player_bbox_bounds(self):
        bad_boxes = [
            {"x": 0.1, "y": 0.2, "width": 0.5},
            {"x": 0.1, "y": 0.2, "width": 0.5, "height": 0.5, "extra": 1},
            {"x": -0.1, "y": 0.2, "width": 0.5, "height": 0.5},
            {"x": 0.1, "y": 1.2, "width": 0.5, "height": 0.5},
            {"x": 0.1, "y": 0.2, "width": 0, "height": 0.5},
            {"x": 0.1, "y": 0.2, "width": 0.5, "height": 0},
            {"x": "0.1", "y": 0.2, "width": 0.5, "height": 0.5},
            {"x": True, "y": 0.2, "width": 0.5, "height": 0.5},
            [0.1, 0.2, 0.5, 0.5],
        ]
        for box in bad_boxes:
            with self.subTest(box=box):
                problems = validate(with_fields(player_bbox=box), "x")
                self.assertTrue(any("player_bbox" in error for error in problems), problems)
        self.assertEqual(
            validate(with_fields(player_bbox={"x": 0, "y": 0, "width": 1, "height": 1}), "x"), []
        )

    def test_keyframe_arrays_must_contain_objects(self):
        for field in ("pose_keyframes", "paddle_keyframes", "ball_keyframes", "court_keypoints"):
            with self.subTest(field=field):
                problems = validate(with_fields(**{field: [1, 2]}), "x")
                self.assertTrue(any(field in error for error in problems), problems)
                problems = validate(with_fields(**{field: [{}, []]}), "x")
                self.assertTrue(any(field in error for error in problems), problems)

    def test_checkpoint_label_rejects_unknown_keys(self):
        doc = valid_doc()
        doc["checkpoint_labels"][0]["comment"] = "extra"
        self.assertTrue(any("comment" in error for error in validate(doc, "x")))

    def test_checkpoint_label_note_is_a_string_of_at_most_500_characters(self):
        doc = valid_doc()
        doc["checkpoint_labels"][0]["note"] = "n" * 500
        self.assertEqual(validate(doc, "x"), [])
        doc["checkpoint_labels"][0]["note"] = "n" * 501
        self.assertTrue(any("note" in error for error in validate(doc, "x")))
        doc["checkpoint_labels"][0]["note"] = None
        self.assertTrue(any("note" in error for error in validate(doc, "x")))

    def test_checkpoint_label_fault_direction_and_severity_cannot_be_null(self):
        doc = valid_doc()
        doc["checkpoint_labels"][0]["verdict"] = "good"
        doc["checkpoint_labels"][0]["fault_direction"] = None
        self.assertTrue(any("fault_direction" in error for error in validate(doc, "x")))
        doc = valid_doc()
        doc["checkpoint_labels"][0]["fault_severity"] = None
        self.assertTrue(any("fault_severity" in error for error in validate(doc, "x")))
        doc = valid_doc()
        doc["checkpoint_labels"][0]["fault_severity"] = True
        self.assertTrue(any("fault_severity" in error for error in validate(doc, "x")))

    def test_checkpoint_label_requires_checkpoint_and_verdict(self):
        problems = validate(with_fields(checkpoint_labels=[{}]), "x")
        self.assertTrue(any("checkpoint" in error for error in problems))
        self.assertTrue(any("verdict" in error for error in problems))

    def test_missing_required_fields_are_reported_alongside_type_errors(self):
        problems = validate({"clip_id": []}, "x")
        self.assertTrue(any("missing required field" in error for error in problems))

    @unittest.skipIf(jsonschema is None, "jsonschema not installed")
    def test_validator_agrees_with_jsonschema_on_fixtures(self):
        schema = json.loads(ANNOTATION_SCHEMA.read_text(encoding="utf-8"))
        checker = jsonschema.Draft202012Validator(schema)
        fixtures = {
            "valid": valid_doc(),
            "valid_optional": with_fields(**OPTIONAL_FIELD_VALID),
            "no_stroke": no_stroke_doc(),
        }
        for outcome in ("unknown_technique", "partial", "aborted"):
            doc = negative_doc(outcome)
            doc["contact_range_ms"] = None
            if outcome == "unknown_technique":
                doc["phases"] = []
            fixtures[outcome] = doc
        for name, fields in TYPE_CONFUSION_CASES.items():
            fixtures[f"type_{name}"] = with_fields(**copy.deepcopy(fields))
        for field, value in OPTIONAL_FIELD_GARBAGE.items():
            fixtures[f"optional_{field}"] = with_fields(**{field: value})
        fixtures["clip_id_short"] = with_fields(clip_id="short")
        for name, doc in fixtures.items():
            with self.subTest(fixture=name):
                schema_ok = not list(checker.iter_errors(doc))
                validator_ok = validate(doc, name) == []
                self.assertEqual(validator_ok, schema_ok)


class ValidatorCliContractTest(unittest.TestCase):
    """Exit 0 = all valid; exit 1 = one INVALID line per bad file; never a traceback."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="validate-annotations-"))

    def write_json(self, name: str, doc) -> Path:
        path = self.tmp / name
        path.write_text(json.dumps(doc), encoding="utf-8")
        return path

    def test_valid_files_exit_zero(self):
        good = self.write_json("good.json", valid_doc())
        code, lines = run_main([good])
        self.assertEqual(code, 0)
        self.assertEqual(lines, ["ok good.json"])

    def test_invalid_utf8_is_reported_as_invalid(self):
        bad = self.tmp / "bad.json"
        bad.write_bytes(b"\xff\xfe")
        code, lines = run_main([bad])
        self.assertEqual(code, 1)
        self.assertEqual(len(lines), 1)
        self.assertTrue(lines[0].startswith(f"INVALID {bad}: unreadable"), lines)

    def test_invalid_utf8_inside_json_string_is_reported_as_invalid(self):
        bad = self.tmp / "bad.json"
        bad.write_bytes(b'{"clip_id": "\xff\xfe"}')
        code, lines = run_main([bad])
        self.assertEqual(code, 1)
        self.assertTrue(lines[0].startswith(f"INVALID {bad}: unreadable"), lines)

    def test_pathologically_deep_json_is_reported_as_invalid(self):
        deep = self.tmp / "deep.json"
        deep.write_text("[" * 100000 + "]" * 100000, encoding="utf-8")
        code, lines = run_main([deep])
        self.assertEqual(code, 1)
        self.assertTrue(lines[0].startswith(f"INVALID {deep}: unreadable"), lines)

    def test_missing_file_and_directory_are_reported_as_invalid(self):
        code, lines = run_main([self.tmp / "missing.json", self.tmp])
        self.assertEqual(code, 1)
        self.assertEqual(len(lines), 2)
        self.assertTrue(all(line.startswith("INVALID ") for line in lines), lines)

    @unittest.skipUnless(hasattr(os, "mkfifo"), "named pipes need POSIX")
    def test_named_pipe_does_not_block(self):
        fifo = self.tmp / "fifo.json"
        os.mkfifo(fifo)
        result = run_cli([fifo], timeout=5)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stderr, "")
        self.assertTrue(result.stdout.startswith(f"INVALID {fifo}"), result.stdout)

    def test_early_bad_file_does_not_abort_the_batch(self):
        bad = self.write_json("bad.json", with_fields(annotation_outcome=["recognized_technique"]))
        good = self.write_json("good.json", valid_doc())
        bad2 = self.write_json("bad2.json", with_fields(quality_flags={"clean": True}))
        bad3 = self.tmp / "bad3.json"
        bad3.write_bytes(b"\xff\xfe")
        good2 = self.write_json("good2.json", no_stroke_doc())
        code, lines = run_main([bad, good, bad2, bad3, good2])
        self.assertEqual(code, 1)
        self.assertIn("ok good.json", lines)
        self.assertIn("ok good2.json", lines)
        self.assertTrue(any(line.startswith("INVALID bad.json: ") for line in lines), lines)
        self.assertTrue(any(line.startswith("INVALID bad2.json: ") for line in lines), lines)
        self.assertTrue(any(line.startswith(f"INVALID {bad3}: ") for line in lines), lines)
        for line in lines:
            self.assertTrue(line.startswith(("ok ", "INVALID ")), line)

    def test_cli_never_writes_a_traceback_for_type_confused_payloads(self):
        paths = [
            self.write_json(f"{name}.json", with_fields(**copy.deepcopy(fields)))
            for name, fields in TYPE_CONFUSION_CASES.items()
        ]
        result = run_cli(paths)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stderr, "")
        invalid_names = {
            line.split(": ", 1)[0].removeprefix("INVALID ")
            for line in result.stdout.splitlines()
            if line.startswith("INVALID ")
        }
        self.assertEqual(invalid_names, {path.name for path in paths})

    def test_no_arguments_is_a_usage_error(self):
        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr):
            code, lines = run_main([])
        self.assertEqual(code, 1)
        self.assertEqual(lines, [])
        self.assertIn("usage", stderr.getvalue())

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
