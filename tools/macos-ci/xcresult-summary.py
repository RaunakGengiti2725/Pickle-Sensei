#!/usr/bin/env python3
"""Summarize .xcresult bundles as Markdown for $GITHUB_STEP_SUMMARY.

Usage: xcresult-summary.py <bundle.xcresult> [...]

Uses `xcrun xcresulttool get test-results summary` (Xcode 16+). Exits non-zero
when any bundle reports failed tests, when any named bundle is missing or
cannot be summarised, or when no bundle was given — so it doubles as a gate
and a stage that produced no evidence cannot report a clean summary.
"""
import json
import os
import subprocess
import sys

failed_total = 0
summarised = 0
unreadable = 0
for bundle in sys.argv[1:]:
    name = os.path.basename(bundle)
    if not os.path.isdir(bundle):
        print(f"- `{name}`: (missing)")
        unreadable += 1
        continue
    try:
        raw = subprocess.run(
            ["xcrun", "xcresulttool", "get", "test-results", "summary", "--path", bundle],
            check=True,
            capture_output=True,
            text=True,
        ).stdout
        summary = json.loads(raw)
    except subprocess.CalledProcessError as exc:
        detail = (exc.stderr or "").strip().splitlines()
        print(f"- `{name}`: (no test summary: xcresulttool exit {exc.returncode}{': ' + detail[-1] if detail else ''})")
        unreadable += 1
        continue
    except (OSError, ValueError) as exc:
        print(f"- `{name}`: (no test summary: {type(exc).__name__}: {exc})")
        unreadable += 1
        continue
    if not isinstance(summary, dict):
        print(f"- `{name}`: (no test summary: unexpected JSON shape {type(summary).__name__})")
        unreadable += 1
        continue
    summarised += 1
    result = summary.get("result")
    total = summary.get("totalTestCount")
    passed = summary.get("passedTests")
    failed = summary.get("failedTests") or 0
    skipped = summary.get("skippedTests")
    failed_total += int(failed)
    print(f"- `{name}`: **{result}** — total {total}, passed {passed}, failed {failed}, skipped {skipped}")
    for f in summary.get("testFailures", [])[:20]:
        print(f"  - FAILED {f.get('testName')}: {f.get('failureText', '').strip()[:200]}")

if not sys.argv[1:]:
    print("xcresult-summary: no .xcresult bundle given", file=sys.stderr)
    sys.exit(2)
if unreadable:
    print(f"xcresult-summary: {unreadable} bundle(s) missing or unreadable — no evidence, not a pass", file=sys.stderr)
if summarised == 0:
    print("xcresult-summary: zero bundles summarised", file=sys.stderr)
sys.exit(1 if (failed_total or unreadable or summarised == 0) else 0)
