"""Paddle candidate detector for swing-lab.

Runs D-FINE (Apache-2.0 code+weights, COCO-pretrained) over a video segment
and emits raw candidate detections per frame. A pickleball paddle has no COCO
class; the nearest proxy classes are kept and RECORDED AS SUCH — downstream
tracking/gating decides what is actually the paddle, and the provenance in
every artifact names the proxy so nobody mistakes this for a paddle-trained
model.

Detections are intentionally kept down to a low score floor: the tracker uses
high-score boxes to establish tracks and low-score boxes only to extend them
(ByteTrack-style two-stage association).

Output coordinates are PIXELS in the upright frame; the TS side normalizes.

Latency notes (W2, measured on afn-sasebo-rally2 event window, 74 frames):
  - The window decode itself was never the bottleneck: ffmpeg -ss/-to input
    seeking decodes exactly the requested span (74 frames, ~0.3s consumer
    wait). What P-latency called the "decode residual" (~17s) was per-
    detection `.tolist()`/`.item()` calls on MPS result tensors — ~61 kept
    detections/frame x 3 synced GPU->CPU transfers each ~= 170ms/frame.
    The default drain now copies the three result tensors to CPU once per
    frame and iterates in numpy; values are bit-equal (verified: baseline
    vs fixed outputs byte-identical on rally2 + wm-volley-02 windows).
  - `--stride N` now drops skipped frames inside ffmpeg (`select` filter) so
    they are never converted to rgb24 nor piped; previously every frame in
    the window was decoded+piped and Python skipped inference only.
  - Model load tries the local HF cache first (no hub HEAD round-trips,
    ~2-4s/invocation saved); falls back to network on cache miss.
  - `--legacy-decode` restores the old frame path (full-window rgb24 pipe +
    Python-side stride skip + per-detection tensor drain) for A/B audits.
  - `--decode-size WxH` (opt-in, NOT default) additionally scales frames
    inside ffmpeg before the pipe. D-FINE's processor resizes to 640x640
    regardless, but swscale-vs-PIL resampling changes pixels, so this path
    is only detection-EQUIVALENT (quantified via compare_paddle_dets.py),
    not bit-equal. Boxes are still emitted in full-res upright pixels.

Usage (one-shot, backward compatible):
  .venv/bin/python detect_paddle.py --video clip.mp4 --out dets.json \
      [--start-ms 0] [--end-ms 0=whole video] [--stride 1] [--floor 0.08] \
      [--roi x0,y0,x1,y1] [--legacy-decode] [--decode-size WxH]

Crop mode (crop-recovery-v1, W12 winner): run inference on explicit crop
rectangles instead of full frames. Detections are mapped back to full-frame
pixels and tagged source="crop" + cropRect so the TS tracker can gate them
(crop candidates only EXTEND tracks; they never start them):
  .venv/bin/python detect_paddle.py --video clip.mp4 --crops crops.json \
      --out crop-dets.json [--floor 0.08]
  crops.json: {"crops": [{"tMs": 2502.5, "rects": [{"x0":..,"y0":..,"x1":..,"y1":..}, ...]}]}
  Per-frame cross-rect NMS (IoU 0.55) unions the multi-scale crops.

Serve mode (persistent warm worker; model loads ONCE, then serves many
requests — kills the ~9-13s/invocation python+torch import + model load):
  .venv/bin/python detect_paddle.py --serve [--no-warmup]

  Protocol: JSON Lines over stdio (stdout is protocol-only; logs -> stderr).
    startup   <- {"event":"ready","protocol":"paddle-serve-v1","modelLoadSec":..,"warmupSec":..,"device":".."}
    request   -> {"id":"r1","video":"/abs.mp4","out":"/abs/dets.json",
                  "startMs":0,"endMs":0,"stride":1,"floor":0.08,"roi":null,
                  "decodeSize":null,"legacyDecode":false}
    response  <- {"id":"r1","ok":true,"out":"...","framesProcessed":74,
                  "paddleDetections":2833,"extras":1686,"timing":{...},"requestWallSec":..}
    ping      -> {"id":"p","op":"ping"}          <- {"id":"p","ok":true,"event":"pong"}
    shutdown  -> {"id":"q","op":"shutdown"}      <- {"id":"q","ok":true,"event":"shutdown"}, exit 0
    errors    <- {"id":..,"ok":false,"error":".."} (worker keeps serving); EOF on stdin -> exit 0.
  Each request writes the same schema paddle-dets.json as one-shot mode
  (timing.modelLoadSec is 0.0 — the load was paid once at worker startup).
"""

