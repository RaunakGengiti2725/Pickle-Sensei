#!/usr/bin/env bash
# Run every static-health harness and collect artifacts in one directory.
#
#   tools/static-health/run-all.sh [out-dir]
#
# Exit status is the number of harnesses that failed to *run* (tool missing,
# crash). Census results (cycles found, unused deps found, clones found) are
# reported in the artifacts, not via the exit code — read the summary.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="${1:-$ROOT/artifacts/static-health}"
mkdir -p "$OUT"
cd "$ROOT"

failures=0
run() {
  local name="$1"; shift
  echo "== $name"
  if "$@" > "$OUT/$name.log" 2>&1; then
    echo "   ok  ($OUT/$name.log)"
  else
    local rc=$?
    echo "   FAIL rc=$rc ($OUT/$name.log)"
    failures=$((failures + 1))
  fi
}

run dead-packages node tools/static-health/dead-packages.mjs \
  --out "$OUT/dead-packages.json" --md "$OUT/dead-packages.md"
run workspace-cycles node tools/static-health/workspace-cycles.mjs \
  --out "$OUT/workspace-cycles.json"
run circular-deps tools/static-health/circular-deps.sh "$OUT/madge"
run depcheck tools/static-health/depcheck-all.sh "$OUT/depcheck"
run type-escapes node tools/static-health/type-escapes.mjs \
  --out "$OUT/type-escapes.json" --md "$OUT/type-escapes.md"
run duplicates tools/static-health/duplicates.sh "$OUT/duplicates"

echo
echo "artifacts: $OUT"
echo "harness failures: $failures"
exit "$failures"
