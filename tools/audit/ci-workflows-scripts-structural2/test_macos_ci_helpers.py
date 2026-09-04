#!/usr/bin/env python3
"""tools/macos-ci Python helpers, exercised on Linux with a stub `xcrun`.

These helpers run on the Mac runner; nothing here claims Apple behaviour. The
tests only pin the helpers' own control flow, which is platform independent:
`xcresult-summary.py` shells out to `xcrun xcresulttool … summary` and parses
JSON; a stub `xcrun` on PATH returns canned JSON / failures.

Asserts (desired behaviour):
  X1  control: summary with failedTests=2 → exit 1 (docstring: "exits non-zero
      when any bundle reports failed tests, so it can double as a gate")
  X2  summary whose `result` is "Failed" but that carries no `failedTests`
      count must still exit non-zero (the gate must key off the verdict, not
      an optional counter)
  X3  `xcrun xcresulttool` failing (non-zero) on an EXISTING bundle must exit
      non-zero — an unreadable result bundle is not a passing summary
  X4  describe-package.py on non-JSON stdin exits non-zero WITHOUT a raw
      traceback (helper output is tee'd into environment.txt evidence)
"""

from __future__ import annotations

import json
import os
import stat
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
HELPERS = ROOT / "tools" / "macos-ci"
OUT = Path(os.environ.get("AUDIT_OUT", ROOT / "artifacts" / "audit-structural2"))
OUT.mkdir(parents=True, exist_ok=True)

failures: list[str] = []
oks: list[str] = []


def check(label: str, cond: bool, detail: str = "") -> None:
    if cond:
        oks.append(label)
        print(f"[test_macos_ci_helpers] ok   {label}")
    else:
        failures.append(f"{label}: {detail}")
        print(f"[test_macos_ci_helpers] FAIL {label}: {detail}")


def run_summary(tmp: Path, xcrun_body: str, tag: str) -> subprocess.CompletedProcess[str]:
    bindir = tmp / f"bin-{tag}"
    bindir.mkdir()
    stub = bindir / "xcrun"
    stub.write_text("#!/usr/bin/env bash\n" + xcrun_body + "\n")
    stub.chmod(stub.stat().st_mode | stat.S_IEXEC)
    bundle = tmp / f"{tag}.xcresult"
    bundle.mkdir()
    env = {"PATH": f"{bindir}:/usr/bin:/bin"}
    proc = subprocess.run(
        [sys.executable, str(HELPERS / "xcresult-summary.py"), str(bundle)],
        capture_output=True,
        text=True,
        env=env,
    )
    (OUT / f"helpers_{tag}.log").write_text(f"exit={proc.returncode}\n{proc.stdout}{proc.stderr}")
    return proc


with tempfile.TemporaryDirectory() as td:
    tmp = Path(td)

    # X1 control
    ok_json = json.dumps({"result": "Failed", "totalTestCount": 5, "passedTests": 3, "failedTests": 2, "skippedTests": 0,
                          "testFailures": [{"testName": "t", "failureText": "boom"}]})
    p = run_summary(tmp, f"printf '%s' '{ok_json}'", "X1")
    check("X1 failedTests=2 → exit 1", p.returncode == 1, f"exit={p.returncode} out={p.stdout!r}")

    # X2 verdict Failed without counter
    bad_json = json.dumps({"result": "Failed", "totalTestCount": 5, "passedTests": 3})
    p = run_summary(tmp, f"printf '%s' '{bad_json}'", "X2")
    check("X2 result=Failed with no failedTests → non-zero", p.returncode != 0, f"exit={p.returncode} out={p.stdout!r}")

    # X3 xcresulttool fails on an existing bundle
    p = run_summary(tmp, "echo 'xcresulttool: error: unable to read bundle' >&2; exit 1", "X3")
    check("X3 xcresulttool failure on existing bundle → non-zero", p.returncode != 0, f"exit={p.returncode} out={p.stdout!r}")

    # X4 describe-package on non-JSON stdin
    p = subprocess.run(
        [sys.executable, str(HELPERS / "describe-package.py")],
        input="error: unable to describe package\n",
        capture_output=True,
        text=True,
    )
    (OUT / "helpers_X4.log").write_text(f"exit={p.returncode}\n{p.stdout}{p.stderr}")
    check(
        "X4 describe-package non-JSON stdin → non-zero without traceback",
        p.returncode != 0 and "Traceback" not in p.stderr,
        f"exit={p.returncode} stderr_has_traceback={'Traceback' in p.stderr}",
    )

(OUT / "helpers_results.json").write_text(json.dumps({"ok": oks, "failures": failures}, indent=2))
if failures:
    print(f"[test_macos_ci_helpers] RESULT FAIL ({len(failures)} assertion(s))")
    sys.exit(1)
print("[test_macos_ci_helpers] RESULT PASS")
