"""Bench harness: paddle-student-v0 vs the committed D-FINE teacher (D4-06).

Protocol (mirrors EXP-2026-08-28-paddle-teacher): DETECTOR-ONLY on committed
HUMAN paddle labels (bundle annotation paddleFrames + otherPaddleFrames center
points, visible only); hit radius 0.08 normalized; +/-40ms frame-match
tolerance; a claim is any detection/peak at or above the operating floor. No
tracker, no ownership gating.

Scope: DEV cases with committed pixels only (afn-sasebo-rally1, wm-volley-02).
Held-out cases (wm-dink-01, afn-vic-rally1) are NEVER touched here.

Teacher accuracy comes from the COMMITTED dets artifacts (no re-inference, no
fabrication). Teacher latency in those artifacts is Mac/MPS and is NOT
comparable to this box; pass --measure-teacher-latency to measure D-FINE
ms/frame on this machine (reported as LINUX-CPU), otherwise teacher CPU
latency is reported as unmeasured.

Usage:
  .venv/bin/python student_bench.py \
      --weights ../../datasets/experiments/wave-d4/d4-06-student/student-paddle-v0.pt \
      [--measure-teacher-latency] [--out bench.json]
"""

from __future__ import annotations

import argparse
import json
import statistics
import time
from pathlib import Path

import numpy as np
import torch

from student_lib import (
    TEACHER_SCORE_FLOOR,
    StudentPaddleNet,
    extract_frames,
    heatmap_peaks,
    heatmap_to_px,
    letterbox,
    load_examples,
    video_meta,
)

HIT_RADIUS_NORM = 0.08
MATCH_TOLERANCE_MS = 40.0
STUDENT_PEAK_FLOOR = 0.30
BENCH_CASES = ("afn-sasebo-rally1", "wm-volley-02")
HELD_OUT = ("wm-dink-01", "afn-vic-rally1")


def load_labels(repo: Path, case_id: str) -> dict[float, list[dict]]:
    """tMs -> list of visible labeled paddle center points (normalized)."""
    labels: dict[float, list[dict]] = {}
    ann_dir = repo / "datasets/paddle-bench/bundles" / case_id / "annotation"
    for path in sorted(ann_dir.glob("devin-visual-*.json")):
        ann = json.loads(path.read_text())
        for key, who in (("paddleFrames", "target"), ("otherPaddleFrames", "other")):
            for fr in ann.get(key, []):
                if fr.get("visibility") != "visible" or not fr.get("point"):
                    continue
                pts = labels.setdefault(float(fr["tMs"]), [])
                p = fr["point"]
                if not any(
                    abs(q["x"] - p["x"]) < 1e-4 and abs(q["y"] - p["y"]) < 1e-4 for q in pts
                ):
                    pts.append({"x": p["x"], "y": p["y"], "who": who, "annotator": ann["annotatorId"]})
    return labels


