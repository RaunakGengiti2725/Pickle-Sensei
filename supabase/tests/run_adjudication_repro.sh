#!/usr/bin/env bash
# Run the db-rls-grants-isolation adjudication reproductions against a
# throwaway postgres:16 (Docker), using the same shim + migrations as
# run_rls_tests.sh. Exits non-zero while any confirmed defect still reproduces.
#
#   ./supabase/tests/run_adjudication_repro.sh
set -euo pipefail

cd "$(dirname "$0")/.."

if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  echo "docker is required" >&2
  exit 2
fi

CONTAINER=pickle-adjudication-repro
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
  psql -U postgres -v ON_ERROR_STOP=1 -f /tests/adjudication_db_rls_grants_isolation.sql
'
