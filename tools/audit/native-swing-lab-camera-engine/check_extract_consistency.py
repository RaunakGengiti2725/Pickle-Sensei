#!/usr/bin/env python3
"""Cross-check a `swing-lab extract --out <dir>` bundle against ITSELF.

`tools/macos-ci/check-swing-lab-extract.py` proves the bundle exists and has
the canonical pose format. This probe goes one step further and asks whether
the metadata the extractor WROTE (video.fps, video.durationMs, the last scene
segment) agrees with the frames the extractor DECODED (pose.json / people.json
frame timestamps and scenes.json per-frame scores). Any tool downstream of
people.json (`packages/swing-lab/src/playerTracker.ts` derives its
frame-interval loss gate from `video.fps`) trusts that metadata verbatim.

Optionally (`--video <path>`, needs ffprobe) the same numbers are compared
against the container so the reader can tell "the container lies" apart from
"the extractor lies".

Usage:
  python3 tools/audit/native-swing-lab-camera-engine/check_extract_consistency.py \
      <extract-out-dir> [--video path/to/clip.mp4] [--report out.json]

Exit 0 when every check holds, 1 when at least one fails, 2 on usage/IO errors.
Never edits the bundle. Audit probe only; not wired into any CI stage.
"""

from __future__ import annotations

import argparse
import json
import shutil
import statistics
import subprocess
import sys
from pathlib import Path

FPS_TOLERANCE = 0.10  # relative
DURATION_SLACK_FRAMES = 2  # durationMs may exceed the last frame by this many intervals


def load(path: Path) -> dict:
    with path.open() as handle:
        return json.load(handle)


def median_interval_ms(timestamps: list[int]) -> float | None:
    deltas = [b - a for a, b in zip(timestamps, timestamps[1:]) if b > a]
    if not deltas:
        return None
    return float(statistics.median(deltas))


