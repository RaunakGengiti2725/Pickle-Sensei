"""W12 (wave-b) RESEARCH PROBE — edge-on / motion-blur paddle recovery study.

Question: the D-FINE proxy detector never boxes the target's own paddle when it
is edge-on or motion-blurred (afn-sasebo-rally2 overhead blur ~2604ms, edge-on
carry ~3005ms; wm-dink-01 wrong-player episode 1680-2160ms happens while the
target paddle is edge-on at the hip). Which CHEAP strategy actually recovers
those S0 misses, and at what precision/runtime cost?

Strategies measured against a full-frame baseline on the exact same frames:
  a) wrist-conditioned crops at 2-3 scales (pose.json wrists), boxes mapped back
  b) lower confidence floor on those crops (precision cost on control frames)
  c) temporal propagation (nearest confident anchor + wrist-anchored offset)
     -> emitted as kind=TRACKED_ESTIMATE, NEVER as a detection
  d) cheap test-time augmentation on the crop (hflip + slight rotations)

Provenance / hygiene:
  - detect_paddle.py is owned by another workstream and is NOT modified; its
    importable helpers (ffprobe_meta, frame_iter, model constants) are imported.
    Its model-load + inference code lives inline in detect_paddle.main(), so the
    minimal load/infer calls are duplicated here (research-only duplication).
  - Reads ONLY sandbox run copies under datasets/experiments/wave-b/W12-runs/
    (canonical runs/ dirs untouched) + the read-only annotation bundle + videos.
  - Writes ONLY under datasets/experiments/wave-b/W12-probe/.
  - wm-dink-01 is a HELD-OUT case: its 1680-2160ms frames are extracted for the
    DIAGNOSTIC section only; every threshold / strategy choice in the report is
    justified on afn-sasebo-rally2 (development split) evidence alone.
  - Every emitted box carries "kind": "DETECTED" (model output on real pixels)
    or "TRACKED_ESTIMATE" (propagated/predicted). They are never mixed.

Usage (run with tools/paddle-lab/.venv/bin/python):
  edge_on_probe.py extract     # decode probe frames -> PNG + manifest
  edge_on_probe.py grid        # render annotation aids (pixel-grid images)
  edge_on_probe.py detect      # baseline + crop/TTA strategies (one pass)
  edge_on_probe.py propagate   # TRACKED_ESTIMATE boxes across miss windows
  edge_on_probe.py truthviz    # overlay visual-truth boxes for verification
  edge_on_probe.py score       # metrics vs visual truth -> strategy-report.json
"""

from __future__ import annotations

import argparse
import json
import math
import time
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont

# Importable pieces of the busy detector tool (read-only import, no edits).
from detect_paddle import (  # noqa: E402
    DETECTOR_VERSION,
    DEVICE,
    EXTRA_LABELS,
    MODEL_ID,
    PADDLE_PROXY_LABELS,
    ffprobe_meta,
    frame_iter,
)

REPO = Path(__file__).resolve().parents[2]
BENCH = REPO / "datasets" / "paddle-bench"
WAVE_B = REPO / "datasets" / "experiments" / "wave-b"
RUNS_SANDBOX = WAVE_B / "W12-runs"          # sandbox copies (never canonical)
OUT = WAVE_B / "W12-probe"                   # all probe artifacts live here
ANNOTATOR_ID = "devin-visual-v2-wave-b"

# Inference floor: intentionally very low; operating floors are applied at
# score time so one inference pass yields every floor curve.
INFER_FLOOR = 0.03
CROP_SCALES = (256, 448, 704)               # px, square, wrist-centered
WRIST_JOINTS = ("right_wrist", "left_wrist")
POSE_MATCH_MS = 25.0                         # frame<->pose timestamp tolerance
WRIST_CARRY_MS = 150.0                       # carry a missing wrist this far

PROBE_PLAN = [
    # afn-sasebo-rally2 (DEV) — known S0 miss windows, dense stride-1
    {"case": "afn-sasebo-rally2", "group": "rally2_missA_overhead_blur",
     "windowMs": (2504, 2705), "note": "overhead swing blur, contact 2620"},
    {"case": "afn-sasebo-rally2", "group": "rally2_missB_edgeon_carry",
     "windowMs": (2905, 3105), "note": "edge-on carry at right thigh"},
    # controls: pre-stroke frames where the (rising) paddle IS detected today
    {"case": "afn-sasebo-rally2", "group": "rally2_control",
     "frameIndices": [62, 64, 65, 66, 68, 69],
     "note": "pre-stroke (< prep 2350ms); baseline already boxes the paddle"},
    # wm-dink-01 (HELD-OUT) — DIAGNOSTIC ONLY, never used for tuning
    {"case": "wm-dink-01", "group": "dink_diag_HELDOUT",
     "windowMs": (1680, 2160), "note": "wrong-player episode; edge-on at hip"},
]

CASES = {
    "afn-sasebo-rally2": {
        "video": BENCH / "videos" / "afn-sasebo-rally2.mp4",
        "run": RUNS_SANDBOX / "afn-sasebo-rally2",
        "annotation": BENCH / "bundles" / "afn-sasebo-rally2" / "annotation" / "devin-visual-v1.json",
        "split": "development",
    },
    "wm-dink-01": {
        "video": BENCH / "videos" / "wm-dink-nearplayer.mp4",
        "run": RUNS_SANDBOX / "wm-dink-01",
        "annotation": BENCH / "bundles" / "wm-dink-01" / "annotation" / "devin-visual-v1.json",
        "split": "held_out",
    },
}


