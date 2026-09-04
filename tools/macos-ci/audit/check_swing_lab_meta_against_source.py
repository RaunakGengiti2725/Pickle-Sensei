#!/usr/bin/env python3
"""Cross-check `swing-lab extract` video metadata against the source container.

Usage: check_swing_lab_meta_against_source.py <out dir> [--video <path>] [--json <report>]

`extract-meta.json` records the input path the Mac run used (repo-relative)
plus `video.durationMs` / `video.nominalFps`, and pose.json publishes
`video.fps`. This script reads the SAME source file two independent ways —
ffprobe (libavformat) and a direct parse of the ISO-BMFF `mvhd`/`mdhd`/`sidx`
boxes — and asserts the CLI's declared duration and frame rate describe that
file. It is a Linux-side ground-truth check: ffprobe and the box parser have
no AVFoundation in the loop, so a disagreement isolates the CLI's
`asset.duration` / `track.nominalFrameRate` reading (main.swift:72-73,93-94)
from the container's own declarations.

Exit 0 when duration and fps agree within tolerance, 1 otherwise, 2 when the
source video or ffprobe is unavailable (NOT a pass).
"""
from __future__ import annotations

import json
import os
import shutil
import struct
import subprocess
import sys

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))


def ffprobe(video: str) -> dict:
    out = subprocess.run(
        [
            "ffprobe",
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-count_packets",
            "-show_entries",
            "stream=avg_frame_rate,r_frame_rate,duration,nb_read_packets",
            "-show_entries",
            "format=duration",
            "-of",
            "json",
            video,
        ],
        check=True,
        capture_output=True,
        text=True,
    ).stdout
    data = json.loads(out)
    stream = data["streams"][0]
    num, den = stream["avg_frame_rate"].split("/")
    return {
        "fps": float(num) / float(den),
        "stream_duration_s": float(stream["duration"]),
        "format_duration_s": float(data["format"]["duration"]),
        "packets": int(stream["nb_read_packets"]),
    }


def iso_bmff_durations(video: str) -> dict:
    """Movie-header, media-header and (for fragmented files) sidx durations in seconds."""
    with open(video, "rb") as fh:
        data = fh.read()
    result: dict = {}

    def walk(off: int, end: int) -> None:
        while off + 8 <= end:
            size, typ = struct.unpack(">I4s", data[off : off + 8])
            typ = typ.decode("latin1")
            hdr = 8
            if size == 1:
                size = struct.unpack(">Q", data[off + 8 : off + 16])[0]
                hdr = 16
            if size == 0:
                size = end - off
            body = off + hdr
            if typ in ("moov", "trak", "mdia"):
                walk(body, off + size)
            elif typ in ("mvhd", "mdhd"):
                version = data[body]
                if version == 0:
                    timescale, duration = struct.unpack(">II", data[body + 12 : body + 20])
                else:
                    timescale = struct.unpack(">I", data[body + 20 : body + 24])[0]
                    duration = struct.unpack(">Q", data[body + 24 : body + 32])[0]
                result[typ] = duration / timescale
            elif typ == "sidx":
                version = data[body]
                timescale = struct.unpack(">I", data[body + 8 : body + 12])[0]
                p = body + 20 if version == 0 else body + 28
                count = struct.unpack(">H", data[p + 2 : p + 4])[0]
                p += 4
                total = 0
                for _ in range(count):
                    _, sub_duration, _ = struct.unpack(">III", data[p : p + 12])
                    p += 12
                    total += sub_duration
                result["sidx"] = result.get("sidx", 0) + total / timescale
            off += size

    walk(0, len(data))
    return result


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print(__doc__)
        return 2
    out = argv[1]
    json_out = argv[argv.index("--json") + 1] if "--json" in argv else None
    with open(os.path.join(out, "extract-meta.json")) as fh:
        meta = json.load(fh)
    with open(os.path.join(out, "pose.json")) as fh:
        pose = json.load(fh)

    video = argv[argv.index("--video") + 1] if "--video" in argv else meta["video"]["path"]
    if not os.path.isabs(video):
        video = os.path.join(REPO_ROOT, video)
    if not os.path.isfile(video):
        print(f"SKIP source video not available at {video} (not a pass)")
        return 2
    if not shutil.which("ffprobe"):
        print("SKIP ffprobe not installed (not a pass)")
        return 2

    probe = ffprobe(video)
    boxes = iso_bmff_durations(video)
    declared_duration_s = meta["video"]["durationMs"] / 1000
    declared_nominal_fps = meta["video"]["nominalFps"]
    declared_pose_fps = pose["video"]["fps"]

    checks = []

    def check(name: str, ok: bool, detail: str) -> None:
        checks.append({"name": name, "ok": ok, "detail": detail})
        print(f"{'PASS' if ok else 'FAIL'} {name} — {detail}")

    print(f"INFO source {video}")
    print(f"INFO ffprobe fps={probe['fps']:.3f} stream_duration={probe['stream_duration_s']:.3f}s "
          f"format_duration={probe['format_duration_s']:.3f}s packets={probe['packets']}")
    print(f"INFO iso-bmff durations (s): {json.dumps({k: round(v, 3) for k, v in boxes.items()})}")
    print(f"INFO swing-lab declared durationMs={meta['video']['durationMs']} nominalFps={declared_nominal_fps} "
          f"pose.video.fps={declared_pose_fps} framesSeen={meta['framesSeen']}")

    check(
        "container self-consistent (ffprobe stream duration == mvhd == mdhd within 50 ms)",
        all(abs(boxes.get(k, probe["stream_duration_s"]) - probe["stream_duration_s"]) <= 0.05 for k in ("mvhd", "mdhd")),
        f"ffprobe {probe['stream_duration_s']:.3f}s mvhd {boxes.get('mvhd')} mdhd {boxes.get('mdhd')}",
    )
    check(
        "extract-meta video.durationMs matches the source duration within 2%",
        abs(declared_duration_s - probe["stream_duration_s"]) <= 0.02 * probe["stream_duration_s"],
        f"declared {declared_duration_s:.3f}s vs source {probe['stream_duration_s']:.3f}s",
    )
    check(
        "extract-meta video.nominalFps matches the source frame rate within 10%",
        abs(declared_nominal_fps - probe["fps"]) <= 0.10 * probe["fps"],
        f"declared {declared_nominal_fps} vs source {probe['fps']:.3f}",
    )
    check(
        "pose.json video.fps matches the source frame rate within 10%",
        abs(declared_pose_fps - probe["fps"]) <= 0.10 * probe["fps"],
        f"declared {declared_pose_fps} vs source {probe['fps']:.3f}",
    )
    check(
        "framesSeen == source video packet count",
        meta["framesSeen"] == probe["packets"],
        f"{meta['framesSeen']} vs {probe['packets']}",
    )

    failed = [c for c in checks if not c["ok"]]
    if json_out:
        with open(json_out, "w") as fh:
            json.dump(
                {"video": video, "ffprobe": probe, "iso_bmff": boxes, "declared": meta["video"],
                 "pose_video": pose["video"], "checks": checks},
                fh,
                indent=2,
            )
    print(f"{len(checks) - len(failed)} passed, {len(failed)} failed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
