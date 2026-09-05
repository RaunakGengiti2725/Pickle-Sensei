#!/usr/bin/env python3
"""Seeded stress campaign driver for the native bridge core.

Runs every scenario in its OWN stress-runner process so a Swift runtime trap
(duplicate landmark, arithmetic overflow) kills one scenario, not the campaign,
and is recorded as a `crashed` row for the exact seed that was executing.

  scripts/campaign.py --iter 200 --out results/campaign-200
  scripts/campaign.py --iter 25 --scenario hugeAndCorruptInputs

Outputs (under --out):
  <scenario>.jsonl   raw runner stream (started/outcome rows)
  <scenario>.log     runner stderr (Swift backtrace on a trap)
  seeds.json         seed -> outcome table for every executed iteration
  summary.json       per-scenario counts, exit codes, flaky rates, minimized seeds
Only iterations whose `started` marker was written count as executed.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import time
from collections import Counter
from pathlib import Path

HERE = Path(__file__).resolve().parent
PACKAGE = HERE.parent


def runner_path() -> Path:
    override = os.environ.get("STRESS_RUNNER")
    if override:
        return Path(override)
    candidate = PACKAGE / ".build" / "debug" / "stress-runner"
    if candidate.exists():
        return candidate
    sys.exit("stress-runner not built: run `swift build` in " + str(PACKAGE))


def list_scenarios(runner: Path) -> list[dict]:
    out = subprocess.run([str(runner), "list"], check=True, capture_output=True, text=True).stdout
    scenarios = []
    for line in out.splitlines():
        parts = line.split()
        if not parts:
            continue
        scenarios.append(
            {
                "name": parts[0],
                "expectsProcessTrap": "[expects-process-trap]" in parts,
                "heavy": "[heavy]" in parts,
            }
        )
    return scenarios


def describe_exit(proc: subprocess.CompletedProcess) -> tuple[int, str | None]:
    code = proc.returncode
    if code < 0:
        import signal

        return code, signal.Signals(-code).name
    return code, None


def run_range(runner: Path, scenario: str, seed_start: int, count: int, jsonl: Path, log: Path) -> dict:
    """Runs seeds [seed_start, seed_start+count) in one process, resuming past traps."""
    rows: dict[int, dict] = {}
    exits: list[dict] = []
    next_seed = seed_start
    end = seed_start + count
    while next_seed < end:
        remaining = end - next_seed
        cmd = [
            str(runner),
            "run",
            "--scenario",
            scenario,
            "--seed-start",
            str(next_seed),
            "--count",
            str(remaining),
            "--out",
            str(jsonl),
        ]
        started_at = time.time()
        proc = subprocess.run(cmd, capture_output=True, text=True)
        code, sig = describe_exit(proc)
        with log.open("a") as fh:
            fh.write(f"$ {' '.join(cmd)}\n→ exit {code}{' (' + sig + ')' if sig else ''} in {time.time() - started_at:.1f}s\n")
            if proc.stderr:
                fh.write(proc.stderr[-4000:] + "\n")
        exits.append({"command": " ".join(cmd), "exit": code, "signal": sig})

        # Parse everything the runner wrote so far.
        pending: dict[int, dict] = {}
        for line in jsonl.read_text().splitlines():
            if not line.strip():
                continue
            row = json.loads(line)
            seed = int(row["seed"])
            if row.get("event") == "started":
                pending[seed] = row
            elif row.get("event") == "outcome":
                pending.pop(seed, None)
                rows[seed] = row
        for seed, marker in pending.items():
            if seed in rows:
                continue
            rows[seed] = {
                "event": "outcome",
                "scenario": scenario,
                "seed": seed,
                "status": "crashed",
                "detail": f"process exited {code}{' (' + sig + ')' if sig else ''} during iteration; stderr tail in {log.name}",
                "operations": 0,
                "durationMs": 0,
                "metrics": {"exitCode": code},
            }
        # The runner stops at the seed that trapped (or finished the range).
        executed = [s for s in rows if seed_start <= s < end]
        if code == 0 or (code == 3 and len(executed) == count):
            break
        if not executed:
            break  # nothing ran at all — do not spin
        next_seed = max(executed) + 1
    return {"rows": rows, "exits": exits}


def replay(runner: Path, scenario: str, seed: int) -> dict:
    proc = subprocess.run([str(runner), "replay", "--scenario", scenario, "--seed", str(seed)], capture_output=True, text=True)
    code, sig = describe_exit(proc)
    status = "held" if code == 0 else ("crashed" if code not in (0, 3) else "violated")
    return {"exit": code, "signal": sig, "status": status}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--iter", type=int, default=int(os.environ.get("STRESS_ITER", "25")))
    parser.add_argument("--seed-start", type=int, default=1)
    parser.add_argument("--scenario", default="all")
    parser.add_argument("--out", default=str(PACKAGE / "results" / time.strftime("campaign-%Y%m%dT%H%M%SZ", time.gmtime())))
    parser.add_argument("--flaky-reruns", type=int, default=10)
    args = parser.parse_args()

    runner = runner_path()
    out = Path(args.out)
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)

    scenarios = list_scenarios(runner)
    if args.scenario != "all":
        scenarios = [s for s in scenarios if s["name"] == args.scenario]
        if not scenarios:
            sys.exit(f"unknown scenario {args.scenario}")

    seeds_table: list[dict] = []
    summary: dict = {
        "runner": str(runner),
        "requestedIterations": args.iter,
        "seedStart": args.seed_start,
        "scenarios": {},
        "executed": 0,
        "held": 0,
        "violated": 0,
        "crashed": 0,
    }
    for scenario in scenarios:
        name = scenario["name"]
        count = max(1, args.iter // 25) if scenario["heavy"] else args.iter
        jsonl = out / f"{name}.jsonl"
        log = out / f"{name}.log"
        result = run_range(runner, name, args.seed_start, count, jsonl, log)
        rows = result["rows"]
        statuses = Counter(r["status"] for r in rows.values())
        failing = sorted(s for s, r in rows.items() if r["status"] != "held")

        # Every failing seed is replayed 10x so flaky vs deterministic is measured, not guessed.
        reruns: dict[str, dict] = {}
        for seed in failing:
            results = [replay(runner, name, seed) for _ in range(args.flaky_reruns)]
            fails = sum(1 for r in results if r["status"] != "held")
            reruns[str(seed)] = {
                "failures": fails,
                "runs": len(results),
                "rate": fails / len(results),
                "statuses": Counter(r["status"] for r in results),
                "exits": sorted({r["exit"] for r in results}),
            }
        summary["scenarios"][name] = {
            "expectsProcessTrap": scenario["expectsProcessTrap"],
            "heavy": scenario["heavy"],
            "requested": count,
            "executed": len(rows),
            "statuses": dict(statuses),
            "failingSeeds": failing,
            "smallestFailingSeed": failing[0] if failing else None,
            "firstFailureDetail": rows[failing[0]]["detail"] if failing else None,
            "reruns": reruns,
            "processExits": result["exits"],
            "operations": sum(r.get("operations", 0) for r in rows.values()),
        }
        for seed in sorted(rows):
            row = rows[seed]
            seeds_table.append(
                {
                    "scenario": name,
                    "seed": seed,
                    "status": row["status"],
                    "detail": row.get("detail"),
                    "operations": row.get("operations", 0),
                    "durationMs": row.get("durationMs", 0),
                    "metrics": row.get("metrics", {}),
                    "replay": f"stress-runner replay --scenario {name} --seed {seed}",
                }
            )
        summary["executed"] += len(rows)
        for key in ("held", "violated", "crashed"):
            summary[key] += statuses.get(key, 0)
        print(
            f"{name:32s} executed={len(rows):5d} held={statuses.get('held', 0):5d} "
            f"violated={statuses.get('violated', 0):3d} crashed={statuses.get('crashed', 0):3d}"
            + (f"  first failing seed={failing[0]}" if failing else "")
        )

    (out / "seeds.json").write_text(json.dumps(seeds_table, indent=1, sort_keys=True))
    (out / "summary.json").write_text(json.dumps(summary, indent=1, sort_keys=True, default=str))
    print(f"\nexecuted={summary['executed']} held={summary['held']} violated={summary['violated']} crashed={summary['crashed']}")
    print(f"artifacts: {out}")
    return 0 if summary["violated"] == 0 and summary["crashed"] == 0 else 3


if __name__ == "__main__":
    sys.exit(main())
