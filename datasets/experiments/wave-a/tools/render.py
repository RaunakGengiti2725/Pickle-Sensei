#!/usr/bin/env python3
"""Timestamped contact sheets for honest visual event labeling (wave-a).

usage: render.py <video> <startMs> <endMs> <fps> <outPrefix> [cols rows tileW markers.json]

Extracts frames with ffmpeg at `fps` from startMs..endMs, then tiles them with
the absolute video ms burned into each tile (frame time = startMs + k*1000/fps,
frame-accurate to +-half the sampling interval). Optional markers.json:
{"points": [{"ms": 12345, "x": 0.5, "y": 0.4, "label": "T"}]} draws a circle
on the nearest tile, e.g. the auto-target's torso from eventBoundsScout.
"""
import json, math, os, shutil, subprocess, sys, tempfile
from PIL import Image, ImageDraw

video, start_ms, end_ms, fps, out_prefix = sys.argv[1], float(sys.argv[2]), float(sys.argv[3]), float(sys.argv[4]), sys.argv[5]
cols = int(sys.argv[6]) if len(sys.argv) > 6 else 5
rows = int(sys.argv[7]) if len(sys.argv) > 7 else 6
tile_w = int(sys.argv[8]) if len(sys.argv) > 8 else 320
markers = []
if len(sys.argv) > 9:
    markers = json.load(open(sys.argv[9]))["points"]

tmp = tempfile.mkdtemp(prefix="wavea-frames-")
try:
    subprocess.run([
        "ffmpeg", "-hide_banner", "-loglevel", "error",
        "-ss", str(start_ms / 1000), "-t", str((end_ms - start_ms) / 1000),
        "-i", video, "-vf", f"fps={fps}", "-fps_mode", "passthrough",
        os.path.join(tmp, "f-%05d.png"),
    ], check=True)
    files = sorted(os.listdir(tmp))
    if not files:
        sys.exit("no frames extracted")
    per_sheet = cols * rows
    n_sheets = math.ceil(len(files) / per_sheet)
    interval = 1000.0 / fps
    for sheet_index in range(n_sheets):
        chunk = files[sheet_index * per_sheet:(sheet_index + 1) * per_sheet]
        first = Image.open(os.path.join(tmp, chunk[0]))
        scale = tile_w / first.width
        tile_h = int(first.height * scale)
        sheet = Image.new("RGB", (cols * tile_w, math.ceil(len(chunk) / cols) * tile_h), "black")
        for index, name in enumerate(chunk):
            global_index = sheet_index * per_sheet + index
            ms = start_ms + global_index * interval
            img = Image.open(os.path.join(tmp, name)).resize((tile_w, tile_h))
            draw = ImageDraw.Draw(img)
            for marker in markers:
                if abs(marker["ms"] - ms) <= interval / 2:
                    mx, my = marker["x"] * tile_w, marker["y"] * tile_h
                    draw.ellipse([mx - 7, my - 7, mx + 7, my + 7], outline="red", width=3)
                    draw.text((mx + 9, my - 7), marker.get("label", "T"), fill="red")
            text = f"{ms:.0f}"
            draw.rectangle([0, 0, 8 + 8 * len(text), 16], fill="black")
            draw.text((4, 2), text, fill="yellow")
            sheet.paste(img, ((index % cols) * tile_w, (index // cols) * tile_h))
        out = f"{out_prefix}-{sheet_index + 1:02d}.png"
        sheet.save(out)
        print(out, f"tiles={len(chunk)} interval={interval:.1f}ms range=[{start_ms + sheet_index * per_sheet * interval:.0f}..{start_ms + (sheet_index * per_sheet + len(chunk) - 1) * interval:.0f}]")
finally:
    shutil.rmtree(tmp, ignore_errors=True)
