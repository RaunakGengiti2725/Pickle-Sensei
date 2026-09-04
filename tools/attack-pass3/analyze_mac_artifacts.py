#!/usr/bin/env python3
"""Linux-side proxy checks over an existing mac-full-verify artifact bundle.

The swing-lab `extract` stage of scripts/mac-full-verify.sh already runs the
committed clip through BOTH ApplePoseProvider paths on the Apple runner:
`extractPose` (temporal anchor active) → pose.json, and `extractAllPoses`
(largest torso first) → people.json, on the same upright frames. This script
diffs them offline so S24 (extractPose vs extractAllPoses top person) has real
Apple truth without triggering a new Mac run, and records the other proxies
the pass-3 scenarios need from the artifact (modelVersion, zero-visibility
sentinel landmarks, low-torso frames, xcodebuild test totals per platform).

Nothing here executes Vision; every number comes from the artifact directory.

Usage:
  analyze_mac_artifacts.py <artifact-dir> [--out report.json]
    <artifact-dir> is the directory `gh run download <id>` produced
    (contains swing-lab-extract/ and vision-core-xcodebuild-*.log).

Exit codes: 0 all proxy assertions held, 1 an assertion failed, 2 usage.
"""
from __future__ import annotations

import argparse
import collections
import json
import os
import re
import sys
from typing import Any

TORSO = ("left_shoulder", "right_shoulder", "left_hip", "right_hip")
EXPECTED_MODEL_VERSION = "apple-vision-bodypose-1"
EXECUTED_RE = re.compile(r"Executed (\d+) tests?, with (\d+) failures? \((\d+) unexpected\)")


def landmark_key(landmarks: list[dict[str, Any]]) -> tuple:
    return tuple(sorted((l["n"], l["x"], l["y"], l["v"]) for l in landmarks))


def analyze_swing_lab(directory: str) -> dict[str, Any]:
    with open(os.path.join(directory, "pose.json"), encoding="utf-8") as handle:
        pose = json.load(handle)
    with open(os.path.join(directory, "people.json"), encoding="utf-8") as handle:
        people = json.load(handle)
    with open(os.path.join(directory, "extract-meta.json"), encoding="utf-8") as handle:
        meta = json.load(handle)

    people_by_t = {frame["t"]: frame["p"] for frame in people["frames"]}
    identical = matches_other = matches_nobody = no_people_entry = 0
    anchor_kept_smaller: list[dict[str, Any]] = []
    max_coord = 0.0
    for frame in pose["frames"]:
        entry = people_by_t.get(frame["t"])
        if entry is None:
            no_people_entry += 1
            continue
        key = landmark_key(frame["l"])
        if landmark_key(entry[0]["l"]) == key:
            identical += 1
            continue
        rank = next((i for i, person in enumerate(entry) if landmark_key(person["l"]) == key), None)
        if rank is None:
            matches_nobody += 1
            by_name = {l["n"]: l for l in entry[0]["l"]}
            for l in frame["l"]:
                other = by_name.get(l["n"])
                if other:
                    max_coord = max(max_coord, abs(l["x"] - other["x"]), abs(l["y"] - other["y"]))
        else:
            matches_other += 1
            anchor_kept_smaller.append({"t": frame["t"], "i": frame["i"], "rankInPeople": rank, "peopleCount": len(entry)})

    zero_vis = collections.Counter()
    zero_vis_per_frame = collections.Counter()
    torso_below_02: list[int] = []
    landmark_counts = collections.Counter()
    for frame in pose["frames"]:
        zeros = 0
        for l in frame["l"]:
            if l["v"] == 0:
                zero_vis[(l["x"], l["y"])] += 1
                zeros += 1
        zero_vis_per_frame[zeros] += 1
        landmark_counts[len(frame["l"])] += 1
        if any(l["v"] < 0.2 for l in frame["l"] if l["n"] in TORSO):
            torso_below_02.append(frame["i"])

    people_counts = collections.Counter(len(frame["p"]) for frame in people["frames"])
    return {
        "meta": meta,
        "poseModelVersion": pose.get("poseModelVersion"),
        "peopleModelVersion": people.get("poseModelVersion"),
        "coordinateSystem": pose.get("coordinateSystem"),
        "s24": {
            "poseFrames": len(pose["frames"]),
            "peopleFrames": len(people["frames"]),
            "identicalToLargestTorso": identical,
            "matchesAnotherDetectedPerson_anchorHysteresis": matches_other,
            "matchesNobody": matches_nobody,
            "noPeopleEntry": no_people_entry,
            "maxCoordDeltaWhenMatchingNobody": max_coord,
            "anchorKeptNonLargestExamples": anchor_kept_smaller[:20],
        },
        "zeroVisibilitySentinels": {
            "total": sum(zero_vis.values()),
            "byCoordinate": [{"xy": list(k), "count": v} for k, v in zero_vis.most_common(5)],
            "framesByZeroCount": {str(k): v for k, v in sorted(zero_vis_per_frame.items())},
        },
        "landmarkCountsPerFrame": {str(k): v for k, v in sorted(landmark_counts.items())},
        "framesWithTorsoJointBelow0_2": len(torso_below_02),
        "framesWithTorsoJointBelow0_2Examples": torso_below_02[:20],
        "peopleCountHistogram": {str(k): v for k, v in sorted(people_counts.items())},
    }


