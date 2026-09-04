#!/usr/bin/env bash
# Duplicate-logic census over packages/*, services/*, ml/ (and tools/* when asked).
#
# Usage: tools/static-health/duplicates.sh <out-dir> [extra roots...]
#   JSCPD=/path/to/jscpd    (default: jscpd on PATH)
#   MIN_TOKENS (default 70) / MIN_LINES (default 8): clone thresholds. Both are
#   recorded in the report so the census is reproducible.
#
# Two passes are recorded:
#   src-only   production code (excludes test/, __tests__/, *.test.ts, eval/)
#   all        src + tests (tests legitimately repeat fixtures; kept separate)
# jscpd exits 0 even when clones are found (no --threshold is set on purpose:
# this is a census, not a merge gate). Raw JSON: <out-dir>/<pass>/jscpd-report.json
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT_DIR="${1:-$REPO_ROOT/artifacts/static-health/duplicates}"
shift || true
JSCPD="${JSCPD:-jscpd}"
MIN_TOKENS="${MIN_TOKENS:-70}"
MIN_LINES="${MIN_LINES:-8}"
ROOTS=(packages services ml "$@")
mkdir -p "$OUT_DIR"
cd "$REPO_ROOT"

run_pass() {
  local pass="$1"; shift
  local dir="$OUT_DIR/$pass"
  mkdir -p "$dir"
  "$JSCPD" "${ROOTS[@]}" \
    --format "typescript,tsx,python" \
    --min-tokens "$MIN_TOKENS" --min-lines "$MIN_LINES" \
    --reporters json,console \
    --output "$dir" \
    --ignore "**/node_modules/**,**/dist/**,**/coverage/**,**/*.d.ts,**/datasets/**,**/*.json" \
    "$@" > "$dir/console.log" 2>&1
  echo "pass=$pass exit=$? report=$dir/jscpd-report.json"
}

run_pass src-only --ignore "**/test/**,**/tests/**,**/__tests__/**,**/*.test.ts,**/*.spec.ts,**/eval/**,**/test_*.py"
run_pass all

node "$REPO_ROOT/tools/static-health/duplicates-summarize.mjs" "$OUT_DIR" "$MIN_TOKENS" "$MIN_LINES" > "$OUT_DIR/summary.md"
cat "$OUT_DIR/summary.md"