from __future__ import annotations

import argparse
import json
import math
import subprocess
import sys
import time
from pathlib import Path

import numpy as np
import torch
from PIL import Image

MODEL_ID = "ustc-community/dfine-medium-coco"
DETECTOR_VERSION = "dfine-medium-coco@transformers"
# COCO proxy classes a pickleball paddle plausibly lands in. Measured on real
# footage 2026-08: 'tennis racket' is the dominant hit; 'baseball bat' rare.
PADDLE_PROXY_LABELS = {"tennis racket", "baseball bat"}
# Recorded for future ball work; NOT integrated into analysis yet.
EXTRA_LABELS = {"sports ball"}

DEVICE = "mps" if torch.backends.mps.is_available() else "cpu"


def ffprobe_meta(video: str) -> tuple[int, int, float, float, float]:
    out = subprocess.run(
        [
            "ffprobe", "-v", "error", "-select_streams", "v:0",
            "-show_entries", "stream=width,height,avg_frame_rate,duration,start_time",
            "-of", "json", video,
        ],
        capture_output=True, text=True, check=True,
    )
    stream = json.loads(out.stdout)["streams"][0]
    num, den = stream["avg_frame_rate"].split("/")
    fps = float(num) / float(den)
    try:
        start_time_ms = float(stream.get("start_time", 0)) * 1000
    except (TypeError, ValueError):
        start_time_ms = 0.0
    return (
        int(stream["width"]), int(stream["height"]), fps,
        float(stream.get("duration", 0)) * 1000, start_time_ms,
    )


def plan_window_seek(start_ms: float, fps: float, start_time_ms: float = 0.0) -> tuple[int, float]:
    """Map a requested window start to absolute CFR frame indexing.

    Frame k of a CFR stream sits at pts = start_time + k/fps. ffmpeg's CLI
    adds the input's start_time to the `-ss` target, then emits the first
    frame whose pts >= target — so the seek value is expressed relative to
    stream start: frame index ceil((start - start_time) * fps), sought at
    index/fps floored to ffmpeg's millisecond CLI precision so the seek lands
    exactly on the frame's pts (never rounding up past it).
    """
    first_index = max(0, math.ceil((start_ms - start_time_ms) * fps / 1000.0 - 1e-6))
    seek_sec = math.floor(first_index / fps * 1000.0) / 1000.0
    return first_index, seek_sec


