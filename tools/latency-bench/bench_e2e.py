"""E17 LINUX end-to-end analysis-latency benchmark (movement-complete -> result).

Measures the wall-clock of the full offline analysis pipeline
(packages/swing-lab analyzeVideo, --reuse-extract) on identical clips and
identical pose-input artifacts across arms:

  baseline-pre-integration  origin/main worktree (pre wave-C/D integration):
                            one-shot detector, no worker, no two-pass, no
                            pose-derivative cache, hull detect-span only.
  integrated-default        integration branch defaults: warm paddle worker ON,
                            pose-derivative cache, event-gated hull span,
                            paddle/ball prep concurrency.
  integrated-twopass-roi    + --two-pass --pass1-roi (adaptive two-pass with
                            pass-1 ROI planning).
  integrated-tight-window   + --tight-window (per-event detect segments;
                            incompatible with --two-pass by design, so it is
                            its own arm).

SCOPE / HONESTY:
  - LINUX-CPU only. Never extrapolate to iPhone or Mac.
  - "movement-complete -> result" here is the ANALYSIS stage: pose/people
    artifacts already exist (on-device pose is computed live during capture;
    Apple-Vision extraction cannot run on Linux). Pose input is held constant
    across arms via LINUX-BENCH MediaPipe artifacts (linux_pose_extract.py) --
    real measured pose over the real committed clips, clearly labeled, used
    ONLY as constant latency-bench input, never as labels or accuracy gold.
  - Clips: the only two committed dev bundle clips (wm-volley-02,
    afn-sasebo-rally1). Held-out wm-dink-01 / afn-vic-rally1 are untouched.
  - Wall time includes node/tsx process startup (measured around the child
    process) plus every pipeline stage; per-stage numbers come from the
    pipeline's own report.json timings.

Usage:
  python3 bench_e2e.py [--reps 12] [--out artifacts/bench-results.json]
"""

from __future__ import annotations

import argparse
import json
import math
import platform
import shutil
import subprocess
import tempfile
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
BASELINE_REPO = Path.home() / "repos" / "ps-baseline"

CLIPS = ["wm-volley-02", "afn-sasebo-rally1"]

ARMS = [
    ("baseline-pre-integration", BASELINE_REPO, []),
    ("integrated-default", REPO, []),
    ("integrated-twopass-roi", REPO, ["--two-pass", "--pass1-roi"]),
    ("integrated-tight-window", REPO, ["--tight-window"]),
]

SEED_FILES = ["pose.json", "people.json", "ball.json", "extract-meta.json"]


def git_head(repo: Path) -> str:
    return subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=repo, capture_output=True, text=True, check=True
    ).stdout.strip()


def nearest_rank(sorted_values: list[float], percentile: float) -> float:
    rank = max(1, math.ceil(percentile / 100.0 * len(sorted_values)))
    return sorted_values[rank - 1]


def run_once(repo: Path, clip: str, flags: list[str]) -> dict:
    clip_path = REPO / "datasets/paddle-bench/bundles" / clip / "clip.mp4"
    seed_dir = HERE / "artifacts" / clip
    out_dir = Path(tempfile.mkdtemp(prefix="e17-latbench-"))
    try:
        for name in SEED_FILES:
            shutil.copy(seed_dir / name, out_dir / name)
        swing_lab = repo / "packages/swing-lab"
        argv = [
            str(swing_lab / "node_modules/.bin/tsx"),
            "src/analyzeVideo.ts",
            str(clip_path),
            "--reuse-extract",
            "--out",
            str(out_dir),
            *flags,
        ]
        started = time.monotonic()
        proc = subprocess.run(argv, cwd=swing_lab, capture_output=True, text=True)
        wall_ms = (time.monotonic() - started) * 1000.0
        report_path = out_dir / "report.json"
        report = json.loads(report_path.read_text()) if report_path.exists() else None
        return {
            "wallMs": round(wall_ms, 1),
            "exitCode": proc.returncode,
            "outcome": report["outcome"]["kind"] if report else None,
            "timings": report["timings"] if report else None,
            "detectSpan": report.get("detectSpan") if report else None,
            "paddleSchedule": report.get("paddleSchedule") if report else None,
            "stderrTail": proc.stderr[-400:] if proc.returncode != 0 else None,
        }
    finally:
        shutil.rmtree(out_dir, ignore_errors=True)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--reps", type=int, default=12)
    parser.add_argument("--out", default=str(HERE / "artifacts" / "bench-results.json"))
    args = parser.parse_args()

    runs: list[dict] = []
    # one discarded warm-up per (arm, clip): fills OS page cache + HF cache path
    for arm_name, repo, flags in ARMS:
        for clip in CLIPS:
            result = run_once(repo, clip, flags)
            runs.append({"arm": arm_name, "clip": clip, "rep": -1, "warmup": True, **result})
            print(f"warmup {arm_name} {clip}: {result['wallMs']}ms exit={result['exitCode']}")
    # measured reps, arms interleaved round-robin against machine drift
    for rep in range(args.reps):
        for arm_name, repo, flags in ARMS:
            for clip in CLIPS:
                result = run_once(repo, clip, flags)
                runs.append({"arm": arm_name, "clip": clip, "rep": rep, "warmup": False, **result})
                print(
                    f"rep{rep} {arm_name} {clip}: {result['wallMs']}ms "
                    f"exit={result['exitCode']} outcome={result['outcome']}"
                )

    summary: dict = {}
    for arm_name, _repo, _flags in ARMS:
        summary[arm_name] = {}
        for scope, selector in [(clip, lambda r, c=clip: r["clip"] == c) for clip in CLIPS] + [
            ("pooled-both-clips", lambda r: True)
        ]:
            walls = sorted(
                r["wallMs"]
                for r in runs
                if r["arm"] == arm_name and not r["warmup"] and r["exitCode"] == 0 and selector(r)
            )
            if not walls:
                continue
            stage_totals: dict[str, list[float]] = {}
            for r in runs:
                if r["arm"] == arm_name and not r["warmup"] and r["exitCode"] == 0 and selector(r):
                    for key, value in (r["timings"] or {}).items():
                        stage_totals.setdefault(key, []).append(float(value))
            summary[arm_name][scope] = {
                "n": len(walls),
                "wallMs": {
                    "p50": nearest_rank(walls, 50),
                    "p90": nearest_rank(walls, 90),
                    "p95": nearest_rank(walls, 95),
                    "min": walls[0],
                    "max": walls[-1],
                    "mean": round(sum(walls) / len(walls), 1),
                },
                "stageMedianMs": {
                    key: nearest_rank(sorted(values), 50) for key, values in stage_totals.items()
                },
            }

    output = {
        "id": "e17-latency-e2e",
        "label": "LINUX-CPU — never extrapolate to iPhone/Mac",
        "createdAtIso": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "host": {
            "platform": platform.platform(),
            "machine": platform.machine(),
            "python": platform.python_version(),
        },
        "commits": {
            "integrated": git_head(REPO),
            "baselinePreIntegration": git_head(BASELINE_REPO),
        },
        "clips": CLIPS,
        "arms": [
            {"name": name, "repo": str(repo), "extraFlags": flags} for name, repo, flags in ARMS
        ],
        "repsPerArmPerClip": args.reps,
        "summary": summary,
        "runs": runs,
    }
    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(output, indent=2))
    print(f"wrote {out_path}")


if __name__ == "__main__":
    main()
