"""Seeded randomized long-run stress for the paddle-lab / mining pure helpers.

Sequences of legal / near-legal calls against the public helpers in
detect_paddle.py, student_lib.py and tools/mining/wave_g_g03_multi_paddle_miner.py
are generated from a recorded seed; invariants are checked after EVERY step and
the whole trace is hashed so the same seed must reproduce the same trace.

Invariants (P = paddle-lab):
  P1 plan_window_seek(start, fps, start_time) returns (first_index, seek_sec)
     with first_index >= 0, pts(first_index) >= start (first frame whose pts is
     not before the requested start), pts(first_index - 1) < start, and
     0 <= first_index / fps - seek_sec < 1 ms (seek floored, never past pts).
  P2 box_iou(a, b) is finite, in [0, 1], symmetric, 1.0 for a positive-area
     box against itself, and agrees with the miner's iou() on legal boxes.
     Inverted (near-legal) boxes must not raise and must stay finite.
  P3 nms_union keeps a subset of its input, sorted by score descending, with
     every kept pair below the IoU threshold, and is idempotent.
  P4 px_to_heatmap / heatmap_to_px round-trip within 1e-6 px; letterbox()
     output is (3, size, size), finite, in [0, 1], with pads matching the
     documented formula.
  P5 render_target is (HEATMAP_SIZE, HEATMAP_SIZE), finite, in [0, max weight];
     heatmap_peaks returns <= max_peaks peaks, scores >= floor, descending,
     pairwise Chebyshev distance > suppression radius, and finds a single
     integer-coordinate center exactly.
  P6 mining dist() is symmetric / non-negative / triangle; seg_intersect() is
     invariant under endpoint and segment swaps and agrees with a parametric
     reference on non-degenerate segments.
  P7 frame_iter over committed CFR clips: emitted tMs are start_time +
     k / fps for consecutive strided indices, the first frame is the first
     frame with pts >= start_ms, every frame has the requested shape and is
     byte-identical to decode_frames_at for the same index.
  P8 determinism: same seed -> identical trace hash (in-process twice).

Environment knobs (small defaults keep this in the suite; the campaign is
STRESS_ITER=2000):
  STRESS_SEED (20260904)  STRESS_ITER (120)  STRESS_MIN_LEN (5)  STRESS_MAX_LEN (60)
  STRESS_DECODE_ITER (3)  STRESS_OUT (optional JSON results path)

Run:  python3 -m unittest discover -s tools/paddle-lab -p 'test_stress_*.py'
"""

from __future__ import annotations

import hashlib
import importlib.util
import json
import math
import os
import random
import sys
import unittest
from pathlib import Path
from typing import Any, Callable

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parents[1]
sys.path.insert(0, str(HERE))

try:
    import numpy as np  # type: ignore

    _HAVE_NUMPY = True
except Exception:  # pragma: no cover - environment dependent
    np = None  # type: ignore
    _HAVE_NUMPY = False

try:
    from detect_paddle import box_iou, decode_frames_at, ffprobe_meta, frame_iter, nms_union, plan_window_seek

    _HAVE_DETECT = True
    _DETECT_IMPORT_ERROR = ""
except Exception as exc:  # pragma: no cover - environment dependent
    _HAVE_DETECT = False
    _DETECT_IMPORT_ERROR = f"{type(exc).__name__}: {exc}"

try:
    import student_lib as sl

    _HAVE_STUDENT = True
    _STUDENT_IMPORT_ERROR = ""
except Exception as exc:  # pragma: no cover - environment dependent
    sl = None  # type: ignore
    _HAVE_STUDENT = False
    _STUDENT_IMPORT_ERROR = f"{type(exc).__name__}: {exc}"


