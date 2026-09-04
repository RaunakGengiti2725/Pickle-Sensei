#!/usr/bin/env bash
# Adversarial follow-up to 20260905000002_permit_lifecycle_one_way.sql: the
# permit lifecycle must be one-way through the client INSERT/DELETE grants
# too, not only through UPDATE. Throwaway postgres:16 (Docker), same shim +
# migrations as run_rls_tests.sh. Exits non-zero while any case reproduces.
#
#   ./supabase/tests/run_attack_permit_insert_lifecycle.sh
set -euo pipefail

cd "$(dirname "$0")/.."

if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  echo "docker is required" >&2
  exit 2
fi

CONTAINER=pickle-attack-permit-insert
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
  exit 2
fi

docker cp tests "$CONTAINER":/tests
docker cp migrations "$CONTAINER":/migrations

docker exec "$CONTAINER" bash -c '
  set -euo pipefail
  psql -U postgres -v ON_ERROR_STOP=1 -q -f /tests/shim_auth.sql
  for f in /migrations/*.sql; do
    psql -U postgres -v ON_ERROR_STOP=1 -q -f "$f"
  done
  psql -U postgres -v ON_ERROR_STOP=1 -f /tests/attack_permit_insert_lifecycle.sql
'