def score_claims(
    claims: list[tuple[float, float]], gold: list[dict]
) -> tuple[int, int, int, list[float]]:
    """Returns (matchedGold, claimsMatched, claimsTotal, centerErrors)."""
    matched_gold = 0
    errors = []
    for g in gold:
        dists = [((cx - g["x"]) ** 2 + (cy - g["y"]) ** 2) ** 0.5 for cx, cy in claims]
        if dists and min(dists) <= HIT_RADIUS_NORM:
            matched_gold += 1
            errors.append(min(dists))
    claims_matched = 0
    for cx, cy in claims:
        if any(((cx - g["x"]) ** 2 + (cy - g["y"]) ** 2) ** 0.5 <= HIT_RADIUS_NORM for g in gold):
            claims_matched += 1
    return matched_gold, claims_matched, len(claims), errors


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo-root", default=str(Path(__file__).resolve().parents[2]))
    ap.add_argument("--weights", required=True)
    ap.add_argument("--measure-teacher-latency", action="store_true")
    ap.add_argument("--latency-frames", type=int, default=20)
    ap.add_argument("--out", default=None)
    args = ap.parse_args()
    repo = Path(args.repo_root).resolve()

    examples = load_examples(repo / "datasets/releases/paddle-distill-v0.1")
    teacher_by_case: dict[str, list[dict]] = {}
    for e in examples:
        if e["caseId"] in BENCH_CASES and e["teacher"] is not None:
            teacher_by_case.setdefault(e["caseId"], []).append(e)
    for case_id in HELD_OUT:
        assert case_id not in teacher_by_case or case_id not in BENCH_CASES

    model = StudentPaddleNet()
    model.load_state_dict(torch.load(args.weights, map_location="cpu"))
    model.eval()

    results = {}
    student_ms: list[float] = []
    for case_id in BENCH_CASES:
        labels = load_labels(repo, case_id)
        clip = repo / "datasets/paddle-bench/bundles" / case_id / "clip.mp4"
        w, h, _ = video_meta(clip)
        teacher_frames = teacher_by_case.get(case_id, [])

        # frame match: labeled tMs -> nearest teacher frame within tolerance
        rows = []
        for t_ms, gold in sorted(labels.items()):
            near = min(teacher_frames, key=lambda e: abs(e["tMs"] - t_ms), default=None)
            if near is None or abs(near["tMs"] - t_ms) > MATCH_TOLERANCE_MS:
                continue
            rows.append((t_ms, gold, near))

        frames = extract_frames(clip, [t for t, _, _ in rows])
        t_stats = {"matchedGold": 0, "goldTotal": 0, "claimsMatched": 0, "claimsTotal": 0, "errors": []}
        s_stats = {"matchedGold": 0, "goldTotal": 0, "claimsMatched": 0, "claimsTotal": 0, "errors": []}
        for t_ms, gold, teacher_ex in rows:
            img = frames.get(t_ms)
            if img is None:
                continue
            # teacher claims from the committed artifact
            t_claims = [
                (((d["box"][0] + d["box"][2]) / 2) / w, ((d["box"][1] + d["box"][3]) / 2) / h)
                for d in teacher_ex["teacher"]["detections"]
                if d["score"] >= TEACHER_SCORE_FLOOR
                and d["label"] in ("tennis racket", "baseball bat")
            ]
            # student claims
            inp, scale, pad_x, pad_y = letterbox(img)
            t0 = time.perf_counter()
            with torch.no_grad():
                hm = torch.sigmoid(model(torch.from_numpy(inp).float().unsqueeze(0)))[0].numpy()
            student_ms.append((time.perf_counter() - t0) * 1000)
            s_claims = []
            for hx, hy, _score in heatmap_peaks(hm, STUDENT_PEAK_FLOOR):
                px, py = heatmap_to_px(hx, hy, scale, pad_x, pad_y)
                s_claims.append((px / w, py / h))

            for stats, claims in ((t_stats, t_claims), (s_stats, s_claims)):
                mg, cm, ct, errs = score_claims(claims, gold)
                stats["matchedGold"] += mg
                stats["goldTotal"] += len(gold)
                stats["claimsMatched"] += cm
                stats["claimsTotal"] += ct
                stats["errors"].extend(errs)

        def summarize(s: dict) -> dict:
            return {
                "recall": round(s["matchedGold"] / s["goldTotal"], 3) if s["goldTotal"] else None,
                "precision": round(s["claimsMatched"] / s["claimsTotal"], 3) if s["claimsTotal"] else None,
                "hits": f"{s['matchedGold']}/{s['goldTotal']}",
                "claims": s["claimsTotal"],
                "medianCenterErrorNorm": round(statistics.median(s["errors"]), 4) if s["errors"] else None,
            }

        results[case_id] = {
            "labeledFramesScored": len(rows),
            "teacher_dfine_committed": summarize(t_stats),
            "student_v0": summarize(s_stats),
        }

    teacher_latency = {"msPerFrame": None, "note": "not measured on this box; committed artifacts' timing is Mac/MPS and not comparable"}
    if args.measure_teacher_latency:
        from transformers import AutoImageProcessor, AutoModelForObjectDetection
        from PIL import Image

        processor = AutoImageProcessor.from_pretrained("ustc-community/dfine-medium-coco")
        dfine = AutoModelForObjectDetection.from_pretrained("ustc-community/dfine-medium-coco")
        dfine.eval()
        clip = repo / "datasets/paddle-bench/bundles" / BENCH_CASES[0] / "clip.mp4"
        _, _, fps = video_meta(clip)
        t_list = [i * 1000.0 / fps for i in range(args.latency_frames)]
        frames = extract_frames(clip, t_list)
        times = []
        for img in frames.values():
            pil = Image.fromarray(img)
            t0 = time.perf_counter()
            with torch.no_grad():
                inputs = processor(images=pil, return_tensors="pt")
                dfine(**inputs)
            times.append((time.perf_counter() - t0) * 1000)
        teacher_latency = {
            "msPerFrame": round(statistics.median(times), 1),
            "framesTimed": len(times),
            "note": "LINUX-CPU, median, includes preprocessing",
        }

    report = {
        "harness": "tools/paddle-lab/student_bench.py",
        "protocol": {
            "hitRadiusNorm": HIT_RADIUS_NORM,
            "matchToleranceMs": MATCH_TOLERANCE_MS,
            "operatingFloors": {"teacher": TEACHER_SCORE_FLOOR, "student": STUDENT_PEAK_FLOOR},
            "labels": "committed bundle annotation paddleFrames + otherPaddleFrames (visible, deduped across annotators)",
            "teacherSource": "COMMITTED dets artifacts (no re-inference)",
        },
        "cases": results,
        "latencyLinuxCpu": {
            "studentMsPerFrame": round(statistics.median(student_ms), 2) if student_ms else None,
            "teacher": teacher_latency,
            "label": "LINUX-CPU (this box; NOT comparable to Mac/iPhone numbers)",
        },
        "honestFraming": "TINY-DATA groundwork bench: 2 dev cases only; held-out untouched. The student trained ONLY on afn-sasebo-rally1 teacher outputs, so the rally1 row is IN-DOMAIN (memorization, not generalization) and wm-volley-02 is the cross-session row. Teacher medianCenterErrorNorm ~0 partly reflects that waveC label points are recorded paddle-box centers.",
    }
    out = args.out or str(repo / "datasets/experiments/wave-d4/d4-06-student/bench.json")
    with open(out, "w") as f:
        json.dump(report, f, indent=2)
        f.write("\n")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
