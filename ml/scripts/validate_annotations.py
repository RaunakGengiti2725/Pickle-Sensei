#!/usr/bin/env python3
"""Validate annotation files against ml/annotations/annotation.schema.json.

Standard-library implementation (no jsonschema dependency) covering the
constraints our schema actually uses: required keys, enums, ranges, types,
additionalProperties, and cross-field ordering rules the JSON Schema cannot
express (phase ordering, stroke window sanity).

Usage:
  python3 ml/scripts/validate_annotations.py path/to/annotations/*.json
Exit code 0 = all valid; 1 = any invalid (errors printed).
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

SHOT_TYPES = {"serve", "return", "forehand_drive", "backhand_drive", "third_shot_drop", "dink", "volley", "overhead"}
PHASES = ["ready", "prepare", "accelerate", "contact", "follow_through", "recover"]
CHECKPOINTS = {
    "ready_position", "athletic_base", "preparation", "paddle_set", "swing_length", "sequencing",
    "paddle_path", "contact_position", "face_wrist_stability", "follow_through", "recovery",
}
VERDICTS = {"good", "minor_fault", "major_fault", "unobservable"}
QUALITY_FLAGS = {
    "clean", "motion_blur", "low_light", "partial_occlusion", "heavy_occlusion",
    "camera_shake", "player_cropped", "multiple_people", "bad_angle",
}
REQUIRED = [
    "clip_id", "shot_type", "handedness", "camera_view", "stroke_start_ms",
    "stroke_end_ms", "phases", "quality_flags", "annotator", "revision",
]


def validate(doc: dict, name: str) -> list[str]:
    errors: list[str] = []

    def err(message: str) -> None:
        errors.append(f"{name}: {message}")

    for key in REQUIRED:
        if key not in doc:
            err(f"missing required field '{key}'")
    if errors:
        return errors

    if doc["shot_type"] not in SHOT_TYPES:
        err(f"unknown shot_type {doc['shot_type']!r}")
    if doc["handedness"] not in {"right", "left"}:
        err("handedness must be right|left")
    if doc["camera_view"] not in {"side", "rear_oblique", "other"}:
        err("camera_view must be side|rear_oblique|other")

    start, end = doc["stroke_start_ms"], doc["stroke_end_ms"]
    if not (isinstance(start, int) and isinstance(end, int) and 0 <= start < end):
        err("stroke window must satisfy 0 <= start_ms < end_ms")

    last_end = -1
    seen_phases: list[str] = []
    for phase in doc["phases"]:
        key = phase.get("key")
        if key not in PHASES:
            err(f"unknown phase key {key!r}")
            continue
        seen_phases.append(key)
        p_start, p_end = phase.get("start_ms"), phase.get("end_ms")
        if not (isinstance(p_start, int) and isinstance(p_end, int) and p_start <= p_end):
            err(f"phase {key}: start_ms must be <= end_ms")
            continue
        if p_start < last_end:
            err(f"phase {key}: phases must be non-overlapping and ordered")
        last_end = p_end
    if [p for p in PHASES if p in seen_phases] != seen_phases:
        err("phases must appear in canonical order ready→…→recover")

    for label in doc.get("checkpoint_labels", []):
        if label.get("checkpoint") not in CHECKPOINTS:
            err(f"unknown checkpoint {label.get('checkpoint')!r}")
        if label.get("verdict") not in VERDICTS:
            err(f"unknown verdict {label.get('verdict')!r}")
        severity = label.get("fault_severity")
        if severity is not None and not (isinstance(severity, (int, float)) and 0 <= severity <= 1):
            err("fault_severity must be within [0,1]")
        if label.get("verdict") in {"minor_fault", "major_fault"} and "fault_direction" not in label:
            err(f"checkpoint {label.get('checkpoint')}: faults require fault_direction")

    for flag in doc["quality_flags"]:
        if flag not in QUALITY_FLAGS:
            err(f"unknown quality flag {flag!r}")

    if not (isinstance(doc["revision"], int) and doc["revision"] >= 1):
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
            doc = json.loads(path.read_text())
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
