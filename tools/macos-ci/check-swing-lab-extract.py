#!/usr/bin/env python3
"""Assert that a `swing-lab extract` run actually exercised the Apple Vision
pipeline AND that the timing it emitted describes the frames it decoded.

Usage: check-swing-lab-extract.py <out dir>

Checks that extract-meta.json / pose.json / people.json / scenes.json exist,
that the pose wire schema is `pickle.pose-sequence.v1`, that at least one
frame carried a detected pose, and that the container-level timing the run
wrote (extract-meta.video.nominalFps / durationMs, pose.video.fps,
people.video.fps, the final scenes.json segment) agrees with the presentation
timestamps of the frames it actually decoded (scenes.json `scores` carries one
raw PTS per decoded frame after the first). Downstream consumers derive their
frame interval and clip end from those fields, so a 2x disagreement silently
halves every gap threshold and appends phantom media to the clip.

Prints one-line summaries suitable for $GITHUB_STEP_SUMMARY on stdout and
exits non-zero on any failure.
"""
import json
import os
import statistics
import sys

TIMING_TOLERANCE = 0.10
MIN_DECODED_FRAMES = 2


def fail(message):
    sys.exit(f"::error::{message}")


def load(out, name):
    path = os.path.join(out, name)
    if not os.path.isfile(path):
        fail(f"swing-lab extract did not write {path}")
    with open(path) as fh:
        return json.load(fh)


def relative_error(emitted, measured):
    return abs(float(emitted) - measured) / measured


def main(argv):
    if len(argv) != 2:
        sys.exit(__doc__)
    out = argv[1]
    meta = load(out, "extract-meta.json")
    pose = load(out, "pose.json")
    people = load(out, "people.json")
    scenes = load(out, "scenes.json")

    frames_with_pose = int(meta.get("framesWithPose", 0))
    frames_seen = int(meta.get("framesSeen", 0))
    schema = pose.get("format")
    pose_frames = len(pose.get("frames", []))

    print(
        f"swing-lab Apple Vision extract: {frames_with_pose}/{frames_seen} frames with pose, "
        f"{meta.get('trajectoryCount', 0)} ball trajectories, model {meta.get('poseModelVersion')}, "
        f"{meta.get('wallTimeMs')} ms wall; pose.json format={schema} frames={pose_frames}"
    )

    if frames_seen <= 0:
        fail("the video reader produced no frames")
    if frames_with_pose <= 0 or pose_frames <= 0:
        fail("Apple Vision produced zero frames with a detected pose")
    if schema != "pickle.pose-sequence.v1":
        fail(f"unexpected pose.json format {schema!r}")

    decoded_ts = [int(score["t"]) for score in scenes.get("scores", [])]
    if len(decoded_ts) < MIN_DECODED_FRAMES:
        fail(f"scenes.json carries {len(decoded_ts)} decoded frame timestamps; need >= {MIN_DECODED_FRAMES}")
    if decoded_ts != sorted(decoded_ts) or len(set(decoded_ts)) != len(decoded_ts):
        fail("scenes.json decoded frame timestamps are not strictly increasing")
    span_ms = decoded_ts[-1] - decoded_ts[0]
    decoded_fps = (len(decoded_ts) - 1) * 1000 / span_ms
    median_frame_ms = statistics.median(b - a for a, b in zip(decoded_ts, decoded_ts[1:]))
    decoded_end_ms = decoded_ts[-1] + median_frame_ms
    print(
        f"swing-lab decoded timing: {len(decoded_ts)} timestamps, first={decoded_ts[0]}ms "
        f"last={decoded_ts[-1]}ms median_dt={median_frame_ms}ms cadence={decoded_fps:.3f} fps "
        f"end={decoded_end_ms:.0f}ms"
    )

    video = meta.get("video", {})
    segments = scenes.get("segments", [])
    if not segments:
        fail("scenes.json has no segments")
    timing_checks = [
        ("extract-meta.video.nominalFps vs decoded cadence", video.get("nominalFps"), decoded_fps),
        ("pose.video.fps vs decoded cadence", pose.get("video", {}).get("fps"), decoded_fps),
        ("people.video.fps vs decoded cadence", people.get("video", {}).get("fps"), decoded_fps),
        ("extract-meta.video.durationMs vs last decoded PTS", video.get("durationMs"), decoded_end_ms),
        ("scenes.segments[-1].endMs vs last decoded PTS", segments[-1].get("endMs"), decoded_end_ms),
    ]
    failures = []
    for label, emitted, measured in timing_checks:
        if not isinstance(emitted, (int, float)) or isinstance(emitted, bool):
            print(f"FAIL {label}: emitted={emitted!r} (missing or non-numeric)")
            failures.append(label)
            continue
        rel = relative_error(emitted, measured)
        ok = rel <= TIMING_TOLERANCE
        print(f"{'ok  ' if ok else 'FAIL'} {label}: emitted={emitted} measured={measured:.3f} rel_err={rel:.3f}")
        if not ok:
            failures.append(label)
    if failures:
        fail(
            f"{len(failures)} timing inconsistency(ies) between emitted metadata and decoded frames "
            f"(tolerance {TIMING_TOLERANCE:.0%}): {failures}"
        )
    print(f"swing-lab timing metadata agrees with decoded frames within {TIMING_TOLERANCE:.0%}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