def _load_miner():
    path = REPO_ROOT / "tools" / "mining" / "wave_g_g03_multi_paddle_miner.py"
    spec = importlib.util.spec_from_file_location("wave_g_g03_multi_paddle_miner", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


miner = _load_miner()

CLIPS = [
    REPO_ROOT / "datasets/paddle-bench/bundles/wm-volley-02/clip.mp4",
    REPO_ROOT / "datasets/paddle-bench/bundles/afn-sasebo-rally1/clip.mp4",
]
FPS_CHOICES = [24.0, 25.0, 30000.0 / 1001.0, 30.0, 60000.0 / 1001.0, 60.0]
EPS = 1e-6


def env_int(name: str, default: int) -> int:
    return int(os.environ.get(name, default))


BASE_SEED = env_int("STRESS_SEED", 20260904)
ITER = env_int("STRESS_ITER", 120)
MIN_LEN = env_int("STRESS_MIN_LEN", 5)
MAX_LEN = env_int("STRESS_MAX_LEN", 60)
DECODE_ITER = env_int("STRESS_DECODE_ITER", 3)
OUT_PATH = os.environ.get("STRESS_OUT")


def derive_seed(base_seed: int, index: int) -> int:
    digest = hashlib.sha256(f"paddle-lab:{base_seed}:{index}".encode()).digest()
    return int.from_bytes(digest[:8], "big")


def _r(x: Any) -> Any:
    """Round floats for a stable trace representation."""
    if isinstance(x, float):
        if math.isnan(x) or math.isinf(x):
            return repr(x)
        return round(x, 9)
    if isinstance(x, (list, tuple)):
        return [_r(v) for v in x]
    if isinstance(x, dict):
        return {str(k): _r(v) for k, v in x.items()}
    return x


def finite(x: float) -> bool:
    return isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x)


class Fail(Exception):
    def __init__(self, invariant: str, detail: str):
        super().__init__(f"{invariant}: {detail}")
        self.invariant = invariant
        self.detail = detail


def check(cond: bool, invariant: str, detail: str) -> None:
    if not cond:
        raise Fail(invariant, detail)


# ---------------------------------------------------------------------------
# Actions (each returns a JSON-able result that becomes part of the trace)
# ---------------------------------------------------------------------------


def gen_box(rng: random.Random, legal: bool = True) -> list[float]:
    x0, y0 = rng.uniform(-50, 1900), rng.uniform(-50, 1000)
    w = rng.choice([0.0, rng.uniform(0, 5), rng.uniform(5, 400)])
    h = rng.choice([0.0, rng.uniform(0, 5), rng.uniform(5, 400)])
    box = [x0, y0, x0 + w, y0 + h]
    if not legal:
        i, j = rng.choice([(0, 2), (1, 3)])
        box[i], box[j] = box[j], box[i]
    return box


def act_plan_seek(rng: random.Random) -> dict:
    fps = rng.choice(FPS_CHOICES)
    start_time_ms = rng.choice([0.0, 33.367, 41.708, rng.uniform(0, 100)])
    mode = rng.choice(["random", "on_frame", "just_after_frame", "negative"])
    k = rng.randrange(0, 3000)
    if mode == "on_frame":
        start_ms = start_time_ms + k * 1000.0 / fps
    elif mode == "just_after_frame":
        start_ms = start_time_ms + k * 1000.0 / fps + rng.uniform(1e-4, 0.5)
    elif mode == "negative":
        start_ms = -rng.uniform(0, 500)
    else:
        start_ms = rng.uniform(0, 100000)
    first_index, seek_sec = plan_window_seek(start_ms, fps, start_time_ms)
    check(isinstance(first_index, int) and first_index >= 0, "P1", f"first_index={first_index!r}")
    check(finite(seek_sec) and seek_sec >= 0, "P1", f"seek_sec={seek_sec!r}")
    pts = start_time_ms + first_index * 1000.0 / fps
    check(pts >= start_ms - 1e-3, "P1", f"pts(first)={pts} < start={start_ms}")
    if first_index > 0:
        prev = start_time_ms + (first_index - 1) * 1000.0 / fps
        check(prev < start_ms + 1e-3, "P1", f"pts(first-1)={prev} >= start={start_ms} (skipped a frame)")
    gap = first_index / fps - seek_sec
    check(-EPS <= gap < 1e-3 + EPS, "P1", f"seek gap {gap}s not in [0, 1ms)")
    return {"fps": fps, "start_time_ms": start_time_ms, "start_ms": start_ms, "first_index": first_index, "seek_sec": seek_sec}