def frame_iter(
    video: str,
    start_ms: float,
    end_ms: float,
    width: int,
    height: int,
    fps: float,
    stride: int = 1,
    decode_size: tuple[int, int] | None = None,
    legacy: bool = False,
    start_time_ms: float = 0.0,
):
    """Decode upright RGB frames via ffmpeg rawvideo pipe (applies rotation).

    Yields (source_frame_index, t_ms, rgb) for frames the caller should run
    inference on, i.e. source indices 0, stride, 2*stride, … of the window.

    Default path: skipped frames are dropped inside ffmpeg (`select`), so only
    needed frames are rgb24-converted and piped; with `decode_size`, frames
    are additionally scaled in ffmpeg. Legacy path (`legacy=True`) preserves
    the original behavior byte-for-byte: no -vf, every window frame piped at
    full resolution, stride applied Python-side.
    """
    first_index, seek_sec = plan_window_seek(start_ms, fps, start_time_ms)
    args = ["ffmpeg", "-v", "error"]
    if start_ms > 0:
        args += ["-ss", f"{seek_sec:.3f}"]
    if end_ms > 0:
        # -to is adjusted by the input start_time exactly like -ss.
        args += ["-to", f"{max((end_ms - start_time_ms) / 1000, seek_sec + 0.001):.3f}"]
    args += ["-i", video]
    out_w, out_h = width, height
    if legacy:
        assert decode_size is None, "--decode-size is not part of the legacy decode path"
    else:
        vf = []
        if stride > 1:
            vf.append(f"select=not(mod(n\\,{stride}))")
        if decode_size is not None:
            out_w, out_h = decode_size
            vf.append(f"scale={out_w}:{out_h}:flags=bilinear")
        if vf:
            # -vsync vfr rather than -fps_mode: same semantics, also on ffmpeg < 5.1
            # (ffmpeg 4.4 rejects -fps_mode outright, which silently yielded zero
            # frames here because the pipe closed before the first frame).
            args += ["-vf", ",".join(vf), "-vsync", "vfr"]
    args += ["-f", "rawvideo", "-pix_fmt", "rgb24", "-"]
    # stdin=DEVNULL: ffmpeg reads inherited stdin for interactive commands and
    # would otherwise consume queued serve-mode request lines off the shared
    # protocol stdin (losing the request and hanging its client).
    proc = subprocess.Popen(args, stdout=subprocess.PIPE, stdin=subprocess.DEVNULL)
    frame_bytes = out_w * out_h * 3
    index = 0
    assert proc.stdout is not None
    while True:
        chunk = proc.stdout.read(frame_bytes)
        if len(chunk) < frame_bytes:
            break
        # Piped frame k is source frame k*stride (ffmpeg select) — or, on the
        # legacy path, source frame k with Python-side stride skip below.
        source_index = index if legacy else index * stride
        if not (legacy and source_index % stride != 0):
            # Constant-frame-rate assumption (our lab transcodes are CFR); the
            # timestamp model is recorded in the output for auditability.
            # tMs is the ABSOLUTE frame pts under the CFR model —
            # start_time + frame_index/fps: the first emitted frame is the
            # first frame with pts >= start, not a frame at exactly start_ms.
            t_ms = start_time_ms + (first_index + source_index) * 1000.0 / fps
            yield source_index, t_ms, np.frombuffer(chunk, dtype=np.uint8).reshape(out_h, out_w, 3)
        index += 1
    if proc.wait() != 0:
        raise RuntimeError(f"ffmpeg decode failed (exit {proc.returncode}) for {video}")


def load_model() -> tuple[object, object, float]:
    """Load processor+model, local HF cache first (saves ~2-4s of hub HEAD
    round-trips per invocation); network only on cache miss (first-ever run)."""
    from transformers import AutoImageProcessor, AutoModelForObjectDetection

    started = time.perf_counter()
    try:
        processor = AutoImageProcessor.from_pretrained(MODEL_ID, local_files_only=True)
        model = AutoModelForObjectDetection.from_pretrained(MODEL_ID, local_files_only=True)
    except Exception:
        print("detect_paddle: local model cache miss; fetching from HF hub", file=sys.stderr)
        processor = AutoImageProcessor.from_pretrained(MODEL_ID)
        model = AutoModelForObjectDetection.from_pretrained(MODEL_ID)
    model = model.to(DEVICE).eval()
    return processor, model, time.perf_counter() - started


def parse_roi(value) -> list[float] | None:
    if value is None:
        return None
    parts = [float(v) for v in value.split(",")] if isinstance(value, str) else [float(v) for v in value]
    assert len(parts) == 4 and all(0.0 <= v <= 1.0 for v in parts), "roi wants x0,y0,x1,y1 in [0,1]"
    return parts


def parse_decode_size(value) -> tuple[int, int] | None:
    if value is None:
        return None
    w, h = (int(v) for v in str(value).lower().split("x"))
    assert w >= 32 and h >= 32, "decode size wants WxH with both >= 32"
    return w, h


