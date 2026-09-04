#!/usr/bin/env bash
# Throwaway Postgres for the supabase/tests/stress harnesses.
#
#   ./supabase/tests/stress/setup_stress_db.sh            # start + migrate
#   ./supabase/tests/stress/setup_stress_db.sh --down     # remove the container
#
# Starts postgres:16 in Docker on ${STRESS_PG_PORT:-5499}, installs the same
# Supabase shim run_rls_tests.sh uses (auth schema, roles, hosted-like default
# privileges) and applies every supabase/migrations/*.sql in order. The
# resulting URL is printed on the last line and is what the node harnesses
# expect in STRESS_DB_URL.
set -euo pipefail

cd "$(dirname "$0")/../.."

CONTAINER=${STRESS_PG_CONTAINER:-pickle-stress-db}
PORT=${STRESS_PG_PORT:-5499}
PASSWORD=${STRESS_PG_PASSWORD:-x}

if [ "${1:-}" = "--down" ]; then
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  exit 0
fi

if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  echo "docker is required for the stress harness" >&2
  exit 2
fi

docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
docker run -d --name "$CONTAINER" -p "127.0.0.1:${PORT}:5432" \
  -e POSTGRES_PASSWORD="$PASSWORD" postgres:16 \
  -c max_connections=200 -c deadlock_timeout=200ms >/dev/null

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

docker exec "$CONTAINER" bash -c '
  set -euo pipefail
  export PGOPTIONS="-c client_min_messages=warning"
  psql -U postgres -v ON_ERROR_STOP=1 -q -f /tests/shim_auth.sql
  for f in /migrations/*.sql; do
    psql -U postgres -v ON_ERROR_STOP=1 -q -f "$f"
  done
' >/dev/null

echo "postgres://postgres:${PASSWORD}@127.0.0.1:${PORT}/postgres"
