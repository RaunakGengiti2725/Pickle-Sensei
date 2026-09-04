#!/usr/bin/env bash
# S9 — Python dependency surface (the "pip" half of the audit scope).
#
# The role brief lists `pip` beside pnpm/npm audit. This harness establishes
# whether there is anything for pip-audit to audit at all, so "no pip audit
# stage" is reported as N/A-with-evidence rather than silently as a pass:
#
#   s9.a  no pip manifest is tracked (requirements*.txt, pyproject.toml,
#         setup.py/cfg, Pipfile, environment.yml)                → HELD if none
#   s9.b  every tracked *.py imports only stdlib modules or sibling modules
#         (so no third-party package is installed by any verify stage)
#   s9.c  the ml verify stage installs nothing (no `pip install` anywhere in
#         scripts/ or .github/)
#
# If s9.a/b/c all hold, `pip audit` has an empty input set and the missing
# stage is not a gap. If any is BROKEN, a pip-audit stage is required and
# missing (same class of finding as S2's pipeline-coverage check).
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

cd "$REPO_ROOT"

# ── s9.a manifests ─────────────────────────────────────────────────────────────
manifests="$(git ls-files | grep -iE '(^|/)(requirements[^/]*\.txt|pyproject\.toml|setup\.(py|cfg)|Pipfile(\.lock)?|environment\.ya?ml)$' || true)"
printf '%s\n' "$manifests" >"$OUT/s9a-manifests.txt"
if [ -z "$manifests" ]; then
  record HELD s9.a-no-pip-manifest 0 "$OUT/s9a-manifests.txt" "no pip/poetry/conda manifest is tracked at this commit"
else
  record BROKEN s9.a-no-pip-manifest 1 "$OUT/s9a-manifests.txt" "python manifests are tracked but no verify stage runs pip-audit: $(printf '%s' "$manifests" | tr '\n' ' ')"
fi

# ── s9.b imports ───────────────────────────────────────────────────────────────
rc=0
python3 - "$OUT/s9b-imports.json" <<'EOF' || rc=$?
import ast, json, subprocess, sys
from pathlib import Path

out = Path(sys.argv[1])
files = [Path(p) for p in subprocess.check_output(["git", "ls-files", "*.py"], text=True).split() if p]
stdlib = set(sys.stdlib_module_names)
local = {f.stem for f in files} | {f.parent.name for f in files}
third = {}
for f in files:
    tree = ast.parse(f.read_text(encoding="utf-8"), filename=str(f))
    for node in ast.walk(tree):
        names = []
        if isinstance(node, ast.Import):
            names = [a.name.split(".")[0] for a in node.names]
        elif isinstance(node, ast.ImportFrom) and node.module and node.level == 0:
            names = [node.module.split(".")[0]]
        for n in names:
            if n not in stdlib and n not in local:
                third.setdefault(n, []).append(f"{f}:{node.lineno}")
out.write_text(json.dumps({"files": [str(f) for f in files], "third_party": third}, indent=2) + "\n")
print(f"python files: {len(files)}  third-party imports: {sorted(third)}")
sys.exit(1 if third else 0)
EOF
if [ "$rc" = 0 ]; then
  record HELD s9.b-stdlib-only 0 "$OUT/s9b-imports.json" "every tracked .py imports only stdlib/sibling modules (python $(python3 -c 'import sys;print(".".join(map(str,sys.version_info[:3])))'))"
else
  record BROKEN s9.b-stdlib-only "$rc" "$OUT/s9b-imports.json" "third-party python imports exist without a manifest or pip-audit stage"
fi

# ── s9.c no pip install in the pipeline ────────────────────────────────────────
hits="$(git grep -n -iE '\bpip3?\s+install\b|pip-audit|python3? -m pip\b' HEAD -- scripts/ .github/ package.json 2>/dev/null | sed 's/^HEAD://' || true)"
printf '%s\n' "$hits" >"$OUT/s9c-pip-install-refs.txt"
if [ -z "$hits" ]; then
  record HELD s9.c-no-pip-install 0 "$OUT/s9c-pip-install-refs.txt" "no verify/CI stage installs python packages (nothing for pip-audit to cover)"
else
  record BROKEN s9.c-no-pip-install 1 "$OUT/s9c-pip-install-refs.txt" "pipeline installs python packages without a pip-audit stage"
fi

verdict