def xcodebuild_totals(path: str) -> dict[str, Any] | None:
    if not os.path.exists(path):
        return None
    last = None
    with open(path, encoding="utf-8", errors="replace") as handle:
        for line in handle:
            match = EXECUTED_RE.search(line)
            if match:
                last = {"executed": int(match.group(1)), "failures": int(match.group(2)), "unexpected": int(match.group(3))}
    return last


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("artifact_dir")
    parser.add_argument("--out")
    args = parser.parse_args(argv)
    swing = os.path.join(args.artifact_dir, "swing-lab-extract")
    if not os.path.isdir(swing):
        print(f"error: {swing} missing", file=sys.stderr)
        return 2
    try:
        report: dict[str, Any] = {"artifactDir": os.path.abspath(args.artifact_dir), "swingLab": analyze_swing_lab(swing)}
    except (OSError, KeyError, ValueError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 2
    report["xcodebuild"] = {
        "macos": xcodebuild_totals(os.path.join(args.artifact_dir, "vision-core-xcodebuild-macos.log")),
        "iosSimulator": xcodebuild_totals(os.path.join(args.artifact_dir, "vision-core-xcodebuild-ios.log")),
    }
    summary_path = os.path.join(args.artifact_dir, "summary.json")
    if os.path.exists(summary_path):
        with open(summary_path, encoding="utf-8") as handle:
            report["summary"] = json.load(handle)

    s24 = report["swingLab"]["s24"]
    assertions = {
        "modelVersionIsExpected": report["swingLab"]["poseModelVersion"] == EXPECTED_MODEL_VERSION
        and report["swingLab"]["peopleModelVersion"] == EXPECTED_MODEL_VERSION,
        "s24_extractPoseAlwaysReturnsAnExtractAllPosesPerson": s24["matchesNobody"] == 0 and s24["noPeopleEntry"] == 0,
        "s24_uprightClipHasNoOrientationDivergence": s24["maxCoordDeltaWhenMatchingNobody"] == 0.0,
        "everyPoseFrameHas13Landmarks": set(report["swingLab"]["landmarkCountsPerFrame"]) == {"13"},
        "noFrameHasAllLandmarksZeroVisibility": "13" not in report["swingLab"]["zeroVisibilitySentinels"]["framesByZeroCount"],
        "xcodebuildMacosGreen": (report["xcodebuild"]["macos"] or {}).get("failures") == 0,
        "xcodebuildIosSimulatorGreen": (report["xcodebuild"]["iosSimulator"] or {}).get("failures") == 0,
    }
    report["assertions"] = assertions
    report["allHeld"] = all(assertions.values())
    if args.out:
        with open(args.out, "w", encoding="utf-8") as handle:
            json.dump(report, handle, indent=2, sort_keys=True)
    printable = dict(report)
    printable["swingLab"] = {k: v for k, v in report["swingLab"].items() if k != "meta"}
    printable.pop("summary", None)
    print(json.dumps(printable, indent=2, sort_keys=True))
    return 0 if report["allHeld"] else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
