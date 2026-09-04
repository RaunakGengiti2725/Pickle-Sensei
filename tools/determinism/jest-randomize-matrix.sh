#!/usr/bin/env bash
# Run the apps/mobile Jest suite once per seed with --randomize and record every
# test's outcome per seed, then report tests whose outcome changes.
#
#   tools/determinism/jest-randomize-matrix.sh [--seeds "1 2 3"] [--out DIR] [-- <extra jest args>]
#
# Per seed: (cd apps/mobile && npx jest --ci --silent --randomize --seed=<s> --json --outputFile=$OUT/jest-seed-<s>.json)
#   console -> $OUT/jest-seed-<s>.log, exit code -> $OUT/jest-seed-<s>.exit
# Finally: node tools/determinism/matrix-report.mjs jest $OUT/jest-seed-*.json > $OUT/matrix.json
# Exit 0 when no test changes outcome across seeds, 1 otherwise.
set -uo pipefail

REPO_ROOT="${PICKLE_REPO:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
HARNESS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$REPO_ROOT"

SEEDS="11 22 33 44 55"
OUT="${PICKLE_DETERMINISM_OUT:-$REPO_ROOT/artifacts/determinism}/jest-$(date -u +%Y%m%dT%H%M%SZ)"
EXTRA=()
while [ $# -gt 0 ]; do
  case "$1" in
    --seeds) SEEDS="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --) shift; EXTRA=("$@"); break ;;
    -h|--help) sed -n '2,11p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

[ -d apps/mobile/node_modules ] || { echo "apps/mobile/node_modules missing — run: cd apps/mobile && npm ci" >&2; exit 75; }
mkdir -p "$OUT"
echo "jest-randomize-matrix: seeds=[$SEEDS] out=$OUT sha=$(git rev-parse HEAD)"

for s in $SEEDS; do
  echo "=== jest --randomize --seed=$s start $(date -u +%H:%M:%S)"
  (cd apps/mobile && CI=true npx jest --ci --silent --randomize --seed="$s" --json --outputFile="$OUT/jest-seed-$s.json" "${EXTRA[@]}") \
    >"$OUT/jest-seed-$s.log" 2>&1
  rc=$?
  echo "$rc" >"$OUT/jest-seed-$s.exit"
  summary="$(node -e 'const r=require(process.argv[1]);console.log(`suites ${r.numPassedTestSuites}/${r.numTotalTestSuites} pass, tests ${r.numPassedTests} pass ${r.numFailedTests} fail ${r.numPendingTests} skip`)' "$OUT/jest-seed-$s.json" 2>/dev/null || echo 'no json')"
  echo "    exit $rc — $summary"
done

node "$HARNESS_DIR/matrix-report.mjs" jest "$OUT"/jest-seed-*.json >"$OUT/matrix.json"
rc=$?
node "$HARNESS_DIR/matrix-report.mjs" --table jest "$OUT"/jest-seed-*.json
echo "matrix: $OUT/matrix.json"
exit $rc
