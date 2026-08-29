"""Ball candidate generation for swing-lab (motion-based, family C).

A pickleball is small, fast, blurred, and absent from many frames — per-frame
detection alone is not a ball perceiver. This stage only proposes CANDIDATES:
3-frame differencing (suppresses ghosting) → connected components → small,
motion-consistent blobs. Association, physics gating, and context suppression
happen downstream in TypeScript; nothing emitted here is "the ball".

Also emits a background-activity grid: cells where motion fires chronically
(crowd, flags, trees) so the tracker can demand more evidence there.

Pure numpy/scipy (BSD); no models, no training, no license risk.

Usage:
  .venv/bin/python ball_candidates.py --video clip.mp4 --out ball-candidates.json \
      [--start-ms 0] [--end-ms 0=whole] [--scale 0.5] [--max-per-frame 40]
"""

from __future__ import annotations

import argparse
import json
import subprocess
import time
from pathlib import Path

import numpy as np
from scipy import ndimage

GENERATOR_VERSION = "ball-diff-candidates-1"
GRID = 24


def ffprobe_meta(video: str) -> tuple[int, int, float, float]:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=width,height,avg_frame_rate,duration",
         "-of", "json", video],
        capture_output=True, text=True, check=True,
    )
    stream = json.loads(out.stdout)["streams"][0]
    num, den = stream["avg_frame_rate"].split("/")
    return int(stream["width"]), int(stream["height"]), float(num) / float(den), \
        float(stream.get("duration", 0)) * 1000


def gray_frames(video: str, start_ms: float, end_ms: float, out_w: int, out_h: int):
    args = ["ffmpeg", "-v", "error"]
    if start_ms > 0:
        args += ["-ss", f"{start_ms / 1000:.3f}"]
    if end_ms > 0:
        args += ["-to", f"{end_ms / 1000:.3f}"]
    args += ["-i", video, "-vf", f"scale={out_w}:{out_h}", "-f", "rawvideo",
             "-pix_fmt", "gray", "-"]
    proc = subprocess.Popen(args, stdout=subprocess.PIPE)
    size = out_w * out_h
    assert proc.stdout is not None
    index = 0
    while True:
        chunk = proc.stdout.read(size)
        if len(chunk) < size:
            break
        yield index, np.frombuffer(chunk, dtype=np.uint8).reshape(out_h, out_w).astype(np.float32)
        index += 1
    proc.wait()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--video", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--start-ms", type=float, default=0)
    parser.add_argument("--end-ms", type=float, default=0)
    parser.add_argument("--scale", type=float, default=0.5)
    parser.add_argument("--max-per-frame", type=int, default=40)
    # Area bounds are in DOWNSCALED pixels; ball ≈ 5–15 px diameter at 0.5×1080p,
    # motion-blur streaks stretch that; players/paddles are far larger.
    parser.add_argument("--min-area", type=int, default=3)
    parser.add_argument("--max-area", type=int, default=700)
    args = parser.parse_args()

    width, height, fps, duration_ms = ffprobe_meta(args.video)
    out_w, out_h = int(width * args.scale) // 2 * 2, int(height * args.scale) // 2 * 2
    start_ms = args.start_ms
    frame_ms = 1000.0 / fps

    started = time.perf_counter()
    frames_out = []
    activity = np.zeros((GRID, GRID), dtype=np.int32)
    processed = 0

    window = []  # rolling 3 grayscale frames
    for index, frame in gray_frames(args.video, start_ms, args.end_ms, out_w, out_h):
        window.append((index, frame))
        if len(window) < 3:
            continue
        if len(window) > 3:
            window.pop(0)
        (i0, f0), (i1, f1), (i2, f2) = window
        # 3-frame differencing: motion present NOW (no ghost at t-1 position).
        diff = np.minimum(np.abs(f1 - f0), np.abs(f2 - f1))
        threshold = max(10.0, float(diff.mean() + 3.5 * diff.std()))
        mask = diff > threshold

        # Background-activity accumulation (chronic motion cells).
        cell_h, cell_w = out_h / GRID, out_w / GRID
        ys, xs = np.nonzero(mask)
        if ys.size > 0:
            cells = np.unique(
                (np.minimum(ys / cell_h, GRID - 1).astype(int)) * GRID
                + np.minimum(xs / cell_w, GRID - 1).astype(int)
            )
            activity.flat[cells] += 1

        labels, count = ndimage.label(mask)
        candidates = []
        if count > 0:
            objects = ndimage.find_objects(labels)
            for label_index, slc in enumerate(objects, start=1):
                if slc is None:
                    continue
                region = labels[slc] == label_index
                area = int(region.sum())
                if area < args.min_area or area > args.max_area:
                    continue
                box_h = slc[0].stop - slc[0].start
                box_w = slc[1].stop - slc[1].start
                long_side, short_side = max(box_h, box_w), max(1, min(box_h, box_w))
                # Mass = summed motion energy — brighter/faster blobs score higher.
                mass = float(diff[slc][region].sum())
                cy = (slc[0].start + slc[0].stop) / 2 / out_h
                cx = (slc[1].start + slc[1].stop) / 2 / out_w
                candidates.append({
                    "x": round(cx, 4),
                    "y": round(cy, 4),
                    "areaPx": area,
                    "wNorm": round(box_w / out_w, 4),
                    "hNorm": round(box_h / out_h, 4),
                    "elong": round(long_side / short_side, 2),
                    "score": round(mass, 1),
                })
        # Two-pool selection: big movers dominate raw mass (limbs, paddles),
        # so ball-sized blobs get reserved slots or the ball never survives
        # the per-frame cap in noisy scenes.
        candidates.sort(key=lambda c: -c["score"])
        big_pool = candidates[: args.max_per_frame - 15]
        small_pool = [c for c in candidates if c["areaPx"] <= 150 and c not in big_pool][:15]
        frames_out.append({
            "tMs": round(start_ms + i1 * frame_ms, 2),
            "candidates": big_pool + small_pool,
            "rawComponentCount": int(count),
        })
        processed += 1

    wall = time.perf_counter() - started
    total_frames = max(1, processed)
    payload = {
        "schemaVersion": 1,
        "generator": {
            "version": GENERATOR_VERSION,
            "method": "3-frame differencing + connected components (numpy/scipy, BSD)",
            "scale": args.scale,
            "note": "Candidates only — association, physics, and context gating decide what is a ball downstream.",
        },
        "video": {"path": args.video, "width": width, "height": height, "fps": fps,
                  "durationMs": duration_ms},
        "window": {"startMs": start_ms, "endMs": args.end_ms or duration_ms},
        "timestampModel": "constant_frame_rate",
        "backgroundActivity": {
            "grid": GRID,
            "cells": [round(float(v) / total_frames, 3) for v in activity.flatten()],
        },
        "timing": {
            "framesProcessed": processed,
            "wallSecTotal": round(wall, 3),
            "msPerFrame": round(1000 * wall / total_frames, 2),
        },
        "frames": frames_out,
    }
    Path(args.out).write_text(json.dumps(payload))
    mean_candidates = (
        sum(len(f["candidates"]) for f in frames_out) / total_frames if frames_out else 0
    )
    print(
        f"ball_candidates: {processed} frames, {mean_candidates:.1f} candidates/frame, "
        f"{payload['timing']['msPerFrame']}ms/frame -> {args.out}"
    )


if __name__ == "__main__":
    main()
