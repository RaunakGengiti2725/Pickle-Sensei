#!/usr/bin/env python3
"""Seeded randomized long-run stress tests for ml/scripts (lens: randomized-seeded).

Run from the repository root (fast default, ~5 s):
  python3 -m unittest discover -s ml/scripts -p 'test_*.py'

Full campaign (>= 2000 sequences of 5-60 steps; writes a seed -> outcome table):
  STRESS_ITER=2000 STRESS_CLI_ITER=300 STRESS_MANIFEST_ITER=2000 \
  STRESS_OUT=/tmp/stress-ml-scripts.json \
  python3 -m unittest ml/scripts/test_stress_seeded_annotations.py -v

Replay one sequence: python3 ml/scripts/stress_seeded_lib.py <seed>

Environment knobs (all optional):
  STRESS_SEED           base seed (default 20260904); per-sequence seeds derive from it
  STRESS_ITER           validate() sequences (default 120)
  STRESS_MIN_LEN/MAX_LEN sequence length bounds (default 5 / 60)
  STRESS_CLI_ITER       CLI batch scenarios (default 25)
  STRESS_MANIFEST_ITER  manifest-schema scenarios (default 120; needs jsonschema)
  STRESS_XPROC          cross-process replays (default 3)
  STRESS_OUT            path for the JSON result table (default: not written)

Nothing here fabricates labels: every value is drawn from the committed schema
vocabularies, and clip ids are visibly synthetic (`stress-<seed>-<n>`).
"""
from __future__ import annotations

import contextlib
import io
import json
import os
import random
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

import stress_seeded_lib as lib  # noqa: E402
import validate_annotations as va  # noqa: E402

BASE_SEED = int(os.environ.get("STRESS_SEED", "20260904"))
ITER = int(os.environ.get("STRESS_ITER", "120"))
MIN_LEN = int(os.environ.get("STRESS_MIN_LEN", "5"))
MAX_LEN = int(os.environ.get("STRESS_MAX_LEN", "60"))
CLI_ITER = int(os.environ.get("STRESS_CLI_ITER", "25"))
MANIFEST_ITER = int(os.environ.get("STRESS_MANIFEST_ITER", "120"))
XPROC = int(os.environ.get("STRESS_XPROC", "3"))
OUT_PATH = os.environ.get("STRESS_OUT")

_RESULTS: dict[str, object] = {"config": {"base_seed": BASE_SEED, "iter": ITER, "min_len": MIN_LEN, "max_len": MAX_LEN}}


def _dump_results() -> None:
    if OUT_PATH:
        Path(OUT_PATH).write_text(json.dumps(_RESULTS, indent=1, default=str), encoding="utf-8")


def _examples(campaign: dict, kind: str, limit: int = 3) -> list[dict]:
    """Re-run the first `limit` failing seeds of `kind` and return minimized repros."""
    out = []
    for seq in campaign["sequences"]:
        if kind not in seq["failure_kinds"]:
            continue
        replay = lib.run_sequence(seq["seed"], MIN_LEN, MAX_LEN)
        failure = next(f for f in replay["failures"] if f["kind"] == kind)
        minimized = lib.minimize_failure(failure)
        minimized["seed"] = seq["seed"]
        minimized["index"] = seq["index"]
        out.append(minimized)
        if len(out) >= limit:
            break
    return out


