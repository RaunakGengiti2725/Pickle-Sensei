#!/usr/bin/env python3
"""Baseline / tolerance / candidate coherence probe for the regression bench.

Checks, without touching any repository file:
  * the committed baseline has 9 `ok` benches, gitDirty=false, no null metrics;
  * baseline metric keys == tolerance metric keys == candidate metric keys;
  * provenance (datasetsTreeSha, datasetReleases, modelVersions) matches
    between baseline and candidate;
  * two candidate summaries are byte-identical modulo runId / timestamps /
    wall clocks (determinism).

usage: coherence.py <candidate.json> [<candidate2.json>]
exit 0 when every check holds, 1 otherwise.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
BASELINE = REPO / "datasets/reports/regression/baseline.json"
TOLERANCES = REPO / "packages/evaluation/regression.tolerances.json"


def load(path: Path) -> dict:
    with path.open() as fh:
        return json.load(fh)


def strip_timing(summary: dict) -> dict:
    copy = dict(summary)
    for key in ("runId", "generatedAtIso", "totalWallClockMs"):
        copy.pop(key, None)
    copy["benches"] = [
        {k: v for k, v in bench.items() if k != "wallClockMs"} for bench in summary["benches"]
    ]
    return copy


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print(__doc__)
        return 2
    baseline = load(BASELINE)
    tolerances = load(TOLERANCES)
    candidate = load(Path(argv[1]))
    ok = True

    def check(label: str, cond: bool, detail: str = "") -> None:
        nonlocal ok
        ok &= cond
        print(f"{'ok  ' if cond else 'FAIL'} {label}{(' — ' + detail) if detail else ''}")

    statuses = [(b["id"], b["status"]) for b in baseline["benches"]]
    check("baseline has 9 ok benches", len(statuses) == 9 and all(s == "ok" for _, s in statuses), str(statuses))
    check("baseline gitDirty=false", baseline["provenance"]["gitDirty"] is False)
    nulls = [k for k, v in baseline["metrics"].items() if v is None]
    check("baseline has no null metrics", not nulls, str(nulls))

    bk, tk, ck = set(baseline["metrics"]), set(tolerances["metrics"]), set(candidate["metrics"])
    check("baseline keys == tolerance keys", bk == tk, f"only-baseline={sorted(bk - tk)} only-tolerances={sorted(tk - bk)}")
    check("candidate keys == baseline keys", ck == bk, f"only-candidate={sorted(ck - bk)} only-baseline={sorted(bk - ck)}")
    check("metric count", len(bk) == 200, str(len(bk)))

    for field in ("datasetsTreeSha", "datasetReleases", "modelVersions", "evidenceClass"):
        check(
            f"provenance.{field} baseline == candidate",
            baseline["provenance"][field] == candidate["provenance"][field],
        )

    if len(argv) > 2:
        other = load(Path(argv[2]))
        check("two candidates identical modulo timing", strip_timing(candidate) == strip_timing(other))

    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