# ---------------------------------------------------------------- utilities

def load_json(p: Path):
    return json.loads(Path(p).read_text())


def dump_json(p: Path, obj) -> None:
    p.parent.mkdir(parents=True, exist_ok=True)
    Path(p).write_text(json.dumps(obj, indent=1, allow_nan=False))


def font(size: int = 20):
    try:
        return ImageFont.load_default(size=size)
    except TypeError:  # very old Pillow
        return ImageFont.load_default()


def iou(a, b) -> float:
    ax0, ay0, ax1, ay1 = a
    bx0, by0, bx1, by1 = b
    ix0, iy0 = max(ax0, bx0), max(ay0, by0)
    ix1, iy1 = min(ax1, bx1), min(ay1, by1)
    iw, ih = max(0.0, ix1 - ix0), max(0.0, iy1 - iy0)
    inter = iw * ih
    if inter <= 0:
        return 0.0
    ua = (ax1 - ax0) * (ay1 - ay0) + (bx1 - bx0) * (by1 - by0) - inter
    return inter / ua if ua > 0 else 0.0


def nms(boxes, thr=0.55):
    """boxes: list of dicts with 'box' and 'score'. Greedy IoU NMS."""
    out = []
    for b in sorted(boxes, key=lambda d: -d["score"]):
        if all(iou(b["box"], k["box"]) < thr for k in out):
            out.append(b)
    return out


def case_meta(case: str):
    meta = load_json(CASES[case]["run"] / "pose.json")["video"]
    return meta["w"], meta["h"], meta["fps"]


def pose_frames(case: str):
    return load_json(CASES[case]["run"] / "pose.json")["frames"]


def wrists_at(case: str, t_ms: float):
    """Wrist pixel positions near t_ms from the SANDBOX pose copy.

    Returns {joint: {x,y,v,src}}; falls back to the nearest pose frame within
    WRIST_CARRY_MS when the joint is missing at the matched frame (src=carried).
    """
    w, h, _ = case_meta(case)
    frames = pose_frames(case)
    out = {}
    for joint in WRIST_JOINTS:
        best = None
        for f in frames:
            dt = abs(f["t"] - t_ms)
            if dt > WRIST_CARRY_MS:
                continue
            lm = next((l for l in f["l"] if l["n"] == joint and l["v"] >= 0.05
                       and (l["x"] != 0 or l["y"] != 0)), None)
            if lm is None:
                continue
            if best is None or dt < best[0]:
                best = (dt, lm)
        if best is not None:
            dt, lm = best
            out[joint] = {"x": lm["x"] * w, "y": lm["y"] * h, "v": lm["v"],
                          "src": "matched" if dt <= POSE_MATCH_MS else f"carried_{dt:.0f}ms"}
    return out


def plan_frames():
    """Resolve PROBE_PLAN into concrete (case, frameIndex, tMs, group) rows."""
    rows = []
    for item in PROBE_PLAN:
        case = item["case"]
        _, _, fps = case_meta(case)
        dt = 1000.0 / fps
        if "frameIndices" in item:
            idxs = item["frameIndices"]
        else:
            lo, hi = item["windowMs"]
            idxs = [i for i in range(0, 100000)
                    if lo - dt / 2 <= i * dt <= hi + dt / 2]
        for i in idxs:
            rows.append({"case": case, "frameIndex": i, "tMs": round(i * dt, 2),
                         "group": item["group"]})
    return rows


def frame_png(case: str, idx: int) -> Path:
    return OUT / "frames" / f"{case}-i{idx:04d}.png"


def annotation_target_points(case: str):
    ann = load_json(CASES[case]["annotation"])
    w, h, _ = case_meta(case)
    return [{"tMs": p["tMs"], "x": p["point"]["x"] * w, "y": p["point"]["y"] * h}
            for p in ann.get("paddleFrames", []) if p.get("point")]


# ---------------------------------------------------------------- extract

def cmd_extract(_args) -> None:
    rows = plan_frames()
    by_case = {}
    for r in rows:
        by_case.setdefault(r["case"], []).append(r)
    for case, items in by_case.items():
        video = str(CASES[case]["video"])
        width, height, fps, _dur, _start = ffprobe_meta(video)
        wanted = {r["frameIndex"]: r for r in items}
        max_idx = max(wanted)
        n_saved = 0
        # decode from t=0 so frame index == absolute CFR index (matches run dets)
        for index, t_ms, rgb in frame_iter(video, 0, 0, width, height, fps):
            if index > max_idx:
                break
            if index in wanted:
                Image.fromarray(rgb).save(frame_png(case, index))
                wanted[index]["tMs"] = round(t_ms, 2)
                n_saved += 1
        print(f"extract: {case}: saved {n_saved}/{len(items)} frames")
    dump_json(OUT / "frames-manifest.json", {
        "workstream": "W12", "createdBy": ANNOTATOR_ID,
        "note": "probe frames; dink_diag_HELDOUT group is diagnostic-only (held-out case)",
        "frames": rows,
    })
    print(f"extract: manifest -> {OUT / 'frames-manifest.json'} ({len(rows)} frames)")


# ---------------------------------------------------------------- grid (annotation aid)

