#!/usr/bin/env python3
"""Structural pins for .github/workflows/*.yml (REVIEW.md / OPERATING_SYSTEM.md rules).

No YAML library is available on the Linux plane, so this parses the small,
regular subset these workflows use with regexes over the raw text.

Asserts (desired behaviour):
  W1  every workflow declares `permissions:` with `contents: read` (REVIEW.md)
  W2  mac-full-verify.yml has no pull_request trigger
  W3  Mac workflows run only on [self-hosted, macOS, ARM64]
  W4  the union of `verify-cloud.sh --only` stage lists in ci.yml equals
      PR_STAGES in scripts/verify-cloud.sh (local `--tier pr` == CI)
  W5  no `${{ inputs.* }}` / `${{ github.event.* }}` expression is expanded
      inside a `run:` script body (GitHub script-injection pattern; inputs must
      be passed through `env:`)
  W6  every job has a `timeout-minutes` (a hung stage otherwise holds a runner
      for GitHub's 360-minute default)
"""

from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
WF = ROOT / ".github" / "workflows"
OUT = Path(os.environ.get("AUDIT_OUT", ROOT / "artifacts" / "audit-structural2"))
OUT.mkdir(parents=True, exist_ok=True)

failures: list[str] = []
oks: list[str] = []


def check(label: str, cond: bool, detail: str = "") -> None:
    if cond:
        oks.append(label)
        print(f"[test_workflows] ok   {label}")
    else:
        failures.append(f"{label}: {detail}")
        print(f"[test_workflows] FAIL {label}: {detail}")


workflows = sorted(WF.glob("*.yml"))
texts = {p.name: p.read_text() for p in workflows}

# W1 permissions
for name, text in texts.items():
    has = re.search(r"^permissions:\s*\n(\s+contents:\s*read)", text, re.M) is not None
    check(f"W1 {name} declares permissions: contents: read", has, "no top-level permissions block")

# W2 no pull_request on mac-full-verify
mfv = texts["mac-full-verify.yml"]
on_block = re.search(r"^on:\n((?:[ \t]+.*\n|\n)+)", mfv, re.M).group(1)
check("W2 mac-full-verify.yml has no pull_request trigger", "pull_request" not in on_block, on_block)

# W3 runner labels
for name in ("mac-full-verify.yml", "mac-smoke-test.yml"):
    labels = re.findall(r"runs-on:\s*\[([^\]]+)\]", texts[name])
    mac_jobs = [l for l in labels if "self-hosted" in l]
    check(
        f"W3 {name} Mac jobs pinned to self-hosted/macOS/ARM64",
        all({"self-hosted", "macOS", "ARM64"} <= {x.strip() for x in l.split(",")} for l in mac_jobs)
        and mac_jobs,
        str(labels),
    )

# W4 stage parity
ci = texts["ci.yml"]
only_lists = re.findall(r"verify-cloud\.sh\s+--only\s+([a-z,]+)", ci)
ci_union = set()
for lst in only_lists:
    ci_union |= set(lst.split(","))
vc = (ROOT / "scripts" / "verify-cloud.sh").read_text()
pr_stages = set(re.search(r"^PR_STAGES=\(([^)]+)\)", vc, re.M).group(1).split())
check(
    "W4 ci.yml --only union == verify-cloud PR_STAGES",
    ci_union == pr_stages,
    f"ci={sorted(ci_union)} pr={sorted(pr_stages)}",
)
(OUT / "workflows_W4_parity.json").write_text(
    json.dumps({"ci_only_lists": only_lists, "ci_union": sorted(ci_union), "PR_STAGES": sorted(pr_stages)}, indent=2)
)

# W5 expressions inside run: bodies
injection: list[str] = []
for name, text in texts.items():
    lines = text.splitlines()
    in_run = False
    run_indent = 0
    for i, line in enumerate(lines, 1):
        m = re.match(r"^(\s*)(-\s+)?run:\s*(\|?|>?)\s*$", line)
        if m:
            in_run = True
            run_indent = len(m.group(1)) + (2 if m.group(2) else 0)
            continue
        if in_run:
            if line.strip() == "":
                continue
            indent = len(line) - len(line.lstrip())
            if indent <= run_indent:
                in_run = False
            elif re.search(r"\$\{\{\s*(inputs|github\.event|github\.head_ref)[.\s]", line):
                injection.append(f"{name}:{i}: {line.strip()}")
        if re.match(r"^\s*(-\s+)?run:\s*\S", line) and re.search(r"\$\{\{\s*(inputs|github\.event)", line):
            injection.append(f"{name}:{i}: {line.strip()}")
check("W5 no untrusted expression expanded inside run: scripts", not injection, "; ".join(injection))
(OUT / "workflows_W5_injection_sites.txt").write_text("\n".join(injection) + "\n")

# W6 timeout-minutes per job
missing_timeout: list[str] = []
for name, text in texts.items():
    jobs_m = re.search(r"^jobs:\n(.*)", text, re.M | re.S)
    body = jobs_m.group(1)
    # split on 2-space-indented job keys
    parts = re.split(r"^  ([A-Za-z0-9_-]+):\s*\n", body, flags=re.M)
    for j in range(1, len(parts), 2):
        job, jbody = parts[j], parts[j + 1]
        if "timeout-minutes" not in jbody:
            missing_timeout.append(f"{name}:{job}")
check("W6 every job sets timeout-minutes", not missing_timeout, ", ".join(missing_timeout))

# W7 CI verify job uses distinct databases for DATABASE_URL_TEST and DATABASE_URL,
# as verify-cloud.sh's defaults (5433/pickle_test vs 5432/pickle_dev) and
# docker-compose (postgres + postgres_test) do locally.
ci_test = re.search(r"^\s+DATABASE_URL_TEST:\s*(\S+)", ci, re.M)
ci_dev = re.search(r"^\s+DATABASE_URL:\s*(\S+)", ci, re.M)
vc_test = re.search(r'DATABASE_URL_TEST:-([^}"]+)', vc).group(1)
vc_dev = re.search(r'DATABASE_URL:-([^}"]+)', vc).group(1)
check(
    "W7 ci.yml test DB != dev DB (matches local two-database layout)",
    ci_test is not None and ci_dev is not None and ci_test.group(1) != ci_dev.group(1),
    f"ci TEST={ci_test and ci_test.group(1)} DEV={ci_dev and ci_dev.group(1)} | local TEST={vc_test} DEV={vc_dev}",
)
check("W7 control: verify-cloud.sh local defaults are two databases", vc_test != vc_dev, f"{vc_test} == {vc_dev}")

(OUT / "workflows_results.json").write_text(json.dumps({"ok": oks, "failures": failures}, indent=2))
if failures:
    print(f"[test_workflows] RESULT FAIL ({len(failures)} assertion(s))")
    sys.exit(1)
print("[test_workflows] RESULT PASS")
