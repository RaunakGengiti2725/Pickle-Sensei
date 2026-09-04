#!/usr/bin/env bash
# Execution audit harness — services-api-legacy-admin-web subsystem.
#
# Runs every vitest suite in scope (packages/api-contracts, packages/database,
# services/api, apps/admin-web) twice (two seeds), with vitest's hanging-process
# reporter to surface leaked handles, and records exit codes + logs under an
# artifacts directory. Never edits tests.
#
# Usage: tools/audit/services-api-legacy-admin-web/run-suites.sh [ARTIFACTS_DIR]
#   MODE=full   (default) shuffle file order AND test order inside each file
#   MODE=files  shuffle file order only; keep in-file test order
#   MODE=plain  no shuffle, two repeats (pure flakiness check)
set -uo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$REPO_ROOT"
MODE="${MODE:-full}"
OUT="${1:-artifacts/audit-suites/${MODE}-$(date -u +%Y%m%dT%H%M%SZ)}"
mkdir -p "$OUT"
export DATABASE_URL_TEST="${DATABASE_URL_TEST:-postgres://pickle:pickle_test_password@localhost:5433/pickle_test}"
export SQS_ENDPOINT_TEST="${SQS_ENDPOINT_TEST:-http://localhost:9324}"
export CI=true

case "$MODE" in
  full) SHUFFLE_ARGS=(--sequence.shuffle) ;;
  files) SHUFFLE_ARGS=(--sequence.shuffle.files --sequence.shuffle.tests=false) ;;
  plain) SHUFFLE_ARGS=() ;;
  *) echo "unknown MODE=$MODE" >&2; exit 2 ;;
esac

PKGS=(@pickle/api-contracts @pickle/database @pickle/api @pickle/admin-web)
SEEDS=(11 22)
RESULTS="$OUT/results.tsv"
printf 'package\trun\tmode\tseed\texit\tseconds\tlog\n' >"$RESULTS"
FAILED=0
for pkg in "${PKGS[@]}"; do
  for i in 0 1; do
    seed="${SEEDS[$i]}"
    slug="${pkg#@pickle/}"
    log="$OUT/${slug}-run$((i + 1))-seed${seed}.log"
    start=$(date +%s)
    seed_args=()
    [ "$MODE" != plain ] && seed_args=(--sequence.seed="$seed")
    pnpm --filter "$pkg" exec vitest run "${SHUFFLE_ARGS[@]}" "${seed_args[@]}" \
      --reporter=default --reporter=hanging-process >"$log" 2>&1
    rc=$?
    end=$(date +%s)
    printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$pkg" "$((i + 1))" "$MODE" "$seed" "$rc" "$((end - start))" "$log" >>"$RESULTS"
    echo "$pkg run$((i + 1)) mode=$MODE seed=$seed exit=$rc ($((end - start))s) -> $log"
    [ $rc -ne 0 ] && FAILED=1
  done
done
echo "results: $RESULTS"
exit $FAILED
