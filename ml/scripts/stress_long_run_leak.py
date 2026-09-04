#!/usr/bin/env python3
"""Long-run leak stress harness for the ml/ Python tooling (lens: long-run-leak).

Invokes the annotation validator (and, when importable, the stdlib-only helpers
of tools/mining and tools/paddle-lab) hundreds to thousands of times in ONE
process with a seeded RNG. After every ``SAMPLE_EVERY`` iterations it forces a
full ``gc.collect()`` (the Python analogue of ``--expose-gc``) and records:

  * tracemalloc traced heap (total, and the bytes still retained that were
    allocated by the unit under test - filtered by source file),
  * live gc-tracked object count and ``gc.garbage`` length,
  * open file descriptors (``/proc/self/fd``) and live threads,
  * RSS from ``/proc/self/status``,
  * per-window invocation time (median + mean).

Every iteration is replayable from its seed (``--replay-seed``); every row is
streamed to ``<out-dir>/<campaign>.rows.jsonl`` so the harness's own
book-keeping has O(1) resident growth and cannot masquerade as a leak.

Verdicts per campaign (``<out-dir>/summary.json``):
  heap        regression slope of the post-warm-up traced heap, as % of the
              post-warm-up baseline per 100 iterations, for the unit-attributed
              retained bytes AND the total traced heap. A slope above
              HEAP_SLOPE_LIMIT_PCT that is also monotone (more than half of the
              consecutive samples increase) is BROKEN.
  fds/threads final == initial (handles / listeners / subscriptions).
  time_drift  median invocation time of the last window over the first
              post-warm-up window; above TIME_DRIFT_LIMIT is BROKEN.
  determinism same seed -> identical validator output twice in a row, input
              document never mutated.
  no_nan_inf  every emitted row round-trips through json.dumps(allow_nan=False).
  exceptions  every uncaught exception raised by the unit under test is
              recorded with its seed (never hidden) and is BROKEN.
  cli_contract validate_annotations.main exit code agrees with the per-file
              expectation computed by the harness.

Campaigns: validate_loop, cli_loop, reload_loop, helpers_loop.

Usage (fast default, wired into the unittest suite through
test_stress_long_run_leak.py):
  python3 ml/scripts/stress_long_run_leak.py --out-dir /tmp/leak
  STRESS_ITER=5000 python3 ml/scripts/stress_long_run_leak.py --out-dir /tmp/leak
  python3 ml/scripts/stress_long_run_leak.py --campaign validate_loop --replay-seed 1234
Exit code 0 = every lens invariant HELD; 1 = at least one BROKEN.
"""
from __future__ import annotations

import tracemalloc

if not tracemalloc.is_tracing():
    tracemalloc.start()

import argparse  # noqa: E402
import contextlib  # noqa: E402
import copy  # noqa: E402
import gc  # noqa: E402
import importlib  # noqa: E402
import importlib.util  # noqa: E402
import io  # noqa: E402
import json  # noqa: E402
import math  # noqa: E402
import os  # noqa: E402
import random  # noqa: E402
import statistics  # noqa: E402
import sys  # noqa: E402
import threading  # noqa: E402
import time  # noqa: E402
from pathlib import Path  # noqa: E402
from typing import Any, Callable  # noqa: E402

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parents[1]
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

import validate_annotations  # noqa: E402

DEFAULT_ITERATIONS = int(os.environ.get("STRESS_ITER", "500"))
DEFAULT_SEED = int(os.environ.get("STRESS_SEED", "20260904"))
SAMPLE_EVERY = 50
WARMUP_ITERATIONS = 100
HEAP_SLOPE_LIMIT_PCT = 5.0
TIME_DRIFT_LIMIT = 1.5
CAMPAIGNS = ("validate_loop", "cli_loop", "reload_loop", "helpers_loop")
UNIT_FILES = (
    "validate_annotations.py",
    "wave_g_g03_multi_paddle_miner.py",
    "compare_paddle_dets.py",
)

OUTCOMES = ("recognized_technique", "unknown_technique", "no_stroke", "partial", "aborted")
TECHNIQUES = sorted(validate_annotations.TECHNIQUES)
PHASE_KEYS = list(validate_annotations.PHASES)
CHECKPOINTS = sorted(validate_annotations.CHECKPOINTS)
FAULT_DIRECTIONS = sorted(validate_annotations.FAULT_DIRECTIONS)
QUALITY_DEFECTS = sorted(validate_annotations.QUALITY_FLAGS - {"clean"})
ATTRIBUTE_VALUES = {
    key: sorted(v for v in values if v is not None)
    for key, values in validate_annotations.ATTRIBUTE_VALUES.items()
}
HANDEDNESS = ("right", "left", "ambidextrous", "unknown")
CAMERA_VIEWS = ("front", "rear", "dominant_side", "nondominant_side", "diagonal", "overhead", "other")


