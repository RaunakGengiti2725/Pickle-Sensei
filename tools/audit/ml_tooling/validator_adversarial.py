#!/usr/bin/env python3
"""Adversarial CLI + contract-parity probe for ml/scripts/validate_annotations.py.

What it does (all deterministic, no network):
  1. Writes a fixed set of annotation fixtures (valid, empty, malformed, hostile)
     into --out-dir/ann/.
  2. Runs the real CLI (`python3 ml/scripts/validate_annotations.py <file>`) on
     each fixture, one file per process, and records exit code, stdout, stderr,
     and whether the process died with an uncaught traceback.
  3. Runs the CLI once over ALL fixtures to check aggregate exit-code semantics.
  4. Validates the same fixtures with a JSON-Schema Draft 2020-12 validator
     against ml/annotations/annotation.schema.json (needs `jsonschema`; when
     it is not importable the parity section is reported UNAVAILABLE, never
     "passed").
  5. Emits --out-dir/validator-adversarial.json and a human table on stdout.

Exit codes: 0 = every expectation held and CLI/schema agree on every fixture
where agreement is expected; 1 = an expectation failed (crash, wrong exit
code, unexpected divergence); 2 = jsonschema unavailable (parity untested).

Usage:
  python3 tools/audit/ml_tooling/validator_adversarial.py --out-dir /tmp/ann-audit
"""
from __future__ import annotations

import argparse
import copy
import json
import os
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
CLI = REPO_ROOT / "ml" / "scripts" / "validate_annotations.py"
SCHEMA = REPO_ROOT / "ml" / "annotations" / "annotation.schema.json"


