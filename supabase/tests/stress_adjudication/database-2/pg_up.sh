#!/usr/bin/env bash
# database-2 adjudication — throwaway postgres:16 with the shim, the hosted
# auth.uid() overlay (reads request.jwt.claims like PostgREST) and every
# migration applied in order. Mirrors supabase/tests/run_rls_tests.sh.
#
#   ./supabase/tests/stress_adjudication/database-2/pg_up.sh        # start (container pickle-adj-pg, port 5499)
#   ./supabase/tests/stress_adjudication/database-2/pg_up.sh down   # remove
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../../.." && pwd)"
CONTAINER=${ADJ_PG_CONTAINER:-pickle-adj-pg}
PORT=${ADJ_PG_PORT:-5499}

if [ "${1:-}" = "down" ]; then
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  exit 0
fi

docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
docker run -d --name "$CONTAINER" -p "$PORT:5432" -e POSTGRES_PASSWORD=pg postgres:16 >/dev/null
for _ in $(seq 1 60); do
  docker exec "$CONTAINER" pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1 && break
  sleep 1
done
docker cp "$ROOT/supabase/tests" "$CONTAINER":/tests
docker cp "$ROOT/supabase/migrations" "$CONTAINER":/migrations
docker exec "$CONTAINER" bash -c '
  set -euo pipefail
  psql -U postgres -v ON_ERROR_STOP=1 -q -f /tests/shim_auth.sql
  psql -U postgres -v ON_ERROR_STOP=1 -q -f /tests/stress_adjudication/database-2/shim_hosted_uid.sql
  for f in /migrations/*.sql; do psql -U postgres -v ON_ERROR_STOP=1 -q -f "$f"; done
'
echo "ADJ_PG_CONTAINER=$CONTAINER"
echo "ADJ_PG_URL=postgres://postgres:pg@127.0.0.1:$PORT/postgres"
