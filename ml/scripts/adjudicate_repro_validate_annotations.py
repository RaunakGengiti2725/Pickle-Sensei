"""Independent minimal repros for the ml/scripts findings (no tester harness)."""
import json
import subprocess
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "ml" / "scripts"))
import validate_annotations as va  # noqa: E402

LEGAL = {
    "clip_id": "stress-000000000000000-1",
    "annotation_outcome": "no_stroke",
    "technique": None,
    "attributes": {k: None for k in va.ATTRIBUTE_VALUES},
    "handedness": "unknown",
    "camera_view": "other",
    "stroke_start_ms": None,
    "stroke_end_ms": None,
    "phases": [],
    "contact_range_ms": None,
    "checkpoint_labels": [],
    "acceptable_alternative_mechanics": False,
    "quality_flags": ["clean"],
    "annotator": "coach-a",
    "revision": 1,
}
assert va.validate(LEGAL, "legal.json") == [], va.validate(LEGAL, "legal.json")

def attempt(label, doc):
    try:
        print(label, "->", va.validate(doc, "x.json"))
    except Exception as exc:  # noqa: BLE001
        print(label, "-> RAISED", type(exc).__name__, exc)

# ML-1: set membership before type check
attempt("ML-1 annotation_outcome=list", {**LEGAL, "annotation_outcome": ["no_stroke"]})
attempt("ML-1 technique=dict", {**LEGAL, "technique": {"a": 1}})
attempt("ML-1 quality_flags=[[]]", {**LEGAL, "quality_flags": [[]]})
attempt("ML-1 handedness=list", {**LEGAL, "handedness": ["right"]})

# ML-3: schema parity (validator accepts what the committed JSON schema rejects)
import jsonschema  # noqa: E402
schema = json.loads((REPO / "ml/annotations/annotation.schema.json").read_text())
validator = jsonschema.Draft202012Validator(schema)
for label, doc in [
    ("ML-3 clip_id short", {**LEGAL, "clip_id": "xx"}),
    ("ML-3 clip_id int", {**LEGAL, "clip_id": 12345}),
    ("ML-3 occlusion_notes int", {**LEGAL, "occlusion_notes": 5}),
    ("ML-3 checkpoint label extra key", {**LEGAL, "annotation_outcome": "aborted", "checkpoint_labels": [{"checkpoint": "preparation", "verdict": "good", "bogus": 1}]}),
]:
    schema_errors = [e.message for e in validator.iter_errors(doc)]
    print(label, "validator:", va.validate(doc, "x.json"), "| schema:", schema_errors[:2])

# ML-2: CLI aborts batch on non-UTF-8 file
with tempfile.TemporaryDirectory() as tmp:
    good = Path(tmp, "good.json"); good.write_text(json.dumps(LEGAL), encoding="utf-8")
    bad = Path(tmp, "bad.json"); bad.write_bytes(b'{"clip_id": "\xc3(" }')
    after = Path(tmp, "after.json"); after.write_text(json.dumps(LEGAL), encoding="utf-8")
    proc = subprocess.run(
        [sys.executable, str(REPO / "ml/scripts/validate_annotations.py"), str(good), str(bad), str(after)],
        capture_output=True, text=True,
    )
    print("ML-2 CLI exit:", proc.returncode)
    print("ML-2 stdout:", proc.stdout.strip())
    print("ML-2 stderr tail:", proc.stderr.strip().splitlines()[-1] if proc.stderr else "")
    # ML-1 via CLI: TypeError aborts too
    crash = Path(tmp, "crash.json"); crash.write_text(json.dumps({**LEGAL, "handedness": ["right"]}), encoding="utf-8")
    proc = subprocess.run(
        [sys.executable, str(REPO / "ml/scripts/validate_annotations.py"), str(good), str(crash), str(after)],
        capture_output=True, text=True,
    )
    print("ML-1 CLI exit:", proc.returncode, "| stdout:", proc.stdout.strip().replace("\n", " / "), "| stderr tail:", proc.stderr.strip().splitlines()[-1] if proc.stderr else "")
