#!/usr/bin/env bash
# ADVERSARIAL TESTER #2 (pass 3) — PG16 side of the edge-billing-webhook attack.
#
#   ./supabase/functions/api/__wf__/attack_billing_webhook_2_pg.sh
#
# Throwaway postgres:16 (Docker) + Supabase shim + every migration in order,
# then attack_billing_webhook_2_pg.sql: which expires_date literals that the
# edge function forwards VERBATIM into billing_entitlements.expires_at does
# PG16 accept, and does the 'Dec 31 2099 00:00:00 GMT' literal round-trip.
# Exits non-zero when PG16 behaviour differs from the pinned matrix.
set -euo pipefail

cd "$(dirname "$0")/../../.."   # → supabase/

if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  echo "Docker is required for this check." >&2
  exit 1
fi

CONTAINER=pickle-attack-billing-webhook-2-db
cleanup() { docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup

docker run -d --name "$CONTAINER" -e POSTGRES_PASSWORD=pg postgres:16 >/dev/null
for _ in $(seq 1 30); do
  docker exec "$CONTAINER" pg_isready -U postgres >/dev/null 2>&1 && break
  sleep 1
done

docker cp tests "$CONTAINER":/tests
docker cp migrations "$CONTAINER":/migrations
docker cp functions/api/__wf__ "$CONTAINER":/wf

docker exec "$CONTAINER" bash -c '
  set -euo pipefail
  psql -U postgres -v ON_ERROR_STOP=1 -q -f /tests/shim_auth.sql >/dev/null
  for f in /migrations/*.sql; do
    psql -U postgres -v ON_ERROR_STOP=1 -q -f "$f" >/dev/null
  done
  psql -U postgres -tA -c "select version()"
  psql -U postgres -v ON_ERROR_STOP=1 -q -f /wf/attack_billing_webhook_2_pg.sql
'
echo "attack_billing_webhook_2_pg: PG16 acceptance matrix matches the pinned expectations."
