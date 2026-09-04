#!/usr/bin/env python3
"""Adversarial scenario S2 — `${{ inputs.only }}` in mac-full-verify.yml.

GitHub Actions substitutes `${{ ... }}` expressions into the `run:` text BEFORE
the shell parses it. This harness reproduces that substitution locally (no
workflow_dispatch is ever issued — Devin may not trigger the Mac runner) and
executes the resulting script with bash against a stub scripts/mac-full-verify.sh
that only records its argv, so we can see exactly which payloads reach the
shell as code and which arrive as a harmless argument.

    tests/attack/ci-workflows-scripts/s2_workflow_input_interpolation.py [<repo-root>] [--json]

Exit 1 when any payload executes injected commands (i.e. the interpolation is
exploitable), 0 when every payload is inert.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(sys.argv[1] if len(sys.argv) > 1 and not sys.argv[1].startswith("--") else Path(__file__).resolve().parents[3])
WORKFLOW = ROOT / ".github/workflows/mac-full-verify.yml"

# Each payload, if it executes, creates the file PWNED (an unambiguous side
# effect — an echoed marker could merely be an argv value bounced back).
PWNED = "pwned"


def payloads(pwned: str) -> dict[str, str]:
    return {
        # the coordinator's payload: `;` inside a double-quoted context is inert
        "semicolon": f"environment; touch {pwned}",
        # command substitution expands INSIDE double quotes
        "cmdsubst": f"environment$(touch {pwned})",
        # backticks also expand inside double quotes
        "backtick": f"environment`touch {pwned}`",
        # close the quote, run a command, comment out the rest of the line
        "quote_break": f'environment"; touch {pwned} #',
        # benign control
        "benign": "environment,swift-native",
    }


def run_step_text() -> str:
    text = WORKFLOW.read_text()
    m = re.search(r"- name: Run canonical Apple verification\n\s+run: \|\n((?:[ ]{10}.*\n)+)", text)
    if not m:
        raise SystemExit("could not locate the run step in mac-full-verify.yml")
    return "".join(line[10:] for line in m.group(1).splitlines(keepends=True))


def substitute(script: str, inputs: dict[str, str]) -> str:
    # GitHub's expression engine: literal textual replacement, no shell quoting.
    def repl(match: re.Match[str]) -> str:
        expr = match.group(1).strip()
        key = expr.removeprefix("inputs.")
        return inputs.get(key, "")
    return re.sub(r"\$\{\{\s*([^}]+?)\s*\}\}", repl, script)


def main() -> int:
    as_json = "--json" in sys.argv
    template = run_step_text()
    assert "${{ inputs.only }}" in template, "expected the raw expression in the run step"
    results = []
    with tempfile.TemporaryDirectory() as tmp:
        stub_dir = Path(tmp) / "scripts"
        stub_dir.mkdir()
        stub = stub_dir / "mac-full-verify.sh"
        stub.write_text('#!/usr/bin/env bash\nprintf "ARGV:%s\\n" "$@"\n')
        stub.chmod(0o755)
        for name in payloads("x"):
            payload = payloads(f"{tmp}/{PWNED}-{name}")[name]
            script = substitute(template, {"only": payload, "clean_build": "false", "launch_check": "true", "js_checks": "false"})
            proc = subprocess.run(["bash", "-c", script], cwd=tmp, capture_output=True, text=True, timeout=30)
            executed = os.path.exists(f"{tmp}/{PWNED}-{name}")
            results.append({
                "payload": name,
                "input_only": payload,
                "substituted_line": next(l for l in script.splitlines() if "--only" in l),
                "exit": proc.returncode,
                "stdout": proc.stdout.strip(),
                "stderr": proc.stderr.strip(),
                "injected_command_ran": executed,
            })
    exploitable = [r["payload"] for r in results if r["injected_command_ran"]]
    verdict = {"workflow": str(WORKFLOW.relative_to(ROOT)), "raw_expression_in_run_step": True,
               "exploitable_payloads": exploitable, "results": results,
               "verdict": "BROKEN" if exploitable else "HELD"}
    if as_json:
        print(json.dumps(verdict, indent=2))
    else:
        for r in results:
            print(f"[{r['payload']:12}] ran={r['injected_command_ran']!s:5} exit={r['exit']} :: {r['substituted_line']}")
            print("    " + r["stdout"].replace("\n", "\n    "))
        print(f"verdict: {verdict['verdict']} exploitable={exploitable}")
    return 1 if exploitable else 0


if __name__ == "__main__":
    sys.exit(main())