# --------------------------------------------------------------------------- generators


def _phases(rng: random.Random, start: int, end: int) -> list[dict[str, Any]]:
    count = rng.randint(1, len(PHASE_KEYS))
    keys = sorted(rng.sample(range(len(PHASE_KEYS)), count))
    cuts = sorted(rng.randint(start, end) for _ in range(count + 1))
    cuts[0], cuts[-1] = start, end
    return [
        {
            "key": PHASE_KEYS[key],
            "start_ms": cuts[index],
            "end_ms": cuts[index + 1],
            "observable": rng.random() < 0.85,
        }
        for index, key in enumerate(keys)
    ]


def _checkpoint_labels(rng: random.Random) -> list[dict[str, Any]]:
    labels = []
    for checkpoint in rng.sample(CHECKPOINTS, rng.randint(0, 4)):
        verdict = rng.choice(("good", "minor_fault", "major_fault", "unobservable"))
        label: dict[str, Any] = {"checkpoint": checkpoint, "verdict": verdict}
        if verdict in {"minor_fault", "major_fault"}:
            label["fault_direction"] = rng.choice(FAULT_DIRECTIONS)
            label["fault_severity"] = round(rng.random(), 3)
        labels.append(label)
    return labels


def generate_valid_doc(rng: random.Random) -> dict[str, Any]:
    """A schema-valid annotation for a seeded outcome (abstentions included)."""
    outcome = rng.choice(OUTCOMES)
    start = rng.randint(0, 5000)
    end = start + rng.randint(1, 4000)
    with_technique = outcome in {"recognized_technique", "partial", "aborted"}
    doc: dict[str, Any] = {
        "clip_id": f"clip-{rng.randrange(10**6):06d}",
        "annotation_outcome": outcome,
        "technique": rng.choice(TECHNIQUES) if with_technique else None,
        "attributes": {key: rng.choice(values) for key, values in ATTRIBUTE_VALUES.items()},
        "handedness": rng.choice(HANDEDNESS),
        "camera_view": rng.choice(CAMERA_VIEWS),
        "stroke_start_ms": start,
        "stroke_end_ms": end,
        "phases": _phases(rng, start, end),
        "contact_range_ms": None,
        "checkpoint_labels": _checkpoint_labels(rng),
        "acceptable_alternative_mechanics": rng.random() < 0.2,
        "quality_flags": ["clean"] if rng.random() < 0.6 else rng.sample(QUALITY_DEFECTS, rng.randint(1, 3)),
        "annotator": f"reviewer-{rng.randrange(1000):03d}",
        "revision": rng.randint(1, 50),
    }
    if with_technique and rng.random() < 0.7:
        c_start = rng.randint(start, end)
        doc["contact_range_ms"] = {"start_ms": c_start, "end_ms": rng.randint(c_start, end)}
    if outcome in {"partial", "aborted"} and rng.random() < 0.5:
        doc["stroke_start_ms"] = doc["stroke_end_ms"] = None
        doc["phases"] = []
        doc["contact_range_ms"] = None
    if outcome == "unknown_technique":
        doc["checkpoint_labels"] = []
        if rng.random() < 0.5:
            doc["phases"] = []
    if outcome == "no_stroke":
        doc["stroke_start_ms"] = doc["stroke_end_ms"] = None
        doc["phases"] = []
        doc["contact_range_ms"] = None
        doc["checkpoint_labels"] = []
        doc["attributes"] = {key: None for key in ATTRIBUTE_VALUES}
    if rng.random() < 0.3:
        doc["primary_coaching_priority"] = rng.choice(CHECKPOINTS)
    if rng.random() < 0.2:
        doc["occlusion_notes"] = "paddle hidden behind torso"
    return doc


def _random_json_value(rng: random.Random, depth: int = 0) -> Any:
    kind = rng.randrange(12 if depth < 2 else 9)
    if kind == 0:
        return None
    if kind == 1:
        return rng.random() < 0.5
    if kind == 2:
        return rng.randint(-10**6, 10**6)
    if kind == 3:
        return rng.choice((0.0, -0.5, 1.5, 1e308, -1e308, 2.5))
    if kind == 4:
        return rng.choice((math.nan, math.inf, -math.inf))
    if kind == 5:
        return ""
    if kind == 6:
        return rng.choice(TECHNIQUES + CHECKPOINTS + list(OUTCOMES) + ["clean", "late", "good"])
    if kind == 7:
        return "".join(rng.choice("abcxyz_-0189 ") for _ in range(rng.randint(1, 24)))
    if kind == 8:
        return 10 ** rng.randint(19, 40)
    if kind == 9:
        return [_random_json_value(rng, depth + 1) for _ in range(rng.randint(0, 3))]
    if kind == 10:
        return {f"k{i}": _random_json_value(rng, depth + 1) for i in range(rng.randint(0, 3))}
    return [rng.choice(TECHNIQUES)]


