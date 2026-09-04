#!/usr/bin/env python3
"""Summarize .xcresult bundles as Markdown for $GITHUB_STEP_SUMMARY.

Usage: xcresult-summary.py <bundle.xcresult> [...]

Uses `xcrun xcresulttool get test-results summary` (Xcode 16+) and exits
non-zero when any bundle reports failed tests, so it can double as a gate.
"""
import json
import os
import subprocess
import sys

failed_total = 0
for bundle in sys.argv[1:]:
    name = os.path.basename(bundle)
    if not os.path.isdir(bundle):
        print(f"- `{name}`: (missing)")
        continue
    try:
        raw = subprocess.run(
            ["xcrun", "xcresulttool", "get", "test-results", "summary", "--path", bundle],
            check=True,
            capture_output=True,
            text=True,
        ).stdout
        summary = json.loads(raw)
    except Exception as exc:  # noqa: BLE001 - report, never crash the summary
        print(f"- `{name}`: (no test summary: {type(exc).__name__})")
        continue
    result = summary.get("result")
    total = summary.get("totalTestCount")
    passed = summary.get("passedTests")
    failed = summary.get("failedTests") or 0
    skipped = summary.get("skippedTests")
    failed_total += int(failed)
    print(f"- `{name}`: **{result}** — total {total}, passed {passed}, failed {failed}, skipped {skipped}")
    for f in summary.get("testFailures", [])[:20]:
        print(f"  - FAILED {f.get('testName')}: {f.get('failureText', '').strip()[:200]}")

sys.exit(1 if failed_total else 0)