def draw_grid(draw: ImageDraw.ImageDraw, x0, y0, x1, y1, step, off_x, off_y, scale, color, fnt):
    """Grid labeled in FULL-FRAME pixel coords over a pasted region."""
    gx = math.ceil(x0 / step) * step
    while gx <= x1:
        px = off_x + (gx - x0) * scale
        draw.line([(px, off_y), (px, off_y + (y1 - y0) * scale)], fill=color, width=1)
        draw.text((px + 2, off_y + 2), str(int(gx)), fill=color, font=fnt)
        gx += step
    gy = math.ceil(y0 / step) * step
    while gy <= y1:
        py = off_y + (gy - y0) * scale
        draw.line([(off_x, py), (off_x + (x1 - x0) * scale, py)], fill=color, width=1)
        draw.text((off_x + 2, py + 2), str(int(gy)), fill=color, font=fnt)
        gy += step


def cmd_grid(_args) -> None:
    manifest = load_json(OUT / "frames-manifest.json")["frames"]
    fnt, fnt_big = font(16), font(24)
    for r in manifest:
        case, idx, t_ms = r["case"], r["frameIndex"], r["tMs"]
        img = Image.open(frame_png(case, idx)).convert("RGB")
        W, H = img.size
        wrists = wrists_at(case, t_ms)
        # left panel: full frame at 0.5x with 100px grid + wrist markers
        s = 0.5
        panel_w = int(W * s)
        crop_view = 420  # display size of each wrist zoom
        crop_src = 560   # source px around wrist
        canvas = Image.new("RGB", (panel_w + crop_view * len(WRIST_JOINTS) + 30,
                                   max(int(H * s), crop_view + 60) + 40), (16, 16, 16))
        canvas.paste(img.resize((panel_w, int(H * s))), (0, 40))
        d = ImageDraw.Draw(canvas)
        d.text((6, 6), f"{case} i{idx} t={t_ms}ms [{r['group']}] full@0.5x grid=100px",
               fill=(255, 255, 120), font=fnt_big)
        draw_grid(d, 0, 0, W, H, 100, 0, 40, s, (70, 70, 70), fnt)
        for j, (joint, wr) in enumerate(sorted(wrists.items())):
            cx, cy = wr["x"], wr["y"]
            d.ellipse([cx * s - 5, 40 + cy * s - 5, cx * s + 5, 40 + cy * s + 5],
                      outline=(0, 255, 255), width=2)
            d.text((cx * s + 6, 40 + cy * s - 18), joint[0].upper() + "W",
                   fill=(0, 255, 255), font=fnt)
        # annotation points near this time (target paddle, +-20ms)
        for p in annotation_target_points(case):
            if abs(p["tMs"] - t_ms) <= 20:
                d.ellipse([p["x"] * s - 6, 40 + p["y"] * s - 6,
                           p["x"] * s + 6, 40 + p["y"] * s + 6], outline=(255, 0, 255), width=2)
                d.text((p["x"] * s + 8, 40 + p["y"] * s), "annPt", fill=(255, 0, 255), font=fnt)
        # right panels: wrist zooms with 50px grid
        for j, (joint, wr) in enumerate(sorted(wrists.items())):
            cx, cy = wr["x"], wr["y"]
            x0 = int(min(max(0, cx - crop_src / 2), max(0, W - crop_src)))
            y0 = int(min(max(0, cy - crop_src / 2), max(0, H - crop_src)))
            x1, y1 = min(W, x0 + crop_src), min(H, y0 + crop_src)
            zoom = img.crop((x0, y0, x1, y1)).resize((crop_view, crop_view))
            ox = panel_w + 15 + j * (crop_view + 15)
            canvas.paste(zoom, (ox, 40))
            sc = crop_view / crop_src
            draw_grid(d, x0, y0, x1, y1, 50, ox, 40, sc, (80, 80, 80), fnt)
            d.ellipse([ox + (cx - x0) * sc - 6, 40 + (cy - y0) * sc - 6,
                       ox + (cx - x0) * sc + 6, 40 + (cy - y0) * sc + 6],
                      outline=(0, 255, 255), width=2)
            d.text((ox, 40 + crop_view + 4),
                   f"{joint} v={wr['v']:.2f} ({wr['src']}) zoom {crop_src}px grid=50px",
                   fill=(0, 255, 255), font=fnt)
        out = OUT / "grids" / f"{case}-i{idx:04d}-grid.png"
        canvas.save(out)
    print(f"grid: rendered {len(manifest)} annotation aids -> {OUT / 'grids'}")


def cmd_zoom(args) -> None:
    """Targeted high-zoom render with fine grid for the visual-truth pass."""
    img = Image.open(frame_png(args.case, args.idx)).convert("RGB")
    W, H = img.size
    half = args.half
    x0, y0, x1, y1 = crop_bounds(args.cx, args.cy, 2 * half, W, H)
    view_w = 840
    sc = view_w / (x1 - x0)
    zoom = img.crop((x0, y0, x1, y1)).resize((view_w, int((y1 - y0) * sc)), Image.LANCZOS)
    canvas = Image.new("RGB", (zoom.width, zoom.height + 30), (16, 16, 16))
    canvas.paste(zoom, (0, 30))
    d = ImageDraw.Draw(canvas)
    fnt = font(15)
    d.text((6, 4), f"{args.case} i{args.idx} zoom cx={args.cx} cy={args.cy} half={half} "
                   f"grid={args.grid}px", fill=(255, 255, 120), font=fnt)
    draw_grid(d, x0, y0, x1, y1, args.grid, 0, 30, sc, (90, 90, 90), fnt)
    if args.show_dets:
        _, _, fps = case_meta(args.case)
        t_ms = args.idx * 1000.0 / fps
        run_dets = load_json(CASES[args.case]["run"] / "paddle-dets.json")["frames"]
        near = min(run_dets, key=lambda f: abs(f["tMs"] - t_ms))
        if abs(near["tMs"] - t_ms) <= 20:
            for det in near["detections"]:
                if det["score"] < args.det_floor:
                    continue
                bx = det["box"]
                if bx[2] < x0 or bx[0] > x1 or bx[3] < y0 or bx[1] > y1:
                    continue
                rect = [(bx[0] - x0) * sc, 30 + (bx[1] - y0) * sc,
                        (bx[2] - x0) * sc, 30 + (bx[3] - y0) * sc]
                d.rectangle(rect, outline=(255, 60, 60), width=2)
                d.text((rect[0] + 2, rect[1] + 2), f"{det['score']:.2f}",
                       fill=(255, 60, 60), font=fnt)
    out = OUT / "grids" / f"{args.case}-i{args.idx:04d}-zoom-{int(args.cx)}x{int(args.cy)}.png"
    canvas.save(out)
    print(out)


