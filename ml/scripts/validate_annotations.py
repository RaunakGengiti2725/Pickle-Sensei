#!/usr/bin/env python3
"""Validate temporal annotation files against the v2 annotation contract.

The validator uses only the Python standard library. The technique vocabulary
is loaded from ml/annotations/annotation.schema.json so this executable check
cannot silently drift from the JSON contract. Unit tests additionally compare
that enum with packages/shared-types/src/pickleballTaxonomy.ts.

Usage:
  python3 ml/scripts/validate_annotations.py path/to/annotations/*.json
Exit code 0 = all valid; 1 = any invalid (errors printed).
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
PHASES = ["ready", "prepare", "accelerate", "contact", "follow_through", "recover"]
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
OPTIONAL = {
    "player_bbox",
    "pose_keyframes",
    "paddle_keyframes",
    "ball_keyframes",
    "court_keypoints",
    "primary_coaching_priority",
    "occlusion_notes",
    "adjudicated_by",
    "adjudication_note",
}


def _is_int(value: object) -> bool:
    return type(value) is int


def _valid_window(start: object, end: object) -> bool:
    return _is_int(start) and _is_int(end) and 0 <= start < end


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

    outcome = doc["annotation_outcome"]
    technique = doc["technique"]
    if outcome not in ANNOTATION_OUTCOMES:
        err(f"unknown annotation_outcome {outcome!r}")
    if technique is not None and technique not in TECHNIQUES:
        err(f"unknown canonical technique {technique!r}")

    if outcome == "recognized_technique" and technique not in TECHNIQUES:
        err("recognized_technique requires one canonical technique")
    if outcome in {"unknown_technique", "no_stroke"} and technique is not None:
        err(f"{outcome} requires technique=null; annotators must not guess a class")

    if doc["handedness"] not in {"right", "left", "ambidextrous", "unknown"}:
        err("handedness must be right|left|ambidextrous|unknown")
    if doc["camera_view"] not in {
        "front",
        "rear",
        "dominant_side",
        "nondominant_side",
        "diagonal",
        "overhead",
        "other",
    }:
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
            if key in attributes and attributes[key] not in allowed:
                err(f"attributes.{key} has unknown value {attributes[key]!r}")
        if outcome == "no_stroke" and any(value is not None for value in attributes.values()):
            err("no_stroke requires all stroke attributes to be null")

    start, end = doc["stroke_start_ms"], doc["stroke_end_ms"]
    if outcome in {"recognized_technique", "unknown_technique"}:
        if not _valid_window(start, end):
            err(f"{outcome} requires 0 <= stroke_start_ms < stroke_end_ms")
    elif outcome == "no_stroke":
        if start is not None or end is not None:
            err("no_stroke requires null stroke boundaries")
    elif outcome in {"partial", "aborted"}:
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
        required_phase_keys = {"key", "start_ms", "end_ms", "observable"}
        if set(phase) != required_phase_keys:
            err(f"phase {index}: fields must be exactly key,start_ms,end_ms,observable")
        key = phase.get("key")
        if key not in PHASES:
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
        if not isinstance(contact, dict) or set(contact) != {"start_ms", "end_ms"}:
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
    if outcome in {"unknown_technique", "no_stroke"} and checkpoint_labels:
        err(f"{outcome} cannot carry technique-specific checkpoint labels")
    for label in checkpoint_labels:
        if not isinstance(label, dict):
            err("checkpoint label must be an object")
            continue
        if label.get("checkpoint") not in CHECKPOINTS:
            err(f"unknown checkpoint {label.get('checkpoint')!r}")
        verdict = label.get("verdict")
        if verdict not in VERDICTS:
            err(f"unknown verdict {verdict!r}")
        direction = label.get("fault_direction")
        if direction is not None and direction not in FAULT_DIRECTIONS:
            err(f"unknown fault_direction {direction!r}")
        if verdict in {"minor_fault", "major_fault"} and direction is None:
            err(f"checkpoint {label.get('checkpoint')}: faults require fault_direction")
        severity = label.get("fault_severity")
        if severity is not None and not (
            isinstance(severity, (int, float))
            and not isinstance(severity, bool)
            and 0 <= severity <= 1
        ):
            err("fault_severity must be within [0,1]")

    quality_flags = doc["quality_flags"]
    if not isinstance(quality_flags, list) or not quality_flags:
        err("quality_flags must be a non-empty array")
    else:
        if len(quality_flags) != len(set(quality_flags)):
            err("quality_flags must be unique")
        for flag in quality_flags:
            if flag not in QUALITY_FLAGS:
                err(f"unknown quality flag {flag!r}")
        if "clean" in quality_flags and len(quality_flags) > 1:
            err("quality flag clean cannot be combined with a defect flag")

    if type(doc["acceptable_alternative_mechanics"]) is not bool:
        err("acceptable_alternative_mechanics must be boolean")
    if not (isinstance(doc["annotator"], str) and len(doc["annotator"]) >= 2):
        err("annotator must be a non-empty opaque reviewer identifier")
    if not (_is_int(doc["revision"]) and doc["revision"] >= 1):
        err("revision must be an integer >= 1")
    return errors


def main(paths: list[str]) -> int:
    if not paths:
        print("usage: validate_annotations.py <annotation.json> [...]", file=sys.stderr)
        return 1
    failures = 0
    for raw in paths:
        path = Path(raw)
        try:
            doc = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
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
