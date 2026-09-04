#!/usr/bin/env bash
# Audit harness (pkg-evaluation-bench): the documented process exit codes
# (cli.ts:13-19 — 2 usage, 3 non-comparable) and the `--json` stdout contract
# depend on the pnpm that launches the script. package.json declares
# pnpm@10.15.1 but nothing enforces it. Runs the same three cases through the
# installed pnpm and, when available, `npx -y pnpm@10.15.1`, and prints a table.
#
# Usage: packages/evaluation/test/audit/harness/pnpm-exit-codes.sh [out-dir]
set -u
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../../.." && pwd)"
OUT="${1:-/tmp/audit-pnpm-exit-$$}"
mkdir -p "$OUT"
cd "$REPO_ROOT"
BASE=datasets/reports/regression/baseline.json

# Non-comparable candidate: same document with evidenceClass swapped for a
# value the validator accepts... there is only one, so use contractVersion.
node -e '
const fs = require("fs");
const s = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
s.contractVersion = 2;
fs.writeFileSync(process.argv[2], JSON.stringify(s));
' "$BASE" "$OUT/noncomparable.json"

run_case() { # <label> <pnpm-cmd...>
  local label="$1"; shift
  local ver; ver="$("$@" --version 2>/dev/null | tail -1)"
  "$@" -s --filter @pickle/evaluation bench:compare "$BASE" "$OUT/noncomparable.json" >"$OUT/$label-noncomp.out" 2>"$OUT/$label-noncomp.err"; local e3=$?
  "$@" -s --filter @pickle/evaluation bench:compare "$BASE" >"$OUT/$label-usage.out" 2>"$OUT/$label-usage.err"; local e2=$?
  "$@" --filter @pickle/evaluation bench:compare "$BASE" "$BASE" --json >"$OUT/$label-json.out" 2>"$OUT/$label-json.err"; local ej=$?
  local jsonok; if node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' "$OUT/$label-json.out" 2>/dev/null; then jsonok=valid; else jsonok=INVALID; fi
  printf '%-14s %-10s non-comparable→exit %s (doc 3) | usage→exit %s (doc 2) | --json without -s→exit %s, stdout %s\n' "$label" "$ver" "$e3" "$e2" "$ej" "$jsonok"
}

run_case "installed" pnpm
if npx -y pnpm@10.15.1 --version >/dev/null 2>&1; then
  run_case "pnpm@10.15.1" npx -y pnpm@10.15.1
else
  echo "pnpm@10.15.1 not obtainable via npx (offline?) — skipped"
fi
echo "artifacts: $OUT"