class SeededValidateSequences(unittest.TestCase):
    """I1-I8 over >= STRESS_ITER seeded action sequences against validate()."""

    campaign: dict

    @classmethod
    def setUpClass(cls) -> None:
        cls.campaign = lib.run_campaign(BASE_SEED, ITER, MIN_LEN, MAX_LEN)
        summary = {k: v for k, v in cls.campaign.items() if k != "sequences"}
        summary["seed_table"] = [
            {
                "index": s["index"],
                "seed": s["seed"],
                "length": s["length"],
                "outcome": s["outcome"],
                "failure_kinds": s["failure_kinds"],
                "first_failure": s["first_failure"],
                "trace_sha256": s["trace_sha256"],
            }
            for s in cls.campaign["sequences"]
        ]
        summary["minimized_examples"] = {
            kind: _examples(cls.campaign, kind) for kind in lib.FAILURE_KINDS if cls.campaign["failures_by_kind"].get(kind)
        }
        _RESULTS["validate_sequences"] = summary
        _dump_results()

    def _assert_kind_absent(self, kind: str) -> None:
        count = self.campaign["failures_by_kind"].get(kind, 0)
        if count:
            seeds = [s["seed"] for s in self.campaign["sequences"] if kind in s["failure_kinds"]][:10]
            examples = _examples(self.campaign, kind, 1)
            self.fail(
                f"{kind}: {count} step(s) across {len(seeds)}+ sequences; seeds={seeds}; "
                f"minimized example={json.dumps(examples[0], default=str)[:1500] if examples else None}"
            )

    def test_campaign_ran_at_scale(self) -> None:
        totals = self.campaign["totals"]
        self.assertEqual(totals["sequences"], ITER)
        self.assertGreaterEqual(totals["steps"], ITER * (MIN_LEN + 1))
        self.assertTrue(all(MIN_LEN <= s["length"] <= MAX_LEN for s in self.campaign["sequences"]))

    def test_I1_validate_never_raises(self) -> None:
        self._assert_kind_absent("CRASH")

    def test_I2_validate_is_deterministic(self) -> None:
        self._assert_kind_absent("NONDETERMINISTIC")

    def test_I3_validate_is_pure(self) -> None:
        self._assert_kind_absent("IMPURE")

    def test_I4_results_are_well_formed(self) -> None:
        self._assert_kind_absent("MALFORMED_RESULT")

    def test_I5_legal_records_are_accepted(self) -> None:
        self._assert_kind_absent("FALSE_REJECT")

    def test_I6_faulted_records_are_rejected(self) -> None:
        self._assert_kind_absent("FALSE_ACCEPT")

    def test_I7_validator_at_least_as_strict_as_schema(self) -> None:
        if not lib.have_jsonschema():
            self.skipTest("jsonschema not importable: differential oracle NOT run (not a pass)")
        self._assert_kind_absent("SCHEMA_REJECTS_VALIDATOR_ACCEPTS")

    def test_I8_same_seed_same_trace_in_process(self) -> None:
        self.assertEqual(self.campaign["nondeterministic_traces"], 0)
        self.assertTrue(all(s["trace_deterministic"] for s in self.campaign["sequences"]))

    def test_I8_same_seed_same_trace_across_processes(self) -> None:
        picked = self.campaign["sequences"][:XPROC]
        mismatches = []
        for seq in picked:
            proc = subprocess.run(
                [sys.executable, str(HERE / "stress_seeded_lib.py"), str(seq["seed"])],
                capture_output=True,
                text=True,
                check=True,
                env={**os.environ, "PYTHONHASHSEED": str(random.Random(seq["seed"]).randint(0, 4294967295))},
            )
            trace = json.loads(proc.stdout)["trace_sha256"]
            if trace != seq["trace_sha256"]:
                mismatches.append((seq["seed"], seq["trace_sha256"], trace))
        _RESULTS["cross_process_replays"] = {"checked": len(picked), "mismatches": mismatches}
        _dump_results()
        self.assertEqual(mismatches, [])


