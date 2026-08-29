"""H22 LINUX performance-certification benchmark (Wave H, Gate 13).

Measures the movement-complete -> result-interactive PROXY on Linux CPU:
the full offline analysis stage (packages/swing-lab analyzeVideo,
--reuse-extract) over constant pre-generated pose/people/ball/extract-meta
artifacts. This is the same measurement boundary as Wave E e17
(tools/latency-bench/bench_e2e.py), extended with:

  - REAL cold runs: page cache dropped via /proc/sys/vm/drop_caches before
    each cold rep (e17 had no true-cold samples).
  - Peak RSS per run (GNU time -v, max over the tsx process tree via wait4
    rusage including children).
  - A Try Again stress phase: N consecutive attempts of the same clip,
    with a least-squares wall-clock and RSS slope over attempts (degrading
    latency / memory growth detection).

SCOPE / HONESTY (unchanged from e17):
  - LINUX-CPU only. Never extrapolate to iPhone or Mac. Absolute numbers on
    this box are NOT comparable to e17's box (different hardware); only
    within-box arm comparisons are valid.
  - Pose input held constant via the committed LINUX-BENCH MediaPipe
    artifacts (never labels/accuracy evidence). ball.json honestly empty.
  - Clips: the two committed dev bundle clips only. Held-out wm-dink-01 /
    afn-vic-rally1 untouched.

Usage:
  python3 bench_h22.py [--cold-reps 3] [--warm-reps 8] [--tryagain 12]
                       [--out artifacts/h22-bench-results.json]
"""

from __future__ import annotations

import argparse
import json
import math
import platform
import re
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
    ("rc-default", REPO, []),
]

SEED_FILES = ["pose.json", "people.json", "ball.json", "extract-meta.json"]

RSS_RE = re.compile(r"Maximum resident set size \(kbytes\): (\d+)")


def git_head(repo: Path) -> str:
    return subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=repo, capture_output=True, text=True, check=True
    ).stdout.strip()


def nearest_rank(sorted_values: list[float], percentile: float) -> float:
    rank = max(1, math.ceil(percentile / 100.0 * len(sorted_values)))
    return sorted_values[rank - 1]


def drop_caches() -> None:
    subprocess.run(["sync"], check=True)
    subprocess.run(
        ["sudo", "-n", "sh", "-c", "echo 3 > /proc/sys/vm/drop_caches"], check=True
    )