def run_window(
    processor,
    model,
    *,
    video: str,
    out: str,
    start_ms: float = 0.0,
    end_ms: float = 0.0,
    stride: int = 1,
    floor: float = 0.08,
    roi: list[float] | None = None,
    decode_size: tuple[int, int] | None = None,
    legacy_decode: bool = False,
    model_load_sec: float = 0.0,
) -> dict:
    """Detect over one video window and write the paddle-dets.json artifact.

    Output schema is identical to the pre-W2 script; box/score values on the
    default path are bit-equal to the legacy path (same decoded pixels, same
    model, batched instead of per-value GPU->CPU transfer)."""
    width, height, fps, duration_ms, start_time_ms = ffprobe_meta(video)
    frames_out = []
    infer_sec_total = 0.0
    wall_started = time.perf_counter()
    frames_processed = 0

    # Full-resolution crop bounds (legacy arithmetic, incl. +32px floor and
    # implicit clamp-to-frame from ndarray slicing) — detections are always
    # emitted in full-res upright pixels regardless of decode size.
    full_x0 = full_y0 = 0
    full_w, full_h = width, height
    if roi is not None:
        full_x0, full_y0 = int(roi[0] * width), int(roi[1] * height)
        full_x1 = min(max(full_x0 + 32, int(roi[2] * width)), width)
        full_y1 = min(max(full_y0 + 32, int(roi[3] * height)), height)
        full_w, full_h = full_x1 - full_x0, full_y1 - full_y0

    for _, t_ms, rgb in frame_iter(
        video, start_ms, end_ms, width, height, fps,
        stride=stride, decode_size=decode_size, legacy=legacy_decode,
        start_time_ms=start_time_ms,
    ):
        dec_h, dec_w = rgb.shape[0], rgb.shape[1]
        crop_x0 = crop_y0 = 0
        if roi is not None:
            crop_x0, crop_y0 = int(roi[0] * dec_w), int(roi[1] * dec_h)
            crop_x1 = max(crop_x0 + 32, int(roi[2] * dec_w))
            crop_y1 = max(crop_y0 + 32, int(roi[3] * dec_h))
            rgb = rgb[crop_y0:crop_y1, crop_x0:crop_x1]
        if decode_size is None:
            # Legacy-identical mapping: post-process to the cropped image size,
            # offset by the crop origin (both already in full-res pixels).
            target_h, target_w = rgb.shape[0], rgb.shape[1]
            off_x, off_y = crop_x0, crop_y0
        else:
            # Frames were scaled in ffmpeg: post-process straight to the
            # full-res crop size so boxes land in full-res pixels.
            target_h, target_w = full_h, full_w
            off_x, off_y = full_x0, full_y0
        image = Image.fromarray(rgb)
        infer_started = time.perf_counter()
        inputs = processor(images=image, return_tensors="pt").to(DEVICE)
        with torch.no_grad():
            outputs = model(**inputs)
        result = processor.post_process_object_detection(
            outputs, target_sizes=[(target_h, target_w)], threshold=floor
        )[0]
        infer_sec_total += time.perf_counter() - infer_started

        detections = []
        extras = []
        if legacy_decode:
            # Original drain, kept for A/B audits: one synced GPU->CPU
            # transfer per value (~170ms/frame measured at ~61 dets/frame).
            for box, score, label in zip(result["boxes"], result["scores"], result["labels"]):
                name = model.config.id2label[label.item()]
                bx = box.tolist()
                entry = {
                    "box": [round(bx[0] + off_x, 1), round(bx[1] + off_y, 1),
                            round(bx[2] + off_x, 1), round(bx[3] + off_y, 1)],
                    "score": round(score.item(), 4),
                    "label": name,
                }
                if name in PADDLE_PROXY_LABELS:
                    detections.append(entry)
                elif name in EXTRA_LABELS:
                    extras.append(entry)
        else:
            # W2 drain fix: batch the three result tensors to CPU once, then
            # iterate in numpy — bit-equal values, ~170ms/frame -> ~0.3ms.
            boxes_np = result["boxes"].detach().cpu().numpy()
            scores_np = result["scores"].detach().cpu().numpy()
            labels_np = result["labels"].detach().cpu().numpy()
            for i in range(boxes_np.shape[0]):
                name = model.config.id2label[int(labels_np[i])]
                if name in PADDLE_PROXY_LABELS:
                    bucket = detections
                elif name in EXTRA_LABELS:
                    bucket = extras
                else:
                    continue
                bx = boxes_np[i].tolist()
                bucket.append({
                    "box": [round(bx[0] + off_x, 1), round(bx[1] + off_y, 1),
                            round(bx[2] + off_x, 1), round(bx[3] + off_y, 1)],
                    "score": round(float(scores_np[i]), 4),
                    "label": name,
                })
        frames_out.append({"tMs": round(t_ms, 2), "detections": detections, "extras": extras})
        frames_processed += 1

    wall_sec = time.perf_counter() - wall_started
    detector_block = {
        "modelId": MODEL_ID,
        "version": DETECTOR_VERSION,
        "license": "Apache-2.0 (code and weights)",
        "device": DEVICE,
        "proxyLabels": sorted(PADDLE_PROXY_LABELS),
        "proxyNote": "COCO has no pickleball paddle class; these proxy classes are what the detector can actually claim.",
        "scoreFloor": floor,
        "roiNorm": roi,
        "stride": stride,
    }
    if decode_size is not None:
        # Opt-in provenance only — absent on the default path so the default
        # artifact stays schema-identical to pre-W2 outputs.
        detector_block["decodeSize"] = f"{decode_size[0]}x{decode_size[1]}"
    payload = {
        "schemaVersion": 1,
        "detector": detector_block,
        "video": {"path": video, "width": width, "height": height, "fps": fps,
                  "durationMs": duration_ms},
        "window": {"startMs": start_ms, "endMs": end_ms or duration_ms},
        "timestampModel": "constant_frame_rate",
        "timing": {
            "modelLoadSec": round(model_load_sec, 3),
            "framesProcessed": frames_processed,
            "inferenceSecTotal": round(infer_sec_total, 3),
            "inferenceMsPerFrame": round(1000 * infer_sec_total / max(1, frames_processed), 1),
            "wallSecTotal": round(wall_sec, 3),
        },
        "frames": frames_out,
    }
    Path(out).write_text(json.dumps(payload))
    return payload


