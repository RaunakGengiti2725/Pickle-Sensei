#!/usr/bin/env bash
# db-rank concurrency stress: disposable postgres:16 → shim + every migration →
# seeded Deno harness → JSON seed/outcome table. Never touches a hosted project.
#
#   ./supabase/tests/stress/db-rank/run.sh                  # STRESS_ITER=2 (suite default)
#   STRESS_ITER=60 ./supabase/tests/stress/db-rank/run.sh   # campaign
#   STRESS_REPLAY=<scenario>:<seed> ./supabase/tests/stress/db-rank/run.sh
#   STRESS_KEEP_DB=1 …                                      # leave the container up
#
# Exit code is the harness's exit code (a violated invariant fails the run).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../../.." && pwd)"
STRESS_OUT_DIR=${STRESS_OUT_DIR:-"$ROOT/artifacts/stress-db-rank/$(date -u +%Y%m%dT%H%M%SZ)"}
mkdir -p "$STRESS_OUT_DIR"
export STRESS_OUT_DIR="$(cd "$STRESS_OUT_DIR" && pwd)"   # absolute: the harness runs from its own dir

if [ -z "${STRESS_PG_URL:-}" ]; then
  url_line="$("$HERE/pg_up.sh" | tee "$STRESS_OUT_DIR/pg_up.log" | tail -n 1)"
  export STRESS_PG_URL="${url_line#STRESS_PG_URL=}"
  started_db=1
else
  started_db=0
fi

cleanup() {
  if [ "$started_db" -eq 1 ] && [ -z "${STRESS_KEEP_DB:-}" ]; then
    "$HERE/pg_up.sh" down
  fi
}
trap cleanup EXIT

set +e
(cd "$HERE" && deno task test 2>&1 | tee "$STRESS_OUT_DIR/harness.log")
status=${PIPESTATUS[0]}
set -e
echo "db-rank stress exit=$status artifacts=$STRESS_OUT_DIR"
exit "$status"
