#!/usr/bin/env bash
# XC journey `settings-account-deletion` — server-side cascade / retention sweep.
#
#   ./supabase/tests/xc/run_account_deletion_cascade.sh [artifact-dir]
#   (default: $XC_ARTIFACT_DIR, else ~/.cache/pickle-sensei/xc-artifacts/account-deletion —
#    the same out-of-tree location the mobile harness uses, see
#    apps/mobile/xc-harness/account-deletion/helpers/artifactDir.ts)
#
# Throwaway postgres:16 in Docker ONLY (never a hosted project): installs
# tests/shim_auth.sql, applies every migration in order, runs
# tests/xc/account_deletion_cascade.sql, and writes
#   <artifact-dir>/server.cascade.log            full psql transcript
#   <artifact-dir>/server.survival_matrix.json   per-table survival matrix
# Also pins the 90-day webhook-audit sweep in the migration text, because the
# stock image has no pg_cron and the migration skips scheduling without it.
# Exits non-zero on any assertion failure; nothing here uses `|| true` to
# hide one.
set -euo pipefail

cd "$(dirname "$0")/../.." # supabase/
REPO_ROOT=$(cd .. && pwd)

OUT=${1:-${XC_ARTIFACT_DIR:-$HOME/.cache/pickle-sensei/xc-artifacts/account-deletion}}
mkdir -p "$OUT"

if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  echo "Docker is required for the throwaway postgres:16 container." >&2
  exit 1
fi

CONTAINER=xc-account-deletion-pg
cleanup() { docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup

docker run -d --name "$CONTAINER" -e POSTGRES_PASSWORD=pg postgres:16 >/dev/null
ready=0
for _ in $(seq 1 60); do
  if docker exec "$CONTAINER" pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done
if [ "$ready" -ne 1 ]; then
  echo "postgres:16 container did not become ready within 60s" >&2
  docker logs "$CONTAINER" 2>&1 | tail -20 >&2
  exit 2
fi

docker cp tests "$CONTAINER":/tests
docker cp migrations "$CONTAINER":/migrations

LOG="$OUT/server.cascade.log"
docker exec "$CONTAINER" bash -c '
  set -euo pipefail
  psql -U postgres -v ON_ERROR_STOP=1 -q -f /tests/shim_auth.sql
  for f in /migrations/*.sql; do
    echo "applying $f"
    psql -U postgres -v ON_ERROR_STOP=1 -q -f "$f"
  done
  psql -U postgres -v ON_ERROR_STOP=1 -f /tests/xc/account_deletion_cascade.sql
' 2>&1 | tee "$LOG"
status=${PIPESTATUS[0]}
if [ "$status" -ne 0 ]; then
  echo "account_deletion_cascade.sql FAILED (exit $status) — see $LOG" >&2
  exit "$status"
fi

# Extract the JSON block emitted between the markers.
awk '/^XC_JSON_BEGIN survival_matrix$/{f=1;next} /^XC_JSON_END$/{f=0} f' "$LOG" \
  >"$OUT/server.survival_matrix.json"
if ! python3 -c 'import json,sys; json.load(open(sys.argv[1]))' "$OUT/server.survival_matrix.json"; then
  echo "survival matrix is not valid JSON" >&2
  exit 3
fi

# Static pin for the disclosed 90-day retention of webhook audit rows
# (legal.ts §7) — the only account-keyed survivor besides the identity ledger.
if ! grep -Eq "purge-old-webhook-events" migrations/*.sql \
  || ! grep -Eq "delete from public.webhook_events where received_at < now\(\) - interval ''90 days''" migrations/*.sql; then
  echo "RETENTION: no 90-day purge-old-webhook-events sweep found in migrations" >&2
  exit 4
fi
if ! grep -Eq "RevenueCat webhook audit records are scheduled for deletion after 90 days" functions/api/legal.ts; then
  echo "RETENTION: legal.ts §7 no longer discloses the 90-day webhook audit retention" >&2
  exit 5
fi

echo "account deletion cascade sweep: PASS — $OUT/server.survival_matrix.json"