def act_box_iou(rng: random.Random) -> dict:
    legal = rng.random() < 0.85
    a, b = gen_box(rng, legal), gen_box(rng, legal or rng.random() < 0.5)
    if rng.random() < 0.1:
        b = list(a)
    ab, ba = box_iou(a, b), box_iou(b, a)
    check(finite(ab) and finite(ba), "P2", f"non-finite iou {ab!r}/{ba!r} for {a} {b}")
    check(abs(ab - ba) <= 1e-12, "P2", f"asymmetric {ab} vs {ba}")
    if legal:
        check(-EPS <= ab <= 1 + EPS, "P2", f"iou out of range {ab} for {a} {b}")
        ref = miner.iou(a, b)
        check(abs(ab - ref) <= 1e-9, "P2", f"box_iou {ab} != miner.iou {ref} for {a} {b}")
        area = (a[2] - a[0]) * (a[3] - a[1])
        if area > 0:
            check(abs(box_iou(a, a) - 1.0) <= 1e-12, "P2", f"self iou {box_iou(a, a)} for {a}")
    return {"a": a, "b": b, "legal": legal, "iou": ab}


def act_nms(rng: random.Random) -> dict:
    n = rng.randrange(0, 25)
    thr = rng.choice([0.55, rng.uniform(0.05, 0.95)])
    anchor = gen_box(rng)
    entries = []
    for i in range(n):
        if rng.random() < 0.5:
            jitter = [rng.uniform(-30, 30) for _ in range(4)]
            box = [anchor[j] + jitter[j] for j in range(4)]
            box = [min(box[0], box[2]), min(box[1], box[3]), max(box[0], box[2]), max(box[1], box[3])]
        else:
            box = gen_box(rng)
        entries.append({"box": box, "score": rng.choice([rng.random(), 0.5]), "id": i})
    kept = nms_union(entries, thr)
    ids = [e["id"] for e in kept]
    check(len(set(ids)) == len(ids) and set(ids) <= {e["id"] for e in entries}, "P3", f"kept {ids} not a subset of input")
    scores = [e["score"] for e in kept]
    check(scores == sorted(scores, reverse=True), "P3", f"kept not score-descending: {scores}")
    for i in range(len(kept)):
        for j in range(i + 1, len(kept)):
            v = box_iou(kept[i]["box"], kept[j]["box"])
            check(v < thr, "P3", f"kept pair {kept[i]['id']},{kept[j]['id']} iou {v} >= {thr}")
    if entries:
        best = max(e["score"] for e in entries)
        check(kept and kept[0]["score"] == best, "P3", "highest-score entry not kept first")
    again = nms_union(kept, thr)
    check([e["id"] for e in again] == ids, "P3", f"not idempotent: {ids} -> {[e['id'] for e in again]}")
    return {"n": n, "thr": thr, "kept": ids}


