#!/usr/bin/env bash
# Bring up a throwaway Postgres 16 on :5499 with the Supabase shim and every
# migration in supabase/migrations applied in order — the same schema
# run_rls_tests.sh asserts against, kept alive so the stress harnesses under
# supabase/tests/stress/ can drive it from parallel sessions.
#
#   ./supabase/tests/stress/setup_db.sh          # create (or recreate) it
#   STRESS_PG_URL=postgres://postgres:x@127.0.0.1:5499/postgres \
#     node supabase/tests/stress/db_drills_saved_boundary.mjs
#   docker rm -f pickle-stress-db                # tear down
set -euo pipefail

cd "$(dirname "$0")/../.."

CONTAINER=${STRESS_PG_CONTAINER:-pickle-stress-db}
PORT=${STRESS_PG_PORT:-5499}

if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  echo "Docker is required for the stress harness database." >&2
  exit 2
fi

docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
docker run -d --name "$CONTAINER" -p "$PORT":5432 -e POSTGRES_PASSWORD=x postgres:16 >/dev/null

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
  psql -U postgres -v ON_ERROR_STOP=1 -q -f /tests/shim_auth.sql
  for f in /migrations/*.sql; do
    psql -U postgres -v ON_ERROR_STOP=1 -q -f "$f"
  done
'

echo "ready: postgres://postgres:x@127.0.0.1:$PORT/postgres ($CONTAINER)"
