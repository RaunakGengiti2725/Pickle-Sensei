#!/usr/bin/env python3
"""Structural contract checks over a real `swing-lab extract` output directory.

Usage: check_swing_lab_artifact_contracts.py <out dir> [--json <report path>]

Complements tools/macos-ci/check-swing-lab-extract.py (which only asserts the
pose wire format and a non-zero pose count) by pinning the OTHER artifacts the
CLI promises in native/swing-lab/Sources/main.swift:

  pose.json     schemaVersion 1 / format pickle.pose-sequence.v1 /
                coordinateSystem normalized_image_top_left / non-empty
                poseModelVersion / frames strictly increasing in t with
                i == 0..n-1 / every landmark has n,x,y,v / video.w,h > 0 /
                video.fps > 0
  people.json   schemaVersion 1, same poseModelVersion + video block as
                pose.json, frames strictly increasing, every frame non-empty
  scenes.json   schemaVersion 1, fixed detector string, cuts strictly
                increasing and within (0, durationMs], segments partition
                [0, durationMs] exactly, every score has t and d >= 0
  ball.json     source / cameraAssumption / pointTiming strings, trajectories
                sorted by startMs, endMs >= startMs, points timed linearly
                over [startMs, endMs] (first == startMs, last == endMs when
                more than one point), x/y within [0, 1] after the y flip,
                confidence within [0, 1]
  extract-meta  framesWithPose == len(pose.frames), framesSeen >=
                framesWithPose + poseMisses, trajectoryCount ==
                len(ball.trajectories), video.durationMs matches scenes'
                final segment end, poseModelVersion matches pose.json

Exit 0 when every check holds, 1 when any fails. Never fabricates: every
line printed is a check that ran against the files given.
"""
from __future__ import annotations

import json
import os
import sys

POSE_FORMAT = "pickle.pose-sequence.v1"
COORDINATE_SYSTEM = "normalized_image_top_left"
DETECTOR = "luma-histogram-chi2-1 (threshold 0.35, deterministic)"
BALL_SOURCE = "apple-vision-trajectories-1"


class Report:
    def __init__(self) -> None:
        self.checks: list[dict] = []

    def check(self, name: str, ok: bool, detail: str = "") -> bool:
        self.checks.append({"name": name, "ok": bool(ok), "detail": detail})
        print(f"{'PASS' if ok else 'FAIL'} {name}{(' — ' + detail) if detail else ''}")
        return bool(ok)

    @property
    def failed(self) -> list[dict]:
        return [c for c in self.checks if not c["ok"]]


def load(out: str, name: str):
    path = os.path.join(out, name)
    if not os.path.isfile(path):
        return None
    with open(path) as fh:
        return json.load(fh)


