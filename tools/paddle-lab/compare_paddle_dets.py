"""Equivalence differ for paddle-dets.json artifacts (W2 decode-path audits).

Compares two detector outputs frame-by-frame and reports whether they are
bit-equal, and if not, how far apart: per-frame count parity, greedy same-label
IoU matching, confidence deltas. Pass bar (W2): count parity on every frame,
zero unmatched boxes, min matched IoU >= --iou-floor (default 0.99).

Usage:
  .venv/bin/python compare_paddle_dets.py --a baseline.json --b candidate.json \
      [--out diff.json] [--iou-floor 0.99]

Exit code 0 when the pass bar is met, 1 otherwise (so it can gate scripts).
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


def iou(a: list[float], b: list[float]) -> float:
    ix0, iy0 = max(a[0], b[0]), max(a[1], b[1])
    ix1, iy1 = min(a[2], b[2]), min(a[3], b[3])
    inter = max(0.0, ix1 - ix0) * max(0.0, iy1 - iy0)
    area_a = max(0.0, a[2] - a[0]) * max(0.0, a[3] - a[1])
    area_b = max(0.0, b[2] - b[0]) * max(0.0, b[3] - b[1])
    union = area_a + area_b - inter
    return inter / union if union > 0 else (1.0 if area_a == area_b == 0 else 0.0)


def match_frame(dets_a: list[dict], dets_b: list[dict]):
    """Greedy same-label matching by descending IoU. Returns (pairs, unmatched_a, unmatched_b)."""
    candidates = []
    for i, da in enumerate(dets_a):
        for j, db in enumerate(dets_b):
            if da["label"] != db["label"]:
                continue
            candidates.append((iou(da["box"], db["box"]), i, j))
    candidates.sort(key=lambda t: -t[0])
    used_a: set[int] = set()
    used_b: set[int] = set()
    pairs = []
    for value, i, j in candidates:
        if i in used_a or j in used_b:
            continue
        used_a.add(i)
        used_b.add(j)
        pairs.append((value, i, j))
    unmatched_a = [i for i in range(len(dets_a)) if i not in used_a]
    unmatched_b = [j for j in range(len(dets_b)) if j not in used_b]
    return pairs, unmatched_a, unmatched_b


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--a", required=True, help="baseline paddle-dets.json")
    parser.add_argument("--b", required=True, help="candidate paddle-dets.json")
    parser.add_argument("--out", default=None, help="optional path for the JSON diff report")
    parser.add_argument("--iou-floor", type=float, default=0.99)
    args = parser.parse_args()

    a = json.loads(Path(args.a).read_text())
    b = json.loads(Path(args.b).read_text())

    report: dict = {
        "a": args.a,
        "b": args.b,
        "iouFloor": args.iou_floor,
        "framesA": len(a["frames"]),
        "framesB": len(b["frames"]),
        "bitEqualFrames": a["frames"] == b["frames"],
    }

    frame_count_match = len(a["frames"]) == len(b["frames"])
    tms_match = frame_count_match and all(
        fa["tMs"] == fb["tMs"] for fa, fb in zip(a["frames"], b["frames"])
    )
    report["tMsIdentical"] = tms_match

    stats = {
        "framesWithCountMismatch": 0,
        "totalA": 0,
        "totalB": 0,
        "matchedPairs": 0,
        "bitEqualPairs": 0,
        "unmatchedA": 0,
        "unmatchedB": 0,
        "minIoU": 1.0,
        "meanIoU": 1.0,
        "pairsBelowFloor": 0,
        "maxAbsScoreDelta": 0.0,
        "worstFrames": [],
    }
    if frame_count_match:
        iou_sum, worst = 0.0, []
        for fa, fb in zip(a["frames"], b["frames"]):
            for kind in ("detections", "extras"):
                da, db = fa[kind], fb[kind]
                stats["totalA"] += len(da)
                stats["totalB"] += len(db)
                if len(da) != len(db):
                    stats["framesWithCountMismatch"] += 1
                pairs, ua, ub = match_frame(da, db)
                stats["unmatchedA"] += len(ua)
                stats["unmatchedB"] += len(ub)
                for value, i, j in pairs:
                    stats["matchedPairs"] += 1
                    iou_sum += value
                    if da[i] == db[j]:
                        stats["bitEqualPairs"] += 1
                    stats["minIoU"] = min(stats["minIoU"], value)
                    if value < args.iou_floor:
                        stats["pairsBelowFloor"] += 1
                        worst.append({"tMs": fa["tMs"], "kind": kind, "iou": round(value, 4),
                                      "a": da[i], "b": db[j]})
                    delta = abs(da[i]["score"] - db[j]["score"])
                    stats["maxAbsScoreDelta"] = max(stats["maxAbsScoreDelta"], round(delta, 4))
        stats["meanIoU"] = round(iou_sum / stats["matchedPairs"], 6) if stats["matchedPairs"] else 1.0
        stats["minIoU"] = round(stats["minIoU"], 6)
        worst.sort(key=lambda w: w["iou"])
        stats["worstFrames"] = worst[:10]
    report["stats"] = stats

    passed = (
        frame_count_match
        and tms_match
        and stats["framesWithCountMismatch"] == 0
        and stats["unmatchedA"] == 0
        and stats["unmatchedB"] == 0
        and stats["minIoU"] >= args.iou_floor
    )
    report["pass"] = passed

    text = json.dumps(report, indent=1)
    if args.out:
        Path(args.out).write_text(text)
    summary = {k: report[k] for k in ("bitEqualFrames", "pass")}
    summary.update({k: stats[k] for k in ("matchedPairs", "bitEqualPairs", "unmatchedA",
                                          "unmatchedB", "minIoU", "meanIoU", "maxAbsScoreDelta",
                                          "framesWithCountMismatch")})
    print(json.dumps({"framesA": report["framesA"], "framesB": report["framesB"], **summary}))
    sys.exit(0 if passed else 1)


if __name__ == "__main__":
    main()
