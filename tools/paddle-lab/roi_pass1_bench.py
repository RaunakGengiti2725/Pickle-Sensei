"""D4-04 pass-1 target-ROI bench (Linux CPU, committed bundle clips).

Measures, per bundle clip, a full-frame stride-3 pass-1 sparse scan vs the
same scan cropped to the target's expected paddle zone:
  - detection agreement INSIDE the zone (the region pass-1 exists to cover:
    full-frame detections whose center lies inside the ROI, greedily matched
    to ROI-run detections by same-label IoU),
  - full-frame detections OUTSIDE the zone (suppressed by design — the
    sparse pass only needs the target's paddle; pass 2 stays full-frame),
  - wall-clock and inference time of both runs.

ZONE SOURCE, DISCLOSED: production (--pass1-roi, paddleRoi.ts) builds the
zone from the TARGET's wrist series; pose extraction is Apple-Vision-only, so
on this Linux box the zone is built from the committed human annotation's
paddleFrames points over the same window, padded identically (0.15 norm).
This measures the DETECTOR under an ROI of realistic size/placement; the
wrist-driven plan itself is unit-tested in paddleRoi.test.ts.

All numbers this script emits are LINUX-CPU. Downstream cascade validation
of the flag is Mac-gated (canonical run dirs + pose are absent here).

Usage:
  .venv/bin/python roi_pass1_bench.py --cases wm-volley-02 afn-sasebo-rally2 \
      [--stride 3] [--pad 0.15] [--iou 0.5] --out bench.json
"""

from __future__ import annotations

import argparse
import json
import tempfile
import time
from pathlib import Path

import numpy as np
import torch
from PIL import Image

from detect_paddle import box_iou, ffprobe_meta, load_model, run_window

REPO_ROOT = Path(__file__).resolve().parents[2]
BUNDLES = REPO_ROOT / "datasets" / "paddle-bench" / "bundles"
WINDOW_HALF_MS = 1500.0
PAD_NORM = 0.15


def zone_from_annotation(case: str, window: tuple[float, float], pad: float):
    annotation_path = BUNDLES / case / "annotation" / "devin-visual-v1.json"
    annotation = json.loads(annotation_path.read_text())
    points = [
        frame["point"]
        for frame in annotation.get("paddleFrames", [])
        if frame.get("point") and window[0] <= frame["tMs"] <= window[1]
    ]
    if not points:
        return None, annotation
    x_values = [point["x"] for point in points]
    y_values = [point["y"] for point in points]
    roi = [
        max(0.0, min(x_values) - pad),
        max(0.0, min(y_values) - pad),
        min(1.0, max(x_values) + pad),
        min(1.0, max(y_values) + pad),
    ]
    return [round(value, 4) for value in roi], annotation


def center_in_roi(box: list[float], roi: list[float], width: int, height: int) -> bool:
    cx = (box[0] + box[2]) / 2 / width
    cy = (box[1] + box[3]) / 2 / height
    return roi[0] <= cx <= roi[2] and roi[1] <= cy <= roi[3]


HIGH_SCORE = 0.3  # tracker-establishing boxes; below sits the 0.08-floor tail