def act_heatmap_roundtrip(rng: random.Random) -> dict:
    h, w = rng.randrange(8, 2001), rng.randrange(8, 2001)
    size = rng.choice([sl.INPUT_SIZE, 64, 128, 512])
    scale = size / max(h, w)
    nh, nw = round(h * scale), round(w * scale)
    pad_x, pad_y = float((size - nw) // 2), float((size - nh) // 2)
    x, y = rng.uniform(-10, w + 10), rng.uniform(-10, h + 10)
    hx, hy = sl.px_to_heatmap(x, y, scale, pad_x, pad_y)
    bx, by = sl.heatmap_to_px(hx, hy, scale, pad_x, pad_y)
    check(all(finite(v) for v in (hx, hy, bx, by)), "P4", f"non-finite roundtrip {hx, hy, bx, by}")
    tol = 1e-6 * max(1.0, abs(x), abs(y))
    check(abs(bx - x) <= tol and abs(by - y) <= tol, "P4", f"roundtrip ({x},{y}) -> ({bx},{by})")
    return {"h": h, "w": w, "size": size, "x": x, "y": y, "hx": hx, "hy": hy}


def act_letterbox(rng: random.Random) -> dict:
    h, w = rng.randrange(1, 65), rng.randrange(1, 65)
    size = rng.choice([32, 64, 96])
    img = np.frombuffer(bytes(rng.getrandbits(8) for _ in range(h * w * 3)), dtype=np.uint8).reshape(h, w, 3)
    out, scale, pad_x, pad_y = sl.letterbox(img, size)
    check(out.shape == (3, size, size), "P4", f"letterbox shape {out.shape}")
    check(bool(np.isfinite(out).all()), "P4", "letterbox produced non-finite values")
    check(float(out.min()) >= 0.0 and float(out.max()) <= 1.0 + EPS, "P4", f"letterbox range [{out.min()}, {out.max()}]")
    exp_scale = size / max(h, w)
    nh, nw = round(h * exp_scale), round(w * exp_scale)
    check(abs(scale - exp_scale) <= 1e-12, "P4", f"scale {scale} != {exp_scale}")
    check(pad_x == float((size - nw) // 2) and pad_y == float((size - nh) // 2), "P4", f"pads {pad_x},{pad_y}")
    digest = hashlib.sha256(np.ascontiguousarray(out).tobytes()).hexdigest()[:16]
    return {"h": h, "w": w, "size": size, "scale": scale, "pad_x": pad_x, "pad_y": pad_y, "sha": digest}


def act_render_peaks(rng: random.Random) -> dict:
    n = rng.randrange(0, 6)
    mode = rng.choice(["random", "single_int"])
    if mode == "single_int":
        centers = [(float(rng.randrange(0, sl.HEATMAP_SIZE)), float(rng.randrange(0, sl.HEATMAP_SIZE)), 1.0)]
    else:
        centers = [
            (rng.uniform(-2, sl.HEATMAP_SIZE + 2), rng.uniform(-2, sl.HEATMAP_SIZE + 2), rng.uniform(0.3, 1.0))
            for _ in range(n)
        ]
    floor = rng.choice([0.3, 0.5, rng.uniform(0.05, 0.95)])
    max_peaks = rng.randrange(1, 9)
    hm = sl.render_target(centers)
    check(hm.shape == (sl.HEATMAP_SIZE, sl.HEATMAP_SIZE), "P5", f"heatmap shape {hm.shape}")
    check(bool(np.isfinite(hm).all()), "P5", "heatmap has non-finite values")
    max_w = max([c[2] for c in centers], default=0.0)
    check(float(hm.min()) >= 0.0 and float(hm.max()) <= max_w + 1e-6, "P5", f"heatmap range [{hm.min()}, {hm.max()}] max_w={max_w}")
    peaks = sl.heatmap_peaks(hm, floor, max_peaks)
    check(len(peaks) <= max_peaks, "P5", f"{len(peaks)} peaks > max_peaks {max_peaks}")
    scores = [p[2] for p in peaks]
    check(all(finite(s) and s >= floor for s in scores), "P5", f"peak scores {scores} below floor {floor}")
    check(scores == sorted(scores, reverse=True), "P5", f"peaks not descending {scores}")
    radius = int(2 * sl.GAUSSIAN_SIGMA_PX)
    for i in range(len(peaks)):
        for j in range(i + 1, len(peaks)):
            d = max(abs(peaks[i][0] - peaks[j][0]), abs(peaks[i][1] - peaks[j][1]))
            check(d > radius, "P5", f"peaks {peaks[i]} {peaks[j]} within suppression radius")
    if mode == "single_int" and floor <= 1.0:
        check(len(peaks) == 1 and (peaks[0][0], peaks[0][1]) == (centers[0][0], centers[0][1]), "P5", f"single center {centers[0]} -> peaks {peaks}")
    return {"mode": mode, "centers": centers, "floor": floor, "max_peaks": max_peaks, "peaks": peaks}


def _seg_intersect_ref(p1, p2, p3, p4) -> bool | None:
    """Parametric reference; None when the configuration is (near-)degenerate."""
    r = (p2[0] - p1[0], p2[1] - p1[1])
    s = (p4[0] - p3[0], p4[1] - p3[1])
    den = r[0] * s[1] - r[1] * s[0]
    if abs(den) < 1e-9:
        return None
    qp = (p3[0] - p1[0], p3[1] - p1[1])
    t = (qp[0] * s[1] - qp[1] * s[0]) / den
    u = (qp[0] * r[1] - qp[1] * r[0]) / den
    if min(abs(t), abs(t - 1), abs(u), abs(u - 1)) < 1e-9:
        return None
    return 0 < t < 1 and 0 < u < 1


def act_mining_geom(rng: random.Random) -> dict:
    pt = lambda: (rng.uniform(0, 1), rng.uniform(0, 1))  # noqa: E731
    a, b, c = pt(), pt(), pt()
    dab, dba, dbc, dac = miner.dist(a, b), miner.dist(b, a), miner.dist(b, c), miner.dist(a, c)
    check(all(finite(v) and v >= 0 for v in (dab, dbc, dac)), "P6", "dist non-finite or negative")
    check(dab == dba, "P6", f"dist asymmetric {dab} {dba}")
    check(dac <= dab + dbc + 1e-12, "P6", "triangle inequality violated")
    p1, p2, p3, p4 = pt(), pt(), pt(), pt()
    if rng.random() < 0.15:
        p3 = p1  # shared endpoint (near-legal)
    got = miner.seg_intersect(p1, p2, p3, p4)
    check(isinstance(got, bool), "P6", f"seg_intersect returned {got!r}")
    for alt in (
        miner.seg_intersect(p2, p1, p3, p4),
        miner.seg_intersect(p1, p2, p4, p3),
        miner.seg_intersect(p3, p4, p1, p2),
    ):
        check(alt == got, "P6", f"seg_intersect not swap-invariant for {p1, p2, p3, p4}")
    ref = _seg_intersect_ref(p1, p2, p3, p4)
    if ref is not None:
        check(ref == got, "P6", f"seg_intersect {got} != reference {ref} for {p1, p2, p3, p4}")
    return {"dist": dab, "segs": [p1, p2, p3, p4], "intersect": got}


def _actions() -> dict[str, Callable[[random.Random], dict]]:
    acts: dict[str, Callable[[random.Random], dict]] = {"mining_geom": act_mining_geom}
    if _HAVE_DETECT:
        acts.update({"plan_seek": act_plan_seek, "box_iou": act_box_iou, "nms": act_nms})
    if _HAVE_STUDENT:
        acts.update({"heatmap_roundtrip": act_heatmap_roundtrip, "letterbox": act_letterbox, "render_peaks": act_render_peaks})
    return acts


ACTIONS = _actions()


def run_sequence(seed: int, min_len: int = MIN_LEN, max_len: int = MAX_LEN) -> dict[str, Any]:
    rng = random.Random(seed)
    length = rng.randint(min_len, max_len)
    names = sorted(ACTIONS)
    trace: list[Any] = []
    failures: list[dict] = []
    for step in range(length):
        name = rng.choice(names)
        try:
            result = ACTIONS[name](rng)
            trace.append([name, _r(result)])
        except Fail as exc:
            failures.append({"step": step, "action": name, "invariant": exc.invariant, "detail": exc.detail})
            trace.append([name, "FAIL", exc.invariant, exc.detail])
        except Exception as exc:  # noqa: BLE001 - crashes are findings, not harness errors
            failures.append({"step": step, "action": name, "invariant": "CRASH", "detail": f"{type(exc).__name__}: {exc}"})
            trace.append([name, "CRASH", f"{type(exc).__name__}: {exc}"])
    digest = hashlib.sha256(json.dumps(trace, sort_keys=True, default=str).encode()).hexdigest()
    return {
        "seed": seed,
        "length": length,
        "trace_sha256": digest,
        "actions": sorted({t[0] for t in trace}),
        "outcome": "BROKEN" if failures else "HELD",
        "failures": failures,
    }


def run_campaign(base_seed: int, iterations: int) -> dict[str, Any]:
    table = []
    nondeterministic = []
    for i in range(iterations):
        seed = derive_seed(base_seed, i)
        first = run_sequence(seed)
        second = run_sequence(seed)
        if first["trace_sha256"] != second["trace_sha256"]:
            nondeterministic.append(seed)
            first["failures"].append({"step": -1, "action": "*", "invariant": "P8", "detail": "trace differs on replay"})
            first["outcome"] = "BROKEN"
        table.append({"index": i, **first})
    by_inv: dict[str, int] = {}
    for row in table:
        for f in row["failures"]:
            by_inv[f["invariant"]] = by_inv.get(f["invariant"], 0) + 1
    return {
        "base_seed": base_seed,
        "iterations": iterations,
        "min_len": MIN_LEN,
        "max_len": MAX_LEN,
        "actions_available": sorted(ACTIONS),
        "detect_paddle_importable": _HAVE_DETECT,
        "detect_paddle_import_error": _DETECT_IMPORT_ERROR,
        "student_lib_importable": _HAVE_STUDENT,
        "student_lib_import_error": _STUDENT_IMPORT_ERROR,
        "totals": {
            "sequences": len(table),
            "steps": sum(r["length"] for r in table),
            "failing_sequences": sum(1 for r in table if r["failures"]),
        },
        "failures_by_invariant": by_inv,
        "nondeterministic_seeds": nondeterministic,
        "seed_table": table,
    }


# ---------------------------------------------------------------------------
# P7: real ffmpeg windows over the committed CFR clips
# ---------------------------------------------------------------------------


def run_decode_window(seed: int) -> dict[str, Any]:
    rng = random.Random(seed)
    clip = rng.choice([c for c in CLIPS if c.exists()])
    width, height, fps, duration_ms, start_time_ms = ffprobe_meta(str(clip))
    frame_ms = 1000.0 / fps
    start_ms = rng.choice([0.0, rng.uniform(0, duration_ms - 5 * frame_ms), start_time_ms + rng.randrange(0, 50) * frame_ms])
    end_ms = min(duration_ms, start_ms + rng.uniform(2 * frame_ms, 12 * frame_ms))
    stride = rng.choice([1, 1, 2, 3])
    record: dict[str, Any] = {
        "seed": seed,
        "clip": clip.parent.name,
        "fps": fps,
        "start_time_ms": start_time_ms,
        "start_ms": start_ms,
        "end_ms": end_ms,
        "stride": stride,
    }
    failures: list[str] = []
    try:
        frames = list(frame_iter(str(clip), start_ms, end_ms, width, height, fps, stride=stride, start_time_ms=start_time_ms))
        first_index, _ = plan_window_seek(start_ms, fps, start_time_ms)
        record["frames"] = len(frames)
        record["first_index"] = first_index
        expected_first_pts = start_time_ms + first_index * frame_ms
        if not frames:
            failures.append(f"P7: no frames for window [{start_ms}, {end_ms}) on {clip.parent.name}")
        for k, (source_index, t_ms, rgb) in enumerate(frames):
            if source_index != k * stride:
                failures.append(f"P7: source_index {source_index} != {k * stride}")
            expected = expected_first_pts + source_index * frame_ms
            if not (finite(t_ms) and abs(t_ms - expected) <= 1e-6):
                failures.append(f"P7: tMs {t_ms} != CFR {expected} at k={k}")
            if rgb.shape != (height, width, 3):
                failures.append(f"P7: frame shape {rgb.shape}")
        if frames:
            t0 = frames[0][1]
            if not (start_ms - 1e-3 <= t0 < start_ms + frame_ms + 1e-3):
                failures.append(f"P7: first tMs {t0} is not the first frame >= start {start_ms}")
            ts = [f[1] for f in frames]
            if any(b <= a for a, b in zip(ts, ts[1:])):
                failures.append("P7: tMs not strictly increasing")
            record["last_t_ms"] = ts[-1]
            record["last_t_past_end"] = ts[-1] >= end_ms
            wanted = [first_index + f[0] for f in frames]
            direct = dict(decode_frames_at(str(clip), wanted, width, height, fps))
            for idx, (source_index, _t, rgb) in zip(wanted, frames):
                other = direct.get(idx)
                if other is None:
                    failures.append(f"P7: decode_frames_at missed index {idx}")
                elif hashlib.sha256(rgb.tobytes()).digest() != hashlib.sha256(other.tobytes()).digest():
                    failures.append(f"P7: frame {idx} differs between frame_iter and decode_frames_at")
        record["cfr_expected_frames"] = max(0, math.ceil(((end_ms - expected_first_pts) / frame_ms - 1e-9) / stride))
    except Exception as exc:  # noqa: BLE001
        failures.append(f"CRASH {type(exc).__name__}: {exc}")
    record["failures"] = failures[:8]
    record["outcome"] = "BROKEN" if failures else "HELD"
    return record


# ---------------------------------------------------------------------------
# unittest wrappers
# ---------------------------------------------------------------------------

_RESULTS: dict[str, Any] = {}


def _campaign() -> dict[str, Any]:
    if "campaign" not in _RESULTS:
        _RESULTS["campaign"] = run_campaign(BASE_SEED, ITER)
    return _RESULTS["campaign"]


def _write_results() -> None:
    if OUT_PATH:
        Path(OUT_PATH).parent.mkdir(parents=True, exist_ok=True)
        Path(OUT_PATH).write_text(json.dumps(_RESULTS, indent=1, sort_keys=True, default=str), encoding="utf-8")


class SeededPaddleLabSequences(unittest.TestCase):
    @classmethod
    def tearDownClass(cls) -> None:
        _write_results()

    def _failures(self, invariant: str) -> list[dict]:
        out = []
        for row in _campaign()["seed_table"]:
            for f in row["failures"]:
                if f["invariant"] == invariant:
                    out.append({"seed": row["seed"], **f})
        return out

    def test_campaign_ran_at_scale(self) -> None:
        c = _campaign()
        self.assertEqual(c["totals"]["sequences"], ITER)
        self.assertTrue(all(MIN_LEN <= r["length"] <= MAX_LEN for r in c["seed_table"]))
        self.assertIn("mining_geom", c["actions_available"])

    @unittest.skipUnless(_HAVE_DETECT, f"detect_paddle not importable: {_DETECT_IMPORT_ERROR}")
    def test_P1_plan_window_seek(self) -> None:
        self.assertEqual(self._failures("P1")[:3], [])

    @unittest.skipUnless(_HAVE_DETECT, f"detect_paddle not importable: {_DETECT_IMPORT_ERROR}")
    def test_P2_box_iou(self) -> None:
        self.assertEqual(self._failures("P2")[:3], [])

    @unittest.skipUnless(_HAVE_DETECT, f"detect_paddle not importable: {_DETECT_IMPORT_ERROR}")
    def test_P3_nms_union(self) -> None:
        self.assertEqual(self._failures("P3")[:3], [])

    @unittest.skipUnless(_HAVE_STUDENT, f"student_lib not importable: {_STUDENT_IMPORT_ERROR}")
    def test_P4_letterbox_and_heatmap_coords(self) -> None:
        self.assertEqual(self._failures("P4")[:3], [])

    @unittest.skipUnless(_HAVE_STUDENT, f"student_lib not importable: {_STUDENT_IMPORT_ERROR}")
    def test_P5_render_target_and_peaks(self) -> None:
        self.assertEqual(self._failures("P5")[:3], [])

    def test_P6_mining_geometry(self) -> None:
        self.assertEqual(self._failures("P6")[:3], [])

    def test_no_crashes(self) -> None:
        self.assertEqual(self._failures("CRASH")[:3], [])

    def test_P8_same_seed_same_trace(self) -> None:
        self.assertEqual(_campaign()["nondeterministic_seeds"], [])


@unittest.skipUnless(_HAVE_DETECT and all(c.exists() for c in CLIPS), "detect_paddle or committed clips unavailable")
class SeededDecodeWindows(unittest.TestCase):
    @classmethod
    def tearDownClass(cls) -> None:
        _write_results()

    def test_P7_frame_iter_windows(self) -> None:
        table = [run_decode_window(derive_seed(BASE_SEED ^ 0xDEC0DE, i)) for i in range(DECODE_ITER)]
        _RESULTS["decode_windows"] = {
            "executed": len(table),
            "broken": sum(1 for r in table if r["failures"]),
            "frames_vs_cfr_expected": [(r.get("frames"), r.get("cfr_expected_frames")) for r in table],
            "table": table,
        }
        broken = [r for r in table if r["failures"]]
        self.assertEqual(broken[:2], [])


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] != "-v":
        print(json.dumps(run_sequence(int(sys.argv[1], 0)), indent=1, default=str))
    else:
        unittest.main()