# ---------------------------------------------------------------- detection core

def load_model():
    from transformers import AutoImageProcessor, AutoModelForObjectDetection
    import torch
    t0 = time.perf_counter()
    processor = AutoImageProcessor.from_pretrained(MODEL_ID)
    model = AutoModelForObjectDetection.from_pretrained(MODEL_ID).to(DEVICE).eval()
    return processor, model, torch, time.perf_counter() - t0


def infer(processor, model, torch, image: Image.Image, floor: float):
    inputs = processor(images=image, return_tensors="pt").to(DEVICE)
    with torch.no_grad():
        outputs = model(**inputs)
    result = processor.post_process_object_detection(
        outputs, target_sizes=[(image.height, image.width)], threshold=floor)[0]
    dets, extras = [], []
    for box, score, label in zip(result["boxes"], result["scores"], result["labels"]):
        name = model.config.id2label[label.item()]
        entry = {"box": [round(v, 1) for v in box.tolist()],
                 "score": round(score.item(), 4), "label": name}
        if name in PADDLE_PROXY_LABELS:
            dets.append(entry)
        elif name in EXTRA_LABELS:
            extras.append(entry)
    return dets, extras


def crop_bounds(cx, cy, size, W, H):
    x0 = int(min(max(0, cx - size / 2), max(0, W - size)))
    y0 = int(min(max(0, cy - size / 2), max(0, H - size)))
    return x0, y0, min(W, x0 + size), min(H, y0 + size)


def map_back(dets, x0, y0):
    return [{**d, "box": [round(d["box"][0] + x0, 1), round(d["box"][1] + y0, 1),
                          round(d["box"][2] + x0, 1), round(d["box"][3] + y0, 1)]}
            for d in dets]


def unrotate_box(box, angle_deg, cx, cy):
    """Map a box from a rotated crop back to unrotated crop coords (AABB of corners)."""
    a = math.radians(angle_deg)  # PIL rotate(angle) is counter-clockwise; invert
    cos_a, sin_a = math.cos(-a), math.sin(-a)
    x0, y0, x1, y1 = box
    pts = [(x0, y0), (x1, y0), (x0, y1), (x1, y1)]
    out = []
    for px, py in pts:
        dx, dy = px - cx, py - cy
        out.append((cx + dx * cos_a - dy * sin_a, cy + dx * sin_a + dy * cos_a))
    xs, ys = [p[0] for p in out], [p[1] for p in out]
    return [min(xs), min(ys), max(xs), max(ys)]


def cmd_detect(_args) -> None:
    manifest = load_json(OUT / "frames-manifest.json")["frames"]
    processor, model, torch, load_sec = load_model()
    print(f"detect: model loaded in {load_sec:.1f}s on {DEVICE}")
    timing: dict[str, list[float]] = {}
    frames_out = []

    def run(strategy, image, floor=INFER_FLOOR):
        t0 = time.perf_counter()
        dets, extras = infer(processor, model, torch, image, floor)
        timing.setdefault(strategy, []).append(time.perf_counter() - t0)
        return dets, extras

    for r in manifest:
        case, idx, t_ms = r["case"], r["frameIndex"], r["tMs"]
        img = Image.open(frame_png(case, idx)).convert("RGB")
        W, H = img.size
        wrists = wrists_at(case, t_ms)
        results = []

        base_dets, base_extras = run("baseline_fullframe", img)
        results.append({"strategy": "baseline_fullframe", "kind": "DETECTED",
                        "cropPx": None, "boxes": base_dets, "extras": base_extras})

        for joint, wr in sorted(wrists.items()):
            for size in CROP_SCALES:
                x0, y0, x1, y1 = crop_bounds(wr["x"], wr["y"], size, W, H)
                crop = img.crop((x0, y0, x1, y1))
                name = f"crop{size}_{joint}"
                dets, _ = run(name, crop)
                results.append({"strategy": name, "kind": "DETECTED",
                                "cropPx": [x0, y0, x1, y1],
                                "boxes": map_back(dets, x0, y0)})
            # TTA on the mid scale (448) crop
            size = CROP_SCALES[1]
            x0, y0, x1, y1 = crop_bounds(wr["x"], wr["y"], size, W, H)
            crop = img.crop((x0, y0, x1, y1))
            cw, ch = crop.size
            flip = crop.transpose(Image.FLIP_LEFT_RIGHT)
            dets, _ = run(f"tta_hflip_{joint}", flip)
            dets = [{**d, "box": [cw - d["box"][2], d["box"][1], cw - d["box"][0], d["box"][3]]}
                    for d in dets]
            results.append({"strategy": f"tta_hflip_{joint}", "kind": "DETECTED",
                            "cropPx": [x0, y0, x1, y1], "boxes": map_back(dets, x0, y0)})
            for ang in (12, -12):
                rot = crop.rotate(ang, resample=Image.BILINEAR, fillcolor=(114, 114, 114))
                dets, _ = run(f"tta_rot{ang:+d}_{joint}", rot)
                dets = [{**d, "box": [round(v, 1) for v in
                                      unrotate_box(d["box"], ang, cw / 2, ch / 2)]}
                        for d in dets]
                results.append({"strategy": f"tta_rot{ang:+d}_{joint}", "kind": "DETECTED",
                                "cropPx": [x0, y0, x1, y1], "boxes": map_back(dets, x0, y0)})

        frames_out.append({**r, "wrists": {j: {k: (round(v, 1) if isinstance(v, float) else v)
                                               for k, v in wr.items()}
                                           for j, wr in wrists.items()},
                           "results": results})
        print(f"detect: {case} i{idx} t={t_ms} done "
              f"({sum(len(x['boxes']) for x in results)} raw boxes)")

    payload = {
        "schemaVersion": 1, "workstream": "W12",
        "detector": {"modelId": MODEL_ID, "version": DETECTOR_VERSION, "device": DEVICE,
                     "proxyLabels": sorted(PADDLE_PROXY_LABELS), "inferenceFloor": INFER_FLOOR,
                     "note": "boxes are kind=DETECTED model outputs; operating floors applied at score time"},
        "timing": {"modelLoadSec": round(load_sec, 2),
                   "perStrategyMsPerFrame": {k: round(1000 * sum(v) / len(v), 1)
                                             for k, v in sorted(timing.items())},
                   "inferences": {k: len(v) for k, v in sorted(timing.items())}},
        "frames": frames_out,
    }
    dump_json(OUT / "probe-dets.json", payload)
    print(f"detect: -> {OUT / 'probe-dets.json'}")
    print(json.dumps(payload["timing"]["perStrategyMsPerFrame"], indent=1))


