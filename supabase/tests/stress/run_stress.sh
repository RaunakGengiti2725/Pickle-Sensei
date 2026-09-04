#!/usr/bin/env bash
# One-shot RLS × concurrency stress run against a disposable postgres:16.
#
#   ./supabase/tests/stress/run_stress.sh                 # STRESS_ITER=24 (suite default, ~1 min)
#   STRESS_ITER=500 STRESS_SEED=7 ./supabase/tests/stress/run_stress.sh   # campaign
#   STRESS_ITER_SEED=123456 ./supabase/tests/stress/run_stress.sh         # replay one seed
#   STRESS_PG_URL=postgres://postgres:pg@127.0.0.1:5499/postgres ./run_stress.sh  # reuse a DB
#
# Exit code is the harness exit code (0 = every executed iteration PASSED).
# Never masks failures. Never points at a hosted project.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"

started_here=0
if [ -z "${STRESS_PG_URL:-}" ]; then
  if ! command -v docker >/dev/null 2>&1; then
    echo "docker is required to start the throwaway postgres (or set STRESS_PG_URL)" >&2
    exit 2
  fi
  url_line="$("$HERE/pg_up.sh" | tail -n1)"
  export STRESS_PG_URL="${url_line#STRESS_PG_URL=}"
  started_here=1
fi
cleanup() {
  if [ "$started_here" -eq 1 ]; then
    "$HERE/pg_up.sh" down
  fi
}
trap cleanup EXIT

export STRESS_OUT="${STRESS_OUT:-$ROOT/artifacts/stress-db-rls/$(date -u +%Y%m%dT%H%M%SZ)}"
mkdir -p "$STRESS_OUT"
echo "STRESS_OUT=$STRESS_OUT"
node "$HERE/rls_concurrency_stress.mjs" 2>&1 | tee "$STRESS_OUT/run.log"
exit "${PIPESTATUS[0]}"
