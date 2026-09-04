#!/usr/bin/env python3
"""Adversarial inputs for ml/scripts/validate_annotations.py (scenarios S2, S3 + extras).

Every test asserts the CONTRACT the validator's docstring promises ("Exit code 0 =
all valid; 1 = any invalid (errors printed)" and the `INVALID <path>: unreadable`
form for files that cannot be parsed). A failing test here is therefore a finding,
not a broken test: the input is one the validator should reject cleanly.

Run (from repo root; stdlib only, python3 >= 3.10):
  python3 -m unittest tools/attack/ml-tooling-datasets/test_attack_validate_annotations.py -v
or
  python3 tools/attack/ml-tooling-datasets/test_attack_validate_annotations.py

Seeded randomness: ATTACK_SEED (default 20260904) drives the fuzz cases; the seed is
printed in the test names' output so a failure can be replayed exactly.
"""
from __future__ import annotations

import copy
import json
import os
import random
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
VALIDATOR = REPO / "ml" / "scripts" / "validate_annotations.py"
SCHEMA = REPO / "ml" / "annotations" / "annotation.schema.json"
sys.path.insert(0, str(REPO / "ml" / "scripts"))
from test_validate_annotations import valid_doc  # noqa: E402  (fixture from the repo's own suite)

SEED = int(os.environ.get("ATTACK_SEED", "20260904"))


class Result:
    def __init__(self, completed: subprocess.CompletedProcess[str]):
        self.code = completed.returncode
        self.stdout = completed.stdout
        self.stderr = completed.stderr

    @property
    def traceback(self) -> bool:
        return "Traceback (most recent call last)" in self.stderr

    def __repr__(self) -> str:
        return f"exit={self.code} stdout={self.stdout[-300:]!r} stderr={self.stderr[-300:]!r}"


def run_validator(*paths: Path) -> Result:
    return Result(
        subprocess.run(
            [sys.executable, str(VALIDATOR), *map(str, paths)],
            capture_output=True,
            text=True,
            timeout=120,
        )
    )


class AttackBase(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="attack-ann-"))

    def write_bytes(self, name: str, data: bytes) -> Path:
        path = self.tmp / name
        path.write_bytes(data)
        return path

    def write_doc(self, name: str, doc: object) -> Path:
        return self.write_bytes(name, json.dumps(doc).encode("utf-8"))

    def assert_unreadable(self, path: Path, label: str) -> None:
        result = run_validator(path)
        self.assertEqual(result.code, 1, f"{label}: expected exit 1, got {result!r}")
        self.assertFalse(result.traceback, f"{label}: traceback instead of INVALID line: {result!r}")
        self.assertIn(f"INVALID {path}: unreadable", result.stdout, f"{label}: {result!r}")

    def assert_invalid_clean(self, path: Path, label: str, needle: str | None = None) -> Result:
        result = run_validator(path)
        self.assertEqual(result.code, 1, f"{label}: expected exit 1, got {result!r}")
        self.assertFalse(result.traceback, f"{label}: traceback instead of INVALID line: {result!r}")
        self.assertIn("INVALID ", result.stdout, f"{label}: {result!r}")
        if needle:
            self.assertIn(needle, result.stdout, f"{label}: {result!r}")
        return result


