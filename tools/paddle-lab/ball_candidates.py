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

Frame clock: every emitted tMs is the ABSOLUTE pts of the frame that was
differenced — start_time + k/fps for source frame k, the same clock
detect_paddle.frame_iter stamps on paddle detections (frame_clock.py), so the
TypeScript tracker's 60 ms association gate is not eaten by container
start_time or a non-frame-aligned `-ss`.

Exit codes: 2 for invalid arguments (non-finite or out-of-range numbers —
--start-ms/--end-ms above frame_clock.MAX_TIME_MS, --scale above MAX_SCALE,
end <= start — are rejected by argparse before ffmpeg is spawned); 1 for
windows outside the clip, unprobeable input, ffmpeg errors or truncated/partial
media (ffmpeg stderr reports it, or fewer frames decode than the probe implies
— min(nb_frames, floor(duration*fps)) for a whole-clip decode, one frame of
`-to` boundary tolerance with --end-ms). A container with no stream, tag or
format duration decodes open-ended with one stderr notice that truncation
cannot be detected. The artifact is only written after a complete, successful
decode and is strict JSON (no NaN/Infinity literals).
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
from pathlib import Path

import numpy as np
from scipy import ndimage

import frame_clock

GENERATOR_VERSION = "ball-diff-candidates-1"
GRID = 24
# Reserved per-frame slots for ball-sized blobs (areaPx <= SMALL_AREA_PX) at
# the default cap; smaller caps split proportionally (see select_candidates).
SMALL_POOL_SLOTS = 15
SMALL_AREA_PX = 150


def ffprobe_meta(video: str) -> tuple[int, int, float, float, float]:
    """(width, height, fps, duration_ms, start_time_ms)."""
    meta = frame_clock.probe_stream(video)
    return meta.width, meta.height, meta.fps, meta.duration_ms, meta.start_time_ms


def gray_frames(
    video: str,
    start_ms: float,
    end_ms: float,
    out_w: int,
    out_h: int,
    *,
    fps: float | None = None,
    start_time_ms: float = 0.0,
    duration_ms: float = 0.0,
    nb_frames: int | None = None,
):
    """Yield (absolute_frame_index, t_ms, gray_float32) for the window [start_ms, end_ms).

    Seeks land exactly on frame k = ceil((start - start_time) * fps / 1000)
    (detect_paddle.plan_window_seek arithmetic) and every yielded frame is
    labelled with its own absolute pts. Raises ValueError for windows that
    cannot contain a frame and RuntimeError when ffmpeg fails, reports
    partial/corrupt media, or decodes fewer frames than the window implies
    (frame_clock.clip_frame_count without --end-ms; one `-to` boundary frame
    tolerated with it; no count when the clip duration is unknown).
    """
    if fps is None:
        meta = frame_clock.probe_stream(video)
        fps, start_time_ms, duration_ms, nb_frames = meta.fps, meta.start_time_ms, meta.duration_ms, meta.nb_frames
    first_index, last_exclusive = frame_clock.window_frame_range(
        start_ms, end_ms, fps, start_time_ms, duration_ms, nb_frames,
    )
    min_frames = frame_clock.min_frames_for_window(first_index, last_exclusive, bounded_end=end_ms > 0, video=video)
    seek_sec = frame_clock.seek_sec_for_frame_index(first_index, fps)
    args = ["ffmpeg", "-v", "error"]
    if start_ms > 0:
        args += ["-ss", f"{seek_sec:.3f}"]
    if end_ms > 0:
        args += ["-to", f"{frame_clock.window_to_sec(last_exclusive, fps, seek_sec):.3f}"]
    args += ["-i", video, "-vf", f"scale={out_w}:{out_h}", "-f", "rawvideo",
             "-pix_fmt", "gray", "-"]
    proc = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, stdin=subprocess.DEVNULL)
    stderr_reader = frame_clock.stderr_reader(proc)
    size = out_w * out_h
    assert proc.stdout is not None
    piped = 0
    drained = False
    try:
        while True:
            chunk = proc.stdout.read(size)
            if len(chunk) < size:
                drained = True
                break
            index = first_index + piped
            yield index, frame_clock.t_ms_for_frame_index(index, fps, start_time_ms), \
                np.frombuffer(chunk, dtype=np.uint8).reshape(out_h, out_w).astype(np.float32)
            piped += 1
    finally:
        if not drained:
            proc.kill()
        proc.stdout.close()
        proc.wait()
    stderr_text = stderr_reader()
    frame_clock.check_decode_health(proc.returncode, stderr_text, video)
    if piped < min_frames:
        raise RuntimeError(frame_clock.shortfall_message(
            piped, min_frames, first_index, last_exclusive, start_ms, end_ms, video, stderr_text,
        ))
    if stderr_text:
        print(f"ffmpeg: {frame_clock.stderr_tail(stderr_text)}", file=sys.stderr)


