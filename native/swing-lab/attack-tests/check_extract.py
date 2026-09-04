#!/usr/bin/env python3
"""Adversarial invariant checker for one `swing-lab extract --out <dir>` output.

Runs anywhere Python 3.9+ runs (Linux CI, the M4 runner) and needs no Apple
frameworks: it only reads the five JSON files the CLI writes. It is the
assertion half of the attack harness in this directory; the fixture half
lives in `fixtures/` and the Mac driver in `run_mac_attacks.sh`.

Every check is reported as PASS or FAIL with the concrete values that were
compared, so a failure is a finding with evidence rather than a boolean.
Exit status is 0 only when every applicable check passed.

Scenario coverage (coordinator ids in brackets):
  [rotated]   pose.video.w/h equal the upright dimensions (--expect-w/-h);
              all landmarks inside [0, 1].
  [vfr]       pose.video.fps agrees with the DECODED cadence derived from
              scenes.json.scores[].t (one entry per decoded frame after the
              first). A pose-frame-derived or wrong nominal rate fails here.
  [rewind]    pose/people timestamps strictly increasing AND every pose
              timestamp is a real decoded presentation time (never remapped).
  [cuts]      scenes.cuts strictly increasing, inside (0, durationMs);
              segments partition [0, durationMs] exactly; optional expected
              cut period/count.
  [panning]   ball.cameraAssumption is the verbatim string "stationary".
  [overwrite] --not-before <epoch> requires every output file's mtime to be
              at or after the second run started; --expect-video-path pins
              extract-meta.video.path to the second input.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
from dataclasses import dataclass, field
from typing import Any, Optional

OUTPUT_FILES = (
    "scenes.json",
    "pose.json",
    "people.json",
    "ball.json",
    "extract-meta.json",
)

POSE_FORMAT = "pickle.pose-sequence.v1"
POSE_COORDINATE_SYSTEM = "normalized_image_top_left"
CAMERA_ASSUMPTION = "stationary"
POINT_TIMING = "linear_over_time_range"


@dataclass
class Check:
    id: str
    ok: bool
    detail: str


@dataclass
class Report:
    out_dir: str
    checks: list[Check] = field(default_factory=list)

    def add(self, check_id: str, ok: bool, detail: str) -> None:
        self.checks.append(Check(check_id, ok, detail))

    @property
    def failed(self) -> list[Check]:
        return [c for c in self.checks if not c.ok]

    def to_json(self) -> dict[str, Any]:
        return {
            "outDir": self.out_dir,
            "ok": not self.failed,
            "checks": [c.__dict__ for c in self.checks],
        }


def _strictly_increasing(values: list[int]) -> Optional[int]:
    """Index of the first non-increase, or None when strictly increasing."""
    for index in range(1, len(values)):
        if values[index] <= values[index - 1]:
            return index
    return None


def _is_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _is_finite_number(value: Any) -> bool:
    return (
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and math.isfinite(value)
    )


def load_outputs(out_dir: str, report: Report) -> Optional[dict[str, Any]]:
    loaded: dict[str, Any] = {}
    missing: list[str] = []
    invalid: list[str] = []
    for name in OUTPUT_FILES:
        path = os.path.join(out_dir, name)
        if not os.path.isfile(path):
            missing.append(name)
            continue
        try:
            with open(path, "r", encoding="utf-8") as handle:
                loaded[name] = json.load(handle)
        except (OSError, ValueError) as error:
            invalid.append(f"{name}: {error}")
    report.add(
        "files.present",
        not missing and not invalid,
        f"present={sorted(loaded)} missing={missing} invalid={invalid}",
    )
    if missing or invalid:
        return None
    return loaded


def decoded_timestamps(scenes: dict[str, Any]) -> list[int]:
    scores = scenes.get("scores")
    if not isinstance(scores, list):
        return []
    result: list[int] = []
    for entry in scores:
        if isinstance(entry, dict) and _is_int(entry.get("t")):
            result.append(entry["t"])
    return result


def check_pose_schema(pose: dict[str, Any], report: Report) -> None:
    report.add(
        "pose.schema",
        pose.get("schemaVersion") == 1
        and pose.get("format") == POSE_FORMAT
        and pose.get("coordinateSystem") == POSE_COORDINATE_SYSTEM
        and isinstance(pose.get("poseModelVersion"), str)
        and isinstance(pose.get("frames"), list),
        f"schemaVersion={pose.get('schemaVersion')!r} format={pose.get('format')!r} "
        f"coordinateSystem={pose.get('coordinateSystem')!r} "
        f"poseModelVersion={pose.get('poseModelVersion')!r} "
        f"frames={type(pose.get('frames')).__name__}",
    )


def check_dimensions(
    pose: dict[str, Any],
    people: dict[str, Any],
    meta: dict[str, Any],
    report: Report,
    expect_w: Optional[int],
    expect_h: Optional[int],
) -> None:
    video = pose.get("video") if isinstance(pose.get("video"), dict) else {}
    people_video = people.get("video") if isinstance(people.get("video"), dict) else {}
    meta_video = meta.get("video") if isinstance(meta.get("video"), dict) else {}
    w, h = video.get("w"), video.get("h")
    positive = _is_int(w) and _is_int(h) and w > 0 and h > 0
    consistent = (
        people_video.get("w") == w
        and people_video.get("h") == h
        and meta_video.get("w") == w
        and meta_video.get("h") == h
    )
    report.add(
        "video.dimensions.positive_and_consistent",
        positive and consistent,
        f"pose={w}x{h} people={people_video.get('w')}x{people_video.get('h')} "
        f"meta={meta_video.get('w')}x{meta_video.get('h')}",
    )
    if expect_w is not None or expect_h is not None:
        ok = (expect_w is None or w == expect_w) and (expect_h is None or h == expect_h)
        report.add(
            "video.dimensions.upright",
            ok,
            f"pose.video={w}x{h} expected={expect_w}x{expect_h} "
            "(rotated inputs must report the UPRIGHT render size, not the encoded size)",
        )


def check_landmarks(pose: dict[str, Any], people: dict[str, Any], report: Report) -> None:
    out_of_range: list[str] = []
    malformed: list[str] = []
    total = 0
    lo_x = lo_y = math.inf
    hi_x = hi_y = -math.inf

    def visit(owner: str, landmarks: Any) -> None:
        nonlocal total, lo_x, lo_y, hi_x, hi_y
        if not isinstance(landmarks, list):
            malformed.append(f"{owner}: landmarks not a list")
            return
        for landmark in landmarks:
            total += 1
            if not isinstance(landmark, dict):
                malformed.append(f"{owner}: landmark not an object")
                continue
            x, y, v = landmark.get("x"), landmark.get("y"), landmark.get("v")
            if not (_is_finite_number(x) and _is_finite_number(y) and _is_finite_number(v)):
                malformed.append(f"{owner}: non-finite {landmark!r}")
                continue
            lo_x, hi_x = min(lo_x, x), max(hi_x, x)
            lo_y, hi_y = min(lo_y, y), max(hi_y, y)
            if not (0.0 <= x <= 1.0 and 0.0 <= y <= 1.0):
                if len(out_of_range) < 10:
                    out_of_range.append(f"{owner}:{landmark.get('n')} x={x} y={y}")
            if not (0.0 <= v <= 1.0):
                if len(out_of_range) < 10:
                    out_of_range.append(f"{owner}:{landmark.get('n')} v={v}")

    for frame in pose.get("frames", []):
        if isinstance(frame, dict):
            visit(f"pose t={frame.get('t')}", frame.get("l"))
    for frame in people.get("frames", []):
        if isinstance(frame, dict) and isinstance(frame.get("p"), list):
            for index, person in enumerate(frame["p"]):
                if isinstance(person, dict):
                    visit(f"people t={frame.get('t')} p[{index}]", person.get("l"))

    if total == 0:
        detail = "no landmarks emitted (nothing to range-check)"
    else:
        detail = (
            f"landmarks={total} x∈[{lo_x:.6f},{hi_x:.6f}] y∈[{lo_y:.6f},{hi_y:.6f}] "
            f"outOfRange={out_of_range} malformed={malformed[:5]}"
        )
    report.add("pose.landmarks.normalized", not out_of_range and not malformed, detail)


def check_timestamps(
    pose: dict[str, Any], people: dict[str, Any], scenes: dict[str, Any], report: Report
) -> None:
    pose_ts = [f.get("t") for f in pose.get("frames", []) if isinstance(f, dict)]
    people_ts = [f.get("t") for f in people.get("frames", []) if isinstance(f, dict)]
    pose_int = all(_is_int(t) for t in pose_ts)
    people_int = all(_is_int(t) for t in people_ts)
    pose_break = _strictly_increasing(pose_ts) if pose_int else 0
    people_break = _strictly_increasing(people_ts) if people_int else 0
    report.add(
        "pose.timestamps.strictly_increasing",
        pose_int and pose_break is None,
        f"frames={len(pose_ts)} firstBreak={pose_break} "
        + (
            f"around={pose_ts[max(0, pose_break - 2): pose_break + 2]}"
            if pose_break is not None and pose_int
            else f"first={pose_ts[:1]} last={pose_ts[-1:]}"
        ),
    )
    report.add(
        "people.timestamps.strictly_increasing",
        people_int and people_break is None,
        f"frames={len(people_ts)} firstBreak={people_break}",
    )

    indices = [f.get("i") for f in pose.get("frames", []) if isinstance(f, dict)]
    report.add(
        "pose.indices.dense",
        indices == list(range(len(indices))),
        f"count={len(indices)} first={indices[:3]} last={indices[-3:]}",
    )

    decoded = decoded_timestamps(scenes)
    decoded_break = _strictly_increasing(decoded)
    report.add(
        "scenes.scores.strictly_increasing",
        decoded_break is None,
        f"decodedFrames(after first)={len(decoded)} firstBreak={decoded_break} "
        + (
            f"around={decoded[max(0, decoded_break - 2): decoded_break + 2]}"
            if decoded_break is not None
            else f"first={decoded[:1]} last={decoded[-1:]}"
        ),
    )

    # Every pose timestamp must be a real decoded presentation time. The
    # first decoded frame has no score entry (no previous histogram), so
    # exactly one pose timestamp may precede scores[0].t.
    if pose_int and decoded:
        decoded_set = set(decoded)
        first_decoded = decoded[0]
        remapped = [t for t in pose_ts if t not in decoded_set and t >= first_decoded]
        before_first = [t for t in pose_ts if t < first_decoded]
        ok = not remapped and len(before_first) <= 1
        report.add(
            "pose.timestamps.are_decoded_pts",
            ok,
            f"poseFrames={len(pose_ts)} notADecodedPts={remapped[:10]} "
            f"beforeFirstScore={before_first[:3]}",
        )
    else:
        report.add(
            "pose.timestamps.are_decoded_pts",
            len(pose_ts) <= 1,
            f"poseFrames={len(pose_ts)} decodedFrames={len(decoded)} (cannot cross-check)",
        )


def check_fps(
    pose: dict[str, Any],
    people: dict[str, Any],
    meta: dict[str, Any],
    scenes: dict[str, Any],
    report: Report,
    fps_tolerance: float,
    expect_fps: Optional[float],
) -> None:
    video = pose.get("video") if isinstance(pose.get("video"), dict) else {}
    fps = video.get("fps")
    people_fps = (people.get("video") or {}).get("fps") if isinstance(people.get("video"), dict) else None
    nominal = (meta.get("video") or {}).get("nominalFps") if isinstance(meta.get("video"), dict) else None
    report.add(
        "video.fps.positive_finite_and_consistent",
        _is_finite_number(fps) and fps > 0 and people_fps == fps,
        f"pose.video.fps={fps!r} people.video.fps={people_fps!r} meta.nominalFps={nominal!r}",
    )

    decoded = decoded_timestamps(scenes)
    if len(decoded) >= 2 and decoded[-1] > decoded[0]:
        decoded_fps = (len(decoded) - 1) * 1000.0 / float(decoded[-1] - decoded[0])
        pose_ts = [f.get("t") for f in pose.get("frames", []) if isinstance(f, dict) and _is_int(f.get("t"))]
        pose_cadence = None
        if len(pose_ts) >= 2 and pose_ts[-1] > pose_ts[0]:
            pose_cadence = (len(pose_ts) - 1) * 1000.0 / float(pose_ts[-1] - pose_ts[0])
        if _is_finite_number(fps) and fps > 0:
            ratio = fps / decoded_fps
            ok = abs(ratio - 1.0) <= fps_tolerance
        else:
            ratio = None
            ok = False
        report.add(
            "video.fps.matches_decoded_cadence",
            ok,
            f"pose.video.fps={fps!r} decodedCadenceFps={decoded_fps:.4f} "
            f"ratio={ratio if ratio is None else round(ratio, 4)} tolerance=±{fps_tolerance} "
            f"poseFrameCadenceFps={None if pose_cadence is None else round(pose_cadence, 4)} "
            f"nominalFps={nominal!r} "
            "(downstream divides 1000/fps per frame; a nominal or pose-cadence rate that "
            "disagrees with the decoded cadence mis-times every frame)",
        )
    else:
        report.add(
            "video.fps.matches_decoded_cadence",
            True,
            f"decodedFrames={len(decoded)} (<2 intervals; cadence not derivable)",
        )
    if expect_fps is not None:
        ok = _is_finite_number(fps) and abs(fps - expect_fps) <= expect_fps * fps_tolerance
        report.add(
            "video.fps.expected",
            ok,
            f"pose.video.fps={fps!r} expected≈{expect_fps} tolerance=±{fps_tolerance * 100:.0f}%",
        )


def check_duration_and_scenes(
    scenes: dict[str, Any],
    meta: dict[str, Any],
    report: Report,
    expect_cut_period_ms: Optional[int],
    expect_cut_count: Optional[int],
    expect_duration_ms: Optional[int],
) -> None:
    meta_video = meta.get("video") if isinstance(meta.get("video"), dict) else {}
    duration = meta_video.get("durationMs")
    decoded = decoded_timestamps(scenes)
    frame_interval = None
    if len(decoded) >= 2 and decoded[-1] > decoded[0]:
        frame_interval = (decoded[-1] - decoded[0]) / (len(decoded) - 1)

    if _is_int(duration) and decoded and frame_interval is not None:
        last_decoded = decoded[-1]
        # durationMs may exceed the last PTS by at most ~two frame intervals
        # (last frame's own duration + edit-list/rounding slack); anything
        # larger means the asset-level duration disagrees with the decoded media.
        slack = 2 * frame_interval + 50
        ok = last_decoded <= duration <= last_decoded + slack
        report.add(
            "video.duration.matches_decoded_media",
            ok,
            f"meta.video.durationMs={duration} lastDecodedPts={last_decoded} "
            f"frameInterval≈{frame_interval:.2f}ms allowedMax={last_decoded + slack:.0f} "
            f"ratioDurationOverDecoded={duration / max(last_decoded, 1):.3f}",
        )
    else:
        report.add(
            "video.duration.matches_decoded_media",
            _is_int(duration) and duration > 0,
            f"meta.video.durationMs={duration!r} decodedFrames={len(decoded)} (cadence not derivable)",
        )
    if expect_duration_ms is not None:
        ok = _is_int(duration) and abs(duration - expect_duration_ms) <= 60
        report.add(
            "video.duration.expected",
            ok,
            f"meta.video.durationMs={duration!r} expected={expect_duration_ms}±60",
        )

    cuts = scenes.get("cuts")
    segments = scenes.get("segments")
    cuts_ok = isinstance(cuts, list) and all(_is_int(c) for c in cuts)
    cut_break = _strictly_increasing(cuts) if cuts_ok else 0
    in_range = cuts_ok and _is_int(duration) and all(0 < c < duration for c in cuts)
    report.add(
        "scenes.cuts.strictly_increasing_in_range",
        cuts_ok and cut_break is None and in_range,
        f"cuts={len(cuts) if isinstance(cuts, list) else cuts!r} firstBreak={cut_break} "
        f"inRange(0,{duration})={in_range} sample={cuts[:8] if isinstance(cuts, list) else None}",
    )

    seg_ok = isinstance(segments, list) and len(segments) >= 1
    detail = f"segments={len(segments) if isinstance(segments, list) else segments!r}"
    if seg_ok:
        starts = [s.get("startMs") if isinstance(s, dict) else None for s in segments]
        ends = [s.get("endMs") if isinstance(s, dict) else None for s in segments]
        ints = all(_is_int(v) for v in starts + ends)
        contiguous = ints and starts[0] == 0 and all(starts[i] == ends[i - 1] for i in range(1, len(segments)))
        positive = ints and all(e > s for s, e in zip(starts, ends))
        last_matches = ints and ends[-1] == duration
        cuts_match = cuts_ok and ints and ends[:-1] == list(cuts)
        seg_ok = contiguous and positive and last_matches and cuts_match
        detail += (
            f" first={segments[0]} last={segments[-1]} durationMs={duration} "
            f"contiguousFromZero={contiguous} allPositive={positive} "
            f"lastEndEqualsDuration={last_matches} boundariesEqualCuts={cuts_match}"
        )
    report.add("scenes.segments.partition_exact", seg_ok, detail)

    if expect_cut_period_ms is not None and cuts_ok:
        tolerance = (frame_interval or 0) * 1.5 + 5
        off_grid = [c for c in cuts if abs(c - round(c / expect_cut_period_ms) * expect_cut_period_ms) > tolerance]
        count_ok = expect_cut_count is None or len(cuts) == expect_cut_count
        report.add(
            "scenes.cuts.expected_grid",
            not off_grid and count_ok,
            f"cuts={cuts} period={expect_cut_period_ms}ms tolerance=±{tolerance:.1f}ms "
            f"offGrid={off_grid} expectedCount={expect_cut_count}",
        )


def check_ball(ball: dict[str, Any], report: Report) -> None:
    assumption = ball.get("cameraAssumption")
    report.add(
        "ball.cameraAssumption.verbatim_stationary",
        isinstance(assumption, str) and assumption == CAMERA_ASSUMPTION,
        f"cameraAssumption={assumption!r} keys={sorted(ball)} "
        "(must stay the literal contract string so downstream fusion can gate on it)",
    )
    report.add(
        "ball.pointTiming",
        ball.get("pointTiming") == POINT_TIMING,
        f"pointTiming={ball.get('pointTiming')!r} source={ball.get('source')!r}",
    )
    trajectories = ball.get("trajectories")
    bad: list[str] = []
    if isinstance(trajectories, list):
        for trajectory in trajectories:
            if not isinstance(trajectory, dict):
                bad.append("trajectory not an object")
                continue
            start, end = trajectory.get("startMs"), trajectory.get("endMs")
            points = trajectory.get("points")
            if not (_is_int(start) and _is_int(end) and end >= start and isinstance(points, list)):
                bad.append(f"{trajectory.get('id')}: start={start} end={end}")
                continue
            ts = [p.get("t") for p in points if isinstance(p, dict)]
            if any(not _is_int(t) for t in ts) or _strictly_increasing(ts) is not None:
                bad.append(f"{trajectory.get('id')}: point timestamps not strictly increasing {ts[:6]}")
            for p in points:
                if isinstance(p, dict) and not (
                    _is_finite_number(p.get("x")) and _is_finite_number(p.get("y"))
                    and 0.0 <= p["x"] <= 1.0 and 0.0 <= p["y"] <= 1.0
                ):
                    bad.append(f"{trajectory.get('id')}: point out of range {p}")
                    break
            if len(bad) >= 10:
                break
    else:
        bad.append("trajectories missing")
    report.add(
        "ball.trajectories.well_formed",
        not bad,
        f"trajectories={len(trajectories) if isinstance(trajectories, list) else None} problems={bad[:5]}",
    )


def check_meta(
    meta: dict[str, Any],
    pose: dict[str, Any],
    people: dict[str, Any],
    scenes: dict[str, Any],
    report: Report,
    expect_video_path: Optional[str],
    expect_people_empty: bool,
    min_pose_frames: Optional[int],
) -> None:
    frames_seen = meta.get("framesSeen")
    frames_with_pose = meta.get("framesWithPose")
    misses = meta.get("poseMisses")
    decoded = decoded_timestamps(scenes)
    pose_frames = len(pose.get("frames", []))
    ok = (
        _is_int(frames_seen)
        and _is_int(frames_with_pose)
        and _is_int(misses)
        and frames_with_pose == pose_frames
        and frames_with_pose + misses <= frames_seen
        and (frames_seen == len(decoded) + 1 or (frames_seen == 0 and not decoded))
    )
    report.add(
        "meta.counts.consistent",
        ok,
        f"framesSeen={frames_seen} decodedFrames={len(decoded)}(+1 first) "
        f"framesWithPose={frames_with_pose} poseFrames={pose_frames} poseMisses={misses}",
    )
    report.add(
        "meta.model_and_wall_time",
        meta.get("poseModelVersion") == pose.get("poseModelVersion") == people.get("poseModelVersion")
        and _is_int(meta.get("wallTimeMs")) and meta["wallTimeMs"] >= 0,
        f"meta.poseModelVersion={meta.get('poseModelVersion')!r} pose={pose.get('poseModelVersion')!r} "
        f"people={people.get('poseModelVersion')!r} wallTimeMs={meta.get('wallTimeMs')!r}",
    )
    if expect_video_path is not None:
        actual = (meta.get("video") or {}).get("path") if isinstance(meta.get("video"), dict) else None
        report.add(
            "meta.video.path",
            actual == expect_video_path,
            f"meta.video.path={actual!r} expected={expect_video_path!r}",
        )
    if expect_people_empty:
        people_frames = people.get("frames")
        report.add(
            "people.frames.empty",
            isinstance(people_frames, list) and len(people_frames) == 0 and pose_frames == 0,
            f"people.frames={len(people_frames) if isinstance(people_frames, list) else people_frames!r} "
            f"pose.frames={pose_frames} (stale data from an earlier run would show up here)",
        )
    if min_pose_frames is not None:
        report.add(
            "pose.frames.minimum",
            pose_frames >= min_pose_frames,
            f"pose.frames={pose_frames} minimum={min_pose_frames}",
        )


def check_overwrite(out_dir: str, report: Report, not_before: float) -> None:
    stale: list[str] = []
    times: dict[str, float] = {}
    for name in OUTPUT_FILES:
        path = os.path.join(out_dir, name)
        mtime = os.stat(path).st_mtime
        times[name] = mtime
        if mtime < not_before:
            stale.append(f"{name} mtime={mtime:.3f}")
    report.add(
        "files.rewritten_after",
        not stale,
        f"notBefore={not_before:.3f} stale={stale} mtimes={ {k: round(v, 3) for k, v in times.items()} }",
    )


def run(args: argparse.Namespace) -> Report:
    report = Report(out_dir=args.out_dir)
    loaded = load_outputs(args.out_dir, report)
    if loaded is None:
        return report
    scenes, pose, people, ball, meta = (loaded[name] for name in OUTPUT_FILES)
    for name, value in zip(OUTPUT_FILES, (scenes, pose, people, ball, meta)):
        if not isinstance(value, dict):
            report.add("files.objects", False, f"{name} is {type(value).__name__}, expected object")
            return report

    check_pose_schema(pose, report)
    check_dimensions(pose, people, meta, report, args.expect_w, args.expect_h)
    check_landmarks(pose, people, report)
    check_timestamps(pose, people, scenes, report)
    check_fps(pose, people, meta, scenes, report, args.fps_tolerance, args.expect_fps)
    check_duration_and_scenes(
        scenes, meta, report, args.expect_cut_period_ms, args.expect_cut_count, args.expect_duration_ms
    )
    check_ball(ball, report)
    check_meta(
        meta, pose, people, scenes, report,
        args.expect_video_path, args.expect_people_empty, args.min_pose_frames,
    )
    if args.not_before is not None:
        check_overwrite(args.out_dir, report, args.not_before)
    return report


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("out_dir", help="directory passed to `swing-lab extract --out`")
    parser.add_argument("--expect-w", type=int, help="[rotated] required upright pose.video.w")
    parser.add_argument("--expect-h", type=int, help="[rotated] required upright pose.video.h")
    parser.add_argument("--expect-fps", type=float, help="[vfr] required pose.video.fps (±tolerance)")
    parser.add_argument(
        "--fps-tolerance", type=float, default=0.15,
        help="relative tolerance for fps comparisons (default 0.15 = ±15%%)",
    )
    parser.add_argument("--expect-duration-ms", type=int, help="required extract-meta.video.durationMs (±60ms)")
    parser.add_argument("--expect-cut-period-ms", type=int, help="[cuts] every cut must sit on this grid")
    parser.add_argument("--expect-cut-count", type=int, help="[cuts] exact number of cuts")
    parser.add_argument("--expect-video-path", help="[overwrite] required extract-meta.video.path")
    parser.add_argument(
        "--expect-people-empty", action="store_true",
        help="[overwrite] people.json and pose.json must contain zero frames",
    )
    parser.add_argument("--min-pose-frames", type=int, help="minimum pose.json frame count")
    parser.add_argument(
        "--not-before", type=float,
        help="[overwrite] Unix epoch seconds; every output file must have mtime >= this",
    )
    parser.add_argument("--report", help="write the JSON report here")
    parser.add_argument("--quiet", action="store_true", help="only print failures")
    return parser


def main(argv: Optional[list[str]] = None) -> int:
    args = build_parser().parse_args(argv)
    report = run(args)
    for check in report.checks:
        if args.quiet and check.ok:
            continue
        print(f"{'PASS' if check.ok else 'FAIL'}  {check.id}: {check.detail}")
    failed = report.failed
    print(f"{'OK' if not failed else 'BROKEN'}: {len(report.checks) - len(failed)}/{len(report.checks)} checks passed for {args.out_dir}")
    if args.report:
        os.makedirs(os.path.dirname(os.path.abspath(args.report)), exist_ok=True)
        with open(args.report, "w", encoding="utf-8") as handle:
            json.dump(report.to_json(), handle, indent=2, sort_keys=True)
            handle.write("\n")
    return 0 if not failed else 1


if __name__ == "__main__":
    sys.exit(main())