class ValidatorConstantsMatchSchema(unittest.TestCase):
    """The validator hard-codes every vocabulary except techniques; pin them to the schema."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.schema = json.loads(lib.ANNOTATION_SCHEMA_PATH.read_text(encoding="utf-8"))
        cls.props = cls.schema["properties"]

    def test_required_and_optional_fields(self) -> None:
        self.assertEqual(set(self.schema["required"]), va.REQUIRED)
        self.assertEqual(set(self.props), va.REQUIRED | va.OPTIONAL)
        self.assertFalse(self.schema.get("additionalProperties", True))

    def test_enums(self) -> None:
        self.assertEqual(set(self.props["annotation_outcome"]["enum"]), va.ANNOTATION_OUTCOMES)
        self.assertEqual(set(self.props["handedness"]["enum"]), set(lib.HANDEDNESS))
        self.assertEqual(set(self.props["camera_view"]["enum"]), set(lib.CAMERA_VIEWS))
        self.assertEqual(self.props["phases"]["items"]["properties"]["key"]["enum"], va.PHASES)
        label_props = self.props["checkpoint_labels"]["items"]["properties"]
        self.assertEqual(set(label_props["checkpoint"]["enum"]), va.CHECKPOINTS)
        self.assertEqual(set(label_props["verdict"]["enum"]), va.VERDICTS)
        self.assertEqual(set(label_props["fault_direction"]["enum"]), va.FAULT_DIRECTIONS)
        self.assertEqual(set(self.props["quality_flags"]["items"]["enum"]), va.QUALITY_FLAGS)
        attribute_props = self.schema["$defs"]["attributes"]["properties"]
        self.assertEqual(set(attribute_props), set(va.ATTRIBUTE_VALUES))
        for key, spec in attribute_props.items():
            self.assertEqual(set(spec["enum"]), va.ATTRIBUTE_VALUES[key], key)


class SeededCliBatches(unittest.TestCase):
    """main(paths) over seeded batches of generated files.

    File kinds: legal, faulted (one injected fault; validity oracle = validate()),
    non_object JSON, not_json, non_utf8 bytes, NaN/Infinity literals (accepted by
    json.loads), missing path, directory. Invariants: main() never raises; returns 0
    iff every file validates clean; prints exactly one `ok <name>` per clean file and
    >= 1 `INVALID <name-or-path>: ...` line per bad file; a bad file never stops the batch.
    """

    KINDS = ("legal", "faulted", "non_object", "not_json", "non_utf8", "nan_literal", "missing", "directory")
    WEIGHTS = (6, 6, 1, 1, 1, 1, 1, 1)

    def _make_file(self, rng: random.Random, directory: Path, seed: int, n: int, kind: str) -> tuple[str, bool]:
        """Returns (path, expected_valid)."""
        name = f"file-{n}.json"
        path = directory / name
        clip_id = f"stress-cli-{seed:016x}-{n}"
        if kind == "legal":
            doc = lib.gen_legal_doc(rng, clip_id)
            path.write_text(json.dumps(doc), encoding="utf-8")
            return str(path), not va.validate(doc, name)
        if kind == "faulted":
            doc = lib.gen_legal_doc(rng, clip_id)
            for _ in range(20):
                fault = rng.choice(sorted(lib.FAULT_ACTIONS))
                probe = json.loads(json.dumps(doc))
                try:
                    applied = lib.FAULT_ACTIONS[fault](random.Random(rng.getrandbits(64)), probe)
                except (KeyError, TypeError, AttributeError, IndexError):
                    applied = None
                if applied is not None:
                    doc = probe
                    break
            path.write_text(json.dumps(doc, allow_nan=True), encoding="utf-8")
            # Whether validate() rejects the fault is I6's business (SeededValidateSequences);
            # here the oracle is validate() itself so only CLI plumbing is under test.
            # If validate() raises, main() must still report the file as INVALID.
            try:
                return str(path), not va.validate(json.loads(json.dumps(doc, allow_nan=True)), name)
            except Exception:
                return str(path), False
        if kind == "non_object":
            path.write_bytes(rng.choice([b"[]", b"1", b"null", b'"x"', b"true"]))
            return str(path), False
        if kind == "not_json":
            path.write_bytes(rng.choice([b"{not json", b"", b"{\"a\": }"]))
            return str(path), False
        if kind == "non_utf8":
            path.write_bytes(rng.choice([b"\xff\xfe{}", b"{\"clip_id\": \"\xc3\x28\"}"]))
            return str(path), False
        if kind == "nan_literal":
            doc = lib.gen_legal_doc(rng, clip_id, "recognized_technique")
            field = rng.choice(["stroke_start_ms", "stroke_end_ms", "revision"])
            literal = rng.choice(["NaN", "Infinity", "-Infinity"])
            text = json.dumps(doc).replace(json.dumps({field: doc[field]})[1:-1], f'"{field}": {literal}')
            self.assertNotEqual(text, json.dumps(doc), "NaN/Infinity literal was not injected")
            path.write_text(text, encoding="utf-8")
            return str(path), False
        if kind == "missing":
            return str(directory / f"missing-{n}.json"), False
        sub = directory / f"dir-{n}"
        sub.mkdir()
        return str(sub), False

    def test_cli_batches(self) -> None:
        table = []
        failures = []
        executed = 0
        for index in range(CLI_ITER):
            seed = lib.derive_seed(BASE_SEED ^ 0xC11, index)
            rng = random.Random(seed)
            with tempfile.TemporaryDirectory() as tmp:
                directory = Path(tmp)
                kinds = [rng.choices(self.KINDS, weights=self.WEIGHTS)[0] for _ in range(rng.randint(1, 8))]
                files = [self._make_file(rng, directory, seed, n, kind) for n, kind in enumerate(kinds)]
                paths = [f[0] for f in files]
                expected_invalid = sum(not f[1] for f in files)
                buffer = io.StringIO()
                row: dict = {"index": index, "seed": seed, "files": kinds, "expected_invalid": expected_invalid}
                try:
                    with contextlib.redirect_stdout(buffer):
                        rc = va.main(paths)
                    executed += 1
                    lines = [line for line in buffer.getvalue().splitlines() if line]
                    row.update({"rc": rc, "lines": len(lines)})
                    problems = []
                    if rc != (1 if expected_invalid else 0):
                        problems.append(f"rc={rc} expected {1 if expected_invalid else 0}")
                    if not all(line.startswith(("ok ", "INVALID ")) for line in lines):
                        problems.append("unexpected report line format")
                    for path, valid in files:
                        name = Path(path).name
                        ok_lines = [line for line in lines if line == f"ok {name}"]
                        invalid_lines = [line for line in lines if line.startswith((f"INVALID {name}: ", f"INVALID {path}: "))]
                        if valid and (len(ok_lines) != 1 or invalid_lines):
                            problems.append(f"{name}: expected exactly one ok line, got ok={len(ok_lines)} invalid={len(invalid_lines)}")
                        if not valid and (ok_lines or not invalid_lines):
                            problems.append(f"{name}: expected >=1 INVALID line and no ok line, got ok={len(ok_lines)} invalid={len(invalid_lines)}")
                    row["outcome"] = "HELD" if not problems else "BROKEN"
                    row["problems"] = problems
                except Exception as exc:  # the CLI must report, not raise
                    executed += 1
                    row.update({"outcome": "BROKEN", "problems": [f"CRASH {type(exc).__name__}: {exc}"]})
                if row["outcome"] == "BROKEN":
                    failures.append(row)
                table.append(row)
        _RESULTS["cli_batches"] = {"executed": executed, "broken": len(failures), "table": table}
        _dump_results()
        self.assertEqual(executed, CLI_ITER)
        self.assertEqual(failures, [], f"{len(failures)} CLI batch(es) broke; first={json.dumps(failures[:1], default=str)[:800]}")


class SeededManifestSchema(unittest.TestCase):
    """Seeded property check of ml/datasets/manifest.schema.json (needs jsonschema).

    Legal manifests (consented/commissioned/licensed, cleared rights, active consent,
    >=2 annotators, accepted review, minor => guardian release) must validate; every
    single injected eligibility fault must be rejected.
    """

    @classmethod
    def setUpClass(cls) -> None:
        if not lib.have_jsonschema():
            raise unittest.SkipTest("jsonschema not importable: manifest schema campaign NOT run (not a pass)")
        cls.validator = lib._schema_validator(lib.MANIFEST_SCHEMA_PATH)
        cls.date_time_checked = "date-time" in lib.jsonschema.FormatChecker().checkers

    @staticmethod
    def _oid(rng: random.Random, prefix: str) -> str:
        return f"{prefix}-{rng.getrandbits(48):012x}"

    @staticmethod
    def _dt(rng: random.Random) -> str:
        return f"2026-{rng.randint(1, 12):02d}-{rng.randint(1, 28):02d}T{rng.randint(0, 23):02d}:{rng.randint(0, 59):02d}:00Z"

    def _item(self, rng: random.Random) -> dict:
        minor = rng.random() < 0.3
        return {
            "clip_id": self._oid(rng, "clip"),
            "media_sha256": "".join(rng.choice("0123456789abcdef") for _ in range(64)),
            "annotation_path": f"annotations/{rng.getrandbits(32):08x}.json",
            "athlete_id": self._oid(rng, "ath"),
            "athlete_group_id": self._oid(rng, "grp"),
            "session_id": self._oid(rng, "ses"),
            "split": rng.choice(["train", "validation", "test", "locked_holdout"]),
            "source": rng.choice(["consented_first_party_capture", "commissioned_capture", "licensed_media"]),
            "capture_provenance": {
                "raw_asset_id": self._oid(rng, "raw"),
                "recorder_or_licensor_id": self._oid(rng, "rec"),
                "recorded_at": None if rng.random() < 0.3 else self._dt(rng),
                "origin_description": "first-party court capture",
                "third_party_broadcast": False,
            },
            "consent": {
                "participant_release_id": self._oid(rng, "rel"),
                "terms_version": "v2",
                "signed_at": self._dt(rng),
                "age_class": "minor" if minor else "adult",
                "guardian_release_id": self._oid(rng, "grd") if minor else None,
                "commercial_model_training": True,
                "product_evaluation": True,
                "derived_features": True,
                "internal_human_review": True,
                "withdrawal_process_version": "v1",
                "state": "active",
            },
            "rights": {
                "rights_holder_id": self._oid(rng, "rh"),
                "commercial_training_grant_id": self._oid(rng, "grant"),
                "evidence_uri": "s3://rights/evidence.pdf",
                "commercial_model_training_permitted": True,
                "derived_feature_use_permitted": True,
                "third_party_media_clearance_complete": True,
                "bystander_clearance_complete": True,
                "verified_by": self._oid(rng, "ver"),
                "verified_at": self._dt(rng),
                "state": "cleared",
            },
            "human_review": {
                "independent_annotator_ids": [self._oid(rng, "ann") for _ in range(rng.randint(2, 4))],
                "coach_reviewer_id": self._oid(rng, "coach"),
                "reviewed_at": self._dt(rng),
                "agreement": rng.choice(["agreed", "disputed_then_adjudicated"]),
                "decision": "accepted",
            },
            "training_eligible": True,
        }

    def _manifest(self, rng: random.Random) -> dict:
        manifest = {
            "dataset_id": self._oid(rng, "ds"),
            "version": f"{rng.randint(0, 3)}.{rng.randint(0, 9)}.{rng.randint(0, 9)}",
            "created_at": self._dt(rng),
            "taxonomy_version": "3",
            "annotation_schema_version": "2",
            "consent_terms_version": "v2",
            "withdrawal_process_version": "v1",
            "rights_reviewed_at": self._dt(rng),
            "items": [self._item(rng) for _ in range(rng.randint(0, 4))],
        }
        if rng.random() < 0.5:
            manifest["description"] = "stress fixture"
        return manifest

    # Every fault is an eligibility rule the README documents; each must be rejected.
    FAULTS = (
        "source_synthetic",
        "source_scraped",
        "consent_training_false",
        "rights_training_false",
        "training_eligible_false",
        "third_party_broadcast_true",
        "consent_withdrawn",
        "rights_pending",
        "minor_without_guardian",
        "adult_with_guardian",
        "one_annotator",
        "duplicate_annotators",
        "review_rejected",
        "bad_sha256",
        "short_opaque_id",
        "extra_item_field",
        "missing_item_field",
        "extra_top_level_field",
        "bystander_unclear",
    )

    def _inject(self, rng: random.Random, manifest: dict, fault: str) -> bool:
        if fault == "extra_top_level_field":
            manifest["notes"] = "x"
            return True
        if not manifest["items"]:
            return False
        item = rng.choice(manifest["items"])
        if fault == "source_synthetic":
            item["source"] = "synthetic"
        elif fault == "source_scraped":
            item["source"] = rng.choice(["scraped_broadcast", "platform_url", "generated"])
        elif fault == "consent_training_false":
            item["consent"]["commercial_model_training"] = False
        elif fault == "rights_training_false":
            item["rights"]["commercial_model_training_permitted"] = False
        elif fault == "training_eligible_false":
            item["training_eligible"] = False
        elif fault == "third_party_broadcast_true":
            item["capture_provenance"]["third_party_broadcast"] = True
        elif fault == "consent_withdrawn":
            item["consent"]["state"] = rng.choice(["withdrawn", "pending", "expired"])
        elif fault == "rights_pending":
            item["rights"]["state"] = rng.choice(["pending", "revoked"])
        elif fault == "minor_without_guardian":
            item["consent"]["age_class"] = "minor"
            item["consent"]["guardian_release_id"] = None
        elif fault == "adult_with_guardian":
            item["consent"]["age_class"] = "adult"
            item["consent"]["guardian_release_id"] = self._oid(rng, "grd")
        elif fault == "one_annotator":
            item["human_review"]["independent_annotator_ids"] = item["human_review"]["independent_annotator_ids"][:1]
        elif fault == "duplicate_annotators":
            ann = item["human_review"]["independent_annotator_ids"][0]
            item["human_review"]["independent_annotator_ids"] = [ann, ann]
        elif fault == "review_rejected":
            item["human_review"]["decision"] = rng.choice(["rejected", "pending"])
        elif fault == "bad_sha256":
            item["media_sha256"] = rng.choice(["abc", "G" * 64, "A" * 64, ""])
        elif fault == "short_opaque_id":
            item[rng.choice(["clip_id", "athlete_id", "athlete_group_id", "session_id"])] = "short"
        elif fault == "extra_item_field":
            item["license_note"] = "x"
        elif fault == "missing_item_field":
            del item[rng.choice(sorted(item))]
        elif fault == "bystander_unclear":
            item["rights"]["bystander_clearance_complete"] = False
        return True

    def test_manifest_schema_campaign(self) -> None:
        table = []
        broken = []
        executed = 0
        for index in range(MANIFEST_ITER):
            seed = lib.derive_seed(BASE_SEED ^ 0x3A1F, index)
            rng = random.Random(seed)
            manifest = self._manifest(rng)
            legal_errors = sorted(e.message for e in self.validator.iter_errors(manifest))
            fault = rng.choice(self.FAULTS)
            faulted = json.loads(json.dumps(manifest))
            applied = self._inject(rng, faulted, fault)
            fault_errors = sorted(e.message for e in self.validator.iter_errors(faulted)) if applied else None
            executed += 1
            problems = []
            if legal_errors:
                problems.append(f"legal manifest rejected: {legal_errors[:3]}")
            if applied and not fault_errors:
                problems.append(f"fault {fault} accepted")
            row = {"index": index, "seed": seed, "items": len(manifest["items"]), "fault": fault if applied else None, "outcome": "HELD" if not problems else "BROKEN", "problems": problems}
            table.append(row)
            if problems:
                broken.append(row)
        _RESULTS["manifest_schema"] = {"executed": executed, "broken": len(broken), "date_time_format_asserted": self.date_time_checked, "table": table}
        _dump_results()
        self.assertEqual(executed, MANIFEST_ITER)
        self.assertEqual(broken, [], f"{len(broken)} manifest scenario(s) broke; first={json.dumps(broken[:1])[:600]}")


if __name__ == "__main__":
    unittest.main()
