#!/usr/bin/env bash
# Disposable Postgres 16 + a REAL PostgREST in front of it, for
# stress_delete_request_pg.test.ts: the in-process edge handler's PostgREST
# calls are forwarded to this PostgREST, so the route's upsert / RPC / insert
# run against every migration, the real RLS policies, column grants and
# triggers — not the in-memory model.
#
#   ./stress_pg_postgrest_up.sh        # start (idempotent)
#   ./stress_pg_postgrest_up.sh down   # remove both containers
#
# Prints the env to export for the test. Never points at a hosted project.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
PG_CONTAINER=${STRESS_PG_CONTAINER:-pickle-stress-pg}
PG_PORT=${STRESS_PG_PORT:-55434}
PGRST_CONTAINER=${STRESS_PGRST_CONTAINER:-pickle-stress-postgrest}
PGRST_PORT=${STRESS_PGRST_PORT:-53000}
PGRST_IMAGE=${STRESS_PGRST_IMAGE:-postgrest/postgrest:v12.2.3}
# Test-only signing secret (PostgREST requires >= 32 chars for HS256).
JWT_SECRET=${STRESS_JWT_SECRET:-stress-delete-request-jwt-secret-0123456789abcdef}

if [ "${1:-up}" = "down" ]; then
  docker rm -f "$PGRST_CONTAINER" >/dev/null 2>&1 || true
  XC_PG_CONTAINER="$PG_CONTAINER" XC_PG_PORT="$PG_PORT" "$HERE/xc_pg_up.sh" down
  exit 0
fi

docker rm -f "$PGRST_CONTAINER" >/dev/null 2>&1 || true
XC_PG_CONTAINER="$PG_CONTAINER" XC_PG_PORT="$PG_PORT" "$HERE/xc_pg_up.sh" >/dev/null

# Hosted Supabase's auth.uid() reads PostgREST's `request.jwt.claims` JSON
# (PostgREST >= 9 no longer sets the legacy `request.jwt.claim.sub` GUC that
# supabase/tests/shim_auth.sql uses for psql-driven tests). Mirror the hosted
# definition so RLS sees the bearer's sub through a real PostgREST too.
docker exec "$PG_CONTAINER" psql -U postgres -v ON_ERROR_STOP=1 -q -c "
create or replace function auth.uid() returns uuid language sql stable as \$\$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
  )::uuid
\$\$;
grant select on auth.users to postgres;
"

docker run -d --name "$PGRST_CONTAINER" --network host \
  -e PGRST_DB_URI="postgres://postgres:pg@127.0.0.1:${PG_PORT}/postgres" \
  -e PGRST_DB_SCHEMAS=public \
  -e PGRST_DB_ANON_ROLE=anon \
  -e PGRST_JWT_SECRET="$JWT_SECRET" \
  -e PGRST_SERVER_HOST=127.0.0.1 \
  -e PGRST_SERVER_PORT="$PGRST_PORT" \
  -e PGRST_DB_POOL=20 \
  "$PGRST_IMAGE" >/dev/null

ready=0
for _ in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:${PGRST_PORT}/" -o /dev/null 2>/dev/null; then
    ready=1
    break
  fi
  sleep 1
done
if [ "$ready" -ne 1 ]; then
  echo "postgrest did not become ready within 60s" >&2
  docker logs "$PGRST_CONTAINER" 2>&1 | tail -20 >&2
  exit 2
fi

echo "STRESS_PG_URL=postgres://postgres:pg@127.0.0.1:${PG_PORT}/postgres"
echo "STRESS_POSTGREST_URL=http://127.0.0.1:${PGRST_PORT}"
echo "STRESS_JWT_SECRET=${JWT_SECRET}"
