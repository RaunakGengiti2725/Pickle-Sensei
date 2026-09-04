#!/usr/bin/env bash
# Run every pnpm-workspace vitest suite once per seed with --sequence.shuffle
# (files AND tests) and record every test's outcome per seed.
#
#   tools/determinism/vitest-shuffle-matrix.sh [--seeds "1 2 3"] [--out DIR] [--filter <pnpm filter>] [--files-only]
#
# --files-only shuffles only the FILE order (tests inside a file keep their written order),
# which separates cross-file coupling (shared DB rows, module state) from intra-file
# step-N-depends-on-step-N-1 coupling.
#
# Per seed (mirrors the verify-cloud `test` stage: workspace-concurrency=1, DATABASE_URL_TEST,
# SQS_ENDPOINT_TEST when reachable):
#   pnpm -r --no-bail --workspace-concurrency=1 exec sh -c 'vitest run --passWithNoTests --sequence.shuffle.files --sequence.shuffle.tests --sequence.seed=<s> \
#        --reporter=default --reporter=json --outputFile.json=$OUT/seed-<s>/<package>.json'
# Finally: node tools/determinism/matrix-report.mjs vitest $OUT/seed-*/ > $OUT/matrix.json
# Exit 0 when no test changes outcome across seeds, 1 otherwise.
set -uo pipefail

REPO_ROOT="${PICKLE_REPO:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
HARNESS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$REPO_ROOT"

SEEDS="11 22 33 44 55"
OUT="${PICKLE_DETERMINISM_OUT:-$REPO_ROOT/artifacts/determinism}/vitest-$(date -u +%Y%m%dT%H%M%SZ)"
FILTER=()
SHUFFLE="--sequence.shuffle.files --sequence.shuffle.tests"
while [ $# -gt 0 ]; do
  case "$1" in
    --seeds) SEEDS="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --filter) FILTER+=(--filter "$2"); shift 2 ;;
    --files-only) SHUFFLE="--sequence.shuffle.files"; shift ;;
    -h|--help) sed -n '2,17p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

export DATABASE_URL_TEST="${DATABASE_URL_TEST:-postgres://pickle:pickle_test_password@localhost:5433/pickle_test}"
export CI="${CI:-true}"
sqs="${SQS_ENDPOINT_TEST:-http://localhost:9324}"
if curl -sS -m 3 -o /dev/null "$sqs/" 2>/dev/null; then export SQS_ENDPOINT_TEST="$sqs"; echo "SQS_ENDPOINT_TEST=$sqs reachable"; else unset SQS_ENDPOINT_TEST; echo "SQS_ENDPOINT_TEST unreachable — @pickle/queue SQS tests skip"; fi

mkdir -p "$OUT"
echo "vitest-shuffle-matrix: seeds=[$SEEDS] shuffle=[$SHUFFLE] out=$OUT sha=$(git rev-parse HEAD)"

for s in $SEEDS; do
  mkdir -p "$OUT/seed-$s"
  echo "=== vitest $SHUFFLE --sequence.seed=$s start $(date -u +%H:%M:%S)"
  # Every workspace package's `test` script is `vitest run` (some add --passWithNoTests);
  # this mirrors `pnpm test` (= pnpm -r --workspace-concurrency=1 test) with shuffle + a JSON report per package.
  # shellcheck disable=SC2016  # $SEED/$SEED_OUT/$SHUFFLE/$PNPM_PACKAGE_NAME expand inside the per-package sh
  SEED="$s" SEED_OUT="$OUT/seed-$s" SHUFFLE="$SHUFFLE" pnpm -r --no-bail --workspace-concurrency=1 "${FILTER[@]}" exec sh -c \
    'vitest run --passWithNoTests $SHUFFLE --sequence.seed="$SEED" --reporter=default --reporter=json --outputFile.json="$SEED_OUT/$(printf %s "$PNPM_PACKAGE_NAME" | tr / _).json"' \
    >"$OUT/seed-$s.log" 2>&1
  rc=$?
  echo "$rc" >"$OUT/seed-$s.exit"
  echo "    exit $rc — $(ls "$OUT/seed-$s" | wc -l) package reports"
done

node "$HARNESS_DIR/matrix-report.mjs" vitest "$OUT"/seed-*/ >"$OUT/matrix.json"
rc=$?
node "$HARNESS_DIR/matrix-report.mjs" --table vitest "$OUT"/seed-*/
echo "matrix: $OUT/matrix.json"
exit $rc
