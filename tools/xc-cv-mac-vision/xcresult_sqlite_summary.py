#!/usr/bin/env python3
"""Summarize `.xcresult` bundles on Linux by reading their `database.sqlite3`.

`tools/macos-ci/xcresult-summary.py` needs `xcrun xcresulttool` (Mac only).
This reader walks the SQLite store Xcode 16+ writes inside the bundle so the
per-test table can be inspected from a downloaded GitHub Actions artifact on
Linux. It reports only what the database holds (device, SDK, suites, test
cases, per-run result and duration) — it does not re-run anything.

Usage: xcresult_sqlite_summary.py --out <json> <bundle.xcresult> [...]

Exit 0 when every bundle had a readable database and no non-`Success` run;
exit 1 when any test case run is not `Success`; exit 2 when a bundle has no
readable database (e.g. a build-only xcresult) — reported, never treated as a
pass.
"""

from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys
from collections import Counter
from typing import Any, Dict, List, Optional, Sequence


def summarize_bundle(bundle: str) -> Dict[str, Any]:
    db_path = os.path.join(bundle, "database.sqlite3")
    summary: Dict[str, Any] = {"bundle": os.path.abspath(bundle), "database": db_path}
    if not os.path.isfile(db_path):
        summary["readable"] = False
        summary["reason"] = "no database.sqlite3 inside bundle"
        return summary
    con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    try:
        tables = {row[0] for row in con.execute("select name from sqlite_master where type='table'")}
        required = {"TestSuites", "TestCases", "TestCaseRuns"}
        if not required.issubset(tables):
            summary["readable"] = False
            summary["reason"] = f"missing tables {sorted(required - tables)}"
            return summary
        summary["readable"] = True
        summary["devices"] = [
            {"name": row[0], "model": row[1], "os": row[2], "arch": row[3], "cpu": row[4], "concrete": row[5]}
            for row in con.execute(
                "select name, modelName, operatingSystemVersionWithBuildNumber, nativeArchitecture, cpuKind, isConcreteDevice from Devices"
            )
        ] if "Devices" in tables else []
        summary["sdks"] = (
            [{"name": row[0], "identifier": row[1]} for row in con.execute("select name, identifier from SDKs")]
            if "SDKs" in tables
            else []
        )
        summary["actions"] = (
            [
                {
                    "name": row[0],
                    "started": row[1],
                    "finished": row[2],
                    "seconds": round(row[2] - row[1], 3) if row[1] is not None and row[2] is not None else None,
                }
                for row in con.execute("select name, started, finished from Actions")
            ]
            if "Actions" in tables
            else []
        )
        rows = con.execute(
            """
            select s.name, c.name, r.result, r.duration
            from TestCaseRuns r
            join TestCases c on c.rowid = r.testCase_fk
            join TestSuites s on s.rowid = c.testSuite_fk
            order by s.name, c.name
            """
        ).fetchall()
        summary["testCaseRuns"] = [
            {"suite": row[0], "test": row[1], "result": row[2], "durationSeconds": row[3]} for row in rows
        ]
        summary["resultCounts"] = dict(Counter(row[2] for row in rows))
        by_suite: Dict[str, Counter] = {}
        for row in rows:
            by_suite.setdefault(row[0], Counter())[row[2]] += 1
        summary["suites"] = {name: dict(counter) for name, counter in sorted(by_suite.items())}
        summary["totalTestCaseRuns"] = len(rows)
        summary["nonSuccess"] = [
            {"suite": row[0], "test": row[1], "result": row[2]} for row in rows if row[2] != "Success"
        ]
        summary["totalDurationSeconds"] = round(sum(row[3] or 0 for row in rows), 3)
        return summary
    finally:
        con.close()


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--out", required=True, help="JSON output path")
    parser.add_argument("bundles", nargs="+")
    args = parser.parse_args(argv)

    summaries: List[Dict[str, Any]] = [summarize_bundle(bundle) for bundle in args.bundles]
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump({"bundles": summaries}, fh, indent=1, sort_keys=True)

    exit_code = 0
    for summary in summaries:
        name = os.path.basename(summary["bundle"])
        if not summary.get("readable"):
            print(f"- {name}: UNREADABLE — {summary.get('reason')}")
            exit_code = max(exit_code, 2)
            continue
        print(
            f"- {name}: {summary['totalTestCaseRuns']} test case runs {summary['resultCounts']} "
            f"in {summary['totalDurationSeconds']}s; devices={[d['name'] for d in summary['devices']]}"
        )
        if summary["nonSuccess"]:
            exit_code = max(exit_code, 1)
            for item in summary["nonSuccess"][:20]:
                print(f"  - {item['result']}: {item['suite']}.{item['test']}")
    print(f"wrote {args.out}")
    return exit_code


if __name__ == "__main__":
    sys.exit(main())