# --------------------------------------------------------------------------- S2
class S2UnreadableFiles(AttackBase):
    def test_zero_byte(self) -> None:
        self.assert_unreadable(self.write_bytes("empty.json", b""), "0-byte")

    def test_truncated(self) -> None:
        full = json.dumps(valid_doc()).encode("utf-8")
        self.assert_unreadable(self.write_bytes("trunc.json", full[: len(full) // 2]), "truncated")

    def test_utf8_bom(self) -> None:
        data = b"\xef\xbb\xbf" + json.dumps(valid_doc()).encode("utf-8")
        self.assert_unreadable(self.write_bytes("bom.json", data), "utf-8 BOM")

    def test_utf16_le_bom(self) -> None:
        data = json.dumps(valid_doc()).encode("utf-16")  # BOM + UTF-16-LE
        self.assert_unreadable(self.write_bytes("utf16.json", data), "utf-16 BOM")

    def test_utf16_be_no_bom(self) -> None:
        data = json.dumps(valid_doc()).encode("utf-16-be")
        self.assert_unreadable(self.write_bytes("utf16be.json", data), "utf-16-be no BOM")

    def test_latin1_byte_in_string(self) -> None:
        doc = valid_doc()
        doc["annotator"] = "rev\u00e9"
        data = json.dumps(doc, ensure_ascii=False).encode("latin-1")
        self.assert_unreadable(self.write_bytes("latin1.json", data), "latin-1")

    def test_random_binary_garbage(self) -> None:
        rng = random.Random(SEED)
        data = bytes(rng.getrandbits(8) for _ in range(4096))
        self.assert_unreadable(self.write_bytes("garbage.bin.json", data), f"binary seed={SEED}")

    def test_deeply_nested_json(self) -> None:
        depth = 100_000
        data = ("[" * depth + "]" * depth).encode("utf-8")
        self.assert_unreadable(self.write_bytes("nested.json", data), "deep nesting")

    def test_missing_file(self) -> None:
        self.assert_unreadable(self.tmp / "does-not-exist.json", "missing")

    def test_directory_instead_of_file(self) -> None:
        directory = self.tmp / "dir.json"
        directory.mkdir()
        self.assert_unreadable(directory, "directory")

    @unittest.skipIf(os.geteuid() == 0, "permission denial is a no-op as root")
    def test_permission_denied(self) -> None:
        path = self.write_doc("locked.json", valid_doc())
        path.chmod(0)
        try:
            self.assert_unreadable(path, "chmod 000")
        finally:
            path.chmod(stat.S_IRUSR | stat.S_IWUSR)

    def test_bad_file_does_not_abort_batch(self) -> None:
        """One unreadable input must not prevent later inputs from being validated."""
        bad = self.write_bytes("bad-utf16.json", json.dumps(valid_doc()).encode("utf-16"))
        good = self.write_doc("good.json", valid_doc())
        result = run_validator(bad, good)
        self.assertEqual(result.code, 1, repr(result))
        self.assertFalse(result.traceback, repr(result))
        self.assertIn("ok good.json", result.stdout, f"batch aborted before good.json: {result!r}")


# --------------------------------------------------------------------------- S3
class S3DuplicatePhases(AttackBase):
    def test_contact_listed_twice_in_valid_order(self) -> None:
        doc = valid_doc()
        phases = doc["phases"]
        contact_index = next(i for i, p in enumerate(phases) if p["key"] == "contact")
        contact = phases[contact_index]
        first = {**contact, "end_ms": contact["start_ms"] + (contact["end_ms"] - contact["start_ms"]) // 2}
        second = {**contact, "start_ms": first["end_ms"]}
        doc["phases"] = phases[:contact_index] + [first, second] + phases[contact_index + 1 :]
        self.assert_invalid_clean(self.write_doc("dup-contact.json", doc), "duplicate contact", "duplicate phase")

    def test_every_phase_duplicated_adjacent(self) -> None:
        doc = valid_doc()
        doubled = []
        for phase in doc["phases"]:
            mid = (phase["start_ms"] + phase["end_ms"]) // 2
            doubled.append({**phase, "end_ms": mid})
            doubled.append({**phase, "start_ms": mid})
        doc["phases"] = doubled
        self.assert_invalid_clean(self.write_doc("dup-all.json", doc), "all duplicated", "duplicate phase")

    def test_duplicate_top_level_json_key_last_wins(self) -> None:
        """JSON with two `technique` keys: the parser silently keeps the last one."""
        doc = valid_doc()
        text = json.dumps(doc)
        assert text.endswith("}")
        # first technique valid, second bogus -> must be rejected
        attacked = text[:-1] + ', "technique": "not_a_technique"}'
        self.assert_invalid_clean(self.write_bytes("dup-key.json", attacked.encode()), "dup key bogus last")


# ------------------------------------------------------------------- extras
ENUM_FIELDS = [
    ("attributes.side", lambda d, v: d["attributes"].__setitem__("side", v)),
    ("handedness", lambda d, v: d.__setitem__("handedness", v)),
    ("camera_view", lambda d, v: d.__setitem__("camera_view", v)),
    ("annotation_outcome", lambda d, v: d.__setitem__("annotation_outcome", v)),
    ("technique", lambda d, v: d.__setitem__("technique", v)),
    ("quality_flags[0]", lambda d, v: d.__setitem__("quality_flags", [v])),
    (
        "checkpoint_labels[0].checkpoint",
        lambda d, v: d.__setitem__("checkpoint_labels", [{"checkpoint": v, "verdict": "good"}]),
    ),
    (
        "checkpoint_labels[0].verdict",
        lambda d, v: d.__setitem__("checkpoint_labels", [{"checkpoint": "ready_position", "verdict": v}]),
    ),
]


class ExtraTypeConfusion(AttackBase):
    def test_unhashable_values_in_enum_fields(self) -> None:
        """A JSON array/object where a string enum is expected must yield INVALID, not TypeError."""
        rng = random.Random(SEED)
        failures = []
        for label, mutate in ENUM_FIELDS:
            for value in ([], ["forehand"], {}, {"k": 1}):
                doc = valid_doc()
                mutate(doc, value)
                path = self.write_doc(f"unhashable-{rng.randrange(1 << 30)}.json", doc)
                result = run_validator(path)
                if result.traceback or result.code != 1 or "INVALID" not in result.stdout:
                    failures.append(f"{label}={value!r}: {result!r}")
        self.assertEqual(failures, [], "\n".join(failures))

    def test_random_type_swaps_never_traceback(self) -> None:
        """Seeded fuzz: swap one leaf for a random JSON value; validator must never crash."""
        rng = random.Random(SEED)
        values = [None, True, False, 0, -1, 1.5, "", "x" * 64, [], [1], {}, {"a": 1}, 10**30, "\u0000", "\U0001f3d3"]
        crashes = []
        for i in range(200):
            doc = valid_doc()
            leaf_paths = list(_leaf_paths(doc))
            path = rng.choice(leaf_paths)
            _set_path(doc, path, rng.choice(values))
            file = self.write_doc(f"fuzz-{i}.json", doc)
            result = run_validator(file)
            if result.traceback:
                crashes.append(f"seed={SEED} case={i} path={path}: {result.stderr.strip().splitlines()[-1]}")
        self.assertEqual(crashes, [], "\n".join(crashes))


def _leaf_paths(node: object, prefix: tuple = ()):
    if isinstance(node, dict):
        for key, value in node.items():
            yield from _leaf_paths(value, prefix + (key,))
    elif isinstance(node, list):
        for index, value in enumerate(node):
            yield from _leaf_paths(value, prefix + (index,))
    else:
        yield prefix


def _set_path(node: object, path: tuple, value: object) -> None:
    for key in path[:-1]:
        node = node[key]
    node[path[-1]] = value


class ExtraSchemaDrift(AttackBase):
    """The validator claims it 'cannot silently drift from the JSON contract'. Compare
    its verdict with ml/annotations/annotation.schema.json on fields it never inspects."""

    def _schema_rejects(self, doc: dict) -> bool | None:
        try:
            import jsonschema  # optional: only present in the paddle-lab venv
        except ImportError:
            return None
        schema = json.loads(SCHEMA.read_text(encoding="utf-8"))
        return bool(list(jsonschema.Draft202012Validator(schema).iter_errors(doc)))

    def _assert_rejected(self, doc: dict, label: str) -> None:
        schema_verdict = self._schema_rejects(doc)
        if schema_verdict is not None:
            self.assertTrue(schema_verdict, f"{label}: schema unexpectedly accepts this doc")
        result = run_validator(self.write_doc(f"{label}.json", doc))
        self.assertEqual(result.code, 1, f"{label}: validator accepted a doc the schema rejects: {result!r}")

    def test_clip_id_not_a_string(self) -> None:
        doc = valid_doc()
        doc["clip_id"] = 42
        self._assert_rejected(doc, "clip_id-int")

    def test_clip_id_too_short(self) -> None:
        doc = valid_doc()
        doc["clip_id"] = "short"
        self._assert_rejected(doc, "clip_id-short")

    def test_optional_fields_wrong_type(self) -> None:
        for field, value in [
            ("player_bbox", "garbage"),
            ("pose_keyframes", 42),
            ("occlusion_notes", [1]),
            ("adjudicated_by", 7),
        ]:
            with self.subTest(field=field):
                doc = valid_doc()
                doc[field] = value
                self._assert_rejected(doc, f"optional-{field}")


class ExtraScale(AttackBase):
    def test_huge_phase_list_terminates_quickly(self) -> None:
        doc = valid_doc()
        doc["phases"] = [doc["phases"][0]] * 200_000
        path = self.write_doc("huge-phases.json", doc)
        result = run_validator(path)
        self.assertEqual(result.code, 1, repr(result))
        self.assertFalse(result.traceback, repr(result))

    def test_unicode_identifiers_accepted(self) -> None:
        doc = valid_doc()
        doc["clip_id"] = "clip-\u30d4\u30c3\u30af\u30eb-\U0001f3d3-0001"
        doc["annotator"] = "\u00e9\u00e8\u00ea"
        result = run_validator(self.write_doc("unicode.json", doc))
        self.assertEqual(result.code, 0, repr(result))
        self.assertFalse(result.traceback, repr(result))

    def test_rapid_repeat_is_deterministic(self) -> None:
        path = self.write_doc("repeat.json", valid_doc())
        outputs = {run_validator(path).stdout for _ in range(10)}
        self.assertEqual(len(outputs), 1, outputs)


if __name__ == "__main__":
    print(f"ATTACK_SEED={SEED}", file=sys.stderr)
    unittest.main(verbosity=2)
