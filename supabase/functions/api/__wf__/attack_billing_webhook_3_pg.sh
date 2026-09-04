#!/usr/bin/env bash
# ADVERSARIAL PASS 3 — edge-billing-webhook: live PostgreSQL confirmations.
#
#   ./supabase/functions/api/__wf__/attack_billing_webhook_3_pg.sh
#
# Spins up a throwaway postgres:16 (Docker), installs the Supabase shim,
# applies every migration in order, then runs attack_billing_webhook_3_pg.sql
# as service_role (the edge function's identity):
#   S4  4000-byte event.id → webhook_events_pkey btree row-size error (54000),
#       plus the exact byte limit for this table via bisection;
#   S5  UPPERCASE uuid upsert into billing_entitlements folds onto the
#       lowercase row and overwrites its verdict (no duplicate row);
#   S3  4.9 MB jsonb payload accepted, no CHECK constraint on webhook_events,
#       and the table stays unreadable to `authenticated`.
# Exits non-zero on any violated expectation. Never touches a remote project.
set -euo pipefail

cd "$(dirname "$0")/../../.."   # → supabase/

if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  echo "Docker is required for this check." >&2
  exit 1
fi

CONTAINER=pickle-attack-webhook3-db
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
  psql -U postgres -v ON_ERROR_STOP=1 -q -f /tests/shim_auth.sql
  for f in /migrations/*.sql; do
    psql -U postgres -v ON_ERROR_STOP=1 -q -f "$f" >/dev/null 2>&1
  done
  echo "── webhook_events schema"
  psql -U postgres -c "\d public.webhook_events"
  echo "── attack_billing_webhook_3_pg.sql (service_role)"
  psql -U postgres -v ON_ERROR_STOP=1 -f /wf/attack_billing_webhook_3_pg.sql
'
echo "ATTACK-3 WEBHOOK PG CHECKS: ALL EXPECTATIONS CONFIRMED"
