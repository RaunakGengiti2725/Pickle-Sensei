"""Wave planner and ledger roll-up for the production program.

    python3 schedule.py plan   [--done W01-01,...] [--active W04-01]
    python3 schedule.py ledger [--runs runs.json]

`plan` prints the packages that may start now: all `deps` accepted, no
`serial_group` shared with an active package, cloud plane (mac plane packages
are queued to the coordinator's single Mac slot), highest severity first,
respecting the two-active-worker limit.

`ledger` rolls `artifacts/production-program/*/record.json` plus the
`runs.json` mapping (workflow run ids, session ids per agent label — filled by
the coordinator from `run_workflow` output) into the program ledger
`.devin/program/ledger/ledger.json` with separate agent / workflow-run /
session counts.
"""

from __future__ import annotations

import argparse
import glob
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
sys.path.insert(0, HERE)
import program_lib as pl  # noqa: E402

MANIFEST = os.path.join(ROOT, ".devin", "program", "manifest.json")
ART = os.path.join(ROOT, "artifacts", "production-program")
LEDGER_DIR = os.path.join(ROOT, ".devin", "program", "ledger")
# Program default (two active workers). The owner may raise it explicitly per
# wave with --max-active; serial groups and dependencies still gate what runs.
MAX_ACTIVE = 2
SEV = {"P0": 0, "P1": 1, "P2": 2}


def load_records() -> dict[str, dict]:
    out = {}
    for path in sorted(glob.glob(os.path.join(ART, "*", "record.json"))):
        with open(path, encoding="utf8") as fh:
            rec = json.load(fh)
        out[rec["package_id"]] = rec
    return out


def plan(done: set[str], active: set[str], blocked: set[str], max_active: int = MAX_ACTIVE) -> list[dict]:
    m = pl.load_manifest(MANIFEST)
    pk = {p["id"]: p for p in m["packages"]}
    busy_groups = {g for a in active for g in pk[a]["serial_groups"]}
    ready = []
    for p in m["packages"]:
        if p["id"] in done or p["id"] in active or p["id"] in blocked:
            continue
        if p["plane"] in ("external", "docs", "mac"):
            continue
        if any(d not in done for d in p["deps"]):
            continue
        if set(p["serial_groups"]) & busy_groups:
            continue
        ready.append(p)
    ready.sort(key=lambda p: (SEV[p["severity"]], len([q for q in m["packages"] if p["id"] in q["deps"]]) * -1, p["id"]))
    # greedy: fill free slots without introducing a serial-group clash among the chosen
    chosen: list[dict] = []
    taken = set(busy_groups)
    for p in ready:
        if len(chosen) + len(active) >= max_active:
            break
        if set(p["serial_groups"]) & taken:
            continue
        chosen.append(p)
        taken |= set(p["serial_groups"])
    return chosen


def ledger(runs_path: str | None) -> dict:
    m = pl.load_manifest(MANIFEST)
    records = load_records()
    runs: dict = {}
    if runs_path and os.path.isfile(runs_path):
        with open(runs_path, encoding="utf8") as fh:
            runs = json.load(fh)
    # runs.json shape: {"<package_id>": {"run_ids": [...], "sessions": {"<agent label>": "<session id>"}}}
    agents: list[dict] = []
    workflow_runs: set[str] = set()
    sessions: set[str] = set()
    packages: list[dict] = []
    for p in m["packages"]:
        rec = records.get(p["id"])
        run_info = runs.get(p["id"], {})
        for rid in run_info.get("run_ids", []):
            workflow_runs.add(rid)
        status = rec["status"] if rec else ("BLOCKED_EXTERNAL" if p["external_blocker"] else "NOT_STARTED")
        row = {
            "id": p["id"],
            "parent": p["parent"],
            "severity": p["severity"],
            "plane": p["plane"],
            "status": status,
            "external_blocker": p["external_blocker"],
            "candidate": (rec or {}).get("candidate"),
            "workflow_run_ids": run_info.get("run_ids", []),
        }
        packages.append(row)
        if rec:
            for a in rec["agents"]:
                sid = run_info.get("sessions", {}).get(a["label"])
                agents.append({"package_id": p["id"], **a, "session_id": sid, "workflow_run_ids": run_info.get("run_ids", [])})
                if sid:
                    sessions.add(sid)
    counts = {
        "agents": {
            "requested": len(agents),
            "launched": len(agents),
            "completed": sum(1 for a in agents if a["status"] == "completed"),
            "failed": sum(1 for a in agents if a["status"] == "failed"),
            "with_session_id": sum(1 for a in agents if a.get("session_id")),
        },
        "workflow_runs": len(workflow_runs),
        "sessions": len(sessions),
        "packages": {s: sum(1 for r in packages if r["status"] == s) for s in sorted({r["status"] for r in packages})},
    }
    out = {"manifest_sha256": m["manifest_sha256"], "lib_version": pl.LIB_VERSION, "counts": counts, "packages": packages, "agents": agents, "workflow_run_ids": sorted(workflow_runs)}
    os.makedirs(LEDGER_DIR, exist_ok=True)
    with open(os.path.join(LEDGER_DIR, "ledger.json"), "w", encoding="utf8") as fh:
        fh.write(pl.dump(out) + "\n")
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["plan", "ledger"])
    ap.add_argument("--done", default="")
    ap.add_argument("--active", default="")
    ap.add_argument("--blocked", default="")
    ap.add_argument("--runs", default=os.path.join(LEDGER_DIR, "runs.json"))
    ap.add_argument("--max-active", type=int, default=MAX_ACTIVE, help="owner-approved concurrent package limit")
    args = ap.parse_args()
    split = lambda s: {x for x in s.split(",") if x}  # noqa: E731
    if args.cmd == "plan":
        for p in plan(split(args.done), split(args.active), split(args.blocked), args.max_active):
            print(f"{p['id']}\t{p['severity']}\t{p['plane']}\t{','.join(p['serial_groups']) or '-'}\t{p['title']}")
    else:
        out = ledger(args.runs)
        print(pl.dump(out["counts"]))


if __name__ == "__main__":
    main()
