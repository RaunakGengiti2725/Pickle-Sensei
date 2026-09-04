#!/usr/bin/env python3
"""Validate temporal annotation files against the v2 annotation contract.

The validator uses only the Python standard library. The technique vocabulary
is loaded from ml/annotations/annotation.schema.json so this executable check
cannot silently drift from the JSON contract. Unit tests additionally compare
that enum with packages/shared-types/src/pickleballTaxonomy.ts.

Every constraint the JSON schema declares (types, enums, required/unknown keys,
bounds, optional-field shapes) is enforced here as well, plus the temporal
rules the schema cannot express. A document this validator accepts therefore
also satisfies annotation.schema.json.

Usage:
  python3 ml/scripts/validate_annotations.py path/to/annotations/*.json
Exit code 0 = all valid; 1 = any invalid, with at least one `INVALID <file>:`
line per bad file. Every input is processed regardless of earlier failures and
no input (wrong JSON type, bad encoding, pathological nesting, non-regular
file) may terminate the run with an exception.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any


SCHEMA_PATH = Path(__file__).resolve().parents[1] / "annotations" / "annotation.schema.json"
with SCHEMA_PATH.open(encoding="utf-8") as schema_file:
    _SCHEMA = json.load(schema_file)

TECHNIQUES = frozenset(_SCHEMA["$defs"]["canonicalTechnique"]["enum"])
ANNOTATION_OUTCOMES = {
    "recognized_technique",
    "unknown_technique",
    "no_stroke",
    "partial",
    "aborted",
}
HANDEDNESS = {"right", "left", "ambidextrous", "unknown"}
CAMERA_VIEWS = {
    "front",
    "rear",
    "dominant_side",
    "nondominant_side",
    "diagonal",
    "overhead",
    "other",
}
PHASES = ["ready", "prepare", "accelerate", "contact", "follow_through", "recover"]
PHASE_KEYS = {"key", "start_ms", "end_ms", "observable"}
CHECKPOINT_LABEL_REQUIRED = {"checkpoint", "verdict"}
CHECKPOINT_LABEL_KEYS = CHECKPOINT_LABEL_REQUIRED | {"fault_direction", "fault_severity", "note"}
CHECKPOINT_NOTE_MAX_LENGTH = 500
CLIP_ID_MIN_LENGTH = 8
BBOX_KEYS = {"x", "y", "width", "height"}
CHECKPOINTS = {
    "ready_position",
    "athletic_base",
    "preparation",
    "paddle_set",
    "swing_length",
    "sequencing",
    "paddle_path",
    "contact_position",
    "face_wrist_stability",
    "follow_through",
    "recovery",
}
VERDICTS = {"good", "minor_fault", "major_fault", "unobservable"}
FAULT_DIRECTIONS = {
    "late",
    "early",
    "high",
    "low",
    "long",
    "short",
    "wide",
    "narrow",
    "open",
    "closed",
    "unstable",
    "none",
}
QUALITY_FLAGS = {
    "clean",
    "motion_blur",
    "low_light",
    "partial_occlusion",
    "heavy_occlusion",
    "camera_shake",
    "player_cropped",
    "multiple_people",
    "bad_angle",
}
ATTRIBUTE_VALUES: dict[str, set[str | None]] = {
    "side": {"forehand", "backhand", "two_hand_backhand", "overhead", None},
    "spin": {"flat", "topspin", "slice", "sidespin", "mixed", "unknown", None},
    "direction": {
        "straight",
        "crosscourt",
        "middle",
        "inside_in",
        "inside_out",
        "around_the_post",
        "unknown",
        None,
    },
    "origin_zone": {
        "baseline",
        "backcourt",
        "transition",
        "nvz_line",
        "nvz",
        "outside_sideline",
        "unknown",
        None,
    },
    "target_zone": {
        "baseline",
        "backcourt",
        "transition",
        "nvz_line",
        "nvz",
        "outside_sideline",
        "unknown",
        None,
    },
    "contact_state": {"after_bounce", "volley", "half_volley", "overhead", None},
    "intent": {"attack", "neutral", "reset", "defend", "place", None},
    "rally_outcome": {
        "in_play",
        "winner",
        "forced_error",
        "unforced_error",
        "fault",
        "unknown",
        None,
    },
}
REQUIRED = {
    "clip_id",
    "annotation_outcome",
    "technique",
    "attributes",
    "handedness",
    "camera_view",
    "stroke_start_ms",
    "stroke_end_ms",
    "phases",
    "contact_range_ms",
    "checkpoint_labels",
    "acceptable_alternative_mechanics",
    "quality_flags",
    "annotator",
    "revision",
}
OPTIONAL_OBJECT_ARRAYS = {"pose_keyframes", "paddle_keyframes", "ball_keyframes"}
OPTIONAL_NULLABLE_OBJECT_ARRAYS = {"court_keypoints"}
OPTIONAL_NULLABLE_STRINGS = {
    "primary_coaching_priority",
    "occlusion_notes",
    "adjudicated_by",
    "adjudication_note",
}
OPTIONAL = (
    {"player_bbox"}
    | OPTIONAL_OBJECT_ARRAYS
    | OPTIONAL_NULLABLE_OBJECT_ARRAYS
    | OPTIONAL_NULLABLE_STRINGS
)


def _is_int(value: object) -> bool:
    return type(value) is int


def _is_number(value: object) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _in_enum(value: object, allowed) -> bool:
    """Enum membership for arbitrary JSON values (lists/dicts are unhashable)."""
    return (value is None or isinstance(value, str)) and value in allowed


def _is_object_array(value: object) -> bool:
    return isinstance(value, list) and all(isinstance(item, dict) for item in value)


def _valid_window(start: object, end: object) -> bool:
    return _is_int(start) and _is_int(end) and 0 <= start < end


def _bbox_errors(bbox: object) -> list[str]:
    if not isinstance(bbox, dict):
        return ["player_bbox must be null or an object {x,y,width,height}"]
    errors: list[str] = []
    for key in sorted(BBOX_KEYS - bbox.keys()):
        errors.append(f"player_bbox missing {key!r}")
    for key in sorted(bbox.keys() - BBOX_KEYS):
        errors.append(f"player_bbox contains unknown field {key!r}")
    for key in ("x", "y"):
        if key in bbox and not (_is_number(bbox[key]) and 0 <= bbox[key] <= 1):
            errors.append(f"player_bbox.{key} must be a number within [0,1]")
    for key in ("width", "height"):
        if key in bbox and not (_is_number(bbox[key]) and 0 < bbox[key] <= 1):
            errors.append(f"player_bbox.{key} must be a number within (0,1]")
    return errors


def validate(doc: dict[str, Any], name: str) -> list[str]:
    errors: list[str] = []

    def err(message: str) -> None:
        errors.append(f"{name}: {message}")

    if not isinstance(doc, dict):
        return [f"{name}: annotation must be a JSON object"]

    for key in sorted(REQUIRED - doc.keys()):
        err(f"missing required field {key!r}")
    for key in sorted(doc.keys() - REQUIRED - OPTIONAL):
        err(f"unknown field {key!r}")
    if REQUIRED - doc.keys():
        return errors

    clip_id = doc["clip_id"]
    if not (isinstance(clip_id, str) and len(clip_id) >= CLIP_ID_MIN_LENGTH):
        err(f"clip_id must be a string of at least {CLIP_ID_MIN_LENGTH} characters")

    outcome = doc["annotation_outcome"]
    technique = doc["technique"]
    if not _in_enum(outcome, ANNOTATION_OUTCOMES):
        err(f"unknown annotation_outcome {outcome!r}")
    if technique is not None and not _in_enum(technique, TECHNIQUES):
        err(f"unknown canonical technique {technique!r}")

    if outcome == "recognized_technique" and not _in_enum(technique, TECHNIQUES):
        err("recognized_technique requires one canonical technique")
    if _in_enum(outcome, {"unknown_technique", "no_stroke"}) and technique is not None:
        err(f"{outcome} requires technique=null; annotators must not guess a class")

    if not _in_enum(doc["handedness"], HANDEDNESS):
        err("handedness must be right|left|ambidextrous|unknown")
    if not _in_enum(doc["camera_view"], CAMERA_VIEWS):
        err("camera_view is not in the consent-first capture vocabulary")

    attributes = doc["attributes"]
    if not isinstance(attributes, dict):
        err("attributes must be an object")
    else:
        missing_attributes = ATTRIBUTE_VALUES.keys() - attributes.keys()
        extra_attributes = attributes.keys() - ATTRIBUTE_VALUES.keys()
        for key in sorted(missing_attributes):
            err(f"attributes missing {key!r}")
        for key in sorted(extra_attributes):
            err(f"attributes contains unknown field {key!r}")
        for key, allowed in ATTRIBUTE_VALUES.items():
            if key in attributes and not _in_enum(attributes[key], allowed):
                err(f"attributes.{key} has unknown value {attributes[key]!r}")
        if outcome == "no_stroke" and any(value is not None for value in attributes.values()):
            err("no_stroke requires all stroke attributes to be null")

    start, end = doc["stroke_start_ms"], doc["stroke_end_ms"]
    if _in_enum(outcome, {"recognized_technique", "unknown_technique"}):
        if not _valid_window(start, end):
            err(f"{outcome} requires 0 <= stroke_start_ms < stroke_end_ms")
    elif outcome == "no_stroke":
        if start is not None or end is not None:
            err("no_stroke requires null stroke boundaries")
    elif _in_enum(outcome, {"partial", "aborted"}):
        both_null = start is None and end is None
        if not both_null and not _valid_window(start, end):
            err(f"{outcome} boundaries must both be null or form a valid stroke window")

    phases = doc["phases"]
    if not isinstance(phases, list):
        err("phases must be an array")
        phases = []
    if outcome == "recognized_technique" and not phases:
        err("recognized_technique requires at least one observable phase span")
    if outcome == "no_stroke" and phases:
        err("no_stroke cannot contain phase spans")

    last_index = -1
    last_end = -1
    seen_phases: set[str] = set()
    for index, phase in enumerate(phases):
        if not isinstance(phase, dict):
            err(f"phase {index}: must be an object")
            continue
        if phase.keys() != PHASE_KEYS:
            err(f"phase {index}: fields must be exactly key,start_ms,end_ms,observable")
        key = phase.get("key")
        if not _in_enum(key, PHASES):
            err(f"unknown phase key {key!r}")
            continue
        if key in seen_phases:
            err(f"phase {key}: duplicate phase")
        seen_phases.add(key)
        phase_index = PHASES.index(key)
        if phase_index <= last_index:
            err("phases must appear once in canonical order ready→…→recover")
        last_index = phase_index

        p_start, p_end = phase.get("start_ms"), phase.get("end_ms")
        if not (_is_int(p_start) and _is_int(p_end) and 0 <= p_start <= p_end):
            err(f"phase {key}: require 0 <= start_ms <= end_ms")
            continue
        if p_start < last_end:
            err(f"phase {key}: phases must be non-overlapping and ordered")
        last_end = p_end
        if _valid_window(start, end) and not (start <= p_start <= p_end <= end):
            err(f"phase {key}: span must be inside the stroke window")
        if type(phase.get("observable")) is not bool:
            err(f"phase {key}: observable must be boolean")

    contact = doc["contact_range_ms"]
    if contact is not None:
        if not isinstance(contact, dict) or contact.keys() != {"start_ms", "end_ms"}:
            err("contact_range_ms must be null or exactly {start_ms,end_ms}")
        else:
            c_start, c_end = contact["start_ms"], contact["end_ms"]
            if not (_is_int(c_start) and _is_int(c_end) and 0 <= c_start <= c_end):
                err("contact_range_ms must satisfy 0 <= start_ms <= end_ms")
            elif _valid_window(start, end) and not (start <= c_start <= c_end <= end):
                err("contact_range_ms must be inside the stroke window")
    if outcome == "no_stroke" and contact is not None:
        err("no_stroke requires contact_range_ms=null")

    checkpoint_labels = doc["checkpoint_labels"]
    if not isinstance(checkpoint_labels, list):
        err("checkpoint_labels must be an array")
        checkpoint_labels = []
    if _in_enum(outcome, {"unknown_technique", "no_stroke"}) and checkpoint_labels:
        err(f"{outcome} cannot carry technique-specific checkpoint labels")
    for index, label in enumerate(checkpoint_labels):
        if not isinstance(label, dict):
            err(f"checkpoint label {index}: must be an object")
            continue
        for key in sorted(CHECKPOINT_LABEL_REQUIRED - label.keys()):
            err(f"checkpoint label {index}: missing required field {key!r}")
        for key in sorted(label.keys() - CHECKPOINT_LABEL_KEYS):
            err(f"checkpoint label {index}: unknown field {key!r}")
        checkpoint = label.get("checkpoint")
        if not _in_enum(checkpoint, CHECKPOINTS):
            err(f"unknown checkpoint {checkpoint!r}")
        verdict = label.get("verdict")
        if not _in_enum(verdict, VERDICTS):
            err(f"unknown verdict {verdict!r}")
        if "fault_direction" in label and not _in_enum(label["fault_direction"], FAULT_DIRECTIONS):
            err(f"unknown fault_direction {label['fault_direction']!r}")
        if _in_enum(verdict, {"minor_fault", "major_fault"}) and "fault_direction" not in label:
            err(f"checkpoint {checkpoint}: faults require fault_direction")
        if "fault_severity" in label:
            severity = label["fault_severity"]
            if not (_is_number(severity) and 0 <= severity <= 1):
                err("fault_severity must be within [0,1]")
        if "note" in label:
            note = label["note"]
            if not (isinstance(note, str) and len(note) <= CHECKPOINT_NOTE_MAX_LENGTH):
                err(f"checkpoint label note must be a string of at most {CHECKPOINT_NOTE_MAX_LENGTH} characters")

    quality_flags = doc["quality_flags"]
    if not isinstance(quality_flags, list) or not quality_flags:
        err("quality_flags must be a non-empty array")
    else:
        for flag in quality_flags:
            if not _in_enum(flag, QUALITY_FLAGS):
                err(f"unknown quality flag {flag!r}")
        known_flags = [flag for flag in quality_flags if isinstance(flag, str)]
        if len(known_flags) != len(set(known_flags)):
            err("quality_flags must be unique")
        if "clean" in known_flags and len(quality_flags) > 1:
            err("quality flag clean cannot be combined with a defect flag")

    if type(doc["acceptable_alternative_mechanics"]) is not bool:
        err("acceptable_alternative_mechanics must be boolean")
    if not (isinstance(doc["annotator"], str) and len(doc["annotator"]) >= 2):
        err("annotator must be a non-empty opaque reviewer identifier")
    if not (_is_int(doc["revision"]) and doc["revision"] >= 1):
        err("revision must be an integer >= 1")

    if "player_bbox" in doc and doc["player_bbox"] is not None:
        for problem in _bbox_errors(doc["player_bbox"]):
            err(problem)
    for key in sorted(OPTIONAL_OBJECT_ARRAYS & doc.keys()):
        if not _is_object_array(doc[key]):
            err(f"{key} must be an array of objects")
    for key in sorted(OPTIONAL_NULLABLE_OBJECT_ARRAYS & doc.keys()):
        if doc[key] is not None and not _is_object_array(doc[key]):
            err(f"{key} must be null or an array of objects")
    for key in sorted(OPTIONAL_NULLABLE_STRINGS & doc.keys()):
        if doc[key] is not None and not isinstance(doc[key], str):
            err(f"{key} must be null or a string")
    return errors


def _read_document(path: Path) -> Any:
    """Parse a regular UTF-8 JSON file; raise ValueError for anything else.

    The regular-file check happens before any open() so FIFOs, sockets and
    directories are rejected instead of blocking or erroring at read time.
    """
    try:
        if not path.is_file():
            raise ValueError("not a regular file" if path.exists() else "no such file")
        return json.loads(path.read_bytes().decode("utf-8"))
    except (OSError, UnicodeDecodeError, RecursionError) as exc:
        raise ValueError(str(exc) or type(exc).__name__) from exc


def main(paths: list[str]) -> int:
    if not paths:
        print("usage: validate_annotations.py <annotation.json> [...]", file=sys.stderr)
        return 1
    failures = 0
    for raw in paths:
        path = Path(raw)
        try:
            doc = _read_document(path)
        except ValueError as exc:
            print(f"INVALID {path}: unreadable ({exc})")
            failures += 1
            continue
        problems = validate(doc, path.name)
        if problems:
            failures += 1
            for problem in problems:
                print(f"INVALID {problem}")
        else:
            print(f"ok {path.name}")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