# ---------------------------------------------------------------- propagation (TRACKED_ESTIMATE)

def target_anchor_dets(case: str):
    """Confident target-paddle detections from the SANDBOX stride-1 run dets.

    Timestamp correction (measured, see visual-truth.json timestampCaveat): the
    run dets were produced with an ffmpeg -ss input seek and sit one frame
    EARLY vs absolute CFR indexing — verified by a pixel-identical box (run
    '2470.63' == probe i75/2502.5). Anchor tMs are shifted +1 frame here.

    Anchor rule (justified on rally2 dev evidence): score >= 0.30, box center
    within 0.06*imageWidth of the time-interpolated annotation target-paddle
    point track, and only inside the annotated track's time span +-150ms (no
    extrapolation — outside it we cannot distinguish the target's paddle from
    far-court players without peeking at W12 truth). Propagation is therefore
    an annotation-informed upper bound, labeled as such in the report.
    """
    w, h, fps = case_meta(case)
    frame_ms = 1000.0 / fps
    dets = load_json(CASES[case]["run"] / "paddle-dets.json")["frames"]
    pts = sorted(annotation_target_points(case), key=lambda p: p["tMs"])
    if not pts:
        return []
    radius = 0.06 * w

    def track_at(t):
        if t <= pts[0]["tMs"]:
            return pts[0]
        if t >= pts[-1]["tMs"]:
            return pts[-1]
        for a, b in zip(pts, pts[1:]):
            if a["tMs"] <= t <= b["tMs"]:
                f = (t - a["tMs"]) / max(1e-6, b["tMs"] - a["tMs"])
                return {"x": a["x"] + f * (b["x"] - a["x"]),
                        "y": a["y"] + f * (b["y"] - a["y"])}
        return pts[-1]

    anchors = []
    for f in dets:
        t = f["tMs"] + frame_ms  # off-by-one correction
        if not (pts[0]["tMs"] - 150 <= t <= pts[-1]["tMs"] + 150):
            continue
        ref = track_at(t)
        best = None
        for d in f["detections"]:
            if d["score"] < 0.30:
                continue
            cx, cy = (d["box"][0] + d["box"][2]) / 2, (d["box"][1] + d["box"][3]) / 2
            dist = math.hypot(cx - ref["x"], cy - ref["y"])
            if dist <= radius and (best is None or d["score"] > best["score"]):
                best = {**d, "tMs": round(t, 2), "distToTrackPx": round(dist, 1)}
        if best:
            anchors.append(best)
    return anchors