def box_iou(a: list[float], b: list[float]) -> float:
    ix0, iy0 = max(a[0], b[0]), max(a[1], b[1])
    ix1, iy1 = min(a[2], b[2]), min(a[3], b[3])
    inter = max(0.0, ix1 - ix0) * max(0.0, iy1 - iy0)
    area_a = (a[2] - a[0]) * (a[3] - a[1])
    area_b = (b[2] - b[0]) * (b[3] - b[1])
    union = area_a + area_b - inter
    return inter / union if union > 0 else 0.0


def nms_union(entries: list[dict], iou_threshold: float = 0.55) -> list[dict]:
    """Cross-scale NMS union (W12): keep the highest-score box of each
    overlapping cluster across crop rects."""
    kept: list[dict] = []
    for entry in sorted(entries, key=lambda item: -item["score"]):
        if all(box_iou(entry["box"], other["box"]) < iou_threshold for other in kept):
            kept.append(entry)
    return kept


def decode_frames_at(video: str, frame_indices: list[int], width: int, height: int, fps: float):
    """Decode exactly the requested source frames under absolute CFR indexing
    (frame k at start_time + k/fps). Yields (frame_index, rgb).

    Seek strategy: input `-ss` at the first wanted frame's exact pts (the
    plan_window_seek arithmetic frame_iter already uses — floored to ffmpeg's
    millisecond CLI precision so the seek never lands past the frame; the
    naive `-ss <tMs>` one-frame-early defect from W12 does not apply because
    the seek target is derived FROM the frame index, not from an annotation
    timestamp). The select expression is rebased to post-seek output ordinals,
    and `-frames:v` stops the decode right after the last wanted frame instead
    of draining the rest of the clip."""
    wanted = sorted(set(frame_indices))
    if not wanted:
        return
    first_index = wanted[0]
    seek_sec = math.floor(first_index / fps * 1000.0) / 1000.0
    args = ["ffmpeg", "-v", "error"]
    if first_index > 0:
        args += ["-ss", f"{seek_sec:.3f}"]
    select = "+".join(f"eq(n\\,{idx - first_index})" for idx in wanted)
    args += [
        "-i", video,
        # -vsync vfr rather than -fps_mode: same semantics, also on ffmpeg < 5.1
        "-vf", f"select={select}", "-vsync", "vfr",
        "-frames:v", str(len(wanted)),
        "-f", "rawvideo", "-pix_fmt", "rgb24", "-",
    ]
    # stdin=DEVNULL: see decode path above — never let ffmpeg read the
    # serve-mode protocol stdin.
    proc = subprocess.Popen(args, stdout=subprocess.PIPE, stdin=subprocess.DEVNULL)
    frame_bytes = width * height * 3
    assert proc.stdout is not None
    position = 0
    while position < len(wanted):
        chunk = proc.stdout.read(frame_bytes)
        if len(chunk) < frame_bytes:
            break
        yield wanted[position], np.frombuffer(chunk, dtype=np.uint8).reshape(height, width, 3)
        position += 1
    if proc.wait() != 0:
        raise RuntimeError(f"ffmpeg decode failed (exit {proc.returncode}) for {video}")


