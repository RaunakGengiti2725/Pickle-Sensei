#!/usr/bin/env python3
"""Seeded randomized long-run stress harness for the ml/ annotation tooling.

Public API under test (ml/scripts/validate_annotations.py):
  validate(doc, name) -> list[str]      pure document validator
  main(paths) -> int                    CLI batch entry point (0 = all valid)
plus the two JSON contracts ml/annotations/annotation.schema.json and
ml/datasets/manifest.schema.json.

Every sequence is replayable from (base_seed, index): the per-sequence seed is
derived deterministically, a `random.Random(seed)` drives every choice, and the
generator uses only the committed vocabularies (no fabricated labels — every
technique, attribute and flag comes from the schema enums; clip ids are
obviously synthetic `stress-<seed>-<n>` identifiers).

Model-checked invariants (evaluated after EVERY step of every sequence):
  I1 NO_CRASH          validate() never raises on JSON-shaped input
                       (the CLI documents 'INVALID ...' output, not tracebacks)
  I2 DETERMINISTIC     validate(doc) called twice returns identical lists
  I3 PURE              validate() does not mutate its input
  I4 WELL_FORMED       result is list[str]; every entry starts with '<name>: '
  I5 NO_FALSE_REJECT   a document the model built as legal (no injected fault)
                       yields []  (the validator must accept legal records)
  I6 NO_FALSE_ACCEPT   a document carrying >=1 injected contract fault yields
                       a non-empty error list
  I7 SCHEMA_SOUND      (differential, when `jsonschema` is importable) if the
                       validator returns [] the JSON Schema also accepts the
                       document — the executable check must be at least as
                       strict as the published contract. The opposite direction
                       (validator stricter than the schema) is EXPECTED for the
                       semantic rules (ordering, windows) and is only counted.
  I8 TRACE_DETERMINISM the full trace of a sequence replayed from its seed is
                       byte-identical (checked in-process for every sequence and
                       cross-process for a sample).

The library is stdlib-only; `jsonschema` is optional and its absence is
reported explicitly in the result table (never silently treated as a pass).
"""
from __future__ import annotations

import copy
import hashlib
import json
import random
import sys
from pathlib import Path
from typing import Any, Callable

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

import validate_annotations as va  # noqa: E402

ANNOTATION_SCHEMA_PATH = HERE.parent / "annotations" / "annotation.schema.json"
MANIFEST_SCHEMA_PATH = HERE.parent / "datasets" / "manifest.schema.json"

try:  # optional differential oracle
    import jsonschema  # type: ignore

    _HAVE_JSONSCHEMA = True
except Exception:  # pragma: no cover - depends on the box
    jsonschema = None  # type: ignore
    _HAVE_JSONSCHEMA = False


def have_jsonschema() -> bool:
    return _HAVE_JSONSCHEMA


def _schema_validator(path: Path):
    schema = json.loads(path.read_text(encoding="utf-8"))
    checker = jsonschema.FormatChecker()
    return jsonschema.Draft202012Validator(schema, format_checker=checker)


_ANNOTATION_SCHEMA_VALIDATOR = _schema_validator(ANNOTATION_SCHEMA_PATH) if _HAVE_JSONSCHEMA else None


def schema_errors(doc: Any) -> list[str] | None:
    """JSON Schema verdict for an annotation doc; None when jsonschema is absent."""
    if _ANNOTATION_SCHEMA_VALIDATOR is None:
        return None
    return sorted(e.message for e in _ANNOTATION_SCHEMA_VALIDATOR.iter_errors(doc))


def canon(value: Any) -> str:
    """Canonical string form (NaN-safe, order-insensitive for dict keys)."""
    return json.dumps(value, sort_keys=True, allow_nan=True, separators=(",", ":"))


def derive_seed(base_seed: int, index: int) -> int:
    digest = hashlib.sha256(f"{base_seed}:{index}".encode()).digest()
    return int.from_bytes(digest[:8], "big")


# --------------------------------------------------------------------------- #
# Vocabularies (all read from the validator module, which reads the schema)    #
# --------------------------------------------------------------------------- #
TECHNIQUES = sorted(va.TECHNIQUES)
OUTCOMES = sorted(va.ANNOTATION_OUTCOMES)
PHASES = list(va.PHASES)
CHECKPOINTS = sorted(va.CHECKPOINTS)
VERDICTS = sorted(va.VERDICTS)
FAULT_DIRECTIONS = sorted(va.FAULT_DIRECTIONS)
QUALITY_FLAGS = sorted(va.QUALITY_FLAGS)
DEFECT_FLAGS = [f for f in QUALITY_FLAGS if f != "clean"]
ATTRIBUTE_VALUES = {k: sorted(v - {None}) for k, v in va.ATTRIBUTE_VALUES.items()}
HANDEDNESS = ["right", "left", "ambidextrous", "unknown"]
CAMERA_VIEWS = ["front", "rear", "dominant_side", "nondominant_side", "diagonal", "overhead", "other"]
OPTIONAL_FIELDS = sorted(va.OPTIONAL)
REQUIRED_FIELDS = sorted(va.REQUIRED)

# JSON values of the "wrong" type, used for type-confusion faults.
WRONG_TYPE_POOL: list[Any] = [None, True, False, 0, -1, 7, 1.5, "", "x", [], [1], {}, {"k": 1}]
UNHASHABLE_POOL: list[Any] = [[], [1], ["clean"], {}, {"k": 1}]


# --------------------------------------------------------------------------- #
# Legal document generator (the model)                                         #
# --------------------------------------------------------------------------- #
def _gen_window(rng: random.Random) -> tuple[int, int]:
    start = rng.choice([0, 0, rng.randint(0, 5000)])
    end = start + rng.randint(1, 4000)
    return start, end


