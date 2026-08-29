"""ROI x KEYFRAME grid for the paddle detector (quality x latency frontier).

Runs detect_paddle.py over dev bench cases for every (stride, roi) cell and
scores S0-level detection against GOLD paddle labels:

  hit = any detection center within 0.05 (normalized) of a visible target
        paddle label at that labeled frame (nearest detector frame <= 1/2
        stride interval away; labels with no detector frame in reach count
        as MISSED for that cell -- keyframing must pay for what it skips).

Latency facts recorded per cell: detector invocations, measured ms/frame,
wall seconds. D-FINE runs at a fixed input size, so ROI changes QUALITY
(object scale, background suppression), stride changes LATENCY.

Downstream (tracking/contact/stroke) is NOT evaluated per cell here; the
chosen operating point must be validated through the full pipeline before
promotion. This grid only buys the shortlist.

Usage: .venv/bin/python roi_keyframe_grid.py --out grid.json
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PB = ROOT / "datasets/paddle-bench"
VENV = Path(__file__).resolve().parent / ".venv/bin/python"

# Dev cases only (held-out never enters a tuning grid).
CASES = [
    {
        "id": "wm-volley-02",
        "video": PB / "videos/wm-volley-nearplayer.mp4",
        "labels": PB / "bundles/wm-volley-02/annotation/devin-visual-v1.json",
        # event-gated span used by the shipped pipeline (report.detectSpan)
        "span": (5000, 7400),
    },
    {
        "id": "afn-sasebo-rally1",
        "video": PB / "videos/afn-sasebo-rally1.mp4",
        "labels": PB / "bundles/afn-sasebo-rally1/annotation/devin-visual-v1.json",
        "span": (0, 4121),
    },
]


def target_roi(case_id: str, span: tuple[float, float]) -> list[float]:
    """Static target ROI: union of the target track's torso positions over the
    span, padded by a reach margin (2.6x torso span each side)."""
    people = json.loads((PB / f"runs/{case_id}/people.json").read_text())
    xs: list[float] = []
    ys: list[float] = []
    spans: list[float] = []
    for frame in people["frames"]:
        if not (span[0] <= frame["t"] <= span[1]):
            continue
        best = None
        best_span = 0.0
        for person in frame["p"]:
            joints = {j["n"]: (j["x"], j["y"]) for j in person["l"] if j["v"] >= 0.2}
            keys = [k for k in ("left_shoulder", "right_shoulder", "left_hip", "right_hip") if k in joints]
            if len(keys) < 3:
                continue
            cx = sum(joints[k][0] for k in keys) / len(keys)
            cy = sum(joints[k][1] for k in keys) / len(keys)
            tspan = abs(joints[keys[0]][1] - joints[keys[-1]][1]) or 0.05
            if tspan > best_span:
                best_span, best = tspan, (cx, cy)
        if best:
            xs.append(best[0])
            ys.append(best[1])
            spans.append(best_span)
    if not xs:
        return [0.0, 0.0, 1.0, 1.0]
    margin = 2.6 * (sum(spans) / len(spans))
    return [
        max(0.0, min(xs) - margin),
        max(0.0, min(ys) - margin * 1.2),
        min(1.0, max(xs) + margin),
        min(1.0, max(ys) + margin * 1.2),
    ]


def score_cell(dets_path: Path, labels_path: Path, stride: int, fps: float) -> dict:
    dets = json.loads(dets_path.read_text())
    width, height = dets["video"]["width"], dets["video"]["height"]
    frames = dets["frames"]
    labels = json.loads(labels_path.read_text())
    visible = [f for f in labels.get("paddleFrames", []) if f["visibility"] == "visible"]
    reach_ms = (stride / fps) * 1000 / 2 + 1
    hits = 0
    reachable = 0
    for label in visible:
        nearest = min(frames, key=lambda fr: abs(fr["tMs"] - label["tMs"]), default=None)
        if nearest is None or abs(nearest["tMs"] - label["tMs"]) > reach_ms:
            continue  # counted as miss below (no detector frame near the label)
        reachable += 1
        for det in nearest["detections"]:
            cx = (det["box"][0] + det["box"][2]) / 2 / width
            cy = (det["box"][1] + det["box"][3]) / 2 / height
            if ((cx - label["point"]["x"]) ** 2 + (cy - label["point"]["y"]) ** 2) ** 0.5 <= 0.05:
                hits += 1
                break
    timing = dets["timing"]
    return {
        "labeledVisible": len(visible),
        "labelsWithDetectorFrame": reachable,
        "hits": hits,
        "recallVsAllLabels": round(hits / len(visible), 3) if visible else None,
        "invocations": timing["framesProcessed"],
        "msPerFrame": timing["inferenceMsPerFrame"],
        "inferenceSec": timing["inferenceSecTotal"],
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    grid = []
    for case in CASES:
        fps = 25.0 if "wm-" in case["id"] else 29.97
        rois = {"full": None, "target": target_roi(case["id"], case["span"])}
        for stride in (1, 2, 3, 4):
            for roi_name, roi in rois.items():
                out = Path(f"/tmp/roi-grid/{case['id']}-s{stride}-{roi_name}.json")
                out.parent.mkdir(parents=True, exist_ok=True)
                cmd = [
                    str(VENV), str(Path(__file__).resolve().parent / "detect_paddle.py"),
                    "--video", str(case["video"]), "--out", str(out),
                    "--start-ms", str(case["span"][0]), "--end-ms", str(case["span"][1]),
                    "--stride", str(stride),
                ]
                if roi:
                    cmd += ["--roi", ",".join(f"{v:.3f}" for v in roi)]
                started = time.perf_counter()
                subprocess.run(cmd, check=True, capture_output=True)
                wall = time.perf_counter() - started
                cell = score_cell(out, case["labels"], stride, fps)
                cell.update({"case": case["id"], "stride": stride, "roi": roi_name,
                             "roiNorm": roi, "wallSecInclLoad": round(wall, 1)})
                grid.append(cell)
                print(f"{case['id']} stride={stride} roi={roi_name}: "
                      f"recall {cell['recallVsAllLabels']} · {cell['invocations']} inv · "
                      f"{cell['msPerFrame']}ms/f · {cell['inferenceSec']}s", flush=True)
    Path(args.out).write_text(json.dumps({"grid": grid}, indent=2))
    print(f"written: {args.out}")


if __name__ == "__main__":
    sys.exit(main())
