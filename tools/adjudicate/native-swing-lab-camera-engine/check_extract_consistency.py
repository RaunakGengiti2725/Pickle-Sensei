#!/usr/bin/env python3
"""Adjudication repro: swing-lab extract metadata vs decoded frame timestamps.

Usage: check_extract_consistency.py <swing-lab-extract dir> [--video <mp4>]

Reads extract-meta.json / pose.json / people.json / scenes.json written by
`swing-lab extract` (a Mac Full Verify artifact) and checks that the emitted
container metadata (nominalFps, durationMs, video.fps) agrees with the frame
timestamps the same run actually decoded (scenes.json scores carry one entry
per decoded frame). Optionally cross-checks the source video with ffprobe.

Exit 1 when any consistency check fails. Linux-runnable: no Apple frameworks.
"""
import json
import os
import shutil
import statistics
import subprocess
import sys

TOLERANCE = 0.10


def load(out, name):
    with open(os.path.join(out, name)) as fh:
        return json.load(fh)


def main(argv):
    if len(argv) < 2:
        sys.exit(__doc__)
    out = argv[1]
    video = None
    if "--video" in argv:
        video = argv[argv.index("--video") + 1]

    meta = load(out, "extract-meta.json")
    pose = load(out, "pose.json")
    people = load(out, "people.json")
    scenes = load(out, "scenes.json")

    decoded_ts = [s["t"] for s in scenes["scores"]]
    if len(decoded_ts) < 2:
        sys.exit("scenes.json carries fewer than 2 decoded frames; nothing to compare")
    deltas = [b - a for a, b in zip(decoded_ts, decoded_ts[1:])]
    decoded_fps = (len(decoded_ts) - 1) * 1000 / (decoded_ts[-1] - decoded_ts[0])
    last_pts_ms = decoded_ts[-1] + statistics.median(deltas)

    nominal_fps = meta["video"]["nominalFps"]
    duration_ms = meta["video"]["durationMs"]
    failures = []

    def check(label, emitted, measured):
        rel = abs(emitted - measured) / measured
        ok = rel <= TOLERANCE
        print(f"{'ok  ' if ok else 'FAIL'} {label}: emitted={emitted} measured={measured:.2f} rel_err={rel:.3f}")
        if not ok:
            failures.append(label)

    print(f"decoded frames={len(decoded_ts)} first={decoded_ts[0]}ms last={decoded_ts[-1]}ms median_dt={statistics.median(deltas)}ms")
    check("extract-meta.video.nominalFps vs decoded cadence", nominal_fps, decoded_fps)
    check("pose.video.fps vs decoded cadence", pose["video"]["fps"], decoded_fps)
    check("people.video.fps vs decoded cadence", people["video"]["fps"], decoded_fps)
    check("extract-meta.video.durationMs vs last decoded PTS", duration_ms, last_pts_ms)
    last_segment = scenes["segments"][-1]
    check("scenes.segments[-1].endMs vs last decoded PTS", last_segment["endMs"], last_pts_ms)

    if video and shutil.which("ffprobe"):
        probe = subprocess.run(
            ["ffprobe", "-v", "error", "-select_streams", "v:0", "-count_packets",
             "-show_entries", "stream=r_frame_rate,nb_read_packets:format=duration",
             "-of", "json", video],
            check=True, capture_output=True, text=True,
        )
        info = json.loads(probe.stdout)
        num, den = info["streams"][0]["r_frame_rate"].split("/")
        ff_fps = int(num) / int(den)
        ff_duration_ms = float(info["format"]["duration"]) * 1000
        ff_packets = int(info["streams"][0]["nb_read_packets"])
        print(f"ffprobe: r_frame_rate={ff_fps} duration={ff_duration_ms:.0f}ms packets={ff_packets}")
        check("extract-meta.video.nominalFps vs ffprobe r_frame_rate", nominal_fps, ff_fps)
        check("extract-meta.video.durationMs vs ffprobe duration", duration_ms, ff_duration_ms)
        if ff_packets != meta["framesSeen"]:
            print(f"FAIL framesSeen={meta['framesSeen']} != ffprobe packets={ff_packets}")
            failures.append("framesSeen vs ffprobe packets")
        else:
            print(f"ok   framesSeen={meta['framesSeen']} == ffprobe packets")

    if failures:
        print(f"\n{len(failures)} consistency failure(s): {failures}")
        return 1
    print("\nall consistency checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