def _gen_phases(rng: random.Random, start: int, end: int, min_count: int) -> list[dict]:
    count = rng.randint(min_count, len(PHASES))
    keys = sorted(rng.sample(range(len(PHASES)), count))
    # monotone, non-overlapping cut points inside [start, end]
    cuts = sorted(rng.randint(start, end) for _ in range(2 * count))
    phases = []
    for i, key_index in enumerate(keys):
        p_start, p_end = cuts[2 * i], cuts[2 * i + 1]
        phases.append(
            {
                "key": PHASES[key_index],
                "start_ms": p_start,
                "end_ms": p_end,
                "observable": rng.random() < 0.85,
            }
        )
    return phases


def _gen_contact(rng: random.Random, start: int, end: int) -> dict | None:
    if rng.random() < 0.3:
        return None
    a = rng.randint(start, end)
    b = rng.randint(a, end)
    return {"start_ms": a, "end_ms": b}


def _gen_label(rng: random.Random) -> dict:
    verdict = rng.choice(VERDICTS)
    label: dict[str, Any] = {"checkpoint": rng.choice(CHECKPOINTS), "verdict": verdict}
    if verdict in {"minor_fault", "major_fault"}:
        label["fault_direction"] = rng.choice(FAULT_DIRECTIONS)
        if rng.random() < 0.7:
            label["fault_severity"] = rng.choice([0, 1, round(rng.random(), 3), rng.randint(0, 1)])
    else:
        if rng.random() < 0.2:
            label["fault_direction"] = "none"
        if rng.random() < 0.2:
            label["fault_severity"] = 0
    if rng.random() < 0.15:
        label["note"] = "n" * rng.randint(0, 500)
    return label


def _gen_labels(rng: random.Random) -> list[dict]:
    return [_gen_label(rng) for _ in range(rng.randint(0, 6))]


def _gen_quality_flags(rng: random.Random) -> list[str]:
    if rng.random() < 0.4:
        return ["clean"]
    return rng.sample(DEFECT_FLAGS, rng.randint(1, len(DEFECT_FLAGS)))


def _gen_attributes(rng: random.Random, outcome: str) -> dict[str, str | None]:
    if outcome == "no_stroke":
        return {k: None for k in ATTRIBUTE_VALUES}
    return {k: (None if rng.random() < 0.15 else rng.choice(v)) for k, v in ATTRIBUTE_VALUES.items()}


def _gen_optional(rng: random.Random, field: str) -> Any:
    if field == "player_bbox":
        if rng.random() < 0.2:
            return None
        x, y = rng.random(), rng.random()
        return {
            "x": round(x, 4),
            "y": round(y, 4),
            "width": round(rng.uniform(0.001, 1.0), 4),
            "height": round(rng.uniform(0.001, 1.0), 4),
        }
    if field in {"pose_keyframes", "paddle_keyframes", "ball_keyframes"}:
        return [{"t_ms": rng.randint(0, 9000)} for _ in range(rng.randint(0, 3))]
    if field == "court_keypoints":
        return None if rng.random() < 0.5 else [{"id": i} for i in range(rng.randint(0, 4))]
    # string-or-null fields
    return None if rng.random() < 0.4 else rng.choice(["coach-b", "adjudicated on review", "wrist"])


def gen_legal_doc(rng: random.Random, clip_id: str, outcome: str | None = None) -> dict:
    """A document that the documented v2 contract accepts."""
    outcome = outcome or rng.choice(OUTCOMES)
    doc: dict[str, Any] = {"clip_id": clip_id, "annotation_outcome": outcome}
    doc["attributes"] = _gen_attributes(rng, outcome)
    doc["handedness"] = rng.choice(HANDEDNESS)
    doc["camera_view"] = rng.choice(CAMERA_VIEWS)
    if outcome == "recognized_technique":
        start, end = _gen_window(rng)
        doc["technique"] = rng.choice(TECHNIQUES)
        doc["stroke_start_ms"], doc["stroke_end_ms"] = start, end
        doc["phases"] = _gen_phases(rng, start, end, 1)
        doc["contact_range_ms"] = _gen_contact(rng, start, end)
        doc["checkpoint_labels"] = _gen_labels(rng)
    elif outcome == "unknown_technique":
        start, end = _gen_window(rng)
        doc["technique"] = None
        doc["stroke_start_ms"], doc["stroke_end_ms"] = start, end
        doc["phases"] = _gen_phases(rng, start, end, 0)
        doc["contact_range_ms"] = _gen_contact(rng, start, end)
        doc["checkpoint_labels"] = []
    elif outcome == "no_stroke":
        doc["technique"] = None
        doc["stroke_start_ms"] = doc["stroke_end_ms"] = None
        doc["phases"] = []
        doc["contact_range_ms"] = None
        doc["checkpoint_labels"] = []
    else:  # partial / aborted
        doc["technique"] = None if rng.random() < 0.6 else rng.choice(TECHNIQUES)
        if rng.random() < 0.5:
            doc["stroke_start_ms"] = doc["stroke_end_ms"] = None
            # phases still must be ordered/non-overlapping; without a window they
            # are only required to be >= 0 (validator) so keep them small
            doc["phases"] = _gen_phases(rng, 0, 3000, 0)
            doc["contact_range_ms"] = None if rng.random() < 0.7 else _gen_contact(rng, 0, 3000)
        else:
            start, end = _gen_window(rng)
            doc["stroke_start_ms"], doc["stroke_end_ms"] = start, end
            doc["phases"] = _gen_phases(rng, start, end, 0)
            doc["contact_range_ms"] = _gen_contact(rng, start, end)
        doc["checkpoint_labels"] = _gen_labels(rng)
    doc["acceptable_alternative_mechanics"] = rng.random() < 0.3
    doc["quality_flags"] = _gen_quality_flags(rng)
    doc["annotator"] = rng.choice(["coach-a", "coach-b", "reviewer-07", "ab"])
    doc["revision"] = rng.randint(1, 12)
    for field in OPTIONAL_FIELDS:
        if rng.random() < 0.25:
            doc[field] = _gen_optional(rng, field)
    return doc