def run_crops(
    processor,
    model,
    *,
    video: str,
    crops_path: str,
    out: str,
    floor: float = 0.08,
    model_load_sec: float = 0.0,
) -> dict:
    """Crop-mode inference (crop-recovery-v1): detect on explicit rectangles,
    map boxes back to full-frame pixels, tag every detection source="crop"
    with its cropRect, and NMS-union across the rects of each frame."""
    width, height, fps, duration_ms, _start_time_ms = ffprobe_meta(video)
    plan = json.loads(Path(crops_path).read_text())["crops"]
    by_frame: dict[int, dict] = {}
    for entry in plan:
        index = int(round(float(entry["tMs"]) * fps / 1000.0))
        by_frame.setdefault(index, {"tMs": float(entry["tMs"]), "rects": []})
        for rect in entry["rects"]:
            if isinstance(rect, dict):
                rect = [rect["x0"], rect["y0"], rect["x1"], rect["y1"]]
            by_frame[index]["rects"].append([float(v) for v in rect])

    frames_out = []
    infer_sec_total = 0.0
    crops_processed = 0
    wall_started = time.perf_counter()
    for frame_index, rgb in decode_frames_at(video, list(by_frame), width, height, fps):
        spec = by_frame[frame_index]
        detections: list[dict] = []
        extras: list[dict] = []
        for rect in spec["rects"]:
            x0 = max(0, min(width - 32, int(rect[0])))
            y0 = max(0, min(height - 32, int(rect[1])))
            x1 = min(width, max(x0 + 32, int(rect[2])))
            y1 = min(height, max(y0 + 32, int(rect[3])))
            crop = rgb[y0:y1, x0:x1]
            image = Image.fromarray(crop)
            infer_started = time.perf_counter()
            inputs = processor(images=image, return_tensors="pt").to(DEVICE)
            with torch.no_grad():
                outputs = model(**inputs)
            result = processor.post_process_object_detection(
                outputs, target_sizes=[(y1 - y0, x1 - x0)], threshold=floor
            )[0]
            infer_sec_total += time.perf_counter() - infer_started
            crops_processed += 1
            boxes_np = result["boxes"].detach().cpu().numpy()
            scores_np = result["scores"].detach().cpu().numpy()
            labels_np = result["labels"].detach().cpu().numpy()
            for i in range(boxes_np.shape[0]):
                name = model.config.id2label[int(labels_np[i])]
                if name in PADDLE_PROXY_LABELS:
                    bucket = detections
                elif name in EXTRA_LABELS:
                    bucket = extras
                else:
                    continue
                bx = boxes_np[i].tolist()
                bucket.append({
                    "box": [round(bx[0] + x0, 1), round(bx[1] + y0, 1),
                            round(bx[2] + x0, 1), round(bx[3] + y0, 1)],
                    "score": round(float(scores_np[i]), 4),
                    "label": name,
                    "source": "crop",
                    "cropRect": [x0, y0, x1, y1],
                })
        frames_out.append({
            "tMs": round(spec["tMs"], 2),
            "detections": nms_union(detections),
            "extras": nms_union(extras),
        })
    frames_out.sort(key=lambda frame: frame["tMs"])

    wall_sec = time.perf_counter() - wall_started
    payload = {
        "schemaVersion": 1,
        "mode": "crops",
        "cropRecoveryVersion": "crop-recovery-v1",
        "detector": {
            "modelId": MODEL_ID,
            "version": DETECTOR_VERSION,
            "license": "Apache-2.0 (code and weights)",
            "device": DEVICE,
            "proxyLabels": sorted(PADDLE_PROXY_LABELS),
            "proxyNote": "COCO has no pickleball paddle class; these proxy classes are what the detector can actually claim.",
            "scoreFloor": floor,
        },
        "video": {"path": video, "width": width, "height": height, "fps": fps,
                  "durationMs": duration_ms},
        "timestampModel": "constant_frame_rate_absolute_from_t0",
        "timing": {
            "modelLoadSec": round(model_load_sec, 3),
            "framesProcessed": len(frames_out),
            "cropsProcessed": crops_processed,
            "inferenceSecTotal": round(infer_sec_total, 3),
            "inferenceMsPerCrop": round(1000 * infer_sec_total / max(1, crops_processed), 1),
            "wallSecTotal": round(wall_sec, 3),
        },
        "frames": frames_out,
    }
    Path(out).write_text(json.dumps(payload))
    return payload


