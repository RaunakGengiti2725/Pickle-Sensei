"""Zero-shot / pretrained paddle-detection candidate bench.

Runs commercially-safe detector candidates over real pickleball frames and
records, per model per frame: boxes, scores, labels, and wall time. Outputs
JSON plus annotated PNGs so a human can verify every claim visually.

Candidates (all Apache-2.0 code AND weights):
  owlv2     google/owlv2-base-patch16-ensemble   (open-vocabulary, text queries)
  gdino     IDEA-Research/grounding-dino-tiny    (open-vocabulary, text queries)
  dfine     ustc-community/dfine-medium-coco     (COCO closed-set; nearest class
                                                  'tennis racket' as paddle proxy)

Usage:
  .venv/bin/python candidate_bench.py --frames /tmp/paddle-frames --out /tmp/paddle-bench-results
"""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

import torch
from PIL import Image, ImageDraw

DEVICE = "mps" if torch.backends.mps.is_available() else "cpu"

PADDLE_QUERIES = ["pickleball paddle", "paddle", "table tennis paddle", "tennis racket"]


def load_frames(frames_dir: Path) -> list[tuple[str, Image.Image]]:
    frames = []
    for path in sorted(frames_dir.glob("*.png")):
        frames.append((path.stem, Image.open(path).convert("RGB")))
    return frames


def run_owlv2(frames, threshold=0.15):
    from transformers import Owlv2ForObjectDetection, Owlv2Processor

    processor = Owlv2Processor.from_pretrained("google/owlv2-base-patch16-ensemble")
    model = Owlv2ForObjectDetection.from_pretrained("google/owlv2-base-patch16-ensemble").to(DEVICE).eval()
    results = {}
    for name, image in frames:
        started = time.perf_counter()
        inputs = processor(text=[PADDLE_QUERIES], images=image, return_tensors="pt").to(DEVICE)
        with torch.no_grad():
            outputs = model(**inputs)
        target_sizes = torch.tensor([image.size[::-1]])
        detections = processor.post_process_grounded_object_detection(
            outputs=outputs, target_sizes=target_sizes, threshold=threshold
        )[0]
        elapsed = time.perf_counter() - started
        results[name] = {
            "timeSec": elapsed,
            "detections": [
                {
                    "box": [round(v) for v in box.tolist()],
                    "score": round(score.item(), 4),
                    "label": PADDLE_QUERIES[label],
                }
                for box, score, label in zip(
                    detections["boxes"], detections["scores"], detections["labels"]
                )
            ],
        }
    return results


def run_gdino(frames, threshold=0.2):
    from transformers import AutoModelForZeroShotObjectDetection, AutoProcessor

    model_id = "IDEA-Research/grounding-dino-tiny"
    processor = AutoProcessor.from_pretrained(model_id)
    model = AutoModelForZeroShotObjectDetection.from_pretrained(model_id).to(DEVICE).eval()
    text = "a pickleball paddle. a paddle. a tennis racket."
    results = {}
    for name, image in frames:
        started = time.perf_counter()
        inputs = processor(images=image, text=text, return_tensors="pt").to(DEVICE)
        with torch.no_grad():
            outputs = model(**inputs)
        detections = processor.post_process_grounded_object_detection(
            outputs,
            inputs.input_ids,
            threshold=threshold,
            text_threshold=threshold,
            target_sizes=[image.size[::-1]],
        )[0]
        elapsed = time.perf_counter() - started
        results[name] = {
            "timeSec": elapsed,
            "detections": [
                {
                    "box": [round(v) for v in box.tolist()],
                    "score": round(score.item(), 4),
                    "label": label,
                }
                for box, score, label in zip(
                    detections["boxes"], detections["scores"], detections["text_labels"]
                )
            ],
        }
    return results


def run_dfine(frames, threshold=0.3):
    from transformers import AutoModelForObjectDetection, AutoImageProcessor

    model_id = "ustc-community/dfine-medium-coco"
    processor = AutoImageProcessor.from_pretrained(model_id)
    model = AutoModelForObjectDetection.from_pretrained(model_id).to(DEVICE).eval()
    results = {}
    for name, image in frames:
        started = time.perf_counter()
        inputs = processor(images=image, return_tensors="pt").to(DEVICE)
        with torch.no_grad():
            outputs = model(**inputs)
        detections = processor.post_process_object_detection(
            outputs, target_sizes=[image.size[::-1]], threshold=threshold
        )[0]
        elapsed = time.perf_counter() - started
        keep = []
        for box, score, label in zip(
            detections["boxes"], detections["scores"], detections["labels"]
        ):
            label_name = model.config.id2label[label.item()]
            if label_name in {"tennis racket", "baseball bat", "sports ball", "person"}:
                keep.append(
                    {
                        "box": [round(v) for v in box.tolist()],
                        "score": round(score.item(), 4),
                        "label": label_name,
                    }
                )
        results[name] = {"timeSec": elapsed, "detections": keep}
    return results


COLORS = {"owlv2": "#7CF54C", "gdino": "#4CC9F5", "dfine": "#F5A64C"}


def annotate(frames, all_results, out_dir: Path):
    for name, image in frames:
        canvas = image.copy()
        draw = ImageDraw.Draw(canvas)
        for model_name, results in all_results.items():
            for det in results[name]["detections"]:
                if det["label"] == "person":
                    continue
                x0, y0, x1, y1 = det["box"]
                color = COLORS[model_name]
                draw.rectangle([x0, y0, x1, y1], outline=color, width=3)
                draw.text((x0 + 2, y0 + 2), f"{model_name} {det['label']} {det['score']:.2f}", fill=color)
        canvas.save(out_dir / f"{name}-annotated.png")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--frames", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--models", default="owlv2,gdino,dfine")
    args = parser.parse_args()

    frames = load_frames(Path(args.frames))
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    print(f"device={DEVICE} frames={len(frames)}")

    runners = {"owlv2": run_owlv2, "gdino": run_gdino, "dfine": run_dfine}
    all_results = {}
    for model_name in args.models.split(","):
        print(f"running {model_name}…")
        all_results[model_name] = runners[model_name](frames)
        times = [r["timeSec"] for r in all_results[model_name].values()]
        hits = sum(
            1
            for r in all_results[model_name].values()
            if any(d["label"] != "person" for d in r["detections"])
        )
        print(
            f"  {model_name}: frames with candidate boxes {hits}/{len(frames)}, "
            f"mean {sum(times)/len(times):.2f}s/frame (first incl. warmup)"
        )

    (out_dir / "results.json").write_text(json.dumps(all_results, indent=1))
    annotate(frames, all_results, out_dir)
    print(f"wrote {out_dir}/results.json + annotated PNGs")


if __name__ == "__main__":
    main()