# --------------------------------------------------------------------------- #
# Actions                                                                      #
# --------------------------------------------------------------------------- #
LegalAction = Callable[[random.Random, dict], set[str]]


def _legal_set_technique(rng: random.Random, doc: dict) -> set[str]:
    if doc["annotation_outcome"] in {"recognized_technique", "partial", "aborted"}:
        doc["technique"] = rng.choice(TECHNIQUES)
    return {"technique"}


def _legal_set_attributes(rng: random.Random, doc: dict) -> set[str]:
    doc["attributes"] = _gen_attributes(rng, doc["annotation_outcome"])
    return {"attributes"}


def _legal_set_handedness(rng: random.Random, doc: dict) -> set[str]:
    doc["handedness"] = rng.choice(HANDEDNESS)
    return {"handedness"}


def _legal_set_camera(rng: random.Random, doc: dict) -> set[str]:
    doc["camera_view"] = rng.choice(CAMERA_VIEWS)
    return {"camera_view"}


def _legal_retime(rng: random.Random, doc: dict) -> set[str]:
    outcome = doc["annotation_outcome"]
    if outcome == "no_stroke":
        return set()
    if outcome in {"partial", "aborted"} and rng.random() < 0.5:
        doc["stroke_start_ms"] = doc["stroke_end_ms"] = None
        doc["phases"] = _gen_phases(rng, 0, 3000, 0)
        doc["contact_range_ms"] = None
    else:
        start, end = _gen_window(rng)
        doc["stroke_start_ms"], doc["stroke_end_ms"] = start, end
        doc["phases"] = _gen_phases(rng, start, end, 1 if outcome == "recognized_technique" else 0)
        doc["contact_range_ms"] = _gen_contact(rng, start, end)
    return {"stroke_start_ms", "stroke_end_ms", "phases", "contact_range_ms"}


def _legal_toggle_observable(rng: random.Random, doc: dict) -> set[str]:
    if doc["phases"]:
        phase = rng.choice(doc["phases"])
        phase["observable"] = not phase["observable"]
    return {"phases"}


def _legal_set_labels(rng: random.Random, doc: dict) -> set[str]:
    if doc["annotation_outcome"] in {"recognized_technique", "partial", "aborted"}:
        doc["checkpoint_labels"] = _gen_labels(rng)
    return {"checkpoint_labels"}


def _legal_set_flags(rng: random.Random, doc: dict) -> set[str]:
    doc["quality_flags"] = _gen_quality_flags(rng)
    return {"quality_flags"}


def _legal_set_annotator(rng: random.Random, doc: dict) -> set[str]:
    doc["annotator"] = rng.choice(["coach-a", "coach-b", "reviewer-07", "ab", "a" * 40])
    return {"annotator"}


def _legal_bump_revision(rng: random.Random, doc: dict) -> set[str]:
    doc["revision"] = doc["revision"] + rng.randint(1, 3)
    return {"revision"}


def _legal_set_aam(rng: random.Random, doc: dict) -> set[str]:
    doc["acceptable_alternative_mechanics"] = not doc["acceptable_alternative_mechanics"]
    return {"acceptable_alternative_mechanics"}


def _legal_add_optional(rng: random.Random, doc: dict) -> set[str]:
    field = rng.choice(OPTIONAL_FIELDS)
    doc[field] = _gen_optional(rng, field)
    return {field}


def _legal_remove_optional(rng: random.Random, doc: dict) -> set[str]:
    present = [f for f in OPTIONAL_FIELDS if f in doc]
    if present:
        field = rng.choice(present)
        del doc[field]
        return {field}
    return set()


LEGAL_ACTIONS: dict[str, LegalAction] = {
    "set_technique": _legal_set_technique,
    "set_attributes": _legal_set_attributes,
    "set_handedness": _legal_set_handedness,
    "set_camera_view": _legal_set_camera,
    "retime": _legal_retime,
    "toggle_observable": _legal_toggle_observable,
    "set_checkpoint_labels": _legal_set_labels,
    "set_quality_flags": _legal_set_flags,
    "set_annotator": _legal_set_annotator,
    "bump_revision": _legal_bump_revision,
    "toggle_alternative_mechanics": _legal_set_aam,
    "add_optional": _legal_add_optional,
    "remove_optional": _legal_remove_optional,
}

# Fault actions: (doc, rng) -> (touched fields, oracle) ; return None if not applicable.
FaultAction = Callable[[random.Random, dict], tuple[set[str], str] | None]


def _needs_window(doc: dict) -> bool:
    return va._valid_window(doc.get("stroke_start_ms"), doc.get("stroke_end_ms"))


def _f_unknown_field(rng, doc):
    doc[rng.choice(["clipId", "extra", "notes", "Technique"])] = 1
    return {"__unknown__"}, "validator"


def _f_missing_required(rng, doc):
    field = rng.choice(REQUIRED_FIELDS)
    del doc[field]
    return {field}, "validator"


def _f_bad_outcome(rng, doc):
    doc["annotation_outcome"] = rng.choice(["recognised_technique", "", "NO_STROKE", "stroke", 3, None])
    return {"annotation_outcome"}, "validator"


