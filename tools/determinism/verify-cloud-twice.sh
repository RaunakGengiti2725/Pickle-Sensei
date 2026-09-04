#!/usr/bin/env bash
# Run scripts/verify-cloud.sh N times (default 2) from a reset state each time
# and diff the resulting summary.json files (stage status + timings).
#
#   tools/determinism/verify-cloud-twice.sh [--runs N] [--tier pr|full] [--out DIR] [-- <extra verify-cloud args>]
#
# Each iteration:
#   1. tools/determinism/clean-state.sh --fresh-mobile   (volumes, caches, mobile deps)
#   2. VERIFY_ARTIFACTS=$OUT/run-<i> scripts/verify-cloud.sh --tier $TIER --start-services --fresh-deps <extra>
#      (stdout/stderr captured to $OUT/run-<i>/console.log, exit code to exit-code.txt)
# Afterwards: node "$HARNESS_DIR/diff-summaries.mjs" $OUT/run-*/summary.json > $OUT/diff.json
# and a human table on stdout. Exit code: 0 when every run has the same
# per-stage status set, 1 when any stage status differs between runs, 2 usage.
# A run that itself fails does NOT make this script exit non-zero — the point is
# the DIFF; read $OUT/diff.json for the statuses.
set -uo pipefail

REPO_ROOT="${PICKLE_REPO:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
HARNESS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$REPO_ROOT"

RUNS=2
TIER="full"
OUT="${PICKLE_DETERMINISM_OUT:-$REPO_ROOT/artifacts/determinism}/verify-cloud-$(date -u +%Y%m%dT%H%M%SZ)"
EXTRA=()
while [ $# -gt 0 ]; do
  case "$1" in
    --runs) RUNS="$2"; shift 2 ;;
    --tier) TIER="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --) shift; EXTRA=("$@"); break ;;
    -h|--help) sed -n '2,16p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

mkdir -p "$OUT"
echo "verify-cloud-twice: runs=$RUNS tier=$TIER out=$OUT sha=$(git rev-parse HEAD)"

for i in $(seq 1 "$RUNS"); do
  run_dir="$OUT/run-$i"
  mkdir -p "$run_dir"
  echo "=== run $i/$RUNS: clean state"
  "$HARNESS_DIR/clean-state.sh" --fresh-mobile 2>&1 | tee "$run_dir/clean-state.log"
  echo "=== run $i/$RUNS: verify-cloud start $(date -u +%H:%M:%S)"
  VERIFY_ARTIFACTS="$run_dir" scripts/verify-cloud.sh --tier "$TIER" --start-services --fresh-deps "${EXTRA[@]}" \
    >"$run_dir/console.log" 2>&1
  rc=$?
  echo "$rc" >"$run_dir/exit-code.txt"
  echo "=== run $i/$RUNS: verify-cloud exit $rc at $(date -u +%H:%M:%S)"
  tail -n 20 "$run_dir/console.log"
done

node "$HARNESS_DIR/diff-summaries.mjs" "$OUT"/run-*/summary.json >"$OUT/diff.json"
diff_rc=$?
node "$HARNESS_DIR/diff-summaries.mjs" --table "$OUT"/run-*/summary.json
echo "diff: $OUT/diff.json"
exit $diff_rc
