"""Adjudication repro: ml/scripts/validate_annotations.py robustness.

For each adversarial input the validator MUST either print `ok` or
`INVALID ...` and exit 0/1 — never crash with a traceback (exit != 0/1 or
Traceback on stderr) and never hang. Also checks that the validator agrees
with ml/annotations/annotation.schema.json for every committed example.

Exit 0 iff every case behaves; exit 1 otherwise.
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
    report["cases"].append({"case": "fifo_path", "exitCode": rc, "hung": hung, "stderr": err[-200:]})
    ok = ok and not hung

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
        report["schemaAgreement"] = "jsonschema unavailable"

    print(json.dumps(report, indent=2))
    print("RESULT:", "ROBUST" if ok else "DEFECTS")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