def _f_bad_technique_string(rng, doc):
    doc["technique"] = rng.choice(["forehand_drive", "DRIVE_FOREHAND", "", "dink", "drive_forehand "])
    return {"technique"}, "validator"


def _f_guess_technique(rng, doc):
    if doc["annotation_outcome"] not in {"unknown_technique", "no_stroke"}:
        return None
    doc["technique"] = rng.choice(TECHNIQUES)
    return {"technique"}, "validator"


def _f_recognized_without_technique(rng, doc):
    if doc["annotation_outcome"] != "recognized_technique":
        return None
    doc["technique"] = None
    return {"technique"}, "validator"


def _f_bad_handedness(rng, doc):
    doc["handedness"] = rng.choice(["Right", "both", "", None, 1])
    return {"handedness"}, "validator"


def _f_bad_camera(rng, doc):
    doc["camera_view"] = rng.choice(["side", "FRONT", "", None, True])
    return {"camera_view"}, "validator"


def _f_attributes_missing_key(rng, doc):
    if not isinstance(doc["attributes"], dict):
        return None
    del doc["attributes"][rng.choice(sorted(ATTRIBUTE_VALUES))]
    return {"attributes"}, "validator"


def _f_attributes_extra_key(rng, doc):
    if not isinstance(doc["attributes"], dict):
        return None
    doc["attributes"]["power"] = "high"
    return {"attributes"}, "validator"


def _f_attributes_bad_value(rng, doc):
    if not isinstance(doc["attributes"], dict):
        return None
    key = rng.choice(sorted(ATTRIBUTE_VALUES))
    doc["attributes"][key] = rng.choice(["nope", "", "Forehand", 0, True, 1.5])
    return {"attributes"}, "validator"


def _f_attributes_not_object(rng, doc):
    doc["attributes"] = rng.choice([[], "forehand", None, 1])
    return {"attributes"}, "validator"


def _f_no_stroke_with_attributes(rng, doc):
    if doc["annotation_outcome"] != "no_stroke" or not isinstance(doc["attributes"], dict):
        return None
    key = rng.choice(sorted(ATTRIBUTE_VALUES))
    doc["attributes"][key] = rng.choice(ATTRIBUTE_VALUES[key])
    return {"attributes"}, "validator"


def _f_window_inverted(rng, doc):
    if doc["annotation_outcome"] == "no_stroke":
        return None
    start, end = _gen_window(rng)  # end > start by construction
    doc["stroke_start_ms"], doc["stroke_end_ms"] = end, start
    return {"stroke_start_ms", "stroke_end_ms"}, "validator"


def _f_window_equal(rng, doc):
    if doc["annotation_outcome"] not in {"recognized_technique", "unknown_technique"}:
        return None
    doc["stroke_end_ms"] = doc["stroke_start_ms"]
    return {"stroke_start_ms", "stroke_end_ms"}, "validator"


def _f_window_negative(rng, doc):
    if doc["annotation_outcome"] not in {"recognized_technique", "unknown_technique"}:
        return None
    doc["stroke_start_ms"] = -rng.randint(1, 100)
    return {"stroke_start_ms"}, "validator"


def _f_window_float(rng, doc):
    if doc["annotation_outcome"] not in {"recognized_technique", "unknown_technique"}:
        return None
    doc["stroke_start_ms"] = 12.5
    return {"stroke_start_ms"}, "validator"


def _f_window_half_null(rng, doc):
    if doc["annotation_outcome"] == "no_stroke":
        return None
    if doc["stroke_start_ms"] is None and doc["stroke_end_ms"] is None:
        doc[rng.choice(["stroke_start_ms", "stroke_end_ms"])] = rng.randint(0, 1000)
    else:
        doc[rng.choice(["stroke_start_ms", "stroke_end_ms"])] = None
    return {"stroke_start_ms", "stroke_end_ms"}, "validator"


def _f_no_stroke_with_bounds(rng, doc):
    if doc["annotation_outcome"] != "no_stroke":
        return None
    doc["stroke_start_ms"], doc["stroke_end_ms"] = _gen_window(rng)
    return {"stroke_start_ms", "stroke_end_ms"}, "validator"


def _f_phases_not_list(rng, doc):
    doc["phases"] = rng.choice([{}, "ready", None, 0])
    return {"phases"}, "validator"


def _f_recognized_empty_phases(rng, doc):
    if doc["annotation_outcome"] != "recognized_technique":
        return None
    doc["phases"] = []
    return {"phases"}, "validator"


def _f_no_stroke_with_phases(rng, doc):
    if doc["annotation_outcome"] != "no_stroke":
        return None
    doc["phases"] = _gen_phases(rng, 0, 1000, 1)
    return {"phases"}, "validator"


def _f_phase_not_object(rng, doc):
    if not isinstance(doc["phases"], list):
        return None
    doc["phases"].append(rng.choice(["ready", 1, None, []]))
    return {"phases"}, "validator"


def _f_phase_extra_key(rng, doc):
    if not isinstance(doc["phases"], list) or not doc["phases"]:
        return None
    rng.choice(doc["phases"])["note"] = "x"
    return {"phases"}, "validator"


def _f_phase_missing_key(rng, doc):
    if not isinstance(doc["phases"], list) or not doc["phases"]:
        return None
    phase = rng.choice(doc["phases"])
    del phase[rng.choice(["start_ms", "end_ms", "observable"])]
    return {"phases"}, "validator"


def _f_phase_unknown_key(rng, doc):
    if not isinstance(doc["phases"], list) or not doc["phases"]:
        return None
    rng.choice(doc["phases"])["key"] = rng.choice(["backswing", "Ready", "", None, 2])
    return {"phases"}, "validator"