def cmd_propagate(_args) -> None:
    manifest = load_json(OUT / "frames-manifest.json")["frames"]
    out_frames = []
    for case in {"afn-sasebo-rally2"}:  # propagation is a rally2 (dev) experiment
        anchors = target_anchor_dets(case)
        print(f"propagate: {case}: {len(anchors)} anchor dets "
              f"{[(a['tMs'], a['score']) for a in anchors]}")
        miss_rows = [r for r in manifest if r["case"] == case and "miss" in r["group"]]
        for r in miss_rows:
            t = r["tMs"]
            before = max((a for a in anchors if a["tMs"] < t), key=lambda a: a["tMs"], default=None)
            after = min((a for a in anchors if a["tMs"] > t), key=lambda a: a["tMs"], default=None)
            entries = []

            def wrist_for(anchor):
                wr = wrists_at(case, anchor["tMs"])
                bx = ((anchor["box"][0] + anchor["box"][2]) / 2,
                      (anchor["box"][1] + anchor["box"][3]) / 2)
                if not wr:
                    return None, None
                joint = min(wr, key=lambda j: math.hypot(wr[j]["x"] - bx[0], wr[j]["y"] - bx[1]))
                return joint, wr[joint]

            # mode 1: hold last confident box (classic coast)
            if before is not None:
                entries.append({"mode": "hold_last", "kind": "TRACKED_ESTIMATE",
                                "box": before["box"], "sourceTMs": [before["tMs"]],
                                "ageMs": round(t - before["tMs"], 1)})
            # mode 2: linear interpolation between anchors (needs both sides)
            if before is not None and after is not None:
                f = (t - before["tMs"]) / max(1e-6, after["tMs"] - before["tMs"])
                box = [round(b + f * (a - b), 1) for b, a in zip(before["box"], after["box"])]
                entries.append({"mode": "interp_anchors", "kind": "TRACKED_ESTIMATE",
                                "box": box, "sourceTMs": [before["tMs"], after["tMs"]]})
            # mode 3: wrist-anchored offset carry/interp
            wr_now_all = wrists_at(case, t)
            if before is not None and wr_now_all:
                joint_b, wr_b = wrist_for(before)
                offs = []
                if joint_b and wr_b:
                    bb = before["box"]
                    offs.append((0.0 if after is None else 0.0, joint_b, wr_b, bb, before["tMs"]))
                if offs:
                    _, joint, wr_anchor, bb, src_t = offs[0]
                    off_x = (bb[0] + bb[2]) / 2 - wr_anchor["x"]
                    off_y = (bb[1] + bb[3]) / 2 - wr_anchor["y"]
                    bw, bh = bb[2] - bb[0], bb[3] - bb[1]
                    src = [src_t]
                    if after is not None:
                        joint_a, wr_a = wrist_for(after)
                        if joint_a and wr_a:
                            ab = after["box"]
                            aoff_x = (ab[0] + ab[2]) / 2 - wr_a["x"]
                            aoff_y = (ab[1] + ab[3]) / 2 - wr_a["y"]
                            f = (t - before["tMs"]) / max(1e-6, after["tMs"] - before["tMs"])
                            off_x += f * (aoff_x - off_x)
                            off_y += f * (aoff_y - off_y)
                            bw += f * ((ab[2] - ab[0]) - bw)
                            bh += f * ((ab[3] - ab[1]) - bh)
                            src = [before["tMs"], after["tMs"]]
                    wr_now = wr_now_all.get(joint) or next(iter(wr_now_all.values()))
                    cx, cy = wr_now["x"] + off_x, wr_now["y"] + off_y
                    entries.append({"mode": "wrist_anchored", "kind": "TRACKED_ESTIMATE",
                                    "joint": joint, "sourceTMs": src,
                                    "box": [round(cx - bw / 2, 1), round(cy - bh / 2, 1),
                                            round(cx + bw / 2, 1), round(cy + bh / 2, 1)]})
            out_frames.append({**r, "estimates": entries,
                               "anchorBefore": before and {"tMs": before["tMs"], "score": before["score"], "box": before["box"]},
                               "anchorAfter": after and {"tMs": after["tMs"], "score": after["score"], "box": after["box"]}})
    dump_json(OUT / "probe-propagation.json", {
        "schemaVersion": 1, "workstream": "W12",
        "note": "ALL boxes here are kind=TRACKED_ESTIMATE (propagated/predicted), NEVER detections; "
                "anchors come from the sandbox stride-1 run dets gated by annotation target points",
        "frames": out_frames})
    print(f"propagate: -> {OUT / 'probe-propagation.json'} ({len(out_frames)} frames)")


# ---------------------------------------------------------------- truth viz

def cmd_truthviz(_args) -> None:
    truth = load_json(OUT / "visual-truth.json")
    dets = {(f["case"], f["frameIndex"]): f for f in load_json(OUT / "probe-dets.json")["frames"]}
    fnt = font(18)
    n = 0
    for tf in truth["frames"]:
        case, idx = tf["case"], tf["frameIndex"]
        img = Image.open(frame_png(case, idx)).convert("RGB")
        d = ImageDraw.Draw(img)
        det_f = dets.get((case, idx))
        if det_f:
            base = next(x for x in det_f["results"] if x["strategy"] == "baseline_fullframe")
            for b in base["boxes"]:
                if b["score"] >= 0.08:
                    d.rectangle(b["box"], outline=(150, 150, 150), width=2)
                    d.text((b["box"][0], b["box"][1] - 18), f"base {b['score']:.2f}",
                           fill=(150, 150, 150), font=fnt)
        for dist in tf.get("distractors", []):
            d.rectangle(dist["box"], outline=(255, 165, 0), width=3)
            d.text((dist["box"][0], dist["box"][3] + 2), f"distractor:{dist['label']}",
                   fill=(255, 165, 0), font=fnt)
        p = tf.get("paddle") or {}
        if p.get("box"):
            d.rectangle(p["box"], outline=(0, 255, 0), width=4)
            d.text((p["box"][0], p["box"][1] - 20),
                   f"TRUTH {p.get('visibility')}", fill=(0, 255, 0), font=fnt)
            # inset zoom (3x) of the truth box neighborhood
            bx = p["box"]
            cx, cy = (bx[0] + bx[2]) / 2, (bx[1] + bx[3]) / 2
            half = max(bx[2] - bx[0], bx[3] - bx[1]) * 1.2
            x0, y0, x1, y1 = crop_bounds(cx, cy, int(2 * half), *img.size)
            if x1 > x0 and y1 > y0:
                zoom = img.crop((x0, y0, x1, y1))
                zw = 360
                zoom = zoom.resize((zw, int(zw * (y1 - y0) / (x1 - x0))))
                img.paste(zoom, (5, 5))
                d.rectangle([5, 5, 5 + zoom.width, 5 + zoom.height], outline=(0, 255, 0), width=2)
        d.text((8, img.height - 26), f"{case} i{idx} t={tf['tMs']}ms {tf['group']}",
               fill=(255, 255, 120), font=fnt)
        img.save(OUT / "truthviz" / f"{case}-i{idx:04d}-truth.png")
        n += 1
    print(f"truthviz: rendered {n} -> {OUT / 'truthviz'}")


