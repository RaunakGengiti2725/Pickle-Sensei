#!/usr/bin/env bash
# Disposable Postgres for the RLS concurrency stress harness.
#
# Same shape as supabase/tests/run_rls_tests.sh (postgres:16 + shim_auth.sql +
# every migration in lexical order) plus the hosted-like auth.uid() overlay
# (shim_hosted_uid.sql), published on a host port so N independent client
# connections can contend on the per-user advisory locks and row locks.
#
#   ./pg_up.sh            # start (replaces a previous container), prints STRESS_PG_URL
#   ./pg_up.sh down       # remove the container
#
# Never points at a hosted project: the URL is always 127.0.0.1.
set -euo pipefail

CONTAINER=${STRESS_PG_CONTAINER:-pickle-stress-pg}
PORT=${STRESS_PG_PORT:-5499}
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"

if [ "${1:-up}" = "down" ]; then
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  exit 0
fi

docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
docker run -d --name "$CONTAINER" -p "127.0.0.1:${PORT}:5432" \
  -e POSTGRES_PASSWORD=pg postgres:16 \
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
docker exec "$CONTAINER" bash -c '
  set -euo pipefail
  psql -U postgres -v ON_ERROR_STOP=1 -q -f /tests/shim_auth.sql
  psql -U postgres -v ON_ERROR_STOP=1 -q -f /tests/stress/shim_hosted_uid.sql
  for f in /migrations/*.sql; do
    echo "applying $f"
    psql -U postgres -v ON_ERROR_STOP=1 -q -f "$f"
  done
'
echo "STRESS_PG_URL=postgres://postgres:pg@127.0.0.1:${PORT}/postgres"