def _f_phase_duplicate(rng, doc):
    if not isinstance(doc["phases"], list) or not doc["phases"]:
        return None
    doc["phases"].append(copy.deepcopy(doc["phases"][-1]))
    return {"phases"}, "validator"


def _f_phase_out_of_order(rng, doc):
    if not isinstance(doc["phases"], list) or len(doc["phases"]) < 2:
        return None
    i = rng.randrange(len(doc["phases"]) - 1)
    doc["phases"][i], doc["phases"][i + 1] = doc["phases"][i + 1], doc["phases"][i]
    order = [PHASES.index(p["key"]) for p in doc["phases"] if isinstance(p, dict) and p.get("key") in PHASES]
    if order == sorted(order):
        return None  # swap happened to restore the canonical order
    return {"phases"}, "validator"


def _f_phase_overlap(rng, doc):
    if not isinstance(doc["phases"], list) or len(doc["phases"]) < 2:
        return None
    i = rng.randrange(1, len(doc["phases"]))
    prev = doc["phases"][i - 1]
    cur = doc["phases"][i]
    if prev["end_ms"] == 0:
        return None
    cur["start_ms"] = prev["end_ms"] - 1
    if cur["start_ms"] > cur["end_ms"]:
        cur["end_ms"] = cur["start_ms"]
    # the overlap is now real: cur.start < prev.end
    return {"phases"}, "validator"


def _f_phase_outside_window(rng, doc):
    if not isinstance(doc["phases"], list) or not doc["phases"] or not _needs_window(doc):
        return None
    doc["phases"][-1]["end_ms"] = doc["stroke_end_ms"] + rng.randint(1, 500)
    return {"phases"}, "validator"


def _f_phase_inverted(rng, doc):
    if not isinstance(doc["phases"], list) or not doc["phases"]:
        return None
    phase = rng.choice(doc["phases"])
    phase["start_ms"], phase["end_ms"] = phase["end_ms"] + 1, phase["start_ms"]
    return {"phases"}, "validator"


def _f_phase_bad_ms_type(rng, doc):
    if not isinstance(doc["phases"], list) or not doc["phases"]:
        return None
    phase = rng.choice(doc["phases"])
    phase[rng.choice(["start_ms", "end_ms"])] = rng.choice([True, 1.5, "100", None, -1])
    return {"phases"}, "validator"


def _f_phase_observable_nonbool(rng, doc):
    if not isinstance(doc["phases"], list) or not doc["phases"]:
        return None
    rng.choice(doc["phases"])["observable"] = rng.choice([1, 0, "true", None])
    return {"phases"}, "validator"


def _f_contact_shape(rng, doc):
    doc["contact_range_ms"] = rng.choice([{"start_ms": 1}, {"start_ms": 1, "end_ms": 2, "x": 0}, [1, 2], 5, "1-2"])
    return {"contact_range_ms"}, "validator"


def _f_contact_inverted(rng, doc):
    if doc["annotation_outcome"] == "no_stroke":
        return None
    doc["contact_range_ms"] = {"start_ms": 500, "end_ms": 400}
    return {"contact_range_ms"}, "validator"


def _f_contact_bad_type(rng, doc):
    if doc["annotation_outcome"] == "no_stroke":
        return None
    doc["contact_range_ms"] = {"start_ms": rng.choice([True, 1.5, "1", None]), "end_ms": 400}
    return {"contact_range_ms"}, "validator"


def _f_contact_outside_window(rng, doc):
    if not _needs_window(doc):
        return None
    doc["contact_range_ms"] = {"start_ms": doc["stroke_end_ms"] + 1, "end_ms": doc["stroke_end_ms"] + 5}
    return {"contact_range_ms"}, "validator"


def _f_no_stroke_with_contact(rng, doc):
    if doc["annotation_outcome"] != "no_stroke":
        return None
    doc["contact_range_ms"] = {"start_ms": 1, "end_ms": 2}
    return {"contact_range_ms"}, "validator"


def _f_labels_not_list(rng, doc):
    doc["checkpoint_labels"] = rng.choice([{}, "good", None, 1])
    return {"checkpoint_labels"}, "validator"


def _f_labels_on_abstention(rng, doc):
    if doc["annotation_outcome"] not in {"unknown_technique", "no_stroke"}:
        return None
    doc["checkpoint_labels"] = [_gen_label(rng)]
    return {"checkpoint_labels"}, "validator"


def _f_label_not_object(rng, doc):
    if not isinstance(doc["checkpoint_labels"], list):
        return None
    doc["checkpoint_labels"].append(rng.choice(["good", 1, None, []]))
    return {"checkpoint_labels"}, "validator"


def _label_target(rng, doc):
    if doc["annotation_outcome"] in {"unknown_technique", "no_stroke"}:
        return None
    if not isinstance(doc["checkpoint_labels"], list):
        return None
    if not doc["checkpoint_labels"]:
        doc["checkpoint_labels"].append(_gen_label(rng))
    label = rng.choice(doc["checkpoint_labels"])
    return label if isinstance(label, dict) else None


def _f_label_bad_checkpoint(rng, doc):
    label = _label_target(rng, doc)
    if label is None:
        return None
    label["checkpoint"] = rng.choice(["grip", "Contact_Position", "", None, 4])
    return {"checkpoint_labels"}, "validator"


def _f_label_bad_verdict(rng, doc):
    label = _label_target(rng, doc)
    if label is None:
        return None
    label["verdict"] = rng.choice(["ok", "GOOD", "", None, 1])
    return {"checkpoint_labels"}, "validator"


def _f_label_bad_direction(rng, doc):
    label = _label_target(rng, doc)
    if label is None:
        return None
    label["fault_direction"] = rng.choice(["left", "LATE", "", 0])
    return {"checkpoint_labels"}, "validator"


