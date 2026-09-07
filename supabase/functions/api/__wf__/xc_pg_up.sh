#!/usr/bin/env bash
# Disposable Postgres for xc_pg_rpc_concurrency.test.ts — the same shape as
# supabase/tests/run_rls_tests.sh (postgres:16 + shim_auth.sql + every
# migration in order), published on a host port so N independent client
# connections can contend on the RPCs' per-user advisory locks.
#
#   ./xc_pg_up.sh            # start (idempotent: replaces a previous container)
#   ./xc_pg_up.sh down       # remove
#
# Prints the XC_PG_URL to use. Never points at a hosted project.
set -euo pipefail

CONTAINER=${XC_PG_CONTAINER:-pickle-xc-pg}
PORT=${XC_PG_PORT:-55433}
ROOT="$(cd "$(dirname "$0")/../../../.." && pwd)"

if [ "${1:-up}" = "down" ]; then
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  exit 0
fi

docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
docker run -d --name "$CONTAINER" -p "127.0.0.1:${PORT}:5432" \
  -e POSTGRES_PASSWORD=pg postgres:16 >/dev/null

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
  for f in /migrations/*.sql; do
    echo "applying $f"
    psql -U postgres -v ON_ERROR_STOP=1 -q -f "$f"
  done
'
echo "XC_PG_URL=postgres://postgres:pg@127.0.0.1:${PORT}/postgres"