def valid_doc() -> dict:
    return {
        "clip_id": "clip-0001-forehand",
        "annotation_outcome": "recognized_technique",
        "technique": "drive_forehand",
        "attributes": {
            "side": "forehand",
            "spin": "flat",
            "direction": "straight",
            "origin_zone": "baseline",
            "target_zone": "baseline",
            "contact_state": "after_bounce",
            "intent": "attack",
            "rally_outcome": "in_play",
        },
        "handedness": "right",
        "camera_view": "dominant_side",
        "stroke_start_ms": 0,
        "stroke_end_ms": 2000,
        "phases": [
            {"key": "ready", "start_ms": 0, "end_ms": 300, "observable": True},
            {"key": "prepare", "start_ms": 300, "end_ms": 700, "observable": True},
            {"key": "accelerate", "start_ms": 700, "end_ms": 1000, "observable": True},
            {"key": "contact", "start_ms": 1000, "end_ms": 1090, "observable": True},
            {"key": "follow_through", "start_ms": 1090, "end_ms": 1400, "observable": True},
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


def mutate(**changes) -> dict:
    doc = valid_doc()
    for key, value in changes.items():
        doc[key] = value
    return doc


# name -> (bytes on disk, expected CLI exit, expected schema verdict or None when
# the schema cannot express the rule, note)
#   expected schema verdict: "valid" / "invalid" / None (no parity expectation)
FIXTURES: dict[str, tuple[bytes, int, str | None, str]] = {}


def add(name: str, payload, cli_exit: int, schema: str | None, note: str) -> None:
    data = payload if isinstance(payload, bytes) else json.dumps(payload, indent=1).encode("utf-8")
    FIXTURES[name] = (data, cli_exit, schema, note)


add("valid", valid_doc(), 0, "valid", "baseline valid recognized_technique")
add("empty-file", b"", 1, "invalid", "0-byte file")
add("whitespace-only", b"   \n", 1, "invalid", "whitespace only")
add("not-json", b"{not json", 1, "invalid", "syntax error")
add("utf8-bom", b"\xef\xbb\xbf" + json.dumps(valid_doc()).encode(), 1, "invalid", "UTF-8 BOM before JSON (json.loads rejects)")
add("invalid-utf8", b'{"clip_id": "\xff\xfe"}', 1, "invalid", "invalid UTF-8 bytes; UnicodeDecodeError is a ValueError, not OSError/JSONDecodeError")
add("top-level-array", [valid_doc()], 1, "invalid", "array instead of object")
add("top-level-null", None, 1, "invalid", "null document")
add("top-level-string", "hello", 1, "invalid", "string document")
add("duplicate-keys", b'{"clip_id":"clip-0001-forehand","clip_id":"other-0001-forehand"}' , 1, "invalid", "duplicate key: last wins silently; missing everything else")
add("nan-severity", json.dumps(valid_doc()).replace("0.6", "NaN").encode(), 1, None, "NaN literal accepted by python json; must be rejected")
add("inf-severity", json.dumps(valid_doc()).replace("0.6", "Infinity").encode(), 1, None, "Infinity literal")
add("deep-nesting", b"[" * 100000 + b"]" * 100000, 1, None, "100k nested arrays; RecursionError path")
add("bool-as-int-ms", mutate(stroke_start_ms=False), 1, "invalid", "bool is not an integer")
add("float-ms", mutate(stroke_start_ms=0.0), 1, None, "0.0: validator rejects (type is int); JSON Schema treats 0.0 as integer -> known divergence")
add("huge-int", mutate(stroke_end_ms=10**30, phases=[{"key": "ready", "start_ms": 0, "end_ms": 10**30, "observable": True}], contact_range_ms=None), 0, "valid", "1e30 ms accepted by both")
add("negative-ms", mutate(stroke_start_ms=-1), 1, "invalid", "negative start")
add("start-eq-end", mutate(stroke_start_ms=0, stroke_end_ms=0, phases=[{"key": "ready", "start_ms": 0, "end_ms": 0, "observable": True}], contact_range_ms=None), 1, None, "zero-length stroke: validator rejects, schema allows -> divergence")
add("clipid-short", mutate(clip_id="ab"), 0, None, "clip_id minLength 8 enforced only by schema -> known divergence")
add("clipid-traversal", mutate(clip_id="../../etc/passwd"), 0, "valid", "path-like clip_id accepted by both (no path semantics in validator)")
add("clipid-empty", mutate(clip_id=""), 0, None, "empty clip_id: schema minLength rejects, validator accepts -> divergence")
add("clipid-nonstring", mutate(clip_id=12345678), 0, None, "integer clip_id: schema rejects, validator accepts -> divergence")
add("unknown-top-field", mutate(extra_field=1), 1, "invalid", "unknown top-level field")
add("checkpoint-unknown-key", mutate(checkpoint_labels=[{"checkpoint": "recovery", "verdict": "good", "bogus": 1}]), 0, None, "checkpoint item additionalProperties=false only in schema -> divergence")
add("checkpoint-note-too-long", mutate(checkpoint_labels=[{"checkpoint": "recovery", "verdict": "good", "note": "x" * 501}]), 0, None, "note maxLength 500 only in schema -> divergence")
add("checkpoint-severity-string", mutate(checkpoint_labels=[{"checkpoint": "recovery", "verdict": "minor_fault", "fault_direction": "late", "fault_severity": "0.5"}]), 1, "invalid", "string severity")
add("checkpoint-severity-bool", mutate(checkpoint_labels=[{"checkpoint": "recovery", "verdict": "minor_fault", "fault_direction": "late", "fault_severity": True}]), 1, "invalid", "bool severity")
add("checkpoint-good-with-direction", mutate(checkpoint_labels=[{"checkpoint": "recovery", "verdict": "good", "fault_direction": "late"}]), 0, "valid", "good verdict + direction allowed by both")
add("player-bbox-out-of-range", mutate(player_bbox={"x": 2, "y": 0, "width": 0.5, "height": 0.5}), 0, None, "optional field content unchecked by validator -> divergence")
add("player-bbox-garbage", mutate(player_bbox="garbage"), 0, None, "optional field type unchecked by validator -> divergence")
add("adjudicated-by-int", mutate(adjudicated_by=42), 0, None, "optional string field type unchecked -> divergence")
add("pose-keyframes-nonarray", mutate(pose_keyframes={"a": 1}), 0, None, "optional array field type unchecked -> divergence")
add("phase-outside-window", mutate(phases=[{"key": "ready", "start_ms": 0, "end_ms": 3000, "observable": True}], contact_range_ms=None), 1, None, "phase exceeds stroke window: validator rejects, schema cannot -> divergence")
add("phase-overlap", mutate(phases=[{"key": "ready", "start_ms": 0, "end_ms": 400, "observable": True}, {"key": "prepare", "start_ms": 300, "end_ms": 700, "observable": True}], contact_range_ms=None), 1, None, "overlap: validator only")
add("phase-duplicate", mutate(phases=[{"key": "ready", "start_ms": 0, "end_ms": 300, "observable": True}, {"key": "ready", "start_ms": 300, "end_ms": 700, "observable": True}], contact_range_ms=None), 1, None, "duplicate phase: validator only")
add("phase-observable-string", mutate(phases=[{"key": "ready", "start_ms": 0, "end_ms": 300, "observable": "true"}], contact_range_ms=None), 1, "invalid", "string observable")
add("phase-extra-key", mutate(phases=[{"key": "ready", "start_ms": 0, "end_ms": 300, "observable": True, "x": 1}], contact_range_ms=None), 1, "invalid", "extra phase key")
add("phase-not-object", mutate(phases=["ready"], contact_range_ms=None), 1, "invalid", "phase is a string")
add("contact-outside-window", mutate(contact_range_ms={"start_ms": 2500, "end_ms": 2600}), 1, None, "contact outside stroke: validator only")
add("contact-extra-key", mutate(contact_range_ms={"start_ms": 1000, "end_ms": 1090, "z": 1}), 1, "invalid", "extra contact key")
add("unknown-technique-guess", {**valid_doc(), "annotation_outcome": "unknown_technique", "checkpoint_labels": []}, 1, "invalid", "unknown_technique with a technique set")
add("unknown-technique-ok", {**valid_doc(), "annotation_outcome": "unknown_technique", "technique": None, "checkpoint_labels": []}, 0, "valid", "unknown_technique abstaining")
add("unknown-technique-with-attrs", {**valid_doc(), "annotation_outcome": "unknown_technique", "technique": None, "checkpoint_labels": []}, 0, "valid", "attributes kept on unknown_technique (allowed by both)")
add("unknown-technique-null-window", {**valid_doc(), "annotation_outcome": "unknown_technique", "technique": None, "checkpoint_labels": [], "stroke_start_ms": None, "stroke_end_ms": None, "phases": [], "contact_range_ms": None}, 1, "invalid", "unknown_technique needs a window")
add("no-stroke-ok", {**valid_doc(), "annotation_outcome": "no_stroke", "technique": None, "checkpoint_labels": [], "stroke_start_ms": None, "stroke_end_ms": None, "phases": [], "contact_range_ms": None, "attributes": {k: None for k in valid_doc()["attributes"]}}, 0, "valid", "clean negative")
add("no-stroke-with-attrs", {**valid_doc(), "annotation_outcome": "no_stroke", "technique": None, "checkpoint_labels": [], "stroke_start_ms": None, "stroke_end_ms": None, "phases": [], "contact_range_ms": None}, 1, None, "no_stroke with stroke attributes: validator rejects, schema cannot -> divergence")
add("no-stroke-with-contact", {**valid_doc(), "annotation_outcome": "no_stroke", "technique": None, "checkpoint_labels": [], "stroke_start_ms": None, "stroke_end_ms": None, "phases": [], "attributes": {k: None for k in valid_doc()["attributes"]}}, 1, "invalid", "no_stroke with contact range")
add("partial-null-window", {**valid_doc(), "annotation_outcome": "partial", "technique": None, "checkpoint_labels": [], "stroke_start_ms": None, "stroke_end_ms": None, "phases": [], "contact_range_ms": None}, 0, "valid", "partial may have null window")
add("partial-half-null", {**valid_doc(), "annotation_outcome": "partial", "technique": None, "checkpoint_labels": [], "stroke_start_ms": None, "phases": [], "contact_range_ms": None}, 1, None, "only one boundary null: validator rejects, schema cannot -> divergence")
add("aborted-with-technique", {**valid_doc(), "annotation_outcome": "aborted"}, 0, "valid", "aborted may keep a technique guess (both allow)")
add("outcome-unknown", mutate(annotation_outcome="maybe"), 1, "invalid", "unknown outcome")
add("outcome-null", mutate(annotation_outcome=None), 1, "invalid", "null outcome")
add("technique-legacy", mutate(technique="forehand_drive"), 1, "invalid", "legacy broad class")
add("technique-case", mutate(technique="Drive_Forehand"), 1, "invalid", "case-sensitive enum")
add("attributes-missing-key", mutate(attributes={k: v for k, v in valid_doc()["attributes"].items() if k != "spin"}), 1, "invalid", "attributes missing spin")
add("attributes-extra-key", mutate(attributes={**valid_doc()["attributes"], "speed_mph": 40}), 1, "invalid", "attributes extra key")
add("attributes-not-object", mutate(attributes=[]), 1, "invalid", "attributes array")
add("attributes-bad-value", mutate(attributes={**valid_doc()["attributes"], "spin": "wicked"}), 1, "invalid", "unknown spin")
add("quality-flags-empty", mutate(quality_flags=[]), 1, "invalid", "empty flags")
add("quality-flags-dup", mutate(quality_flags=["motion_blur", "motion_blur"]), 1, "invalid", "duplicate flags")
add("quality-flags-clean-plus", mutate(quality_flags=["clean", "low_light"]), 1, None, "clean+defect: validator only")
add("quality-flags-not-array", mutate(quality_flags="clean"), 1, "invalid", "string flags")
add("annotator-short", mutate(annotator="a"), 1, "invalid", "1-char annotator")
add("annotator-int", mutate(annotator=12), 1, "invalid", "int annotator")
add("revision-zero", mutate(revision=0), 1, "invalid", "revision 0")
add("revision-float", mutate(revision=1.0), 1, None, "1.0 revision: validator rejects, schema integer accepts -> divergence")
add("revision-bool", mutate(revision=True), 1, "invalid", "bool revision")
add("alt-mechanics-string", mutate(acceptable_alternative_mechanics="no"), 1, "invalid", "string bool")
add("handedness-unknown-value", mutate(handedness="both"), 1, "invalid", "bad handedness")
add("camera-view-bad", mutate(camera_view="drone"), 1, "invalid", "bad camera view")
add("missing-required", {k: v for k, v in valid_doc().items() if k != "annotator"}, 1, "invalid", "missing annotator")
add("every-required-missing", {}, 1, "invalid", "empty object")


def write_fixtures(ann_dir: Path) -> None:
    ann_dir.mkdir(parents=True, exist_ok=True)
    for name, (data, _, _, _) in FIXTURES.items():
        (ann_dir / f"{name}.json").write_bytes(data)


def run_cli(*paths: Path) -> dict:
    proc = subprocess.run(
        [sys.executable, str(CLI), *[str(p) for p in paths]],
        capture_output=True,
        text=True,
        cwd=str(REPO_ROOT),
        errors="replace",
    )
    return {
        "exit": proc.returncode,
        "stdout": proc.stdout.strip(),
        "stderr": proc.stderr.strip(),
        "traceback": "Traceback (most recent call last)" in proc.stderr,
    }


def schema_verdict(validator, data: bytes) -> str:
    try:
        doc = json.loads(data.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError, RecursionError):
        return "invalid"
    errors = list(validator.iter_errors(doc))
    return "invalid" if errors else "valid"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out-dir", required=True)
    args = parser.parse_args()
    out_dir = Path(args.out_dir)
    ann_dir = out_dir / "ann"
    write_fixtures(ann_dir)

    try:
        import jsonschema  # type: ignore

        validator = jsonschema.Draft202012Validator(json.loads(SCHEMA.read_text(encoding="utf-8")))
        schema_available = True
    except ImportError:
        validator = None
        schema_available = False

    rows = []
    problems: list[str] = []
    for name, (data, expected_exit, expected_schema, note) in FIXTURES.items():
        path = ann_dir / f"{name}.json"
        cli = run_cli(path)
        row = {
            "fixture": name,
            "note": note,
            "cli_exit": cli["exit"],
            "cli_expected_exit": expected_exit,
            "cli_traceback": cli["traceback"],
            "cli_stdout": cli["stdout"][:400],
            "cli_stderr_tail": cli["stderr"][-400:],
        }
        if cli["exit"] != expected_exit:
            problems.append(f"{name}: CLI exit {cli['exit']} != expected {expected_exit}")
        if cli["traceback"]:
            problems.append(f"{name}: CLI died with an uncaught traceback (exit {cli['exit']})")
        if schema_available:
            verdict = schema_verdict(validator, data)
            row["schema_verdict"] = verdict
            cli_verdict = "valid" if cli["exit"] == 0 else "invalid"
            row["parity"] = "agree" if verdict == cli_verdict else f"DIVERGE(cli={cli_verdict},schema={verdict})"
            if expected_schema is not None and verdict != expected_schema:
                problems.append(f"{name}: schema verdict {verdict} != expected {expected_schema}")
            if expected_schema is not None and verdict != cli_verdict:
                problems.append(f"{name}: unexpected CLI/schema divergence cli={cli_verdict} schema={verdict}")
        rows.append(row)

    aggregate = run_cli(*[ann_dir / f"{n}.json" for n in FIXTURES])
    valid_only = run_cli(ann_dir / "valid.json", ann_dir / "unknown-technique-ok.json", ann_dir / "no-stroke-ok.json")
    no_args = run_cli()
    missing = run_cli(ann_dir / "does-not-exist.json")
    directory = run_cli(ann_dir)
    semantics = {
        "all_fixtures": {"exit": aggregate["exit"], "expected": 1},
        "only_valid_files": {"exit": valid_only["exit"], "expected": 0},
        "no_args": {"exit": no_args["exit"], "expected": 1, "stderr": no_args["stderr"][:200]},
        "missing_file": {"exit": missing["exit"], "expected": 1, "stdout": missing["stdout"][:200]},
        "directory_arg": {"exit": directory["exit"], "expected": 1, "stdout": directory["stdout"][:200]},
    }
    for key, entry in semantics.items():
        if entry["exit"] != entry["expected"]:
            problems.append(f"aggregate {key}: exit {entry['exit']} != {entry['expected']}")

    divergences = [r for r in rows if r.get("parity", "").startswith("DIVERGE")]
    report = {
        "cli": str(CLI.relative_to(REPO_ROOT)),
        "schema": str(SCHEMA.relative_to(REPO_ROOT)),
        "jsonschema_available": schema_available,
        "fixtures": len(rows),
        "problems": problems,
        "divergences": [{"fixture": d["fixture"], "parity": d["parity"], "note": d["note"]} for d in divergences],
        "aggregate_semantics": semantics,
        "rows": rows,
    }
    (out_dir / "validator-adversarial.json").write_text(json.dumps(report, indent=1), encoding="utf-8")

    print(f"{'fixture':34} {'cli':>4} {'exp':>4} tb  schema   parity")
    for r in rows:
        print(f"{r['fixture']:34} {r['cli_exit']:>4} {r['cli_expected_exit']:>4} {'Y' if r['cli_traceback'] else '-':>2}  {r.get('schema_verdict','n/a'):8} {r.get('parity','n/a')}")
    print()
    print(f"fixtures={len(rows)} divergences={len(divergences)} problems={len(problems)} jsonschema={'yes' if schema_available else 'UNAVAILABLE'}")
    for p in problems:
        print(f"PROBLEM: {p}")
    if not schema_available:
        return 2
    return 1 if problems else 0


if __name__ == "__main__":
    raise SystemExit(main())