def strictly_increasing(values) -> tuple[bool, str]:
    for index in range(1, len(values)):
        if values[index] <= values[index - 1]:
            return False, f"index {index}: {values[index - 1]} -> {values[index]}"
    return True, ""


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print(__doc__)
        return 2
    out = argv[1]
    json_out = None
    if "--json" in argv:
        json_out = argv[argv.index("--json") + 1]
    report = Report()

    meta = load(out, "extract-meta.json")
    pose = load(out, "pose.json")
    people = load(out, "people.json")
    scenes = load(out, "scenes.json")
    ball = load(out, "ball.json")
    for name, obj in (
        ("extract-meta.json", meta),
        ("pose.json", pose),
        ("people.json", people),
        ("scenes.json", scenes),
        ("ball.json", ball),
    ):
        report.check(f"{name} exists and parses", obj is not None)
    if any(obj is None for obj in (meta, pose, people, scenes, ball)):
        return finish(report, json_out)

    # ── pose.json ────────────────────────────────────────────────────────────
    report.check("pose.schemaVersion == 1", pose.get("schemaVersion") == 1, repr(pose.get("schemaVersion")))
    report.check("pose.format", pose.get("format") == POSE_FORMAT, repr(pose.get("format")))
    report.check(
        "pose.coordinateSystem",
        pose.get("coordinateSystem") == COORDINATE_SYSTEM,
        repr(pose.get("coordinateSystem")),
    )
    model = pose.get("poseModelVersion")
    report.check("pose.poseModelVersion non-empty string", isinstance(model, str) and model != "", repr(model))
    video = pose.get("video") or {}
    report.check(
        "pose.video w/h positive ints",
        isinstance(video.get("w"), int) and isinstance(video.get("h"), int) and video["w"] > 0 and video["h"] > 0,
        repr(video),
    )
    fps = video.get("fps")
    report.check("pose.video.fps finite > 0", isinstance(fps, (int, float)) and fps > 0 and fps == fps, repr(fps))
    frames = pose.get("frames") or []
    report.check("pose.frames non-empty", len(frames) > 0, str(len(frames)))
    ts = [f.get("t") for f in frames]
    ok, detail = strictly_increasing(ts)
    report.check("pose.frames t strictly increasing", ok, detail)
    report.check(
        "pose.frames i == 0..n-1",
        all(f.get("i") == index for index, f in enumerate(frames)),
        "",
    )
    landmark_ok = True
    landmark_detail = ""
    for f in frames:
        for mark in f.get("l") or []:
            if not (
                isinstance(mark.get("n"), str)
                and all(isinstance(mark.get(k), (int, float)) for k in ("x", "y", "v"))
            ):
                landmark_ok = False
                landmark_detail = f"frame t={f.get('t')} landmark {mark!r}"
                break
        if not landmark_ok:
            break
    report.check("pose landmarks carry n/x/y/v", landmark_ok, landmark_detail)
    report.check(
        "pose confidence in [0,1]",
        all(isinstance(f.get("c"), (int, float)) and 0 <= f["c"] <= 1 for f in frames),
        "",
    )

    # fps consistency: if the decoded frame cadence is known, the declared fps
    # should describe the video, not the pose-hit subset.
    if len(ts) >= 2 and meta.get("framesSeen") and meta["video"].get("durationMs"):
        decoded_fps = (int(meta["framesSeen"]) - 1) * 1000 / max(1, int(meta["video"]["durationMs"]))
        pose_fps = (len(ts) - 1) * 1000 / max(1, ts[-1] - ts[0])
        print(
            f"INFO decoded-frame fps ≈ {decoded_fps:.3f}, pose-frame fps ≈ {pose_fps:.3f}, "
            f"nominalFps = {meta['video'].get('nominalFps')}, declared pose.video.fps = {fps}"
        )
        # When the container reports a nominal rate the CLI must publish it.
        nominal = meta["video"].get("nominalFps")
        if isinstance(nominal, (int, float)) and nominal > 0:
            report.check("pose.video.fps == nominalFps when nominal > 0", fps == nominal, f"{fps} vs {nominal}")
        # Pose frames are a SUBSET of decoded frames, so consecutive pose
        # frames can never be closer together than one video frame period.
        pose_dts = sorted(ts[i] - ts[i - 1] for i in range(1, len(ts)))
        median_pose_dt = pose_dts[len(pose_dts) // 2]
        frame_period_ms = 1000 / fps if fps else float("inf")
        report.check(
            "pose cadence never denser than video.fps (median pose dt >= 0.9 * 1000/fps)",
            median_pose_dt >= 0.9 * frame_period_ms,
            f"median pose dt {median_pose_dt} ms vs frame period {frame_period_ms:.2f} ms ({fps} fps)",
        )

    # scenes.scores carry one entry per decoded frame after the first, so
    # their cadence IS the decoded frame cadence and their last t IS the last
    # decoded frame — both must agree with the fps/duration the CLI declares.
    score_ts = [s.get("t") for s in (scenes.get("scores") or [])]
    if len(score_ts) >= 2 and fps:
        dts = sorted(score_ts[i] - score_ts[i - 1] for i in range(1, len(score_ts)))
        median_dt = dts[len(dts) // 2]
        decoded_fps = 1000 / median_dt if median_dt else float("inf")
        report.check(
            "declared video.fps within 25% of decoded frame cadence (scenes.scores)",
            abs(decoded_fps - fps) <= 0.25 * fps,
            f"decoded ≈ {decoded_fps:.2f} fps (median dt {median_dt} ms) vs declared {fps} fps",
        )
        duration_ms = int(meta["video"]["durationMs"])
        report.check(
            "last decoded frame within 2 frame periods of video.durationMs",
            duration_ms - score_ts[-1] <= 2 * (1000 / fps) + 1,
            f"last decoded t {score_ts[-1]} ms vs durationMs {duration_ms} ms",
        )

    # ── people.json ──────────────────────────────────────────────────────────
    report.check("people.schemaVersion == 1", people.get("schemaVersion") == 1, repr(people.get("schemaVersion")))
    report.check(
        "people.poseModelVersion == pose.poseModelVersion",
        people.get("poseModelVersion") == model,
        repr(people.get("poseModelVersion")),
    )
    report.check("people.video == pose.video", people.get("video") == video, "")
    pframes = people.get("frames") or []
    ok, detail = strictly_increasing([f.get("t") for f in pframes])
    report.check("people.frames t strictly increasing", ok, detail)
    report.check(
        "people.frames every frame has >= 1 person with c/l",
        all(
            isinstance(f.get("p"), list)
            and len(f["p"]) >= 1
            and all(isinstance(p.get("c"), (int, float)) and isinstance(p.get("l"), list) for p in f["p"])
            for f in pframes
        ),
        "",
    )
    pose_ts = set(ts)
    people_ts = {f.get("t") for f in pframes}
    report.check(
        "every pose frame t also appears in people.json",
        pose_ts <= people_ts,
        f"{len(pose_ts - people_ts)} pose frames missing from people.json",
    )

    # ── scenes.json ──────────────────────────────────────────────────────────
    duration_ms = int(meta["video"]["durationMs"])
    report.check("scenes.schemaVersion == 1", scenes.get("schemaVersion") == 1, repr(scenes.get("schemaVersion")))
    report.check("scenes.detector fixed string", scenes.get("detector") == DETECTOR, repr(scenes.get("detector")))
    cuts = scenes.get("cuts") or []
    ok, detail = strictly_increasing(cuts)
    report.check("scenes.cuts strictly increasing", ok, detail)
    report.check(
        "scenes.cuts within (0, durationMs]",
        all(isinstance(c, int) and 0 < c <= duration_ms for c in cuts),
        f"min={min(cuts) if cuts else None} max={max(cuts) if cuts else None} duration={duration_ms}",
    )
    segments = scenes.get("segments") or []
    partition_ok = bool(segments) and segments[0].get("startMs") == 0 and segments[-1].get("endMs") == duration_ms
    for index in range(1, len(segments)):
        if segments[index].get("startMs") != segments[index - 1].get("endMs"):
            partition_ok = False
            break
    report.check("scenes.segments partition [0, durationMs]", partition_ok, f"{len(segments)} segments")
    report.check(
        "scenes.segments every segment endMs > startMs",
        all(s.get("endMs") > s.get("startMs") for s in segments),
        "",
    )
    report.check(
        "scenes.segments == cuts + 1",
        len(segments) == len(cuts) + 1,
        f"{len(segments)} vs {len(cuts)}",
    )
    scores = scenes.get("scores") or []
    report.check(
        "scenes.scores t increasing, d >= 0",
        strictly_increasing([s.get("t") for s in scores])[0]
        and all(isinstance(s.get("d"), (int, float)) and s["d"] >= 0 for s in scores),
        f"{len(scores)} scores",
    )
    report.check(
        "every cut has a score entry with d > 0.35",
        all(any(s.get("t") == c and s.get("d") > 0.35 for s in scores) for c in cuts),
        "",
    )

    # ── ball.json ────────────────────────────────────────────────────────────
    report.check("ball.source", ball.get("source") == BALL_SOURCE, repr(ball.get("source")))
    report.check("ball.cameraAssumption == stationary", ball.get("cameraAssumption") == "stationary", "")
    report.check(
        "ball.pointTiming == linear_over_time_range",
        ball.get("pointTiming") == "linear_over_time_range",
        "",
    )
    trajectories = ball.get("trajectories") or []
    starts = [t.get("startMs") for t in trajectories]
    report.check(
        "ball.trajectories sorted by startMs (non-decreasing)",
        all(starts[i] >= starts[i - 1] for i in range(1, len(starts))),
        "",
    )
    reversed_ranges = [t for t in trajectories if t.get("endMs") < t.get("startMs")]
    report.check("ball.trajectories endMs >= startMs", not reversed_ranges, f"{len(reversed_ranges)} reversed")
    ids = [t.get("id") for t in trajectories]
    report.check("ball.trajectories ids unique", len(set(ids)) == len(ids), f"{len(ids) - len(set(ids))} duplicates")
    timing_ok = True
    timing_detail = ""
    range_ok = True
    range_detail = ""
    for t in trajectories:
        pts = t.get("points") or []
        if not pts:
            timing_ok = False
            timing_detail = f"trajectory {t.get('id')} has no points"
            break
        pt_ts = [p.get("t") for p in pts]
        if pt_ts[0] != t["startMs"] or (len(pts) > 1 and pt_ts[-1] != t["endMs"]):
            timing_ok = False
            timing_detail = f"trajectory {t.get('id')} points span {pt_ts[0]}..{pt_ts[-1]} vs {t['startMs']}..{t['endMs']}"
            break
        if any(pt_ts[i] < pt_ts[i - 1] for i in range(1, len(pt_ts))):
            timing_ok = False
            timing_detail = f"trajectory {t.get('id')} point times decrease"
            break
        for p in pts:
            if not (0 <= p.get("x") <= 1 and 0 <= p.get("y") <= 1):
                range_ok = False
                range_detail = f"trajectory {t.get('id')} point {p!r}"
                break
        if not range_ok:
            break
    report.check("ball points timed linearly over [startMs, endMs]", timing_ok, timing_detail)
    report.check("ball points x/y within [0,1]", range_ok, range_detail)
    report.check(
        "ball confidence within [0,1]",
        all(isinstance(t.get("confidence"), (int, float)) and 0 <= t["confidence"] <= 1 for t in trajectories),
        "",
    )
    report.check(
        "ball trajectories end within durationMs",
        all(t.get("endMs") <= duration_ms for t in trajectories),
        "",
    )

    # ── extract-meta.json ────────────────────────────────────────────────────
    report.check(
        "meta.framesWithPose == len(pose.frames)",
        meta.get("framesWithPose") == len(frames),
        f"{meta.get('framesWithPose')} vs {len(frames)}",
    )
    report.check(
        "meta.framesSeen >= framesWithPose + poseMisses",
        int(meta.get("framesSeen", 0)) >= int(meta.get("framesWithPose", 0)) + int(meta.get("poseMisses", 0)),
        f"{meta.get('framesSeen')} vs {meta.get('framesWithPose')} + {meta.get('poseMisses')}",
    )
    report.check(
        "meta.trajectoryCount == len(ball.trajectories)",
        meta.get("trajectoryCount") == len(trajectories),
        f"{meta.get('trajectoryCount')} vs {len(trajectories)}",
    )
    report.check(
        "meta.poseModelVersion == pose.poseModelVersion",
        meta.get("poseModelVersion") == model,
        "",
    )
    report.check(
        "meta.video w/h == pose.video w/h",
        meta["video"].get("w") == video.get("w") and meta["video"].get("h") == video.get("h"),
        "",
    )
    report.check("meta.wallTimeMs >= 0 int", isinstance(meta.get("wallTimeMs"), int) and meta["wallTimeMs"] >= 0, "")
    report.check(
        "last pose frame t <= durationMs",
        not ts or ts[-1] <= duration_ms,
        f"{ts[-1] if ts else None} vs {duration_ms}",
    )

    return finish(report, json_out)


def finish(report: Report, json_out: str | None) -> int:
    summary = {
        "checks": report.checks,
        "passed": len(report.checks) - len(report.failed),
        "failed": len(report.failed),
    }
    if json_out:
        with open(json_out, "w") as fh:
            json.dump(summary, fh, indent=2)
    print(f"{summary['passed']} passed, {summary['failed']} failed")
    return 1 if report.failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