def run_once(repo: Path, clip: str, flags: list[str]) -> dict:
    clip_path = REPO / "datasets/paddle-bench/bundles" / clip / "clip.mp4"
    seed_dir = HERE / "artifacts" / clip
    out_dir = Path(tempfile.mkdtemp(prefix="h22-latbench-"))
    try:
        for name in SEED_FILES:
            shutil.copy(seed_dir / name, out_dir / name)
        swing_lab = repo / "packages/swing-lab"
        argv = [
            "/usr/bin/time",
            "-v",
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
        rss_match = RSS_RE.search(proc.stderr)
        report_path = out_dir / "report.json"
        report = json.loads(report_path.read_text()) if report_path.exists() else None
        serialize_started = time.monotonic()
        if report is not None:
            json.dumps(report)
        serialize_ms = (time.monotonic() - serialize_started) * 1000.0
        return {
            "wallMs": round(wall_ms, 1),
            "maxRssKb": int(rss_match.group(1)) if rss_match else None,
            "exitCode": proc.returncode,
            "outcome": report["outcome"]["kind"] if report else None,
            "timings": report["timings"] if report else None,
            "reportSerializeMs": round(serialize_ms, 2) if report else None,
            "reportBytes": report_path.stat().st_size if report_path.exists() else None,
            "stderrTail": proc.stderr[-400:] if proc.returncode != 0 else None,
        }
    finally:
        shutil.rmtree(out_dir, ignore_errors=True)


def least_squares_slope(ys: list[float]) -> float:
    n = len(ys)
    xs = list(range(n))
    mean_x = sum(xs) / n
    mean_y = sum(ys) / n
    denom = sum((x - mean_x) ** 2 for x in xs)
    if denom == 0:
        return 0.0
    return sum((x - mean_x) * (y - mean_y) for x, y in zip(xs, ys)) / denom


def summarize(walls: list[float]) -> dict:
    s = sorted(walls)
    return {
        "n": len(s),
        "p50": nearest_rank(s, 50),
        "p90": nearest_rank(s, 90),
        "p95": nearest_rank(s, 95),
        "min": s[0],
        "max": s[-1],
        "mean": round(sum(s) / len(s), 1),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--cold-reps", type=int, default=3)
    parser.add_argument("--warm-reps", type=int, default=8)
    parser.add_argument("--tryagain", type=int, default=12)
    parser.add_argument("--out", default=str(HERE / "artifacts" / "h22-bench-results.json"))
    args = parser.parse_args()

    runs: list[dict] = []

    # PHASE 1 — true-cold runs (page cache dropped before every rep)
    for rep in range(args.cold_reps):
        for arm_name, repo, flags in ARMS:
            for clip in CLIPS:
                drop_caches()
                result = run_once(repo, clip, flags)
                runs.append(
                    {"phase": "cold", "arm": arm_name, "clip": clip, "rep": rep, **result}
                )
                print(f"cold rep{rep} {arm_name} {clip}: {result['wallMs']}ms exit={result['exitCode']}")

    # PHASE 2 — warm runs (1 discarded warmup per arm+clip, then measured reps)
    for arm_name, repo, flags in ARMS:
        for clip in CLIPS:
            result = run_once(repo, clip, flags)
            runs.append({"phase": "warmup-discard", "arm": arm_name, "clip": clip, "rep": -1, **result})
            print(f"warmup {arm_name} {clip}: {result['wallMs']}ms")
    for rep in range(args.warm_reps):
        for arm_name, repo, flags in ARMS:
            for clip in CLIPS:
                result = run_once(repo, clip, flags)
                runs.append(
                    {"phase": "warm", "arm": arm_name, "clip": clip, "rep": rep, **result}
                )
                print(f"warm rep{rep} {arm_name} {clip}: {result['wallMs']}ms exit={result['exitCode']} outcome={result['outcome']}")

    # PHASE 3 — Try Again stress: consecutive attempts, rc-default, both clips
    tryagain: dict[str, dict] = {}
    for clip in CLIPS:
        attempts = []
        for attempt in range(args.tryagain):
            result = run_once(REPO, clip, [])
            attempts.append(result)
            runs.append({"phase": "tryagain", "arm": "rc-default", "clip": clip, "rep": attempt, **result})
            print(f"tryagain attempt{attempt} {clip}: {result['wallMs']}ms rss={result['maxRssKb']}kB")
        ok = [a for a in attempts if a["exitCode"] == 0]
        walls = [a["wallMs"] for a in ok]
        rsses = [float(a["maxRssKb"]) for a in ok if a["maxRssKb"] is not None]
        tryagain[clip] = {
            "attempts": len(attempts),
            "ok": len(ok),
            "wallMs": summarize(walls) if walls else None,
            "wallSlopeMsPerAttempt": round(least_squares_slope(walls), 1) if len(walls) > 1 else None,
            "firstWallMs": walls[0] if walls else None,
            "lastWallMs": walls[-1] if walls else None,
            "maxRssKb": summarize(rsses) if rsses else None,
            "rssSlopeKbPerAttempt": round(least_squares_slope(rsses), 1) if len(rsses) > 1 else None,
        }

    summary: dict = {}
    for phase in ["cold", "warm"]:
        summary[phase] = {}
        for arm_name, _repo, _flags in ARMS:
            summary[phase][arm_name] = {}
            scopes = [(clip, lambda r, c=clip: r["clip"] == c) for clip in CLIPS]
            scopes.append(("pooled-both-clips", lambda r: True))
            for scope, selector in scopes:
                sel = [
                    r
                    for r in runs
                    if r["phase"] == phase
                    and r["arm"] == arm_name
                    and r["exitCode"] == 0
                    and selector(r)
                ]
                if not sel:
                    continue
                walls = [r["wallMs"] for r in sel]
                rsses = [float(r["maxRssKb"]) for r in sel if r["maxRssKb"] is not None]
                stage_totals: dict[str, list[float]] = {}
                for r in sel:
                    for key, value in (r["timings"] or {}).items():
                        stage_totals.setdefault(key, []).append(float(value))
                summary[phase][arm_name][scope] = {
                    "wallMs": summarize(walls),
                    "maxRssKb": summarize(rsses) if rsses else None,
                    "stageMedianMs": {
                        key: nearest_rank(sorted(values), 50)
                        for key, values in stage_totals.items()
                    },
                }

    output = {
        "id": "h22-perf-cert-bench",
        "label": "LINUX-CPU — never extrapolate to iPhone/Mac; absolute numbers not comparable across boxes",
        "createdAtIso": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "host": {
            "platform": platform.platform(),
            "machine": platform.machine(),
            "python": platform.python_version(),
        },
        "commits": {
            "rc": git_head(REPO),
            "baselinePreIntegration": git_head(BASELINE_REPO),
        },
        "clips": CLIPS,
        "arms": [
            {"name": name, "repo": str(repo), "extraFlags": flags} for name, repo, flags in ARMS
        ],
        "coldReps": args.cold_reps,
        "warmReps": args.warm_reps,
        "tryagainAttempts": args.tryagain,
        "summary": summary,
        "tryagain": tryagain,
        "runs": runs,
    }
    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(output, indent=2))
    print(f"wrote {out_path}")


if __name__ == "__main__":
    main()