def match_frames(full_frames, roi_frames, roi, width, height, iou_floor):
    by_t = {frame["tMs"]: frame for frame in roi_frames}
    stats = {
        "framesCompared": 0,
        "fullInsideRoi": 0,
        "fullOutsideRoi": 0,
        "matched": 0,
        "unmatchedFullInsideRoi": 0,
        "highScoreInsideRoi": 0,
        "highScoreMatched": 0,
        "roiOnly": 0,
        "iouSum": 0.0,
        "scoreDeltaSum": 0.0,
        "worst": [],
    }
    for full in full_frames:
        roi_frame = by_t.get(full["tMs"])
        if roi_frame is None:
            continue
        stats["framesCompared"] += 1
        inside = [d for d in full["detections"] if center_in_roi(d["box"], roi, width, height)]
        stats["fullOutsideRoi"] += len(full["detections"]) - len(inside)
        stats["fullInsideRoi"] += len(inside)
        candidates = []
        for i, det_a in enumerate(inside):
            for j, det_b in enumerate(roi_frame["detections"]):
                if det_a["label"] != det_b["label"]:
                    continue
                candidates.append((box_iou(det_a["box"], det_b["box"]), i, j))
        candidates.sort(key=lambda item: -item[0])
        used_a: set[int] = set()
        used_b: set[int] = set()
        for value, i, j in candidates:
            if value < iou_floor or i in used_a or j in used_b:
                continue
            used_a.add(i)
            used_b.add(j)
            stats["matched"] += 1
            if inside[i]["score"] >= HIGH_SCORE:
                stats["highScoreMatched"] += 1
            stats["iouSum"] += value
            stats["scoreDeltaSum"] += abs(inside[i]["score"] - roi_frame["detections"][j]["score"])
        stats["highScoreInsideRoi"] += sum(
            1 for d in inside if d["score"] >= HIGH_SCORE
        )
        unmatched = len(inside) - len(used_a)
        stats["unmatchedFullInsideRoi"] += unmatched
        stats["roiOnly"] += len(roi_frame["detections"]) - len(used_b)
        if unmatched:
            stats["worst"].append({"tMs": full["tMs"], "unmatchedInsideRoi": unmatched})
    stats["worst"] = stats["worst"][:10]
    return stats


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--cases", nargs="+", required=True)
    parser.add_argument("--stride", type=int, default=3)
    parser.add_argument("--pad", type=float, default=PAD_NORM)
    parser.add_argument("--iou", type=float, default=0.5)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()

    processor, model, load_sec = load_model()
    # Warm up torch/CPU caches so fullFrame-vs-roi timing isn't a cold-start
    # artifact (first inference of a process is several times slower).
    warm = Image.fromarray(np.zeros((720, 1280, 3), dtype=np.uint8))
    for _ in range(2):
        with torch.no_grad():
            model(**processor(images=warm, return_tensors="pt"))

    report = {
        "bench": "d4-04-pass1-roi",
        "measurementEnv": "LINUX-CPU",
        "zoneSource": "annotation paddleFrames points (pose absent on Linux; disclosed proxy for the wrist-driven production plan)",
        "stride": args.stride,
        "padNorm": args.pad,
        "iouFloor": args.iou,
        "modelLoadSec": round(load_sec, 3),
        "processorInputSize": "fixed 640x640 (do_resize=True) — ROI cropping does not shrink model compute, only decode/preprocess",
        "cases": [],
    }
    for case in args.cases:
        video = str(BUNDLES / case / "clip.mp4")
        width, height, fps, duration_ms, _ = ffprobe_meta(video)
        _, annotation = zone_from_annotation(case, (0, duration_ms), args.pad)
        contact_ms = annotation["phases"]["contactMs"]
        window = (
            max(0.0, contact_ms - WINDOW_HALF_MS),
            min(duration_ms, contact_ms + WINDOW_HALF_MS),
        )
        roi, _ = zone_from_annotation(case, window, args.pad)
        entry: dict = {
            "case": case,
            "window": {"startMs": window[0], "endMs": window[1]},
            "roiNorm": roi,
        }
        if roi is None:
            entry["skipped"] = "no annotated paddle points inside the window"
            report["cases"].append(entry)
            continue
        entry["roiAreaFraction"] = round((roi[2] - roi[0]) * (roi[3] - roi[1]), 4)
        with tempfile.TemporaryDirectory() as tmp:
            runs = {}
            for name, roi_arg in (("fullFrame", None), ("roi", roi)):
                out_path = Path(tmp) / f"{case}-{name}.json"
                started = time.perf_counter()
                payload = run_window(
                    processor,
                    model,
                    video=video,
                    out=str(out_path),
                    start_ms=window[0],
                    end_ms=window[1],
                    stride=args.stride,
                    roi=roi_arg,
                )
                runs[name] = {
                    "payload": payload,
                    "wallSec": round(time.perf_counter() - started, 3),
                }
            full = runs["fullFrame"]["payload"]
            cropped = runs["roi"]["payload"]
            stats = match_frames(
                full["frames"], cropped["frames"], roi, width, height, args.iou
            )
            matched = max(1, stats["matched"])
            entry["agreementInsideRoi"] = {
                **{k: v for k, v in stats.items() if k not in ("iouSum", "scoreDeltaSum")},
                "matchRate": round(stats["matched"] / max(1, stats["fullInsideRoi"]), 4),
                "highScoreMatchRate": round(
                    stats["highScoreMatched"] / max(1, stats["highScoreInsideRoi"]), 4
                ),
                "meanIoU": round(stats["iouSum"] / matched, 4),
                "meanAbsScoreDelta": round(stats["scoreDeltaSum"] / matched, 4),
            }
            entry["timing"] = {
                name: {
                    "framesProcessed": run["payload"]["timing"]["framesProcessed"],
                    "inferenceSecTotal": run["payload"]["timing"]["inferenceSecTotal"],
                    "wallSecTotal": run["payload"]["timing"]["wallSecTotal"],
                    "requestWallSec": run["wallSec"],
                }
                for name, run in runs.items()
            }
            entry["wallClockSavedSec"] = round(
                runs["fullFrame"]["wallSec"] - runs["roi"]["wallSec"], 3
            )
        report["cases"].append(entry)
        print(json.dumps({k: entry[k] for k in ("case", "roiNorm", "wallClockSavedSec")}))
    Path(args.out).write_text(json.dumps(report, indent=2))
    print(f"-> {args.out}")


if __name__ == "__main__":
    main()
