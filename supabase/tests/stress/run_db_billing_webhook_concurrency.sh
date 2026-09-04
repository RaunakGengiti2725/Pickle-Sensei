#!/usr/bin/env bash
# One-shot runner for the db-billing-webhook-tables concurrency stress harness:
# disposable postgres:16 (shim + every migration) → seeded Deno campaign →
# JSON seed→outcome tables under artifacts/stress/db-billing-webhook-tables/<run>/.
#
#   ./run_db_billing_webhook_concurrency.sh                 # STRESS_ITER=3 (suite-friendly)
#   STRESS_ITER=80 ./run_db_billing_webhook_concurrency.sh  # campaign: 7 scenarios × 80 = 560 interleavings
#   STRESS_ROUND_SEED=<seed> STRESS_FILTER=S3 ./run_db_billing_webhook_concurrency.sh   # replay one round
#
# Exit code is the Deno test exit code (the container is always removed).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
RUN_ID=${STRESS_RUN_ID:-$(date -u +%Y%m%dT%H%M%SZ)}
OUT_DIR=${STRESS_OUT_DIR:-"$ROOT/artifacts/stress/db-billing-webhook-tables/$RUN_ID"}
mkdir -p "$OUT_DIR"

export STRESS_PG_CONTAINER=${STRESS_PG_CONTAINER:-pickle-stress-pg-$$}
export STRESS_PG_PORT=${STRESS_PG_PORT:-5499}
cleanup() { "$HERE/stress_pg_up.sh" down; }
trap cleanup EXIT

url_line=$("$HERE/stress_pg_up.sh" | tail -1)
export STRESS_PG_URL=${url_line#STRESS_PG_URL=}
export STRESS_OUT_DIR="$OUT_DIR/"

filter_args=()
if [ -n "${STRESS_FILTER:-}" ]; then
  filter_args=(--filter "$STRESS_FILTER")
fi

set +e
(
  cd "$HERE"
  deno test -A --no-check --config deno.json db_billing_webhook_concurrency.test.ts "${filter_args[@]}"
) 2>&1 | tee "$OUT_DIR/deno-test.log"
status=${PIPESTATUS[0]}
set -e

{
  echo "{"
  echo "  \"run_id\": \"$RUN_ID\","
  echo "  \"commit\": \"$(git -C "$ROOT" rev-parse HEAD)\","
  echo "  \"seed\": ${STRESS_SEED:-20260904},"
  echo "  \"iter\": ${STRESS_ITER:-3},"
  echo "  \"lanes\": ${STRESS_LANES:-16},"
  echo "  \"jitter_ms\": ${STRESS_JITTER_MS:-25},"
  echo "  \"round_seed\": ${STRESS_ROUND_SEED:-null},"
  echo "  \"deno_exit\": $status"
  echo "}"
} > "$OUT_DIR/run.json"
echo "artifacts: $OUT_DIR (deno exit $status)"
exit "$status"
