#!/usr/bin/env bash
# Adversarial harnesses for the storage / media-worker subsystem (pass 3).
#
# Runs the attack suites against the LOCAL docker services (postgres_test,
# minio, elasticmq) and leaves one log per suite under
# artifacts/attack-storage/. A non-zero exit means at least one attack
# landed: the failing assertions describe the expected behaviour, the log
# line above each failure records what the code actually did.
#
# Usage: scripts/attack-storage-media-worker.sh [--start-services]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/artifacts/attack-storage"
mkdir -p "$OUT"

if [[ "${1:-}" == "--start-services" ]]; then
  (cd "$ROOT" && docker compose up -d postgres_test minio elasticmq)
fi

export DATABASE_URL_TEST="${DATABASE_URL_TEST:-postgres://pickle:pickle_test_password@localhost:5433/pickle_test}"
export S3_ENDPOINT_TEST="${S3_ENDPOINT_TEST:-http://localhost:9000}"
export SQS_ENDPOINT_TEST="${SQS_ENDPOINT_TEST:-http://localhost:9324}"
export ATTACK_SEED="${ATTACK_SEED:-20260904}"

status=0
run() {
  local pkg="$1" file="$2" log="$3"
  echo "== $pkg :: $file (seed=$ATTACK_SEED)"
  if (cd "$ROOT/$pkg" && npx vitest run "$file") >"$OUT/$log" 2>&1; then
    echo "exit=0" >>"$OUT/$log"
    echo "   HELD  -> $OUT/$log"
  else
    echo "exit=1" >>"$OUT/$log"
    echo "   BROKEN (see failing assertions) -> $OUT/$log"
    status=1
  fi
}

run services/media-worker test/attack-minio-objectStore.integration.test.ts S1-S3-objectStore.log
run services/api test/attack-minio-upload.integration.test.ts S2-S4-api-upload.log
run services/media-worker test/attack-deletion-lifecycle.integration.test.ts S5-S7-lifecycle.log
run services/media-worker test/attack-elasticmq-poison.integration.test.ts Q1-Q4-elasticmq.log

exit "$status"