def serve(warmup: bool) -> None:
    """Persistent warm worker: JSONL requests on stdin, JSONL responses on
    stdout (protocol in module docstring). stdout is protocol-only."""
    processor, model, load_sec = load_model()
    warmup_sec = 0.0
    if warmup:
        # One dummy forward + full drain absorbs the first-inference MPS graph
        # compile (~0.5-0.6s measured in P §1.2) before the first request.
        started = time.perf_counter()
        dummy = Image.new("RGB", (1280, 720), (127, 127, 127))
        inputs = processor(images=dummy, return_tensors="pt").to(DEVICE)
        with torch.no_grad():
            outputs = model(**inputs)
        result = processor.post_process_object_detection(
            outputs, target_sizes=[(720, 1280)], threshold=0.08
        )[0]
        result["boxes"].detach().cpu().numpy()
        warmup_sec = time.perf_counter() - started
    ready = {
        "event": "ready",
        "protocol": "paddle-serve-v1",
        "modelLoadSec": round(load_sec, 3),
        "warmupSec": round(warmup_sec, 3),
        "device": DEVICE,
    }
    print(json.dumps(ready), flush=True)

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        request_id = None
        try:
            req = json.loads(line)
            request_id = req.get("id")
            op = req.get("op", "detect")
            if op == "ping":
                print(json.dumps({"id": request_id, "ok": True, "event": "pong"}), flush=True)
                continue
            if op == "shutdown":
                print(json.dumps({"id": request_id, "ok": True, "event": "shutdown"}), flush=True)
                return
            if op != "detect":
                raise ValueError(f"unknown op: {op}")
            started = time.perf_counter()
            payload = run_window(
                processor,
                model,
                video=req["video"],
                out=req["out"],
                start_ms=float(req.get("startMs", 0)),
                end_ms=float(req.get("endMs", 0)),
                stride=int(req.get("stride", 1)),
                floor=float(req.get("floor", 0.08)),
                roi=parse_roi(req.get("roi")),
                decode_size=parse_decode_size(req.get("decodeSize")),
                legacy_decode=bool(req.get("legacyDecode", False)),
                model_load_sec=0.0,  # paid once at worker startup, not per request
            )
            response = {
                "id": request_id,
                "ok": True,
                "out": req["out"],
                "framesProcessed": payload["timing"]["framesProcessed"],
                "paddleDetections": sum(len(f["detections"]) for f in payload["frames"]),
                "extras": sum(len(f["extras"]) for f in payload["frames"]),
                "timing": payload["timing"],
                "requestWallSec": round(time.perf_counter() - started, 3),
            }
            print(json.dumps(response), flush=True)
        except Exception as error:  # keep serving — one bad request must not kill the worker
            print(json.dumps({"id": request_id, "ok": False, "error": f"{type(error).__name__}: {error}"}), flush=True)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--video", required=False)
    parser.add_argument("--out", required=False)
    parser.add_argument("--start-ms", type=float, default=0)
    parser.add_argument("--end-ms", type=float, default=0)
    parser.add_argument("--stride", type=int, default=1)
    parser.add_argument("--floor", type=float, default=0.08)
    parser.add_argument(
        "--roi",
        default=None,
        help="normalized x0,y0,x1,y1 crop; boxes are mapped back to full-frame pixels. "
        "D-FINE runs at a fixed input size, so ROI is a QUALITY lever (paddle occupies "
        "more of the model input), not a per-frame latency lever.",
    )
    parser.add_argument(
        "--legacy-decode", action="store_true",
        help="restore the pre-W2 frame path (full-window full-res pipe, Python-side "
        "stride skip, per-detection tensor drain) for A/B audits.",
    )
    parser.add_argument(
        "--decode-size", default=None,
        help="OPT-IN WxH ffmpeg-side downscale before inference (e.g. 640x640). "
        "Changes pixel content vs the default path (swscale vs PIL resampling) — "
        "detection-equivalent only; quantify with compare_paddle_dets.py.",
    )
    parser.add_argument(
        "--serve", action="store_true",
        help="persistent warm worker: load the model once, then serve JSONL "
        "detect requests on stdin (protocol in module docstring).",
    )
    parser.add_argument("--no-warmup", action="store_true",
                        help="serve mode: skip the startup dummy inference")
    parser.add_argument(
        "--crops", default=None,
        help="crop-recovery-v1: JSON file of per-frame crop rectangles; "
        "detections come back full-frame-pixel, tagged source=crop + cropRect.",
    )
    args = parser.parse_args()

    if args.serve:
        serve(warmup=not args.no_warmup)
        return

    if not args.video or not args.out:
        parser.error("--video and --out are required (unless --serve)")

    if args.crops:
        processor, model, load_sec = load_model()
        payload = run_crops(
            processor,
            model,
            video=args.video,
            crops_path=args.crops,
            out=args.out,
            floor=args.floor,
            model_load_sec=load_sec,
        )
        print(
            f"detect_paddle --crops: {payload['timing']['framesProcessed']} frames, "
            f"{payload['timing']['cropsProcessed']} crops, "
            f"{payload['timing']['inferenceMsPerCrop']}ms/crop inference ({DEVICE}), "
            f"-> {args.out}"
        )
        return

    roi = parse_roi(args.roi)
    decode_size = parse_decode_size(args.decode_size)
    if args.legacy_decode and decode_size is not None:
        parser.error("--decode-size cannot be combined with --legacy-decode")

    processor, model, load_sec = load_model()
    payload = run_window(
        processor,
        model,
        video=args.video,
        out=args.out,
        start_ms=args.start_ms,
        end_ms=args.end_ms,
        stride=args.stride,
        floor=args.floor,
        roi=roi,
        decode_size=decode_size,
        legacy_decode=args.legacy_decode,
        model_load_sec=load_sec,
    )
    print(
        f"detect_paddle: {payload['timing']['framesProcessed']} frames, "
        f"{payload['timing']['inferenceMsPerFrame']}ms/frame inference ({DEVICE}), "
        f"-> {args.out}"
    )


if __name__ == "__main__":
    main()