def _mutate_type_fuzz(rng: random.Random, doc: dict[str, Any]) -> str:
    """Replace one arbitrary field (top-level, attribute, phase or label) with a random JSON value."""
    targets: list[tuple[Any, Any]] = [(doc, key) for key in doc]
    if isinstance(doc.get("attributes"), dict):
        targets += [(doc["attributes"], key) for key in doc["attributes"]]
    for field in ("phases", "checkpoint_labels"):
        items = doc.get(field)
        if isinstance(items, list):
            targets += [(item, key) for item in items if isinstance(item, dict) for key in item]
    if isinstance(doc.get("contact_range_ms"), dict):
        targets += [(doc["contact_range_ms"], key) for key in doc["contact_range_ms"]]
    container, key = rng.choice(targets)
    value = _random_json_value(rng)
    container[key] = value
    return f"type_fuzz:{key}={json.dumps(value, allow_nan=True)[:40]}"


def _mutate_drop_required(rng: random.Random, doc: dict[str, Any]) -> str:
    key = rng.choice(sorted(validate_annotations.REQUIRED))
    doc.pop(key, None)
    return f"drop_required:{key}"


def _mutate_unknown_field(rng: random.Random, doc: dict[str, Any]) -> str:
    key = "x_" + "".join(rng.choice("abcdefgh") for _ in range(6))
    doc[key] = _random_json_value(rng)
    return f"unknown_field:{key}"


def _mutate_phase_disorder(rng: random.Random, doc: dict[str, Any]) -> str:
    phases = doc.get("phases")
    if isinstance(phases, list) and len(phases) >= 2:
        i, j = rng.sample(range(len(phases)), 2)
        phases[i], phases[j] = phases[j], phases[i]
        return "phase_disorder"
    return "phase_disorder:noop"


def _mutate_phase_overlap(rng: random.Random, doc: dict[str, Any]) -> str:
    phases = doc.get("phases")
    if isinstance(phases, list) and len(phases) >= 2 and isinstance(phases[0], dict) and isinstance(phases[1], dict):
        phases[1]["start_ms"] = phases[0].get("start_ms", 0)
        return "phase_overlap"
    return "phase_overlap:noop"


def _mutate_window_inverted(rng: random.Random, doc: dict[str, Any]) -> str:
    doc["stroke_start_ms"], doc["stroke_end_ms"] = doc.get("stroke_end_ms"), doc.get("stroke_start_ms")
    return "window_inverted"


def _mutate_severity(rng: random.Random, doc: dict[str, Any]) -> str:
    labels = doc.get("checkpoint_labels")
    if isinstance(labels, list) and labels and isinstance(labels[0], dict):
        labels[0]["fault_severity"] = rng.choice((-0.1, 1.4, True, "0.5", math.nan, math.inf))
        return "severity_out_of_range"
    return "severity_out_of_range:noop"


def _mutate_quality_flags(rng: random.Random, doc: dict[str, Any]) -> str:
    doc["quality_flags"] = rng.choice(
        (["clean", "motion_blur"], ["motion_blur", "motion_blur"], [], ["studio"], [["clean"]], "clean")
    )
    return "quality_flags_bad"


def _mutate_guess_class(rng: random.Random, doc: dict[str, Any]) -> str:
    doc["annotation_outcome"] = rng.choice(("unknown_technique", "no_stroke"))
    doc["technique"] = rng.choice(TECHNIQUES)
    return "abstention_with_guessed_class"


MUTATORS: list[Callable[[random.Random, dict[str, Any]], str]] = [
    _mutate_type_fuzz,
    _mutate_type_fuzz,
    _mutate_type_fuzz,
    _mutate_drop_required,
    _mutate_unknown_field,
    _mutate_phase_disorder,
    _mutate_phase_overlap,
    _mutate_window_inverted,
    _mutate_severity,
    _mutate_quality_flags,
    _mutate_guess_class,
]


def generate_case(seed: int) -> tuple[dict[str, Any], list[str]]:
    """Deterministically build the (possibly mutated) document for ``seed``."""
    rng = random.Random(seed)
    doc = generate_valid_doc(rng)
    mutations: list[str] = []
    if rng.random() < 0.5:
        for _ in range(rng.randint(1, 3)):
            mutations.append(rng.choice(MUTATORS)(rng, doc))
    return doc, mutations


# --------------------------------------------------------------------------- probes


def open_fd_count() -> int:
    try:
        return len(os.listdir("/proc/self/fd"))
    except OSError:
        return -1


def rss_kib() -> int:
    try:
        with open("/proc/self/status", encoding="utf-8") as status:
            for line in status:
                if line.startswith("VmRSS:"):
                    return int(line.split()[1])
    except OSError:
        pass
    return -1


