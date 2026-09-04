"""Adjudication repro: ml/scripts/validate_annotations.py robustness.

For each adversarial input the validator MUST either print `ok` or
`INVALID ...` and exit 0/1 — never crash with a traceback (exit != 0/1 or
Traceback on stderr) and never hang. Also checks that the validator agrees
with ml/annotations/annotation.schema.json for every committed example.

Exit 0 iff every case behaves; exit 1 otherwise. The schema-agreement half
needs the `jsonschema` package; when it is missing the run is a DEFECT, not
a pass (a skipped check is never evidence).
"""

from __future__ import annotations

import copy
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
VALIDATOR = REPO_ROOT / "ml/scripts/validate_annotations.py"
SCHEMA = REPO_ROOT / "ml/annotations/annotation.schema.json"
sys.path.insert(0, str(REPO_ROOT / "ml/scripts"))
from test_validate_annotations import negative_doc, valid_doc  # noqa: E402


def run(paths: list[str], timeout: float = 10.0) -> tuple[int | None, str, str]:
    try:
        p = subprocess.run([sys.executable, str(VALIDATOR), *paths], capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        return None, "", "TIMEOUT"
    return p.returncode, p.stdout, p.stderr


def base_doc() -> dict:
    return valid_doc()


def main() -> int:
    report = {"cases": [], "schemaAgreement": None}
    ok = True
    tmp = Path(tempfile.mkdtemp(prefix="adj-validator-"))
    base = base_doc()

    def case(name: str, write, expect_invalid: bool = True):
        nonlocal ok
        path = tmp / f"{name}.json"
        write(path)
        rc, out, err = run([str(path)])
        crashed = rc not in (0, 1) or "Traceback" in err or rc is None
        graceful = (not crashed) and (rc == 1 if expect_invalid else rc == 0)
        row = {"case": name, "exitCode": rc, "stdout": out.strip()[:200], "stderrTail": err.strip()[-300:], "graceful": graceful}
        report["cases"].append(row)
        ok = ok and graceful

    case("invalid_utf8", lambda p: p.write_bytes(b'{"clip_id": "\xff\xfe"}'))
    case("deep_nesting", lambda p: p.write_text("[" * 100000 + "]" * 100000))

    def mutate(**kv):
        def w(p: Path):
            d = copy.deepcopy(base)
            d.update(kv)
            p.write_text(json.dumps(d))
        return w

    case("handedness_list", mutate(handedness=["right"]))
    case("technique_dict", mutate(technique={"x": 1}))
    case("outcome_list", mutate(annotation_outcome=[]))
    case("camera_view_list", mutate(camera_view=[]))
    case("quality_flags_nested_list", mutate(quality_flags=[["clean"]]))
    attrs = copy.deepcopy(base["attributes"])
    attrs[next(iter(attrs))] = []
    case("attribute_value_list", mutate(attributes=attrs))
    case("phase_key_list", mutate(phases=[{"key": [], "start_ms": 0, "end_ms": 1, "observable": True}]))
    case("checkpoint_label_list_fields", mutate(checkpoint_labels=[{"checkpoint": [], "verdict": [], "fault_direction": []}]))
    case("stroke_start_bool", mutate(stroke_start_ms=True, stroke_end_ms=1000))

    dup = json.dumps(base)[:-1] + ', "revision": 999999}'  # duplicate key, last wins silently
    def dup_writer(p: Path):
        p.write_text(dup)
    path = tmp / "duplicate_key.json"
    dup_writer(path)
    rc, out, err = run([str(path)])
    report["cases"].append({"case": "duplicate_key_last_wins", "exitCode": rc, "stdout": out.strip()[:200],
                            "note": "accepted silently; python json keeps the LAST duplicate"})

    # FIFO: validator must not block forever on a path that is a named pipe
    fifo = tmp / "fifo.json"
    os.mkfifo(fifo)
    rc, out, err = run([str(fifo)], timeout=5)
    hung = rc is None
    fifo_graceful = (not hung) and rc == 1 and "Traceback" not in err and out.startswith("INVALID")
    report["cases"].append({"case": "fifo_path", "exitCode": rc, "hung": hung, "graceful": fifo_graceful,
                            "stderr": err[-200:]})
    ok = ok and fifo_graceful

    # Batch: an early bad file must not abort the run — every later file still gets
    # its own `ok` / `INVALID` line and the exit code reflects the whole batch.
    batch_bad = tmp / "batch_bad.json"
    batch_good = tmp / "batch_good.json"
    batch_bad2 = tmp / "batch_bad2.json"
    mutate(annotation_outcome=[])(batch_bad)
    batch_good.write_text(json.dumps(base))
    mutate(quality_flags={"clean": True})(batch_bad2)
    rc, out, err = run([str(batch_bad), str(batch_good), str(batch_bad2)])
    lines = out.strip().splitlines()
    batch_graceful = (
        rc == 1
        and "Traceback" not in err
        and any(l.startswith("INVALID batch_bad.json") for l in lines)
        and "ok batch_good.json" in lines
        and any(l.startswith("INVALID batch_bad2.json") for l in lines)
    )
    report["cases"].append({"case": "batch_bad_good_bad2", "exitCode": rc, "stdout": lines[:6],
                            "stderrTail": err.strip()[-300:], "graceful": batch_graceful})
    ok = ok and batch_graceful

    # Schema agreement: documents the validator accepts must satisfy annotation.schema.json
    try:
        import jsonschema
        schema = json.loads(SCHEMA.read_text())
        validator = jsonschema.Draft202012Validator(schema) if "2020-12" in schema.get("$schema", "") else jsonschema.Draft7Validator(schema)
        docs = {"valid_doc": valid_doc()}
        for outcome in ("unknown_technique", "no_stroke", "partial", "aborted"):
            d = negative_doc(outcome)
            if outcome == "no_stroke":
                d["attributes"] = {k: None for k in d["attributes"]}
                d["stroke_start_ms"] = d["stroke_end_ms"] = None
                d["phases"] = []
                d["contact_range_ms"] = None
            docs[f"negative_{outcome}"] = d
        # optional fields with plausible shapes the validator never inspects
        opt = valid_doc()
        opt.update({"player_bbox": "not-a-box", "pose_keyframes": 42, "paddle_keyframes": {}, "ball_keyframes": None,
                    "court_keypoints": True, "primary_coaching_priority": [], "occlusion_notes": 1,
                    "adjudicated_by": [], "adjudication_note": {}})
        docs["optional_fields_garbage"] = opt
        # one payload per optional field so a single lenient check cannot hide behind the others
        for field, value in (("player_bbox", "not-a-box"), ("pose_keyframes", 42), ("paddle_keyframes", {}),
                             ("ball_keyframes", None), ("court_keypoints", True),
                             ("primary_coaching_priority", []), ("occlusion_notes", 1),
                             ("adjudicated_by", []), ("adjudication_note", {})):
            d = valid_doc()
            d[field] = value
            docs[f"optional_{field}_garbage"] = d
        # optional fields with schema-valid shapes must be ACCEPTED by both
        opt_ok = valid_doc()
        opt_ok.update({"player_bbox": {"x": 0.1, "y": 0.2, "width": 0.5, "height": 0.7},
                       "pose_keyframes": [{"t_ms": 0}], "paddle_keyframes": [], "ball_keyframes": [{}],
                       "court_keypoints": None, "primary_coaching_priority": "contact_position",
                       "occlusion_notes": None, "adjudicated_by": "coach-b", "adjudication_note": "ok"})
        docs["optional_fields_valid"] = opt_ok
        # other schema constraints the validator must mirror
        d = valid_doc(); d["clip_id"] = "short"; docs["clip_id_too_short"] = d
        d = valid_doc(); d["checkpoint_labels"][0]["comment"] = "x"; docs["checkpoint_extra_key"] = d
        d = valid_doc(); d["checkpoint_labels"][0]["note"] = "n" * 501; docs["checkpoint_note_too_long"] = d
        d = valid_doc(); d["checkpoint_labels"][0]["fault_severity"] = None; docs["checkpoint_severity_null"] = d
        d = valid_doc(); d["checkpoint_labels"][0]["verdict"] = "good"; d["checkpoint_labels"][0]["fault_direction"] = None
        docs["checkpoint_direction_null"] = d
        for name in ("handedness_list", "technique_dict", "outcome_list", "camera_view_list",
                     "quality_flags_nested_list", "attribute_value_list", "phase_key_list",
                     "checkpoint_label_list_fields", "stroke_start_bool"):
            docs[f"type_{name}"] = json.loads((tmp / f"{name}.json").read_text())
        rows = []
        for name, doc in docs.items():
            p = tmp / f"schema_{name}.json"
            p.write_text(json.dumps(doc))
            schema_errors = [e.message for e in validator.iter_errors(doc)]
            rc, out, err = run([str(p)])
            agree = (rc == 0) == (not schema_errors)
            rows.append({"doc": name, "validatorExit": rc, "schemaErrors": schema_errors[:6], "agree": agree})
            ok = ok and agree
        report["schemaAgreement"] = rows
    except ImportError:
        report["schemaAgreement"] = "jsonschema unavailable — agreement NOT checked; run with a Python that has jsonschema"
        ok = False

    print(json.dumps(report, indent=2))
    print("RESULT:", "ROBUST" if ok else "DEFECTS")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
