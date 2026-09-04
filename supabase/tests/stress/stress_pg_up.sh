#!/usr/bin/env bash
# Disposable Postgres for the supabase/tests/stress harnesses — the same shape
# as supabase/tests/run_rls_tests.sh (postgres:16 + shim_auth.sql + every
# migration in lexical order), published on a host port so N independent
# client connections can contend for real. Never points at a hosted project.
#
#   ./stress_pg_up.sh            # start (idempotent: replaces a previous container)
#   ./stress_pg_up.sh down       # remove
#
# Prints STRESS_PG_URL=... on success.
set -euo pipefail

CONTAINER=${STRESS_PG_CONTAINER:-pickle-stress-pg}
PORT=${STRESS_PG_PORT:-5499}
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"

remove_container() {
  # `docker rm -f` on a missing name is the only error we accept here.
  if docker container inspect "$CONTAINER" >/dev/null 2>&1; then
    docker rm -f "$CONTAINER" >/dev/null
  fi
}

if [ "${1:-up}" = "down" ]; then
  remove_container
  exit 0
fi

remove_container
docker run -d --name "$CONTAINER" -p "127.0.0.1:${PORT}:5432" \
  -e POSTGRES_PASSWORD=x postgres:16 \
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

docker cp "$ROOT/supabase/tests" "$CONTAINER":/tests
docker cp "$ROOT/supabase/migrations" "$CONTAINER":/migrations
# NOTICEs from `create ... if not exists` are noise; every real error still stops
# the run (ON_ERROR_STOP + set -e) and reaches stderr.
docker exec "$CONTAINER" bash -c '
  set -euo pipefail
  psql -U postgres -v ON_ERROR_STOP=1 -q -f /tests/shim_auth.sql
  for f in /migrations/*.sql; do
    PGOPTIONS="-c client_min_messages=warning" psql -U postgres -v ON_ERROR_STOP=1 -q -f "$f" >/dev/null
  done
'
echo "STRESS_PG_URL=postgres://postgres:x@127.0.0.1:${PORT}/postgres"