def _f_label_fault_without_direction(rng, doc):
    label = _label_target(rng, doc)
    if label is None:
        return None
    label["verdict"] = rng.choice(["minor_fault", "major_fault"])
    label.pop("fault_direction", None)
    return {"checkpoint_labels"}, "validator"


def _f_label_severity_out_of_range(rng, doc):
    label = _label_target(rng, doc)
    if label is None:
        return None
    label["fault_severity"] = rng.choice([1.4, -0.01, 2, -1, float("nan"), float("inf"), -float("inf")])
    return {"checkpoint_labels"}, "validator"


def _f_label_severity_bad_type(rng, doc):
    label = _label_target(rng, doc)
    if label is None:
        return None
    label["fault_severity"] = rng.choice([True, "0.5", [], {}])
    return {"checkpoint_labels"}, "validator"


def _f_flags_empty(rng, doc):
    doc["quality_flags"] = []
    return {"quality_flags"}, "validator"


def _f_flags_not_list(rng, doc):
    doc["quality_flags"] = rng.choice(["clean", None, {}, 1])
    return {"quality_flags"}, "validator"


def _f_flags_duplicate(rng, doc):
    if not isinstance(doc["quality_flags"], list) or not doc["quality_flags"]:
        return None
    doc["quality_flags"].append(doc["quality_flags"][0])
    return {"quality_flags"}, "validator"


def _f_flags_unknown(rng, doc):
    doc["quality_flags"] = [rng.choice(["blurry", "CLEAN", "", None, 1])]
    return {"quality_flags"}, "validator"


def _f_flags_clean_combo(rng, doc):
    doc["quality_flags"] = ["clean", rng.choice(DEFECT_FLAGS)]
    return {"quality_flags"}, "validator"


def _f_aam_nonbool(rng, doc):
    doc["acceptable_alternative_mechanics"] = rng.choice([1, 0, "false", None])
    return {"acceptable_alternative_mechanics"}, "validator"


def _f_annotator_bad(rng, doc):
    doc["annotator"] = rng.choice(["", "a", None, 7, ["ab"]])
    return {"annotator"}, "validator"


def _f_revision_bad(rng, doc):
    doc["revision"] = rng.choice([0, -1, 1.0, "1", None, True])
    return {"revision"}, "validator"


# --- contract-only faults (documented in annotation.schema.json, not in the validator docstring)
def _f_clip_id_short(rng, doc):
    doc["clip_id"] = "x" * rng.randint(0, 7)
    return {"clip_id"}, "schema"


def _f_clip_id_type(rng, doc):
    doc["clip_id"] = rng.choice([None, 12345678, True, [], {}])
    return {"clip_id"}, "schema"


def _f_label_extra_key(rng, doc):
    label = _label_target(rng, doc)
    if label is None:
        return None
    label[rng.choice(["comment", "severity", "Checkpoint"])] = 1
    return {"checkpoint_labels"}, "schema"


def _f_label_note_too_long(rng, doc):
    label = _label_target(rng, doc)
    if label is None:
        return None
    label["note"] = "n" * rng.randint(501, 800)
    return {"checkpoint_labels"}, "schema"


def _f_label_note_bad_type(rng, doc):
    label = _label_target(rng, doc)
    if label is None:
        return None
    label["note"] = rng.choice([1, None, [], {}])
    return {"checkpoint_labels"}, "schema"


def _f_optional_bad_type(rng, doc):
    field = rng.choice(OPTIONAL_FIELDS)
    if field == "player_bbox":
        doc[field] = rng.choice(
            [
                {"x": 5},
                {"x": 0.1, "y": 0.1, "width": 0, "height": 0.5},
                {"x": -0.1, "y": 0.1, "width": 0.5, "height": 0.5},
                {"x": 0.1, "y": 0.1, "width": 0.5, "height": 1.5},
                {"x": 0.1, "y": 0.1, "width": 0.5, "height": 0.5, "z": 0},
                "bbox",
                [0, 0, 1, 1],
                1,
            ]
        )
    elif field in {"pose_keyframes", "paddle_keyframes", "ball_keyframes"}:
        doc[field] = rng.choice(["str", None, 1, {}, [1], ["a"]])
    elif field == "court_keypoints":
        doc[field] = rng.choice(["str", 3, {}, [1], True])
    else:
        doc[field] = rng.choice([3, True, [], {}, 1.5])
    return {field}, "schema"


# --- type-confusion faults hitting membership tests with unhashable JSON values
def _f_unhashable_enum(rng, doc):
    site = rng.choice(
        [
            "annotation_outcome",
            "technique",
            "handedness",
            "camera_view",
            "attributes.value",
            "quality_flags.item",
            "label.checkpoint",
            "label.verdict",
            "label.fault_direction",
            "phase.key",
        ]
    )
    value = copy.deepcopy(rng.choice(UNHASHABLE_POOL))
    if site == "attributes.value":
        if not isinstance(doc["attributes"], dict) or not doc["attributes"]:
            return None
        doc["attributes"][rng.choice(sorted(doc["attributes"]))] = value
        return {"attributes"}, "validator"
    if site == "quality_flags.item":
        if not isinstance(doc["quality_flags"], list):
            return None
        doc["quality_flags"].append(value)
        return {"quality_flags"}, "validator"
    if site.startswith("label."):
        label = _label_target(rng, doc)
        if label is None:
            return None
        label[site.split(".", 1)[1]] = value
        return {"checkpoint_labels"}, "validator"
    if site == "phase.key":
        if not isinstance(doc["phases"], list) or not doc["phases"]:
            return None
        rng.choice(doc["phases"])["key"] = value
        return {"phases"}, "validator"
    doc[site] = value
    return {site}, "validator"