# ---------------------------------------------------------------- scoring

OPERATING_FLOORS = (0.08, 0.15, 0.25)
IOU_MAIN = 0.30  # blur/edge-on truth boxes are fuzzy; 0.30 chosen on rally2 dev frames
CONTROL_REGION_SCALE = CROP_SCALES[-1]  # false boxes counted inside the widest crop


def strategy_views(det_frame):
    """Expand raw per-strategy results into scoring views incl. merged variants."""
    res = {x["strategy"]: x for x in det_frame["results"]}
    views = {}
    for name, x in res.items():
        views[name] = {"boxes": x["boxes"], "kind": "DETECTED", "cropPx": x.get("cropPx")}
    for joint in WRIST_JOINTS:
        scales = [res[f"crop{s}_{joint}"] for s in CROP_SCALES if f"crop{s}_{joint}" in res]
        if scales:
            views[f"cropMULTI_{joint}"] = {
                "boxes": nms([b for x in scales for b in x["boxes"]]),
                "kind": "DETECTED", "cropPx": scales[-1]["cropPx"]}
        tta = [res[k] for k in (f"crop{CROP_SCALES[1]}_{joint}", f"tta_hflip_{joint}",
                                f"tta_rot+12_{joint}", f"tta_rot-12_{joint}") if k in res]
        if tta:
            views[f"ttaMERGE_{joint}"] = {
                "boxes": nms([b for x in tta for b in x["boxes"]]),
                "kind": "DETECTED", "cropPx": tta[0]["cropPx"]}
    both = [v for j in WRIST_JOINTS if (v := views.get(f"cropMULTI_{j}"))]
    if both:
        views["cropMULTI_bothwrists"] = {
            "boxes": nms([b for v in both for b in v["boxes"]]), "kind": "DETECTED",
            "cropPx": None}
    return views


