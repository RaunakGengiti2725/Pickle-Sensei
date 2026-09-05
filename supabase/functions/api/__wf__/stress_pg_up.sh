#!/usr/bin/env bash
# Disposable Postgres 16 + PostgREST for stress_route_delete_saved_drills_pg.test.ts.
#
# Postgres comes from ./xc_pg_up.sh (postgres:16 + supabase/tests/shim_auth.sql
# + every migration in order) on its own container/port; PostgREST v11 (the
# major Supabase hosts) sits in front of it with the shim's anon/authenticated
# roles behind an `authenticator` login role, exactly like the hosted stack.
# The edge handler's PostgREST calls are rewritten to it by the test's fetch
# wrapper; the JWT secret below is a throwaway for this disposable stack only
# — it never points at, or resembles, a hosted project.
#
#   ./stress_pg_up.sh            # start (idempotent), prints the env to export
#   ./stress_pg_up.sh down       # remove both containers
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
PG_CONTAINER=${STRESS_PG_CONTAINER:-pickle-stress-pg}
PG_PORT=${STRESS_PG_PORT:-55434}
PGRST_CONTAINER=${STRESS_PGRST_CONTAINER:-pickle-stress-pgrst}
PGRST_PORT=${STRESS_PGRST_PORT:-3001}
PGRST_IMAGE=${STRESS_PGRST_IMAGE:-postgrest/postgrest:v11.2.2}
JWT_SECRET=${STRESS_PGRST_JWT_SECRET:-stress-saved-drills-disposable-jwt-secret-0123456789}
AUTHENTICATOR_PASSWORD=stress-authenticator

if [ "${1:-up}" = "down" ]; then
  docker rm -f "$PGRST_CONTAINER" >/dev/null 2>&1 || true
  XC_PG_CONTAINER="$PG_CONTAINER" XC_PG_PORT="$PG_PORT" "$HERE/xc_pg_up.sh" down
  exit 0
fi

docker rm -f "$PGRST_CONTAINER" >/dev/null 2>&1 || true
XC_PG_CONTAINER="$PG_CONTAINER" XC_PG_PORT="$PG_PORT" "$HERE/xc_pg_up.sh" >/dev/null

docker exec -i "$PG_CONTAINER" psql -U postgres -v ON_ERROR_STOP=1 -q <<SQL
do \$\$
begin
  if not exists (select 1 from pg_roles where rolname = 'authenticator') then
    create role authenticator noinherit login password '${AUTHENTICATOR_PASSWORD}';
  end if;
end \$\$;
grant anon, authenticated to authenticator;
-- The shim's auth.uid() reads only the legacy request.jwt.claim.sub GUC, which
-- PostgREST v11 no longer sets; hosted Supabase's auth.uid() also reads the
-- 'sub' of request.jwt.claims. Install the hosted definition so RLS sees the
-- caller exactly as production does (test stack only; not a migration).
create or replace function auth.uid()
returns uuid
language sql
stable
as \$\$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
\$\$;
SQL

docker run -d --name "$PGRST_CONTAINER" --network host \
  -e PGRST_DB_URI="postgres://authenticator:${AUTHENTICATOR_PASSWORD}@127.0.0.1:${PG_PORT}/postgres" \
  -e PGRST_DB_SCHEMAS=public \
  -e PGRST_DB_ANON_ROLE=anon \
  -e PGRST_JWT_SECRET="$JWT_SECRET" \
  -e PGRST_SERVER_PORT="$PGRST_PORT" \
  -e PGRST_SERVER_HOST=127.0.0.1 \
  -e PGRST_LOG_LEVEL=warn \
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
  echo "PostgREST did not become ready within 60s" >&2
  docker logs "$PGRST_CONTAINER" 2>&1 | tail -20 >&2
  exit 2
fi

echo "export STRESS_PG_URL=postgres://postgres:pg@127.0.0.1:${PG_PORT}/postgres"
echo "export STRESS_POSTGREST_URL=http://127.0.0.1:${PGRST_PORT}"
echo "export STRESS_PGRST_JWT_SECRET=${JWT_SECRET}"