FAULT_ACTIONS: dict[str, FaultAction] = {
    name[3:]: fn for name, fn in list(globals().items()) if name.startswith("_f_") and callable(fn)
}


# --------------------------------------------------------------------------- #
# Sequence runner                                                              #
# --------------------------------------------------------------------------- #
FAILURE_KINDS = (
    "CRASH",
    "NONDETERMINISTIC",
    "IMPURE",
    "MALFORMED_RESULT",
    "FALSE_REJECT",
    "FALSE_ACCEPT",
    "SCHEMA_REJECTS_VALIDATOR_ACCEPTS",
)


def check_doc(doc: dict, name: str, faults: dict[str, str]) -> dict[str, Any]:
    """Run validate() on one document and evaluate I1-I7. Returns a step record."""
    before = canon(doc)
    record: dict[str, Any] = {"failures": [], "errors": None, "schema_errors": None}
    try:
        errors = va.validate(doc, name)
    except Exception as exc:  # I1
        record["failures"].append({"kind": "CRASH", "detail": f"{type(exc).__name__}: {exc}"})
        record["errors"] = None
        if canon(doc) != before:
            record["failures"].append({"kind": "IMPURE", "detail": "input mutated before raising"})
        return record
    record["errors"] = errors
    if canon(doc) != before:  # I3
        record["failures"].append({"kind": "IMPURE", "detail": "validate() mutated its input"})
    second = va.validate(copy.deepcopy(doc), name)  # I2
    if second != errors:
        record["failures"].append({"kind": "NONDETERMINISTIC", "detail": f"{errors!r} != {second!r}"})
    if not isinstance(errors, list) or not all(  # I4
        isinstance(e, str) and e.startswith(f"{name}: ") and len(e) > len(name) + 2 for e in errors
    ):
        record["failures"].append({"kind": "MALFORMED_RESULT", "detail": repr(errors)[:300]})
    if not faults and errors:  # I5
        record["failures"].append({"kind": "FALSE_REJECT", "detail": errors[:5]})
    if faults and not errors:  # I6
        record["failures"].append({"kind": "FALSE_ACCEPT", "detail": sorted(faults)})
    s_errors = schema_errors(doc)
    record["schema_errors"] = s_errors
    if s_errors is not None:
        if not errors and s_errors:  # I7 unsound direction
            record["failures"].append(
                {"kind": "SCHEMA_REJECTS_VALIDATOR_ACCEPTS", "detail": s_errors[:5], "faults": sorted(faults)}
            )
        record["validator_stricter"] = bool(errors) and not s_errors
    return record


def run_sequence(seed: int, min_len: int = 5, max_len: int = 60, fault_rate: float = 0.35) -> dict[str, Any]:
    """Replay one seeded sequence; returns a JSON-able trace with failures."""
    rng = random.Random(seed)
    length = rng.randint(min_len, max_len)
    clip_id = f"stress-{seed:016x}-{rng.randint(0, 999):03d}"
    doc = gen_legal_doc(rng, clip_id)
    faults: dict[str, str] = {}  # tag -> oracle
    fault_fields: set[str] = set()
    steps: list[dict[str, Any]] = []
    failures: list[dict[str, Any]] = []
    trace = hashlib.sha256()
    validator_stricter = 0

    def evaluate(step_index: int, action: str, kind: str) -> None:
        nonlocal validator_stricter
        record = check_doc(doc, f"{clip_id}.json", faults)
        validator_stricter += int(bool(record.get("validator_stricter")))
        trace.update(canon([step_index, action, kind, record["errors"], record["schema_errors"]]).encode())
        step = {
            "i": step_index,
            "action": action,
            "kind": kind,
            "faults": sorted(faults),
            "n_errors": None if record["errors"] is None else len(record["errors"]),
            "schema_ok": None if record["schema_errors"] is None else not record["schema_errors"],
        }
        steps.append(step)
        for failure in record["failures"]:
            failures.append({**failure, "step": step_index, "action": action, "faults": sorted(faults), "doc": copy.deepcopy(doc)})

    evaluate(0, "gen_legal_doc", "legal")
    for i in range(1, length + 1):
        roll = rng.random()
        if faults and roll < 0.25:
            # repair: rebuild a legal record for the same clip (same outcome family when possible)
            outcome = doc.get("annotation_outcome") if doc.get("annotation_outcome") in OUTCOMES else None
            doc = gen_legal_doc(rng, clip_id, outcome)
            faults.clear()
            fault_fields.clear()
            evaluate(i, "repair", "repair")
            continue
        if roll < 1.0 - fault_rate:
            # legal edit that does not touch a faulted field (so the model stays exact)
            for _ in range(8):
                name = rng.choice(sorted(LEGAL_ACTIONS))
                probe = copy.deepcopy(doc)
                try:
                    touched = LEGAL_ACTIONS[name](random.Random(rng.getrandbits(64)), probe)
                except (KeyError, TypeError, AttributeError, IndexError):
                    continue  # a stacked fault broke the shape this edit relies on
                if touched & fault_fields:
                    continue
                doc = probe
                break
            else:
                name = "noop"
            evaluate(i, name, "legal")
            continue
        # inject a fault
        applied = None
        for _ in range(12):
            name = rng.choice(sorted(FAULT_ACTIONS))
            if name in faults:
                continue  # re-applying a fault could cancel it (e.g. a second swap)
            probe = copy.deepcopy(doc)
            try:
                result = FAULT_ACTIONS[name](random.Random(rng.getrandbits(64)), probe)
            except (KeyError, TypeError, AttributeError, IndexError):
                result = None
            if result is None:
                continue
            touched, oracle = result
            doc = probe
            faults[name] = oracle
            fault_fields |= touched
            applied = name
            break
        evaluate(i, applied or "noop", "fault" if applied else "legal")

    return {
        "seed": seed,
        "length": length,
        "clip_id": clip_id,
        "steps_executed": len(steps),
        "trace_sha256": trace.hexdigest(),
        "failures": failures,
        "validator_stricter_steps": validator_stricter,
        "jsonschema_available": have_jsonschema(),
    }