def cmd_score(_args) -> None:
    truth = {(f["case"], f["frameIndex"]): f
             for f in load_json(OUT / "visual-truth.json")["frames"]}
    det_payload = load_json(OUT / "probe-dets.json")
    prop = {(f["case"], f["frameIndex"]): f
            for f in load_json(OUT / "probe-propagation.json")["frames"]}
    timing = det_payload["timing"]["perStrategyMsPerFrame"]
    ann_pts = {c: annotation_target_points(c) for c in CASES}

    groups: dict[str, list] = {}
    for f in det_payload["frames"]:
        groups.setdefault(f["group"], []).append(f)

    def eval_group(frames, floor, view_name):
        rows = []
        for f in frames:
            tf = truth.get((f["case"], f["frameIndex"]))
            if tf is None:
                continue
            views = strategy_views(f)
            if view_name not in views:
                continue
            boxes = [b for b in nms(views[view_name]["boxes"]) if b["score"] >= floor]
            p = tf.get("paddle") or {}
            gt = p.get("box")
            vis = p.get("visibility")
            best_iou, best = 0.0, None
            for b in boxes:
                i = iou(b["box"], gt) if gt else 0.0
                if i > best_iou:
                    best_iou, best = i, b
            # false boxes: near-wrist region, not truth, not a listed distractor
            region = views[view_name].get("cropPx")
            if region is None:
                wr = f.get("wrists") or {}
                regs = [crop_bounds(w["x"], w["y"], CONTROL_REGION_SCALE,
                                    *case_meta(f["case"])[:2]) for w in wr.values()]
            else:
                regs = [region]
            false_boxes, wrong_instance, false_near_wrist = 0, 0, 0
            wr_pts = [(w["x"], w["y"]) for w in (f.get("wrists") or {}).values()]
            for b in boxes:
                cx, cy = (b["box"][0] + b["box"][2]) / 2, (b["box"][1] + b["box"][3]) / 2
                if not any(r[0] <= cx <= r[2] and r[1] <= cy <= r[3] for r in regs):
                    continue
                if gt and iou(b["box"], gt) >= 0.10:
                    continue
                if any(iou(b["box"], dd["box"]) >= 0.10 for dd in tf.get("distractors", [])):
                    wrong_instance += 1
                else:
                    false_boxes += 1
                    if any(math.hypot(cx - wx, cy - wy) <= 150 for wx, wy in wr_pts):
                        false_near_wrist += 1
            # annotation point hit (rally2 target points within +-20ms)
            ann_hit = None
            near = [p2 for p2 in ann_pts[f["case"]] if abs(p2["tMs"] - f["tMs"]) <= 20]
            if near and boxes:
                ann_hit = any(b["box"][0] <= p2["x"] <= b["box"][2]
                              and b["box"][1] <= p2["y"] <= b["box"][3]
                              for p2 in near for b in boxes)
            elif near:
                ann_hit = False
            rows.append({"tMs": f["tMs"], "vis": vis, "gt": gt, "bestIoU": round(best_iou, 3),
                         "bestScore": best and best["score"], "nBoxes": len(boxes),
                         "falseBoxes": false_boxes, "wrongInstance": wrong_instance,
                         "falseNearWrist150": false_near_wrist, "annPtHit": ann_hit})
        return rows

    # collect all view names present
    all_views = set()
    for f in det_payload["frames"]:
        all_views.update(strategy_views(f).keys())

    report = {"schemaVersion": 1, "workstream": "W12", "annotator": ANNOTATOR_ID,
              "iouMain": IOU_MAIN, "operatingFloors": list(OPERATING_FLOORS),
              "runtimeMsPerFrame": timing,
              "discipline": "wm-dink-01 (held_out) rows are DIAGNOSTIC ONLY; thresholds/strategy "
                            "choices are justified on afn-sasebo-rally2 (development) evidence alone",
              "strategies": {}, "propagation": {}}

    scoreable = {g: [f for f in frames] for g, frames in groups.items()}
    for view in sorted(all_views):
        entry = {}
        for gname, frames in scoreable.items():
            per_floor = {}
            for floor in OPERATING_FLOORS:
                rows = eval_group(frames, floor, view)
                vis_rows = [r for r in rows if r["vis"] in ("visible", "blur_visible") and r["gt"]]
                rec = [r for r in vis_rows if r["bestIoU"] >= IOU_MAIN]
                rec10 = [r for r in vis_rows if r["bestIoU"] >= 0.10]
                per_floor[str(floor)] = {
                    "framesScored": len(rows), "visibleGtFrames": len(vis_rows),
                    "recovered@IoU.30": f"{len(rec)}/{len(vis_rows)}" if vis_rows else None,
                    "recovered@IoU.10": f"{len(rec10)}/{len(vis_rows)}" if vis_rows else None,
                    "meanBestIoU": round(float(np.mean([r["bestIoU"] for r in vis_rows])), 3) if vis_rows else None,
                    "falseBoxesPerFrame": round(float(np.mean([r["falseBoxes"] for r in rows])), 2) if rows else None,
                    "falseNearWrist150PerFrame": round(float(np.mean([r["falseNearWrist150"] for r in rows])), 2) if rows else None,
                    "wrongInstancePerFrame": round(float(np.mean([r["wrongInstance"] for r in rows])), 2) if rows else None,
                    "perFrame": rows if floor == 0.08 else None,
                    "annPtHits": f"{sum(1 for r in rows if r['annPtHit'])}/{sum(1 for r in rows if r['annPtHit'] is not None)}",
                }
            entry[gname] = per_floor
        report["strategies"][view] = entry

    # propagation (TRACKED_ESTIMATE — separate, never mixed with detections)
    prop_rows: dict[str, dict[str, list]] = {}
    for (case, idx), pf in prop.items():
        tf = truth.get((case, idx))
        if tf is None or not (tf.get("paddle") or {}).get("box"):
            continue
        gt = tf["paddle"]["box"]
        for e in pf["estimates"]:
            prop_rows.setdefault(e["mode"], {}).setdefault(pf["group"], []).append(
                {"tMs": pf["tMs"], "iou": round(iou(e["box"], gt), 3)})
    for mode, by_group in prop_rows.items():
        report["propagation"][mode] = {
            g: {"kind": "TRACKED_ESTIMATE", "frames": len(rows),
                "meanIoU": round(float(np.mean([r["iou"] for r in rows])), 3),
                "iou>=0.30": f"{sum(1 for r in rows if r['iou'] >= IOU_MAIN)}/{len(rows)}",
                "iou>=0.10": f"{sum(1 for r in rows if r['iou'] >= 0.10)}/{len(rows)}",
                "perFrame": rows}
            for g, rows in by_group.items()}

    dump_json(OUT / "strategy-report.json", report)
    print(f"score: -> {OUT / 'strategy-report.json'}")
    # console digest: rally2 miss groups at floor 0.08 for headline views
    for view in ("baseline_fullframe", "cropMULTI_right_wrist", "cropMULTI_left_wrist",
                 "cropMULTI_bothwrists", "ttaMERGE_right_wrist", "ttaMERGE_left_wrist"):
        if view not in report["strategies"]:
            continue
        for g in ("rally2_missA_overhead_blur", "rally2_missB_edgeon_carry", "rally2_control"):
            e = report["strategies"][view].get(g, {}).get("0.08")
            if e:
                print(f"{view:28s} {g:28s} rec.30={e['recovered@IoU.30']} "
                      f"rec.10={e['recovered@IoU.10']} mIoU={e['meanBestIoU']} "
                      f"fp/f={e['falseBoxesPerFrame']} wi/f={e['wrongInstancePerFrame']}")


# ---------------------------------------------------------------- main

def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name, fn in [("extract", cmd_extract), ("grid", cmd_grid), ("detect", cmd_detect),
                     ("propagate", cmd_propagate), ("truthviz", cmd_truthviz),
                     ("score", cmd_score)]:
        sp = sub.add_parser(name)
        sp.set_defaults(fn=fn)
    zp = sub.add_parser("zoom")
    zp.add_argument("--case", required=True)
    zp.add_argument("--idx", type=int, required=True)
    zp.add_argument("--cx", type=float, required=True)
    zp.add_argument("--cy", type=float, required=True)
    zp.add_argument("--half", type=int, default=220)
    zp.add_argument("--grid", type=int, default=25)
    zp.add_argument("--show-dets", action="store_true")
    zp.add_argument("--det-floor", type=float, default=0.25)
    zp.set_defaults(fn=cmd_zoom)
    args = ap.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)
    args.fn(args)


if __name__ == "__main__":
    main()
