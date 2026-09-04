#!/usr/bin/env python3
"""Compare Apple Vision (Mac runner truth) vs Linux replay proxy pose artifacts.

Both inputs are `swing-lab extract` style directories holding
`pose.json` (pickle.pose-sequence.v1), `people.json` and `extract-meta.json`.
The Apple directory is the `swing-lab-extract/` folder from a
`mac-full-verify` GitHub Actions artifact; the Linux directory is produced by
`tools/latency-bench/linux_pose_extract.py` (MediaPipe — a PROXY, never Apple
truth).

Nothing here re-labels either plane as correct. The tool measures each plane
on its own (pose count, confidence distribution, per-joint visibility,
frame/time coverage, timestamp cadence) and then aligns the two by source
timestamp so the divergence can be stated with numbers.

Usage:
  compare_pose_planes.py --apple <dir> --linux <dir> --out <dir>
      [--source-video <mp4>] [--source-fps 24] [--source-frames 1461]
      [--source-duration-ms 60875] [--apple-report <report.json>]
      [--linux-report <report.json>] [--match-tolerance-ms 21]

Writes `<out>/comparison.json` (raw tables/matrices) and `<out>/comparison.md`.
Exit code is 0 when the comparison ran; the divergence itself is reported in
the JSON, not as a failure (a plane disagreeing is the *result*, not an
error). Exit code 2 = bad inputs.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import shutil
import statistics
import subprocess
import sys
from collections import Counter
from typing import Any, Dict, List, Optional, Sequence, Tuple

JOINTS_13 = [
    "head",
    "left_shoulder",
    "right_shoulder",
    "left_elbow",
    "right_elbow",
    "left_wrist",
    "right_wrist",
    "left_hip",
    "right_hip",
    "left_knee",
    "right_knee",
    "left_ankle",
    "right_ankle",
]

CORE_JOINTS = [
    "left_shoulder",
    "right_shoulder",
    "left_hip",
    "right_hip",
    "left_knee",
    "right_knee",
    "left_ankle",
    "right_ankle",
    "left_wrist",
    "right_wrist",
]

VISIBLE_THRESHOLD = 0.3  # same floor as packages/vision-geometry captureQuality
CONFIDENCE_BINS = [0.0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0000001]


def _load_json(path: str) -> Any:
    with open(path, "r", encoding="utf-8") as fh:
        return json.load(fh)


def _percentiles(values: Sequence[float], points: Sequence[float]) -> Dict[str, Optional[float]]:
    if not values:
        return {f"p{int(p * 100):02d}": None for p in points}
    ordered = sorted(values)
    out: Dict[str, Optional[float]] = {}
    for p in points:
        rank = p * (len(ordered) - 1)
        lo = math.floor(rank)
        hi = math.ceil(rank)
        if lo == hi:
            value = ordered[lo]
        else:
            value = ordered[lo] + (ordered[hi] - ordered[lo]) * (rank - lo)
        out[f"p{int(p * 100):02d}"] = round(value, 6)
    return out


def _distribution(values: Sequence[float]) -> Dict[str, Any]:
    if not values:
        return {"count": 0, "mean": None, "min": None, "max": None, "percentiles": _percentiles([], [])}
    return {
        "count": len(values),
        "mean": round(statistics.fmean(values), 6),
        "stdev": round(statistics.pstdev(values), 6) if len(values) > 1 else 0.0,
        "min": round(min(values), 6),
        "max": round(max(values), 6),
        "percentiles": _percentiles(values, [0.05, 0.25, 0.5, 0.75, 0.95]),
    }


def _histogram(values: Sequence[float], edges: Sequence[float]) -> List[Dict[str, Any]]:
    counts = [0] * (len(edges) - 1)
    for value in values:
        for index in range(len(edges) - 1):
            if edges[index] <= value < edges[index + 1]:
                counts[index] += 1
                break
    total = max(1, len(values))
    return [
        {
            "from": round(edges[index], 3),
            "to": round(min(edges[index + 1], 1.0), 3),
            "count": counts[index],
            "fraction": round(counts[index] / total, 6),
        }
        for index in range(len(edges) - 1)
    ]


def _cadence(timestamps: Sequence[float]) -> Dict[str, Any]:
    deltas = [round(b - a, 3) for a, b in zip(timestamps, timestamps[1:])]
    counter = Counter(round(d) for d in deltas)
    median = statistics.median(deltas) if deltas else None
    return {
        "deltaCount": len(deltas),
        "medianDeltaMs": median,
        "impliedFpsFromMedianDelta": round(1000.0 / median, 4) if median else None,
        "deltaHistogramMs": [
            {"deltaMs": delta, "count": count} for delta, count in sorted(counter.items())
        ],
        "gapsOverOneFrame": [
            {"index": index + 1, "fromMs": timestamps[index], "toMs": timestamps[index + 1], "gapMs": deltas[index]}
            for index in range(len(deltas))
            if median and deltas[index] > median * 1.5
        ],
        "nonMonotonic": sum(1 for d in deltas if d <= 0),
    }


def analyze_plane(label: str, directory: str) -> Dict[str, Any]:
    pose_path = os.path.join(directory, "pose.json")
    people_path = os.path.join(directory, "people.json")
    meta_path = os.path.join(directory, "extract-meta.json")
    for path in (pose_path, meta_path):
        if not os.path.isfile(path):
            raise FileNotFoundError(f"{label}: missing {path}")
    pose = _load_json(pose_path)
    meta = _load_json(meta_path)
    people = _load_json(people_path) if os.path.isfile(people_path) else None

    frames: List[Dict[str, Any]] = pose.get("frames", [])
    timestamps = [float(frame["t"]) for frame in frames]
    confidences = [float(frame["c"]) for frame in frames]
    indexes = [int(frame["i"]) for frame in frames]

    per_joint_visibility: Dict[str, List[float]] = {name: [] for name in JOINTS_13}
    per_joint_zeroed: Dict[str, int] = {name: 0 for name in JOINTS_13}
    per_joint_visible: Dict[str, int] = {name: 0 for name in JOINTS_13}
    landmark_names: Counter = Counter()
    core_visible_counts: List[int] = []
    full_body_frames = 0
    frames_with_extra_z = 0
    for frame in frames:
        by_name = {mark["n"]: mark for mark in frame.get("l", [])}
        landmark_names.update(by_name.keys())
        if any("z" in mark for mark in frame.get("l", [])):
            frames_with_extra_z += 1
        for name in JOINTS_13:
            mark = by_name.get(name)
            if mark is None:
                continue
            visibility = float(mark["v"])
            per_joint_visibility[name].append(visibility)
            if visibility >= VISIBLE_THRESHOLD:
                per_joint_visible[name] += 1
            if visibility == 0 and float(mark["x"]) == 0 and float(mark["y"]) == 0:
                per_joint_zeroed[name] += 1
        visible_core = sum(
            1 for name in CORE_JOINTS if float(by_name.get(name, {"v": 0})["v"]) >= VISIBLE_THRESHOLD
        )
        core_visible_counts.append(visible_core)
        if visible_core == len(CORE_JOINTS):
            full_body_frames += 1

    people_frames = people.get("frames", []) if isinstance(people, dict) else []
    people_counts = [len(frame.get("p", [])) for frame in people_frames]
    people_conf = [float(person["c"]) for frame in people_frames for person in frame.get("p", [])]

    # frameIndex semantics: is `i` a dense 0..n-1 counter (pose-hit ordinal) or
    # a sparse source-frame index with holes where the model missed?
    dense_counter = indexes == list(range(len(indexes)))
    index_matches_time = None
    video = pose.get("video", {})
    fps_declared = float(video.get("fps", 0) or 0)
    if fps_declared > 0 and timestamps:
        expected = [round(t * fps_declared / 1000.0) for t in timestamps]
        index_matches_time = sum(1 for e, i in zip(expected, indexes) if e == i) / len(indexes)

    cadence = _cadence(timestamps)
    implied_fps = cadence["impliedFpsFromMedianDelta"]
    fps_consistency = None
    if implied_fps and fps_declared > 0:
        fps_consistency = {
            "declaredVideoFps": fps_declared,
            "impliedFpsFromPoseTimestamps": implied_fps,
            "ratioDeclaredOverImplied": round(fps_declared / implied_fps, 4),
            "consistent": abs(fps_declared - implied_fps) / implied_fps < 0.15,
        }

    return {
        "plane": label,
        "directory": os.path.abspath(directory),
        "poseModelVersion": pose.get("poseModelVersion"),
        "format": pose.get("format"),
        "coordinateSystem": pose.get("coordinateSystem"),
        "videoDeclared": video,
        "extractMeta": meta,
        "poseCount": len(frames),
        "firstPoseMs": timestamps[0] if timestamps else None,
        "lastPoseMs": timestamps[-1] if timestamps else None,
        "spanMs": (timestamps[-1] - timestamps[0]) if len(timestamps) >= 2 else 0,
        "effectiveFpsOverSpan": round((len(timestamps) - 1) * 1000.0 / (timestamps[-1] - timestamps[0]), 4)
        if len(timestamps) >= 2 and timestamps[-1] > timestamps[0]
        else None,
        "frameIndexSemantics": {
            "firstIndex": indexes[0] if indexes else None,
            "lastIndex": indexes[-1] if indexes else None,
            "isDenseCounterFromZero": dense_counter,
            "fractionMatchingRoundedTimestampTimesFps": round(index_matches_time, 4)
            if index_matches_time is not None
            else None,
        },
        "cadence": cadence,
        "fpsConsistency": fps_consistency,
        "confidence": {
            "distribution": _distribution(confidences),
            "histogram": _histogram(confidences, CONFIDENCE_BINS),
        },
        "landmarkVocabulary": sorted(landmark_names.keys()),
        "framesWithZ": frames_with_extra_z,
        "perJoint": {
            name: {
                "visibility": _distribution(per_joint_visibility[name]),
                "visibleFraction": round(per_joint_visible[name] / len(frames), 6) if frames else None,
                "zeroedFraction": round(per_joint_zeroed[name] / len(frames), 6) if frames else None,
            }
            for name in JOINTS_13
        },
        "coreJointsVisiblePerFrame": _distribution([float(v) for v in core_visible_counts]),
        "fullBodyFrameFraction": round(full_body_frames / len(frames), 6) if frames else None,
        "people": {
            "framesWithPeople": len(people_frames),
            "peoplePerFrame": _distribution([float(c) for c in people_counts]),
            "peoplePerFrameHistogram": [
                {"people": k, "frames": v} for k, v in sorted(Counter(people_counts).items())
            ],
            "personConfidence": _distribution(people_conf),
        },
    }


def _probe_source(video: str) -> Optional[Dict[str, Any]]:
    if not shutil.which("ffprobe"):
        return None
    cmd = [
        "ffprobe",
        "-v",
        "error",
        "-count_frames",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=codec_name,r_frame_rate,avg_frame_rate,nb_read_frames,duration,width,height",
        "-of",
        "json",
        video,
    ]
    result = subprocess.run(cmd, capture_output=True, text=True, check=False)
    if result.returncode != 0:
        return {"command": cmd, "exitCode": result.returncode, "stderr": result.stderr[-2000:]}
    stream = json.loads(result.stdout)["streams"][0]
    num, den = stream["r_frame_rate"].split("/")
    return {
        "command": cmd,
        "exitCode": 0,
        "codec": stream.get("codec_name"),
        "fps": float(num) / float(den),
        "frames": int(stream.get("nb_read_frames", 0)),
        "durationMs": round(float(stream.get("duration", 0)) * 1000.0, 3),
        "width": stream.get("width"),
        "height": stream.get("height"),
    }


def align_planes(
    apple_frames: List[Dict[str, Any]],
    linux_frames: List[Dict[str, Any]],
    source_fps: float,
    source_frame_count: int,
    tolerance_ms: float,
) -> Dict[str, Any]:
    """Bucket both planes onto the source frame grid and compare where both fired."""
    interval = 1000.0 / source_fps

    def bucket(frames: List[Dict[str, Any]]) -> Dict[int, Dict[str, Any]]:
        out: Dict[int, Dict[str, Any]] = {}
        for frame in frames:
            slot = int(round(float(frame["t"]) / interval))
            if abs(slot * interval - float(frame["t"])) <= tolerance_ms and slot not in out:
                out[slot] = frame
        return out

    apple_by_slot = bucket(apple_frames)
    linux_by_slot = bucket(linux_frames)
    slots = range(source_frame_count)
    both = [s for s in slots if s in apple_by_slot and s in linux_by_slot]
    apple_only = [s for s in slots if s in apple_by_slot and s not in linux_by_slot]
    linux_only = [s for s in slots if s not in apple_by_slot and s in linux_by_slot]
    neither = [s for s in slots if s not in apple_by_slot and s not in linux_by_slot]

    def runs(values: List[int]) -> List[Dict[str, int]]:
        out: List[Dict[str, int]] = []
        for value in values:
            if out and out[-1]["toFrame"] == value - 1:
                out[-1]["toFrame"] = value
            else:
                out.append({"fromFrame": value, "toFrame": value})
        return [dict(run, length=run["toFrame"] - run["fromFrame"] + 1) for run in out]

    joint_deltas: Dict[str, List[float]] = {name: [] for name in JOINTS_13}
    joint_visibility_agreement: Dict[str, Counter] = {name: Counter() for name in JOINTS_13}
    torso_deltas: List[float] = []
    conf_pairs: List[Tuple[float, float]] = []
    for slot in both:
        a = {m["n"]: m for m in apple_by_slot[slot]["l"]}
        l = {m["n"]: m for m in linux_by_slot[slot]["l"]}
        conf_pairs.append((float(apple_by_slot[slot]["c"]), float(linux_by_slot[slot]["c"])))
        for name in JOINTS_13:
            am, lm = a.get(name), l.get(name)
            if am is None or lm is None:
                continue
            av = float(am["v"]) >= VISIBLE_THRESHOLD
            lv = float(lm["v"]) >= VISIBLE_THRESHOLD
            joint_visibility_agreement[name][f"apple={int(av)},linux={int(lv)}"] += 1
            if av and lv:
                joint_deltas[name].append(
                    math.hypot(float(am["x"]) - float(lm["x"]), float(am["y"]) - float(lm["y"]))
                )
        if all(k in a and k in l for k in ("left_hip", "right_hip", "left_shoulder", "right_shoulder")):
            def mid(marks: Dict[str, Any]) -> Tuple[float, float]:
                xs = [float(marks[k]["x"]) for k in ("left_hip", "right_hip", "left_shoulder", "right_shoulder")]
                ys = [float(marks[k]["y"]) for k in ("left_hip", "right_hip", "left_shoulder", "right_shoulder")]
                return (sum(xs) / 4, sum(ys) / 4)

            if all(float(a[k]["v"]) >= VISIBLE_THRESHOLD and float(l[k]["v"]) >= VISIBLE_THRESHOLD for k in ("left_hip", "right_hip", "left_shoulder", "right_shoulder")):
                (ax, ay), (lx, ly) = mid(a), mid(l)
                torso_deltas.append(math.hypot(ax - lx, ay - ly))

    correlation = None
    if len(conf_pairs) >= 3:
        xs = [p[0] for p in conf_pairs]
        ys = [p[1] for p in conf_pairs]
        mx, my = statistics.fmean(xs), statistics.fmean(ys)
        num = sum((x - mx) * (y - my) for x, y in conf_pairs)
        den = math.sqrt(sum((x - mx) ** 2 for x in xs) * sum((y - my) ** 2 for y in ys))
        correlation = round(num / den, 6) if den > 0 else None

    # Same-person agreement proxy: torso-mid distance under 0.10 of the frame.
    same_subject = sum(1 for d in torso_deltas if d < 0.10)
    return {
        "sourceFps": source_fps,
        "sourceFrameCount": source_frame_count,
        "matchToleranceMs": tolerance_ms,
        "confusionMatrix": {
            "bothPose": len(both),
            "appleOnly": len(apple_only),
            "linuxOnly": len(linux_only),
            "neither": len(neither),
        },
        "appleOnlyRuns": runs(apple_only),
        "linuxOnlyRuns": runs(linux_only),
        "neitherRuns": runs(neither),
        "frameConfidenceCorrelationOnBoth": correlation,
        "frameConfidenceMeanApple": round(statistics.fmean(p[0] for p in conf_pairs), 6) if conf_pairs else None,
        "frameConfidenceMeanLinux": round(statistics.fmean(p[1] for p in conf_pairs), 6) if conf_pairs else None,
        "perJointPositionDeltaNormalized": {
            name: _distribution(joint_deltas[name]) for name in JOINTS_13
        },
        "perJointVisibilityAgreement": {
            name: dict(joint_visibility_agreement[name]) for name in JOINTS_13
        },
        "torsoMidDeltaNormalized": _distribution(torso_deltas),
        "torsoMidWithin0_10Fraction": round(same_subject / len(torso_deltas), 6) if torso_deltas else None,
    }


def _report_summary(path: Optional[str]) -> Optional[Dict[str, Any]]:
    if not path:
        return None
    if not os.path.isfile(path):
        return {"path": path, "missing": True}
    report = _load_json(path)
    quality = report.get("quality") or {}
    player = report.get("player") or {}
    scene = report.get("scene")
    outcome = report.get("outcome") or {}
    contact = report.get("contact") or {}
    return {
        "path": os.path.abspath(path),
        "poseSequenceSha256": report.get("poseSequenceSha256"),
        "outcome": outcome,
        "quality": {
            "analyzable": quality.get("analyzable"),
            "reasons": quality.get("reasons"),
            "stats": quality.get("stats"),
        },
        "player": {
            "targetTrackId": player.get("targetTrackId"),
            "policy": player.get("policy"),
            "selectionConfidence": player.get("selectionConfidence"),
            "targetCoverage": player.get("targetCoverage"),
            "lossPeriods": player.get("lossPeriods"),
            "candidateTrackCount": len(player.get("candidateTracks") or []),
            "risks": player.get("risks") or player.get("identityRisks"),
        },
        "scenePresent": scene is not None,
        "sceneCutCount": scene.get("cutCount") if isinstance(scene, dict) else None,
        "sceneAnalysisSegment": scene.get("analysisSegment") if isinstance(scene, dict) else None,
        "contact": {
            "status": contact.get("status"),
            "estimatedContactMs": contact.get("estimatedContactMs"),
            "confidence": contact.get("confidence"),
            "limitingFactors": contact.get("limitingFactors"),
            "detail": contact.get("detail"),
        },
        "window": report.get("window"),
    }


def build_markdown(result: Dict[str, Any]) -> str:
    a = result["apple"]
    l = result["linux"]
    align = result["alignment"]
    lines = [
        "# Apple Vision vs Linux replay proxy — pose plane comparison",
        "",
        "Apple = physical M4 runner artifact (Apple Vision). Linux = MediaPipe replay PROXY (never Apple truth).",
        "",
        "| metric | apple | linux |",
        "|---|---|---|",
        f"| poseModelVersion | `{a['poseModelVersion']}` | `{l['poseModelVersion']}` |",
        f"| pose count | {a['poseCount']} | {l['poseCount']} |",
        f"| first/last pose (ms) | {a['firstPoseMs']} / {a['lastPoseMs']} | {l['firstPoseMs']} / {l['lastPoseMs']} |",
        f"| effective fps over span | {a['effectiveFpsOverSpan']} | {l['effectiveFpsOverSpan']} |",
        f"| declared video.fps | {a['videoDeclared'].get('fps')} | {l['videoDeclared'].get('fps')} |",
        f"| implied fps (median Δt) | {a['cadence']['impliedFpsFromMedianDelta']} | {l['cadence']['impliedFpsFromMedianDelta']} |",
        f"| frame index `i` dense 0..n-1 | {a['frameIndexSemantics']['isDenseCounterFromZero']} | {l['frameIndexSemantics']['isDenseCounterFromZero']} |",
        f"| frame conf mean / p50 | {a['confidence']['distribution']['mean']} / {a['confidence']['distribution']['percentiles']['p50']} | {l['confidence']['distribution']['mean']} / {l['confidence']['distribution']['percentiles']['p50']} |",
        f"| full-body frame fraction (10 core joints v≥0.3) | {a['fullBodyFrameFraction']} | {l['fullBodyFrameFraction']} |",
        f"| frames with people | {a['people']['framesWithPeople']} | {l['people']['framesWithPeople']} |",
        f"| people/frame mean | {a['people']['peoplePerFrame']['mean']} | {l['people']['peoplePerFrame']['mean']} |",
        "",
        "## Source-grid confusion matrix",
        "",
        f"source fps {align['sourceFps']}, {align['sourceFrameCount']} frames, tolerance ±{align['matchToleranceMs']} ms",
        "",
        "| both | apple only | linux only | neither |",
        "|---|---|---|---|",
        f"| {align['confusionMatrix']['bothPose']} | {align['confusionMatrix']['appleOnly']} | {align['confusionMatrix']['linuxOnly']} | {align['confusionMatrix']['neither']} |",
        "",
        f"frame-confidence Pearson r on shared frames: {align['frameConfidenceCorrelationOnBoth']}",
        f"torso-mid within 0.10 of frame on shared frames: {align['torsoMidWithin0_10Fraction']}",
        "",
        "## Per-joint visibility (fraction of pose frames with v ≥ 0.3)",
        "",
        "| joint | apple | linux | shared-frame Δpos p50 |",
        "|---|---|---|---|",
    ]
    for name in JOINTS_13:
        delta = align["perJointPositionDeltaNormalized"][name]["percentiles"]["p50"]
        lines.append(
            f"| {name} | {a['perJoint'][name]['visibleFraction']} | {l['perJoint'][name]['visibleFraction']} | {delta} |"
        )
    lines += ["", "## Confidence histogram", "", "| bin | apple | linux |", "|---|---|---|"]
    for ab, lb in zip(a["confidence"]["histogram"], l["confidence"]["histogram"]):
        lines.append(f"| [{ab['from']}, {ab['to']}) | {ab['count']} | {lb['count']} |")
    if result.get("source"):
        s = result["source"]
        lines += ["", "## Source probe (ffprobe)", "", f"`{json.dumps({k: v for k, v in s.items() if k != 'command'})}`"]
    for key in ("appleReport", "linuxReport"):
        rep = result.get(key)
        if rep:
            lines += ["", f"## {key} (swing-lab analyze:video --reuse-extract)", "", f"```json\n{json.dumps(rep, indent=1)[:4000]}\n```"]
    lines += ["", "## Divergence flags", ""]
    for flag in result["divergenceFlags"]:
        lines.append(f"- {flag}")
    return "\n".join(lines) + "\n"


def divergence_flags(result: Dict[str, Any]) -> List[str]:
    flags: List[str] = []
    a, l, align = result["apple"], result["linux"], result["alignment"]
    for plane in (a, l):
        fc = plane.get("fpsConsistency")
        if fc and not fc["consistent"]:
            flags.append(
                f"{plane['plane']}: declared video.fps={fc['declaredVideoFps']} but pose timestamps imply "
                f"{fc['impliedFpsFromPoseTimestamps']} fps (ratio {fc['ratioDeclaredOverImplied']})"
            )
        meta = plane.get("extractMeta") or {}
        src = result.get("source") or {}
        declared_duration = (meta.get("video") or {}).get("durationMs")
        if declared_duration and src.get("durationMs") and abs(declared_duration - src["durationMs"]) > 500:
            flags.append(
                f"{plane['plane']}: extract-meta durationMs={declared_duration} vs source {src['durationMs']} ms"
            )
        if plane["cadence"]["nonMonotonic"]:
            flags.append(f"{plane['plane']}: {plane['cadence']['nonMonotonic']} non-monotonic timestamp step(s)")
    if a["frameIndexSemantics"]["isDenseCounterFromZero"] != l["frameIndexSemantics"]["isDenseCounterFromZero"]:
        flags.append(
            "frameIndex `i` semantics differ: apple dense pose-hit counter="
            f"{a['frameIndexSemantics']['isDenseCounterFromZero']}, linux={l['frameIndexSemantics']['isDenseCounterFromZero']}"
        )
    cm = align["confusionMatrix"]
    flags.append(
        f"coverage: both={cm['bothPose']} appleOnly={cm['appleOnly']} linuxOnly={cm['linuxOnly']} neither={cm['neither']}"
    )
    if a["confidence"]["distribution"]["mean"] is not None and l["confidence"]["distribution"]["mean"] is not None:
        flags.append(
            "frame confidence calibration differs: apple mean "
            f"{a['confidence']['distribution']['mean']} vs linux mean {l['confidence']['distribution']['mean']} "
            "(different models; not comparable as accuracy)"
        )
    for key, label in (("appleReport", "apple"), ("linuxReport", "linux")):
        rep = result.get(key)
        if rep and not rep.get("missing") and rep.get("scenePresent") is False:
            flags.append(f"{label}: no scenes.json → scene-validity stage did not run on this plane")
    return flags


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--apple", required=True, help="Apple swing-lab-extract directory (Mac artifact)")
    parser.add_argument("--linux", required=True, help="Linux MediaPipe proxy extract directory")
    parser.add_argument("--out", required=True)
    parser.add_argument("--source-video", default=None)
    parser.add_argument("--source-fps", type=float, default=None)
    parser.add_argument("--source-frames", type=int, default=None)
    parser.add_argument("--source-duration-ms", type=float, default=None)
    parser.add_argument("--apple-report", default=None, help="report.json from analyze:video --reuse-extract on the Apple dir")
    parser.add_argument("--linux-report", default=None, help="report.json from analyze:video --reuse-extract on the Linux dir")
    parser.add_argument("--match-tolerance-ms", type=float, default=21.0)
    args = parser.parse_args(argv)

    try:
        apple = analyze_plane("apple", args.apple)
        linux = analyze_plane("linux", args.linux)
    except (FileNotFoundError, KeyError, ValueError, json.JSONDecodeError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    source: Optional[Dict[str, Any]] = None
    if args.source_video:
        source = _probe_source(args.source_video)
    if source is None or source.get("exitCode", 0) != 0:
        if args.source_fps and args.source_frames:
            source = {
                "fps": args.source_fps,
                "frames": args.source_frames,
                "durationMs": args.source_duration_ms,
                "origin": "cli-args",
            }
    if not source or "fps" not in source:
        print("error: need --source-video (with ffprobe) or --source-fps + --source-frames", file=sys.stderr)
        return 2

    apple_frames = _load_json(os.path.join(args.apple, "pose.json"))["frames"]
    linux_frames = _load_json(os.path.join(args.linux, "pose.json"))["frames"]
    alignment = align_planes(
        apple_frames, linux_frames, float(source["fps"]), int(source["frames"]), args.match_tolerance_ms
    )
    result: Dict[str, Any] = {
        "tool": "tools/xc-cv-mac-vision/compare_pose_planes.py",
        "planes": {
            "apple": "Apple Vision on the physical M4 runner (mac-full-verify artifact) — Apple truth",
            "linux": "MediaPipe PoseLandmarker on Linux — replay PROXY, not Apple truth",
        },
        "source": source,
        "apple": apple,
        "linux": linux,
        "alignment": alignment,
        "appleReport": _report_summary(args.apple_report),
        "linuxReport": _report_summary(args.linux_report),
    }
    result["divergenceFlags"] = divergence_flags(result)

    os.makedirs(args.out, exist_ok=True)
    json_path = os.path.join(args.out, "comparison.json")
    md_path = os.path.join(args.out, "comparison.md")
    with open(json_path, "w", encoding="utf-8") as fh:
        json.dump(result, fh, indent=1, sort_keys=True)
    with open(md_path, "w", encoding="utf-8") as fh:
        fh.write(build_markdown(result))
    print(f"wrote {json_path}\nwrote {md_path}")
    for flag in result["divergenceFlags"]:
        print(f"- {flag}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
