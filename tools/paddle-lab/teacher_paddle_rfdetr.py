"""RF-DETR teacher candidate vs the frozen D-FINE COCO proxy.

Both are Apache-2.0 code AND Apache-2.0 weights (RF-DETR N/L only — XL/2XL are
PML-licensed and are NOT used here). Both use COCO's "tennis racket" class as a
pickleball-paddle proxy, so this is a like-for-like detector comparison on the
SAME real labeled frames the frozen benchmark uses.

Usage:
  python teacher_paddle_rfdetr.py --frames frames.json --out out.json
    frames.json: [{"case": str, "video": path, "tMs": int,
                   "point": {"x":..,"y":..} | null, "visibility": str}, ...]
"""
import argparse
import json
import time

import av
import numpy as np
from PIL import Image

TENNIS_RACKET = "tennis racket"
SPORTS_BALL = "sports ball"


def frame_at(path: str, t_ms: int) -> Image.Image | None:
    container = av.open(path)
    stream = container.streams.video[0]
    target = t_ms / 1000.0
    best = None
    for frame in container.decode(stream):
        if frame.time is None:
            continue
        if best is None or abs(frame.time - target) < abs(best[0] - target):
            best = (frame.time, frame.to_image())
        if frame.time > target + 0.2:
            break
    container.close()
    return best[1] if best else None


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--frames", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--model", default="large", choices=["nano", "small", "medium", "large"])
    parser.add_argument("--threshold", type=float, default=0.15)
    args = parser.parse_args()

    from rfdetr.detr import RFDETRLarge, RFDETRMedium, RFDETRNano, RFDETRSmall

    builder = {
        "nano": RFDETRNano, "small": RFDETRSmall,
        "medium": RFDETRMedium, "large": RFDETRLarge,
    }[args.model]
    load_started = time.time()
    model = builder()
    model.optimize_for_inference()
    load_sec = time.time() - load_started

    from rfdetr.assets.coco_classes import COCO_CLASSES

    wanted = {
        index for index, name in COCO_CLASSES.items()
        if name in (TENNIS_RACKET, SPORTS_BALL)
    }
    racket_ids = {i for i, n in COCO_CLASSES.items() if n == TENNIS_RACKET}

    frames = json.load(open(args.frames))
    results = []
    infer_times = []
    for entry in frames:
        image = frame_at(entry["video"], entry["tMs"])
        if image is None:
            results.append({**entry, "detections": [], "error": "frame_not_decoded"})
            continue
        width, height = image.size
        started = time.time()
        detections = model.predict(image, threshold=args.threshold)
        infer_times.append((time.time() - started) * 1000)
        found = []
        for box, class_id, score in zip(
            detections.xyxy, detections.class_id, detections.confidence
        ):
            if int(class_id) not in wanted:
                continue
            x1, y1, x2, y2 = [float(value) for value in box]
            found.append({
                "cls": COCO_CLASSES.get(int(class_id), str(class_id)),
                "score": float(score),
                "cx": ((x1 + x2) / 2) / width,
                "cy": ((y1 + y2) / 2) / height,
                "w": (x2 - x1) / width,
                "h": (y2 - y1) / height,
                "isRacket": int(class_id) in racket_ids,
            })
        results.append({**entry, "detections": found})

    json.dump(
        {
            "detector": f"rfdetr-{args.model}-coco@rfdetr",
            "license": "Apache-2.0 code + Apache-2.0 weights (N/L family)",
            "threshold": args.threshold,
            "timing": {
                "loadSec": round(load_sec, 2),
                "msPerFrameMedian": round(float(np.median(infer_times)), 1) if infer_times else None,
                "frames": len(infer_times),
            },
            "results": results,
        },
        open(args.out, "w"),
        indent=2,
    )
    print(f"wrote {args.out}: {len(results)} frames, load {load_sec:.1f}s, "
          f"median {np.median(infer_times):.0f}ms/frame" if infer_times else "no frames")


if __name__ == "__main__":
    main()