def ffprobe_video(path: Path) -> dict | None:
    if shutil.which("ffprobe") is None:
        return None
    stream = subprocess.run(
        [
            "ffprobe", "-v", "error", "-select_streams", "v:0",
            "-show_entries", "stream=avg_frame_rate,r_frame_rate,duration",
            "-show_entries", "format=duration",
            "-of", "json", str(path),
        ],
        check=True, capture_output=True, text=True,
    )
    info = json.loads(stream.stdout)
    packets = subprocess.run(
        [
            "ffprobe", "-v", "error", "-select_streams", "v:0",
            "-show_entries", "packet=pts_time", "-of", "csv=p=0", str(path),
        ],
        check=True, capture_output=True, text=True,
    )
    pts = sorted(float(x) for x in packets.stdout.split() if x)
    num, den = info["streams"][0]["avg_frame_rate"].split("/")
    return {
        "avgFps": float(num) / float(den) if float(den) else None,
        "containerDurationMs": round(float(info["format"]["duration"]) * 1000),
        "frameCount": len(pts),
        "lastPtsMs": round(pts[-1] * 1000) if pts else None,
        "medianIntervalMs": median_interval_ms([round(p * 1000) for p in pts]),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("out_dir")
    parser.add_argument("--video", help="source clip; compared with ffprobe when available")
    parser.add_argument("--report", help="write the JSON verdict here")
    args = parser.parse_args()

    out = Path(args.out_dir)
    try:
        meta = load(out / "extract-meta.json")
        pose = load(out / "pose.json")
        people = load(out / "people.json")
        scenes = load(out / "scenes.json")
    except (OSError, json.JSONDecodeError) as error:
        print(f"check_extract_consistency: cannot read bundle: {error}", file=sys.stderr)
        return 2

    checks: list[dict] = []

    def check(name: str, ok: bool, detail: dict) -> None:
        checks.append({"name": name, "ok": bool(ok), **detail})

    pose_ts = [int(frame["t"]) for frame in pose["frames"]]
    score_ts = [int(score["t"]) for score in scenes.get("scores", [])]
    decoded_ts = score_ts or pose_ts  # scenes.scores has one entry per decoded frame after the first
    decoded_interval = median_interval_ms(decoded_ts)
    measured_fps = 1000.0 / decoded_interval if decoded_interval else None
    written_fps = float(pose["video"]["fps"])
    written_duration = int(meta["video"]["durationMs"])
    last_decoded = max(decoded_ts) if decoded_ts else None

    check(
        "pose.video.fps matches decoded frame cadence",
        measured_fps is not None and abs(written_fps - measured_fps) <= FPS_TOLERANCE * measured_fps,
        {"writtenFps": written_fps, "measuredFps": measured_fps, "medianIntervalMs": decoded_interval},
    )
    check(
        "people.video.fps == pose.video.fps",
        float(people["video"]["fps"]) == written_fps,
        {"peopleFps": people["video"]["fps"], "poseFps": written_fps},
    )
    check(
        "extract-meta.video.durationMs within a few frames of the last decoded frame",
        last_decoded is not None
        and decoded_interval is not None
        and last_decoded <= written_duration <= last_decoded + DURATION_SLACK_FRAMES * decoded_interval,
        {"writtenDurationMs": written_duration, "lastDecodedFrameMs": last_decoded},
    )
    segments = scenes.get("segments", [])
    last_segment_end = int(segments[-1]["endMs"]) if segments else None
    check(
        "last scene segment ends where the decoded video ends",
        last_segment_end is not None
        and last_decoded is not None
        and decoded_interval is not None
        and last_decoded <= last_segment_end <= last_decoded + DURATION_SLACK_FRAMES * decoded_interval,
        {"lastSegmentEndMs": last_segment_end, "lastDecodedFrameMs": last_decoded},
    )
    # Contract already pinned by tools/macos-ci/check-swing-lab-extract.py; repeated here so the
    # report is self-contained.
    check(
        "framesWithPose == len(pose.frames) == len(people.frames)",
        int(meta["framesWithPose"]) == len(pose_ts) == len(people["frames"]),
        {"framesWithPose": meta["framesWithPose"], "poseFrames": len(pose_ts), "peopleFrames": len(people["frames"])},
    )

    container = None
    if args.video:
        video = Path(args.video)
        if not video.is_file():
            print(f"check_extract_consistency: --video not found: {video}", file=sys.stderr)
            return 2
        container = ffprobe_video(video)
        if container is None:
            checks.append({"name": "container comparison", "ok": None, "detail": "ffprobe unavailable; skipped"})
        else:
            check(
                "extract-meta.video.durationMs matches container duration",
                abs(written_duration - container["containerDurationMs"]) <= DURATION_SLACK_FRAMES * (decoded_interval or 0) + 1,
                {"writtenDurationMs": written_duration, "containerDurationMs": container["containerDurationMs"]},
            )
            check(
                "extract-meta.framesSeen == container frame count",
                int(meta["framesSeen"]) == container["frameCount"],
                {"framesSeen": meta["framesSeen"], "containerFrames": container["frameCount"]},
            )
            check(
                "pose.video.fps matches container average fps",
                container["avgFps"] is not None and abs(written_fps - container["avgFps"]) <= FPS_TOLERANCE * container["avgFps"],
                {"writtenFps": written_fps, "containerAvgFps": container["avgFps"]},
            )

    failed = [c for c in checks if c["ok"] is False]
    verdict = {
        "tool": "check_extract_consistency",
        "outDir": str(out),
        "video": args.video,
        "ok": not failed,
        "checks": checks,
        "container": container,
    }
    if args.report:
        Path(args.report).parent.mkdir(parents=True, exist_ok=True)
        Path(args.report).write_text(json.dumps(verdict, indent=2) + "\n")

    for c in checks:
        mark = "PASS" if c["ok"] else ("SKIP" if c["ok"] is None else "FAIL")
        detail = {k: v for k, v in c.items() if k not in ("name", "ok")}
        print(f"{mark}  {c['name']}  {json.dumps(detail)}")
    print(f"check_extract_consistency: {len(checks) - len(failed)}/{len(checks)} checks hold")
    return 0 if not failed else 1


if __name__ == "__main__":
    sys.exit(main())
