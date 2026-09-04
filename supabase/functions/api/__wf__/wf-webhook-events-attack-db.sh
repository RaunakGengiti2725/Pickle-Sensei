#!/usr/bin/env bash
# Adversarial pass 3 (edge-billing-webhook) — database-side companion to
# webhook_attack_pass3.test.ts. Spins up a throwaway postgres:16-alpine
# (Docker), installs the Supabase shim, applies every migration in order and
# runs wf-webhook-events-attack-db.sql, which asserts what the REAL
# webhook_events / billing_entitlements schema does with the payloads the edge
# webhook forwards verbatim (NUL escapes, 8 KiB ids, the empty-string id,
# unknown-profile TRANSFER destinations, case-variant UUIDs).
#
#   ./supabase/functions/api/__wf__/wf-webhook-events-attack-db.sh
#
# Exits non-zero on any violated invariant. Never touches a hosted project.
set -euo pipefail

cd "$(dirname "$0")/../../.."   # → supabase/

if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  echo "Docker is required for this check." >&2
  exit 1
fi

CONTAINER=pickle-wf-webhook-attack-db
cleanup() { docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup

docker run -d --name "$CONTAINER" -e POSTGRES_PASSWORD=pg postgres:16-alpine >/dev/null
for _ in $(seq 1 30); do
  docker exec "$CONTAINER" pg_isready -U postgres >/dev/null 2>&1 && break
  sleep 1
done

docker cp tests "$CONTAINER":/tests
docker cp migrations "$CONTAINER":/migrations
docker cp functions/api/__wf__ "$CONTAINER":/wf

docker exec "$CONTAINER" sh -c '
  set -eu
  psql -U postgres -v ON_ERROR_STOP=1 -q -f /tests/shim_auth.sql
  for f in /migrations/*.sql; do
    psql -U postgres -v ON_ERROR_STOP=1 -q -f "$f" >/dev/null 2>&1
  done
  echo "── webhook_events / billing_entitlements schema invariants"
  psql -U postgres -v ON_ERROR_STOP=1 -f /wf/wf-webhook-events-attack-db.sql
'
echo "WEBHOOK-EVENTS ATTACK DB CHECKS: ALL PASSED"
