#!/usr/bin/env python3
"""Diff two attack-pass3 S27 dumps (macOS vs iOS Simulator, or run vs run).

Consumes the JSON reports written by
native/vision-core/Tests/AttackPass3ApplePoseProviderTests.swift
(`testS27_dumpPerFrameLandmarksForCrossPlatformDiff`) and reports, per frame,
the maximum landmark coordinate / visibility delta, the set of frames where one
platform detected a person and the other did not, and whether both dumps carry
the same `modelVersion`. Landmarks are matched by name, never by position.

Exit codes:
  0  both dumps report the same modelVersion and were comparable
  1  modelVersion differs, or a dump is missing the S27 record
  2  usage error

Usage:
  compare_s27.py <macos-report.json> <ios-simulator-report.json> [--out diff.json]
  compare_s27.py --swing-lab <pose-a.json> <pose-b.json> [--out diff.json]
    (swing-lab pose.json from two mac-full-verify runs; same frame schema)
"""
from __future__ import annotations

import argparse
import json
import sys
from typing import Any

S27_TEST = "testS27_dumpPerFrameLandmarksForCrossPlatformDiff"


def load_s27_record(path: str) -> dict[str, Any]:
    with open(path, encoding="utf-8") as handle:
        report = json.load(handle)
    for record in report.get("records", []):
        if record.get("test") == S27_TEST:
            return normalize_s27_record(record, report.get("platform"))
    raise SystemExit(f"{path}: no {S27_TEST} record")


def normalize_s27_record(record: dict[str, Any], platform: str | None) -> dict[str, Any]:
    """The Swift dump writes AttackPass3.serialize frames ({t, c, l:[{n,x,y,v}]},
    plus {i, t, miss} for frames without a person). Flatten to the schema diff()
    reads: frames[{index, t, confidence, landmarks[{name,x,y,visibility}]}] and
    misses[{t, error}]."""
    frames = []
    misses = []
    for frame in record.get("frames", []):
        if "miss" in frame:
            misses.append({"index": frame.get("i"), "t": frame["t"], "error": frame["miss"]})
            continue
        frames.append({
            "index": frame.get("i"),
            "t": frame["t"],
            "confidence": frame["c"],
            "landmarks": [{"name": l["n"], "x": l["x"], "y": l["y"], "visibility": l["v"]} for l in frame["l"]],
        })
    return {
        "platform": record.get("platform") or platform,
        "osVersion": record.get("osVersion"),
        "modelVersion": record.get("modelVersion"),
        "frames": frames,
        "misses": misses,
    }


def load_swing_lab(path: str) -> dict[str, Any]:
    with open(path, encoding="utf-8") as handle:
        pose = json.load(handle)
    frames = []
    for frame in pose["frames"]:
        frames.append({
            "index": frame["i"],
            "t": frame["t"],
            "confidence": frame["c"],
            "landmarks": [{"name": l["n"], "x": l["x"], "y": l["y"], "visibility": l["v"]} for l in frame["l"]],
        })
    return {
        "platform": "macos(swing-lab)",
        "modelVersion": pose.get("poseModelVersion"),
        "frames": frames,
        "misses": [],
    }


def index_frames(record: dict[str, Any]) -> dict[int, dict[str, Any]]:
    out: dict[int, dict[str, Any]] = {}
    for frame in record.get("frames", []):
        out[int(frame["t"])] = frame
    return out


def diff(a: dict[str, Any], b: dict[str, Any]) -> dict[str, Any]:
    frames_a = index_frames(a)
    frames_b = index_frames(b)
    misses_a = {int(m["t"]) for m in a.get("misses", [])}
    misses_b = {int(m["t"]) for m in b.get("misses", [])}
    common = sorted(set(frames_a) & set(frames_b))
    per_frame = []
    max_coord = 0.0
    max_vis = 0.0
    max_conf = 0.0
    differing = 0
    landmark_set_mismatch = 0
    for t in common:
        fa, fb = frames_a[t], frames_b[t]
        by_name = {l["name"]: l for l in fb["landmarks"]}
        coord = vis = 0.0
        names_match = len(fa["landmarks"]) == len(fb["landmarks"])
        for landmark in fa["landmarks"]:
            other = by_name.get(landmark["name"])
            if other is None:
                names_match = False
                continue
            coord = max(coord, abs(landmark["x"] - other["x"]), abs(landmark["y"] - other["y"]))
            vis = max(vis, abs(landmark["visibility"] - other["visibility"]))
        conf = abs(fa["confidence"] - fb["confidence"])
        if not names_match:
            landmark_set_mismatch += 1
        if coord > 0 or vis > 0 or conf > 0 or not names_match:
            differing += 1
        max_coord = max(max_coord, coord)
        max_vis = max(max_vis, vis)
        max_conf = max(max_conf, conf)
        per_frame.append({
            "t": t,
            "maxCoordDelta": coord,
            "maxVisibilityDelta": vis,
            "confidenceDelta": conf,
            "landmarkSetMatch": names_match,
        })
    only_a = sorted(set(frames_a) - set(frames_b))
    only_b = sorted(set(frames_b) - set(frames_a))
    return {
        "platformA": a.get("platform"),
        "platformB": b.get("platform"),
        "osVersionA": a.get("osVersion"),
        "osVersionB": b.get("osVersion"),
        "modelVersionA": a.get("modelVersion"),
        "modelVersionB": b.get("modelVersion"),
        "modelVersionsEqual": a.get("modelVersion") == b.get("modelVersion"),
        "framesA": len(frames_a),
        "framesB": len(frames_b),
        "commonFrames": len(common),
        "detectedOnlyInA": only_a,
        "detectedOnlyInB": only_b,
        "missesOnlyInA": sorted(misses_a - misses_b),
        "missesOnlyInB": sorted(misses_b - misses_a),
        "differingFrames": differing,
        "landmarkSetMismatches": landmark_set_mismatch,
        "maxCoordDelta": max_coord,
        "maxVisibilityDelta": max_vis,
        "maxConfidenceDelta": max_conf,
        "bitIdentical": differing == 0 and not only_a and not only_b,
        "perFrame": per_frame,
    }


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("a")
    parser.add_argument("b")
    parser.add_argument("--swing-lab", action="store_true", help="inputs are swing-lab pose.json files")
    parser.add_argument("--out", help="write the full diff (with perFrame) here")
    args = parser.parse_args(argv)
    try:
        if args.swing_lab:
            a, b = load_swing_lab(args.a), load_swing_lab(args.b)
        else:
            a, b = load_s27_record(args.a), load_s27_record(args.b)
    except (OSError, KeyError, ValueError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    result = diff(a, b)
    if args.out:
        with open(args.out, "w", encoding="utf-8") as handle:
            json.dump(result, handle, indent=2, sort_keys=True)
    summary = {k: v for k, v in result.items() if k != "perFrame"}
    print(json.dumps(summary, indent=2, sort_keys=True))
    return 0 if result["modelVersionsEqual"] else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
