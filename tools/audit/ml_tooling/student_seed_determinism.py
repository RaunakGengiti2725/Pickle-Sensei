#!/usr/bin/env python3
"""Seed-determinism + split-integrity probe for tools/paddle-lab/train_student.py.

Runs the UNMODIFIED trainer into scratch --out-dir locations (never the
committed datasets/experiments/wave-d4/d4-06-student):

  run A: --seed S          run B: --seed S (again)      run C: --seed S+1

and checks
  * A == B  : every state_dict tensor bit-identical, training-report loss
              curves identical (same seed => same weights on the same box)
  * A != C  : a different seed actually changes the weights (seed is wired)
  * split   : training-report split is by sessionKey and the held-out cases
              (wm-dink-01, afn-vic-rally1) appear in neither train nor val
  * vs committed: tensor-level comparison against the committed
              student-paddle-v0.pt (reported, not required — torch/CPU version
              drift can legitimately change floating-point results)

Usage: student_seed_determinism.py --out-dir DIR [--seed 1706] [--epochs 60]
Exit 0 iff A==B, A!=C and the split checks hold.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

import torch

REPO = Path(__file__).resolve().parents[3]
TRAINER = REPO / "tools/paddle-lab/train_student.py"
COMMITTED = REPO / "datasets/experiments/wave-d4/d4-06-student"
HELD_OUT = {"wm-dink-01", "afn-vic-rally1"}


def train(out: Path, seed: int, epochs: int) -> int:
    out.mkdir(parents=True, exist_ok=True)
    proc = subprocess.run(
        [
            sys.executable,
            str(TRAINER),
            "--repo-root",
            str(REPO),
            "--seed",
            str(seed),
            "--epochs",
            str(epochs),
            "--out-dir",
            str(out),
        ],
        capture_output=True,
        text=True,
        errors="replace",
    )
    (out / "stdout.log").write_text(proc.stdout)
    (out / "stderr.log").write_text(proc.stderr)
    return proc.returncode


def state(out: Path) -> dict[str, torch.Tensor]:
    return torch.load(out / "student-paddle-v0.pt", map_location="cpu")


def tensors_equal(a: dict, b: dict) -> tuple[bool, float]:
    if a.keys() != b.keys():
        return False, float("inf")
    max_abs = 0.0
    same = True
    for k in a:
        if a[k].shape != b[k].shape:
            return False, float("inf")
        if not torch.equal(a[k], b[k]):
            same = False
            max_abs = max(max_abs, (a[k].float() - b[k].float()).abs().max().item())
    return same, max_abs


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out-dir", required=True)
    ap.add_argument("--seed", type=int, default=1706)
    ap.add_argument("--epochs", type=int, default=60)
    args = ap.parse_args()
    out = Path(args.out_dir)
    out.mkdir(parents=True, exist_ok=True)
    problems: list[str] = []

    runs = {"A": args.seed, "B": args.seed, "C": args.seed + 1}
    exits = {}
    for name, seed in runs.items():
        exits[name] = train(out / name, seed, args.epochs)
        print(f"run {name} seed={seed} exit={exits[name]}")
        if exits[name] != 0:
            problems.append(f"run {name} exit {exits[name]}")
    if problems:
        print("PROBLEMS:", problems)
        return 1

    sa, sb, sc = state(out / "A"), state(out / "B"), state(out / "C")
    ra = json.loads((out / "A/training-report.json").read_text())
    rb = json.loads((out / "B/training-report.json").read_text())

    ab_same, ab_max = tensors_equal(sa, sb)
    print(f"A vs B (same seed): tensors identical={ab_same} max|diff|={ab_max}")
    if not ab_same:
        problems.append(f"same seed produced different weights (max|diff|={ab_max})")
    curve_a = {k: v for k, v in ra.items() if k not in ("trainWallSec",)}
    curve_b = {k: v for k, v in rb.items() if k not in ("trainWallSec",)}
    print(f"A vs B training-report (minus wall time) identical={curve_a == curve_b}")
    if curve_a != curve_b:
        problems.append("same seed produced different training-report")

    ac_same, ac_max = tensors_equal(sa, sc)
    print(f"A vs C (seed+1): tensors identical={ac_same} max|diff|={ac_max}")
    if ac_same:
        problems.append("different seed produced identical weights — seed not wired")

    split = ra.get("split", {})
    train_s, val_s = split.get("train", {}).get("session"), split.get("val", {}).get("session")
    print(f"split rule={split.get('rule')!r} train={train_s} val={val_s}")
    if split.get("rule") != "by sessionKey" or not train_s or not val_s or train_s == val_s:
        problems.append(f"split not by disjoint sessionKey: {split}")
    report_text = json.dumps(ra)
    leaked = sorted(h for h in HELD_OUT if h in report_text)
    print(f"held-out cases mentioned in training-report: {leaked}")
    if leaked:
        problems.append(f"held-out cases referenced by trainer report: {leaked}")

    if (COMMITTED / "student-paddle-v0.pt").exists() and args.seed == 1706 and args.epochs == 60:
        sk = state(COMMITTED)
        same, mx = tensors_equal(sa, sk)
        print(f"A vs committed student-paddle-v0.pt: identical={same} max|diff|={mx}")
        rk = json.loads((COMMITTED / "training-report.json").read_text())
        print(
            "A vs committed training-report: split equal="
            f"{rk.get('split') == ra.get('split')} params equal={rk.get('parameters') == ra.get('parameters')}"
        )

    (out / "summary.json").write_text(
        json.dumps(
            {
                "exits": exits,
                "same_seed_identical": ab_same,
                "same_seed_max_abs_diff": ab_max,
                "diff_seed_identical": ac_same,
                "diff_seed_max_abs_diff": ac_max,
                "split": split,
                "problems": problems,
            },
            indent=1,
        )
    )
    print("\nPROBLEMS:" if problems else "\nno problems")
    for p in problems:
        print(" -", p)
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