def unit_retained_bytes() -> int:
    """Bytes still alive that were allocated from a unit-under-test source file."""
    snapshot = tracemalloc.take_snapshot()
    filters = [tracemalloc.Filter(True, f"*{name}") for name in UNIT_FILES]
    return sum(stat.size for stat in snapshot.filter_traces(filters).statistics("filename"))


def _json_safe(value: Any) -> Any:
    """Make a row serialisable with allow_nan=False by stringifying non-finite floats."""
    if isinstance(value, float) and not math.isfinite(value):
        return f"<{value!r}>"
    if isinstance(value, dict):
        return {str(k): _json_safe(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_json_safe(v) for v in value]
    return value


class Recorder:
    """Streams rows + heap samples to JSONL so the harness itself has O(1) resident growth."""

    def __init__(self, out_dir: Path, campaign: str) -> None:
        self.campaign = campaign
        self.rows_path = out_dir / f"{campaign}.rows.jsonl"
        self.samples_path = out_dir / f"{campaign}.samples.jsonl"
        self._rows = self.rows_path.open("w", encoding="utf-8")
        self._samples = self.samples_path.open("w", encoding="utf-8")
        self.rows_written = 0
        self.outcome_counts: dict[str, int] = {}
        self.exceptions: list[dict[str, Any]] = []
        self.flag_counts: dict[str, int] = {}
        self.nan_rows = 0
        self._window_ms: list[float] = []

    def row(self, seed: int, outcome: str, elapsed_ms: float, **extra: Any) -> None:
        record = {"seed": seed, "outcome": outcome, "ms": round(elapsed_ms, 4), **extra}
        try:
            line = json.dumps(_json_safe(record), allow_nan=False, sort_keys=True)
        except ValueError:
            self.nan_rows += 1
            line = json.dumps({"seed": seed, "outcome": "nan_in_row"}, sort_keys=True)
        self._rows.write(line + "\n")
        self.rows_written += 1
        self.outcome_counts[outcome] = self.outcome_counts.get(outcome, 0) + 1
        for key, value in extra.items():
            if value is True:
                self.flag_counts[key] = self.flag_counts.get(key, 0) + 1
        self._window_ms.append(elapsed_ms)
        if outcome == "exception" and len(self.exceptions) < 10:
            self.exceptions.append({"seed": seed, **{k: extra[k] for k in ("exc_type", "exc_msg") if k in extra}})

    def sample(self, iteration: int) -> dict[str, Any]:
        self._rows.flush()
        self._samples.flush()
        gc.collect()
        gc.collect()
        current, peak = tracemalloc.get_traced_memory()
        window = self._window_ms
        record = {
            "iteration": iteration,
            "heap_bytes": current,
            "heap_peak_bytes": peak,
            "unit_retained_bytes": unit_retained_bytes(),
            "gc_objects": len(gc.get_objects()),
            "gc_garbage": len(gc.garbage),
            "open_fds": open_fd_count(),
            "threads": threading.active_count(),
            "rss_kib": rss_kib(),
            "window_median_ms": round(statistics.median(window), 4) if window else None,
            "window_mean_ms": round(statistics.fmean(window), 4) if window else None,
        }
        self._window_ms = []
        self._samples.write(json.dumps(record, sort_keys=True) + "\n")
        return record

    def close(self) -> None:
        self._rows.close()
        self._samples.close()

    def samples(self) -> list[dict[str, Any]]:
        with self.samples_path.open(encoding="utf-8") as handle:
            return [json.loads(line) for line in handle if line.strip()]


# --------------------------------------------------------------------------- campaigns


class Campaign:
    """One stress campaign: ``setup`` runs before the initial sample, ``iteration`` per seed."""

    name = ""

    def setup(self, out_dir: Path) -> None:
        pass

    def iteration(self, seed: int) -> tuple[str, dict[str, Any]]:
        raise NotImplementedError


def _same_modulo_nan(a: Any, b: Any) -> bool:
    return json.dumps(_json_safe(a), sort_keys=True) == json.dumps(_json_safe(b), sort_keys=True)


class ValidateLoop(Campaign):
    """validate() twice per seeded (possibly mutated) document; determinism + input immutability."""

    name = "validate_loop"

    def iteration(self, seed: int) -> tuple[str, dict[str, Any]]:
        doc, mutations = generate_case(seed)
        before = copy.deepcopy(doc)
        extra: dict[str, Any] = {"mutations": mutations}
        try:
            first = validate_annotations.validate(copy.deepcopy(doc), "seed")
            second = validate_annotations.validate(doc, "seed")
        except Exception as exc:  # noqa: BLE001 - the harness must record, never hide
            extra.update(exc_type=type(exc).__name__, exc_msg=str(exc)[:160])
            return "exception", extra
        extra["errors"] = len(first)
        if first != second:
            extra["nondeterministic"] = True
        if doc != before and not _same_modulo_nan(doc, before):
            extra["input_mutated"] = True
        if any(not isinstance(message, str) for message in first):
            extra["non_string_error"] = True
        outcome = "valid" if not first else "invalid"
        if not mutations and outcome != "valid":
            outcome = "unexpected_" + outcome
        return outcome, extra


class CliLoop(Campaign):
    """validate_annotations.main() over 1-4 seeded files per iteration (valid, invalid, binary, non-JSON)."""

    name = "cli_loop"

    def setup(self, out_dir: Path) -> None:
        self.work_dir = out_dir / "cli_work"
        self.work_dir.mkdir(parents=True, exist_ok=True)

    def iteration(self, seed: int) -> tuple[str, dict[str, Any]]:
        rng = random.Random(seed ^ 0x5EED)
        paths: list[str] = []
        expect_failure = False
        expect_crash = False
        for file_index in range(rng.randint(1, 4)):
            path = self.work_dir / f"doc{file_index}.json"
            roll = rng.random()
            if roll < 0.08:
                path.write_bytes(bytes(rng.randrange(256) for _ in range(rng.randint(1, 64))))
                expect_failure = True
            elif roll < 0.16:
                path.write_text("{not json", encoding="utf-8")
                expect_failure = True
            else:
                doc, _ = generate_case(seed * 7 + file_index)
                try:
                    payload = json.dumps(doc, allow_nan=True)
                except (TypeError, ValueError):
                    payload = "[]"
                path.write_text(payload, encoding="utf-8")
                try:
                    if validate_annotations.validate(json.loads(payload), path.name):
                        expect_failure = True
                except Exception:  # noqa: BLE001 - the CLI will hit the same exception
                    expect_crash = True
            paths.append(str(path))
        extra: dict[str, Any] = {"files": len(paths), "expect_failure": expect_failure or expect_crash}
        stdout = io.StringIO()
        try:
            with contextlib.redirect_stdout(stdout):
                code = validate_annotations.main(paths)
        except Exception as exc:  # noqa: BLE001
            extra.update(exc_type=type(exc).__name__, exc_msg=str(exc)[:160])
            return "exception", extra
        lines = stdout.getvalue().splitlines()
        if code == 0 and (expect_failure or expect_crash):
            extra["missed_invalid_file"] = True
        if code != 0 and not expect_failure and not expect_crash:
            extra["false_invalid"] = True
        if code != 0 and not any(line.startswith("INVALID") for line in lines):
            extra["exit1_without_invalid_line"] = True
        if len([line for line in lines if line.startswith(("ok ", "INVALID"))]) < len(paths):
            extra["unreported_file"] = True
        return ("exit0" if code == 0 else "exit1"), extra


class ReloadLoop(Campaign):
    """Mount/unmount analogue: importlib.reload re-reads the schema and rebuilds every module global."""

    name = "reload_loop"

    def setup(self, out_dir: Path) -> None:
        self.probe_doc = generate_valid_doc(random.Random(1))
        errors = validate_annotations.validate(copy.deepcopy(self.probe_doc), "probe")
        if errors:
            raise RuntimeError(f"harness bug: probe document is not valid: {errors}")

    def iteration(self, seed: int) -> tuple[str, dict[str, Any]]:
        try:
            module = importlib.reload(validate_annotations)
            techniques = len(module.TECHNIQUES)
            errors = module.validate(copy.deepcopy(self.probe_doc), "probe")
        except Exception as exc:  # noqa: BLE001
            return "exception", {"exc_type": type(exc).__name__, "exc_msg": str(exc)[:160]}
        extra = {"techniques": techniques, "errors": len(errors)}
        return ("reloaded" if techniques == 61 and errors == [] else "reload_state_drift"), extra


def _load_optional(name: str, relative: str) -> Any | None:
    path = REPO_ROOT / relative
    if not path.exists():
        return None
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        return None
    module = importlib.util.module_from_spec(spec)
    try:
        spec.loader.exec_module(module)
    except ImportError:
        return None
    return module


def _box(rng: random.Random) -> list[float]:
    x0, y0 = rng.uniform(-10, 1000), rng.uniform(-10, 1000)
    return [x0, y0, x0 + rng.uniform(0, 300), y0 + rng.uniform(0, 300)]


class HelpersLoop(Campaign):
    """Stdlib-only geometry helpers from tools/mining + tools/paddle-lab (skipped_unavailable if absent)."""

    name = "helpers_loop"

    def setup(self, out_dir: Path) -> None:
        self.miner = _load_optional("wave_g_miner", "tools/mining/wave_g_g03_multi_paddle_miner.py")
        self.compare = _load_optional("compare_paddle_dets", "tools/paddle-lab/compare_paddle_dets.py")

    def iteration(self, seed: int) -> tuple[str, dict[str, Any]]:
        if self.miner is None and self.compare is None:
            return "skipped_unavailable", {"reason": "tools/mining and tools/paddle-lab not importable"}
        rng = random.Random(seed)
        problems: list[str] = []
        try:
            if self.miner is not None:
                self._check_miner(rng, problems)
            if self.compare is not None:
                self._check_compare(rng, problems)
        except Exception as exc:  # noqa: BLE001
            return "exception", {"exc_type": type(exc).__name__, "exc_msg": str(exc)[:160]}
        return ("held" if not problems else "property_violation"), {"problems": problems}

    def _check_miner(self, rng: random.Random, problems: list[str]) -> None:
        miner = self.miner
        a, b = _box(rng), _box(rng)
        value = miner.iou(a, b)
        if not (0.0 <= value <= 1.0 + 1e-9) or not math.isfinite(value):
            problems.append(f"miner.iou out of range {value!r}")
        if value != miner.iou(a, b):
            problems.append("miner.iou nondeterministic")
        if (a[2] - a[0]) * (a[3] - a[1]) > 0 and miner.iou(a, a) < 1.0 - 1e-9:
            problems.append("miner.iou(a,a) != 1")
        pts = [(rng.uniform(0, 1), rng.uniform(0, 1)) for _ in range(4)]
        if miner.seg_intersect(*pts) != miner.seg_intersect(pts[2], pts[3], pts[0], pts[1]):
            problems.append("seg_intersect not symmetric")
        distance = miner.dist(pts[0], pts[1])
        if not math.isfinite(distance) or distance < 0:
            problems.append("dist invalid")
        candidates = [
            miner.make_candidate(
                rng.choice(("S1_foreign_paddle_near_target", "S2_crossing_paddles", "S5")),
                rng.choice(("case-a", "case-b")),
                rng.uniform(0, 20000),
                "synthetic",
                {},
                rng.random(),
            )
            for _ in range(rng.randint(0, 40))
        ]
        ranked = miner.dedupe_and_rank(copy.deepcopy(candidates))
        if ranked != miner.dedupe_and_rank(copy.deepcopy(candidates)):
            problems.append("dedupe_and_rank nondeterministic")
        ids = [c["candidateId"] for c in ranked]
        if len(ids) != len(set(ids)):
            problems.append("dedupe_and_rank duplicate candidateId")
        if len(ranked) > len(candidates):
            problems.append("dedupe_and_rank grew")
        keys = [(c["scenario"], c["caseId"], c["tMs"]) for c in ranked]
        if keys != sorted(keys):
            problems.append("dedupe_and_rank unsorted")

    def _check_compare(self, rng: random.Random, problems: list[str]) -> None:
        compare = self.compare
        a, b = _box(rng), _box(rng)
        value = compare.iou(a, b)
        if not (0.0 <= value <= 1.0 + 1e-9) or not math.isfinite(value):
            problems.append(f"compare.iou out of range {value!r}")
        dets_a = [{"label": rng.choice(("paddle", "ball")), "box": _box(rng)} for _ in range(rng.randint(0, 6))]
        dets_b = [{"label": rng.choice(("paddle", "ball")), "box": _box(rng)} for _ in range(rng.randint(0, 6))]
        pairs, ua, ub = compare.match_frame(dets_a, dets_b)
        if compare.match_frame(dets_a, dets_b) != (pairs, ua, ub):
            problems.append("match_frame nondeterministic")
        if len(pairs) + len(ua) != len(dets_a) or len(pairs) + len(ub) != len(dets_b):
            problems.append("match_frame partition broken")
        if len({i for _, i, _ in pairs}) != len(pairs) or len({j for _, _, j in pairs}) != len(pairs):
            problems.append("match_frame reused a detection")


CAMPAIGN_CLASSES: dict[str, type[Campaign]] = {
    cls.name: cls for cls in (ValidateLoop, CliLoop, ReloadLoop, HelpersLoop)
}


# --------------------------------------------------------------------------- analysis


def _slope_per_iteration(points: list[tuple[int, float]]) -> float:
    if len(points) < 2:
        return 0.0
    xs = [p[0] for p in points]
    ys = [p[1] for p in points]
    mean_x, mean_y = statistics.fmean(xs), statistics.fmean(ys)
    denominator = sum((x - mean_x) ** 2 for x in xs)
    if denominator == 0:
        return 0.0
    return sum((x - mean_x) * (y - mean_y) for x, y in zip(xs, ys)) / denominator


def _heap_verdict(steady: list[dict[str, Any]], key: str) -> dict[str, Any]:
    baseline = steady[0][key]
    slope = _slope_per_iteration([(s["iteration"], s[key]) for s in steady])
    slope_pct = (slope * 100 / baseline * 100) if baseline else 0.0
    increases = sum(1 for a, b in zip(steady, steady[1:]) if b[key] > a[key])
    monotone_fraction = increases / max(1, len(steady) - 1)
    broken = slope_pct > HEAP_SLOPE_LIMIT_PCT and monotone_fraction > 0.5
    return {
        "baseline_bytes": baseline,
        "final_bytes": steady[-1][key],
        "max_bytes": max(s[key] for s in steady),
        "slope_bytes_per_100_iterations": round(slope * 100, 2),
        "slope_pct_per_100_iterations": round(slope_pct, 4),
        "monotone_increase_fraction": round(monotone_fraction, 3),
        "limit_pct_per_100": HEAP_SLOPE_LIMIT_PCT,
        "held": not broken,
    }


def analyse(campaign: str, rec: Recorder, initial: dict[str, Any], iterations: int) -> dict[str, Any]:
    samples = rec.samples()
    steady = [s for s in samples if s["iteration"] >= WARMUP_ITERATIONS] or samples
    verdicts: dict[str, Any] = {}
    broken: list[str] = []

    if steady:
        for key, label in (("unit_retained_bytes", "heap_unit_retained"), ("heap_bytes", "heap_total_traced")):
            verdict = _heap_verdict(steady, key)
            verdicts[label] = verdict
            if not verdict["held"]:
                broken.append(
                    f"{label} slope {verdict['slope_pct_per_100_iterations']:.3f}% per 100 iterations "
                    f"> {HEAP_SLOPE_LIMIT_PCT}% and monotone ({verdict['monotone_increase_fraction']:.2f})"
                )
        objects_slope = _slope_per_iteration([(s["iteration"], s["gc_objects"]) for s in steady])
        verdicts["gc_objects"] = {
            "baseline": steady[0]["gc_objects"],
            "final": steady[-1]["gc_objects"],
            "slope_per_100_iterations": round(objects_slope * 100, 2),
            "garbage_final": steady[-1]["gc_garbage"],
            "held": steady[-1]["gc_garbage"] == 0,
        }
        if steady[-1]["gc_garbage"]:
            broken.append(f"gc.garbage holds {steady[-1]['gc_garbage']} uncollectable objects")
        verdicts["rss_kib"] = {
            "steady_first": steady[0]["rss_kib"],
            "final": steady[-1]["rss_kib"],
            "delta": steady[-1]["rss_kib"] - steady[0]["rss_kib"],
        }
        medians = [s["window_median_ms"] for s in steady if s["window_median_ms"] is not None]
        if len(medians) >= 2 and medians[0]:
            drift = medians[-1] / medians[0]
            verdicts["time_drift"] = {
                "first_window_median_ms": medians[0],
                "last_window_median_ms": medians[-1],
                "max_window_median_ms": max(medians),
                "ratio": round(drift, 3),
                "limit": TIME_DRIFT_LIMIT,
                "held": drift <= TIME_DRIFT_LIMIT,
            }
            if drift > TIME_DRIFT_LIMIT:
                broken.append(f"invocation time drift x{drift:.2f} > x{TIME_DRIFT_LIMIT}")

    final = samples[-1] if samples else initial
    for key in ("open_fds", "threads"):
        held = final[key] == initial[key]
        verdicts[key] = {
            "initial": initial[key],
            "final": final[key],
            "max": max(s[key] for s in samples),
            "held": held,
        }
        if not held:
            broken.append(f"{key} {initial[key]} -> {final[key]}")

    flags = rec.flag_counts
    verdicts["determinism"] = {
        "nondeterministic_rows": flags.get("nondeterministic", 0),
        "input_mutated_rows": flags.get("input_mutated", 0),
        "held": not flags.get("nondeterministic") and not flags.get("input_mutated"),
    }
    if flags.get("nondeterministic"):
        broken.append(f"{flags['nondeterministic']} seeds gave different output on the second call")
    if flags.get("input_mutated"):
        broken.append(f"{flags['input_mutated']} seeds had their input document mutated")
    verdicts["no_nan_inf"] = {"rows_with_nan": rec.nan_rows, "held": rec.nan_rows == 0}
    if rec.nan_rows:
        broken.append(f"{rec.nan_rows} rows contained NaN/Infinity")
    cli_keys = ("missed_invalid_file", "false_invalid", "exit1_without_invalid_line", "unreported_file")
    verdicts["cli_contract"] = {
        **{key: flags.get(key, 0) for key in cli_keys},
        "held": not any(flags.get(k) for k in cli_keys),
    }
    for key in cli_keys:
        if flags.get(key):
            broken.append(f"{flags[key]} CLI runs flagged {key}")

    exceptions = rec.outcome_counts.get("exception", 0)
    unexpected = sum(
        count
        for outcome, count in rec.outcome_counts.items()
        if outcome.startswith("unexpected_") or outcome in {"property_violation", "reload_state_drift"}
    )
    verdicts["exceptions"] = {"count": exceptions, "held": exceptions == 0, "first_seeds": rec.exceptions}
    verdicts["unexpected_outcomes"] = {"count": unexpected, "held": unexpected == 0}
    if exceptions:
        broken.append(f"{exceptions} iterations raised an uncaught exception from the unit under test")
    if unexpected:
        broken.append(f"{unexpected} iterations produced an unexpected outcome")

    return {
        "campaign": campaign,
        "iterations_requested": iterations,
        "iterations_executed": rec.rows_written,
        "outcome_counts": dict(sorted(rec.outcome_counts.items())),
        "samples": len(samples),
        "verdicts": verdicts,
        "broken": broken,
        "held": not broken,
        "rows_file": str(rec.rows_path),
        "samples_file": str(rec.samples_path),
    }


# --------------------------------------------------------------------------- driver


def seeds_for(seed: int, iterations: int) -> list[int]:
    return [(seed * 1_000_003 + index) % (2**31) for index in range(iterations)]


def run_campaign(campaign: str, iterations: int, seed: int, out_dir: Path) -> dict[str, Any]:
    out_dir.mkdir(parents=True, exist_ok=True)
    runner = CAMPAIGN_CLASSES[campaign]()
    runner.setup(out_dir)
    rec = Recorder(out_dir, campaign)
    try:
        initial = rec.sample(0)
        wall = time.perf_counter()
        for index, iteration_seed in enumerate(seeds_for(seed, iterations), 1):
            started = time.perf_counter()
            outcome, extra = runner.iteration(iteration_seed)
            elapsed_ms = (time.perf_counter() - started) * 1000
            rec.row(iteration_seed, outcome, elapsed_ms, **extra)
            if index % SAMPLE_EVERY == 0:
                rec.sample(index)
        if rec.rows_written % SAMPLE_EVERY:
            rec.sample(rec.rows_written)
        wall_s = time.perf_counter() - wall
    finally:
        rec.close()
    report = analyse(campaign, rec, initial, iterations)
    report["wall_seconds"] = round(wall_s, 3)
    report["seed"] = seed
    return report


def replay(campaign: str, seed: int) -> int:
    if campaign == "validate_loop":
        doc, mutations = generate_case(seed)
        print(json.dumps({"seed": seed, "mutations": mutations, "doc": _json_safe(doc)}, indent=2, allow_nan=False))
        try:
            errors = validate_annotations.validate(doc, f"seed-{seed}")
        except Exception as exc:  # noqa: BLE001
            print(f"EXCEPTION {type(exc).__name__}: {exc}")
            return 1
        print(json.dumps({"errors": errors}, indent=2))
        return 0
    runner = CAMPAIGN_CLASSES[campaign]()
    runner.setup(Path(os.environ.get("STRESS_OUT_DIR", "artifacts/stress/ml-scripts-long-run-leak")))
    outcome, extra = runner.iteration(seed)
    print(json.dumps({"seed": seed, "outcome": outcome, **_json_safe(extra)}, indent=2, allow_nan=False))
    return 0 if outcome not in {"exception", "property_violation", "reload_state_drift"} else 1


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--iterations", type=int, default=DEFAULT_ITERATIONS)
    parser.add_argument("--seed", type=int, default=DEFAULT_SEED)
    parser.add_argument(
        "--out-dir", default=os.environ.get("STRESS_OUT_DIR", "artifacts/stress/ml-scripts-long-run-leak")
    )
    parser.add_argument("--campaign", action="append", choices=CAMPAIGNS, help="repeatable; default all")
    parser.add_argument("--replay-seed", type=int, default=None)
    args = parser.parse_args(argv)
    campaigns = args.campaign or list(CAMPAIGNS)
    if args.replay_seed is not None:
        return replay(campaigns[0], args.replay_seed)
    out_dir = Path(args.out_dir)
    reports = [run_campaign(campaign, args.iterations, args.seed, out_dir) for campaign in campaigns]
    summary = {
        "unit": "ml-scripts",
        "lens": "long-run-leak",
        "python": sys.version.split()[0],
        "seed": args.seed,
        "iterations_per_campaign": args.iterations,
        "sample_every": SAMPLE_EVERY,
        "warmup_iterations": WARMUP_ITERATIONS,
        "scenarios_executed": sum(r["iterations_executed"] for r in reports),
        "campaigns": reports,
        "all_held": all(r["held"] for r in reports),
    }
    (out_dir / "summary.json").write_text(json.dumps(summary, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    for report in reports:
        status = "HELD" if report["held"] else "BROKEN"
        print(
            f"{status} {report['campaign']}: {report['iterations_executed']} iterations, "
            f"{report['wall_seconds']}s, outcomes={report['outcome_counts']}"
        )
        for item in report["broken"]:
            print(f"  - {item}")
    print(f"summary: {out_dir / 'summary.json'}")
    return 0 if summary["all_held"] else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