def shrink_doc(doc: dict, still_fails: Callable[[dict], bool]) -> dict:
    """Greedy delta-debugging: drop optional keys / list items while the failure persists."""
    current = copy.deepcopy(doc)
    changed = True
    while changed:
        changed = False
        for field in [f for f in OPTIONAL_FIELDS if f in current]:
            trial = copy.deepcopy(current)
            del trial[field]
            if still_fails(trial):
                current, changed = trial, True
        for field in ("phases", "checkpoint_labels", "quality_flags"):
            if isinstance(current.get(field), list) and len(current[field]) > 1:
                for idx in range(len(current[field])):
                    trial = copy.deepcopy(current)
                    del trial[field][idx]
                    if still_fails(trial):
                        current, changed = trial, True
                        break
        if isinstance(current.get("checkpoint_labels"), list):
            for label in current["checkpoint_labels"]:
                if isinstance(label, dict):
                    for key in [k for k in label if k not in {"checkpoint", "verdict"}]:
                        trial = copy.deepcopy(current)
                        trial["checkpoint_labels"][current["checkpoint_labels"].index(label)].pop(key)
                        if still_fails(trial):
                            current, changed = trial, True
                            break
    return current


def failure_predicate(kind: str) -> Callable[[dict], bool] | None:
    """Predicate that is true while the failure class still reproduces on a doc.

    FALSE_ACCEPT can only be shrunk against an independent oracle (the JSON
    Schema); without jsonschema the original document is kept as-is.
    """
    if kind == "FALSE_ACCEPT":
        if not have_jsonschema():
            return None
        kind = "SCHEMA_REJECTS_VALIDATOR_ACCEPTS"
    if kind not in {"CRASH", "SCHEMA_REJECTS_VALIDATOR_ACCEPTS", "FALSE_REJECT"}:
        return None

    def pred(doc: dict) -> bool:
        record = check_doc(doc, "min.json", {})
        return any(f["kind"] == kind for f in record["failures"])

    return pred


def minimize_failure(failure: dict[str, Any]) -> dict[str, Any]:
    kind = failure["kind"]
    pred = failure_predicate(kind)
    if pred is not None and pred(failure["doc"]):
        minimized = shrink_doc(failure["doc"], pred)
    else:
        minimized = failure["doc"]
    return {
        "kind": kind,
        "step": failure["step"],
        "action": failure["action"],
        "faults": failure["faults"],
        "detail": failure.get("detail"),
        "minimized_doc": minimized,
        "minimized_size": len(canon(minimized)),
        "original_size": len(canon(failure["doc"])),
    }


def run_campaign(base_seed: int, iterations: int, min_len: int, max_len: int) -> dict[str, Any]:
    results = []
    totals = {"sequences": 0, "steps": 0, "failing_sequences": 0, "validator_stricter_steps": 0}
    by_kind: dict[str, int] = {k: 0 for k in FAILURE_KINDS}
    nondeterministic_traces = 0
    for index in range(iterations):
        seed = derive_seed(base_seed, index)
        first = run_sequence(seed, min_len, max_len)
        second = run_sequence(seed, min_len, max_len)  # I8 in-process
        trace_ok = first["trace_sha256"] == second["trace_sha256"]
        nondeterministic_traces += int(not trace_ok)
        totals["sequences"] += 1
        totals["steps"] += first["steps_executed"]
        totals["validator_stricter_steps"] += first["validator_stricter_steps"]
        kinds = sorted({f["kind"] for f in first["failures"]})
        for f in first["failures"]:
            by_kind[f["kind"]] = by_kind.get(f["kind"], 0) + 1
        if first["failures"] or not trace_ok:
            totals["failing_sequences"] += 1
        first_failure = first["failures"][0] if first["failures"] else None
        results.append(
            {
                "index": index,
                "seed": seed,
                "length": first["length"],
                "steps": first["steps_executed"],
                "trace_sha256": first["trace_sha256"],
                "trace_deterministic": trace_ok,
                "outcome": "HELD" if not first["failures"] and trace_ok else "BROKEN",
                "failure_kinds": kinds,
                "first_failure": None
                if first_failure is None
                else {"step": first_failure["step"], "kind": first_failure["kind"], "action": first_failure["action"], "faults": first_failure["faults"]},
                "n_failures": len(first["failures"]),
            }
        )
    return {
        "base_seed": base_seed,
        "iterations": iterations,
        "min_len": min_len,
        "max_len": max_len,
        "jsonschema_available": have_jsonschema(),
        "totals": totals,
        "failures_by_kind": by_kind,
        "nondeterministic_traces": nondeterministic_traces,
        "sequences": results,
    }


def replay_report(seed: int, min_len: int = 5, max_len: int = 60, full: bool = False) -> dict[str, Any]:
    """Replay one seed; `full` keeps the offending documents, otherwise only minimized repros."""
    result = run_sequence(seed, min_len, max_len)
    if not full:
        result["failures"] = [minimize_failure(f) for f in result["failures"]]
    return result


if __name__ == "__main__":  # manual replay helper: python3 stress_seeded_lib.py <seed> [--full]
    seed_arg = int(sys.argv[1], 0)
    print(json.dumps(replay_report(seed_arg, full="--full" in sys.argv[2:]), indent=1, default=str))
