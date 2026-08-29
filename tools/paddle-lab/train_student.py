"""Train the paddle student head from paddle-distill-v0.1 (D4-06 groundwork).

HONEST FRAMING: this is TINY-DATA groundwork, not a promotion candidate. The
training-eligible-with-pixels set is 217 teacher frames from exactly TWO dev
clips / two sessions. The split is by sessionKey (paddle-bench splitNote):
  train = afn-sasebo-2025-06 (afn-sasebo-rally1, 124 frames)
  val   = wm-tournament-2014 (wm-volley-02, 93 frames)
Held-out cases (wm-dink-01, afn-vic-rally1) are quarantined by the exporter
and are refused here by construction.

Targets are the TEACHER's racket-class detections (score >= 0.30) rendered as
center gaussians — teacher outputs, not human observations. Human paddle
labels are used only by student_bench.py for evaluation.

Usage:
  .venv/bin/python train_student.py [--epochs 60] [--out-dir ../../datasets/experiments/wave-d4/d4-06-student]
"""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn

from student_lib import (
    HEATMAP_SIZE,
    TEACHER_SCORE_FLOOR,
    StudentPaddleNet,
    extract_frames,
    letterbox,
    load_examples,
    px_to_heatmap,
    render_target,
)

TRAIN_SESSION = "afn-sasebo-2025-06"
VAL_SESSION = "wm-tournament-2014"


def build_split(repo: Path) -> dict[str, list[dict]]:
    examples = load_examples(repo / "datasets/releases/paddle-distill-v0.1")
    split: dict[str, list[dict]] = {"train": [], "val": []}
    for e in examples:
        if not e["trainingEligible"] or not e["media"]["pixelsCommitted"]:
            continue
        if e["teacher"] is None:
            continue
        if e["sessionKey"] == TRAIN_SESSION:
            split["train"].append(e)
        elif e["sessionKey"] == VAL_SESSION:
            split["val"].append(e)
        else:
            raise SystemExit(f"unexpected eligible session {e['sessionKey']}")
    return split


def build_tensors(repo: Path, examples: list[dict]) -> tuple[torch.Tensor, torch.Tensor]:
    by_clip: dict[str, list[dict]] = {}
    for e in examples:
        by_clip.setdefault(e["media"]["bundleClip"], []).append(e)
    xs, ys = [], []
    for clip, clip_examples in sorted(by_clip.items()):
        frames = extract_frames(repo / clip, [e["tMs"] for e in clip_examples])
        for e in clip_examples:
            img = frames.get(e["tMs"])
            if img is None:
                continue
            inp, scale, pad_x, pad_y = letterbox(img)
            centers = []
            for det in e["teacher"]["detections"]:
                if det["score"] < TEACHER_SCORE_FLOOR:
                    continue
                if det["label"] not in ("tennis racket", "baseball bat"):
                    continue
                x0, y0, x1, y1 = det["box"]
                hx, hy = px_to_heatmap((x0 + x1) / 2, (y0 + y1) / 2, scale, pad_x, pad_y)
                centers.append((hx, hy, float(det["score"])))
            xs.append(inp)
            ys.append(render_target(centers))
    return (
        torch.from_numpy(np.stack(xs)).float(),
        torch.from_numpy(np.stack(ys)).float(),
    )


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo-root", default=str(Path(__file__).resolve().parents[2]))
    ap.add_argument("--epochs", type=int, default=60)
    ap.add_argument("--batch-size", type=int, default=8)
    ap.add_argument("--lr", type=float, default=2e-3)
    ap.add_argument("--seed", type=int, default=1706)
    ap.add_argument(
        "--out-dir",
        default=None,
        help="defaults to <repo>/datasets/experiments/wave-d4/d4-06-student",
    )
    args = ap.parse_args()
    repo = Path(args.repo_root).resolve()
    out_dir = Path(args.out_dir) if args.out_dir else repo / "datasets/experiments/wave-d4/d4-06-student"
    out_dir.mkdir(parents=True, exist_ok=True)

    torch.manual_seed(args.seed)
    np.random.seed(args.seed)

    split = build_split(repo)
    x_train, y_train = build_tensors(repo, split["train"])
    x_val, y_val = build_tensors(repo, split["val"])
    print(f"train {tuple(x_train.shape)} val {tuple(x_val.shape)}")

    model = StudentPaddleNet()
    n_params = sum(p.numel() for p in model.parameters())
    opt = torch.optim.Adam(model.parameters(), lr=args.lr)
    # focal-style weighting: positives are ~1% of cells
    def loss_fn(logits: torch.Tensor, target: torch.Tensor) -> torch.Tensor:
        bce = nn.functional.binary_cross_entropy_with_logits(logits, target, reduction="none")
        weight = torch.where(target > 0.1, torch.tensor(20.0), torch.tensor(1.0))
        return (bce * weight).mean()

    history = []
    t0 = time.time()
    for epoch in range(args.epochs):
        model.train()
        perm = torch.randperm(len(x_train))
        total = 0.0
        for i in range(0, len(perm), args.batch_size):
            idx = perm[i : i + args.batch_size]
            opt.zero_grad()
            loss = loss_fn(model(x_train[idx]), y_train[idx])
            loss.backward()
            opt.step()
            total += float(loss.detach()) * len(idx)
        model.eval()
        with torch.no_grad():
            val_loss = float(loss_fn(model(x_val), y_val))
        history.append({"epoch": epoch, "trainLoss": total / len(x_train), "valLoss": val_loss})
        if epoch % 10 == 0 or epoch == args.epochs - 1:
            print(f"epoch {epoch:3d} train {history[-1]['trainLoss']:.4f} val {val_loss:.4f}")
    wall = time.time() - t0

    torch.save(model.state_dict(), out_dir / "student-paddle-v0.pt")
    report = {
        "model": "paddle-student-v0 (center-heatmap CNN)",
        "parameters": n_params,
        "dataset": "paddle-distill-v0.1 (trainingEligible AND pixelsCommitted AND teacher!=null)",
        "split": {
            "rule": "by sessionKey",
            "train": {"session": TRAIN_SESSION, "frames": len(x_train)},
            "val": {"session": VAL_SESSION, "frames": len(x_val)},
        },
        "targets": f"teacher D-FINE racket-class detections score >= {TEACHER_SCORE_FLOOR} (teacher outputs, NOT human observations)",
        "seed": args.seed,
        "epochs": args.epochs,
        "trainWallSec": round(wall, 1),
        "hardware": "LINUX-CPU",
        "history": history,
        "honestFraming": "TINY-DATA groundwork: 2 clips / 2 sessions; not a promotion candidate; no accuracy claim beyond student_bench.py numbers",
    }
    with open(out_dir / "training-report.json", "w") as f:
        json.dump(report, f, indent=2)
        f.write("\n")
    print(f"params {n_params}, wall {wall:.1f}s -> {out_dir}")


if __name__ == "__main__":
    main()