def select_candidates(candidates: list[dict], max_per_frame: int) -> list[dict]:
    """Two-pool selection honouring the cap for EVERY positive max_per_frame.

    Big movers dominate raw mass (limbs, paddles), so ball-sized blobs get
    reserved slots or the ball never survives the per-frame cap in noisy
    scenes. The small pool takes min(SMALL_POOL_SLOTS, cap // 2) slots (15 of
    the default 40, unchanged), the rest go to the top scorers; a small pool
    that underfills leaves the frame below the cap rather than backfilling.
    """
    ranked = sorted(candidates, key=lambda c: -c["score"])
    small_slots = min(SMALL_POOL_SLOTS, max_per_frame // 2)
    big_slots = max_per_frame - small_slots
    big_pool = ranked[:big_slots]
    small_pool = [c for c in ranked[big_slots:] if c["areaPx"] <= SMALL_AREA_PX][:small_slots]
    return big_pool + small_pool


def build_parser() -> argparse.ArgumentParser:
    # Numeric types are the shared bounded validators: nan/inf/1e400 and
    # finite-but-absurd values (--end-ms 1e308, --scale 1e6) exit 2 here.
    parser = argparse.ArgumentParser()
    parser.add_argument("--video", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--start-ms", type=frame_clock.time_ms, default=0,
                        help=f"absolute ms, 0..{frame_clock.MAX_TIME_MS:g}")
    parser.add_argument("--end-ms", type=frame_clock.time_ms, default=0,
                        help=f"absolute ms, 0..{frame_clock.MAX_TIME_MS:g}; 0 = to the end of the clip")
    parser.add_argument("--scale", type=frame_clock.scale_factor, default=0.5,
                        help=f"downscale factor, 0 < scale <= {frame_clock.MAX_SCALE:g}")
    parser.add_argument("--max-per-frame", type=frame_clock.positive_int, default=40)
    # Area bounds are in DOWNSCALED pixels; ball ≈ 5–15 px diameter at 0.5×1080p,
    # motion-blur streaks stretch that; players/paddles are far larger.
    parser.add_argument("--min-area", type=frame_clock.positive_int, default=3)
    parser.add_argument("--max-area", type=frame_clock.positive_int, default=700)
    return parser


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()
    if args.min_area > args.max_area:
        parser.error(f"--min-area ({args.min_area}) must not exceed --max-area ({args.max_area})")
    if args.end_ms > 0 and args.end_ms <= args.start_ms:
        parser.error(f"--end-ms ({args.end_ms:g}) must be greater than --start-ms ({args.start_ms:g})")

    try:
        meta = frame_clock.probe_stream(args.video)
    except (subprocess.CalledProcessError, ValueError, KeyError) as exc:
        detail = exc.stderr.strip() if isinstance(exc, subprocess.CalledProcessError) else str(exc)
        sys.exit(f"ball_candidates: cannot probe {args.video}: {detail}")
    width, height, fps, duration_ms, start_time_ms = meta.width, meta.height, meta.fps, meta.duration_ms, meta.start_time_ms
    out_w, out_h = int(width * args.scale) // 2 * 2, int(height * args.scale) // 2 * 2
    if out_w < 2 or out_h < 2:
        parser.error(f"--scale {args.scale:g} downsamples {width}x{height} to {out_w}x{out_h}; need at least 2x2")
    start_ms = args.start_ms
    try:
        first_index, last_exclusive = frame_clock.window_frame_range(
            start_ms, args.end_ms, fps, start_time_ms, duration_ms, meta.nb_frames,
        )
    except ValueError as exc:
        sys.exit(f"ball_candidates: invalid window for {args.video}: {exc}")
    if last_exclusive is not None and last_exclusive - first_index < 3:
        sys.exit(
            f"ball_candidates: window [{start_ms:g}, {args.end_ms or duration_ms:g}) ms holds "
            f"{last_exclusive - first_index} frame(s); 3-frame differencing needs at least 3"
        )

    started = time.perf_counter()
    try:
        decoded = gray_frames(
            args.video, start_ms, args.end_ms, out_w, out_h,
            fps=fps, start_time_ms=start_time_ms, duration_ms=duration_ms, nb_frames=meta.nb_frames,
        )
        frames_out, activity, processed = difference_frames(decoded, args, out_w, out_h)
    except RuntimeError as exc:
        sys.exit(f"ball_candidates: {exc}")
    if processed == 0:
        sys.exit(
            f"ball_candidates: window [{start_ms:g}, {args.end_ms or duration_ms:g}) ms of {args.video} decoded "
            "fewer than 3 frames; 3-frame differencing needs at least 3"
        )

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
                  "durationMs": duration_ms, "startTimeMs": start_time_ms},
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
    Path(args.out).write_text(json.dumps(payload, allow_nan=False))
    mean_candidates = (
        sum(len(f["candidates"]) for f in frames_out) / total_frames if frames_out else 0
    )
    print(
        f"ball_candidates: {processed} frames, {mean_candidates:.1f} candidates/frame, "
        f"{payload['timing']['msPerFrame']}ms/frame -> {args.out}"
    )


def difference_frames(decoded, args: argparse.Namespace, out_w: int, out_h: int) -> tuple[list[dict], np.ndarray, int]:
    """Run 3-frame differencing over the decoded stream; returns (frames, activity grid, processed)."""
    frames_out: list[dict] = []
    activity = np.zeros((GRID, GRID), dtype=np.int32)
    processed = 0
    window = []  # rolling 3 grayscale frames
    for index, t_ms, frame in decoded:
        window.append((index, t_ms, frame))
        if len(window) < 3:
            continue
        if len(window) > 3:
            window.pop(0)
        (_, _, f0), (_, t1_ms, f1), (_, _, f2) = window
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
        frames_out.append({
            "tMs": round(t1_ms, 2),
            "candidates": select_candidates(candidates, args.max_per_frame),
            "rawComponentCount": int(count),
        })
        processed += 1
    return frames_out, activity, processed


if __name__ == "__main__":
    main()
