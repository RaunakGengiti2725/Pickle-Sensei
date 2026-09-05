#!/usr/bin/env bash
# Disposable Postgres + PostgREST for the saved-drill DELETE stress tests.
#
#   ./stress_pg_up.sh          # start; prints the env to export
#   ./stress_pg_up.sh down     # remove both containers
#
# Postgres: ./xc_pg_up.sh (postgres:16 + supabase/tests/shim_auth.sql + every
# migration in supabase/migrations, in order). On top of that, TEST-ONLY setup
# that hosted Supabase provides and the shim does not:
#   - auth.uid() that also reads PostgREST v12's `request.jwt.claims` JSON GUC
#     (hosted definition: coalesce of the legacy `request.jwt.claim.sub` and
#     `request.jwt.claims ->> 'sub'`);
#   - an `authenticator` login role that PostgREST connects as and switches to
#     anon / authenticated per request.
# PostgREST: postgrest/postgrest:v12.2.3 on 127.0.0.1:${STRESS_PGRST_PORT},
# verifying HS256 bearers signed with STRESS_JWT_SECRET (the same secret the
# in-process fake GoTrue signs its access tokens with).
#
# Nothing here ever points at a hosted project.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
PG_CONTAINER=${XC_PG_CONTAINER:-pickle-xc-pg}
PG_PORT=${XC_PG_PORT:-55433}
PGRST_CONTAINER=${STRESS_PGRST_CONTAINER:-pickle-stress-postgrest}
PGRST_PORT=${STRESS_PGRST_PORT:-3001}
JWT_SECRET=${STRESS_JWT_SECRET:-stress-local-jwt-secret-at-least-32-characters-long}

if [ "${1:-up}" = "down" ]; then
  docker rm -f "$PGRST_CONTAINER" >/dev/null 2>&1 || true
  XC_PG_CONTAINER="$PG_CONTAINER" XC_PG_PORT="$PG_PORT" "$HERE/xc_pg_up.sh" down
  exit 0
fi

docker rm -f "$PGRST_CONTAINER" >/dev/null 2>&1 || true
XC_PG_CONTAINER="$PG_CONTAINER" XC_PG_PORT="$PG_PORT" "$HERE/xc_pg_up.sh" >/dev/null

docker exec -i "$PG_CONTAINER" psql -U postgres -v ON_ERROR_STOP=1 -q <<'SQL'
create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select nullif(
    coalesce(
      current_setting('request.jwt.claim.sub', true),
      (current_setting('request.jwt.claims', true)::jsonb ->> 'sub')
    ),
    ''
  )::uuid
$$;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'authenticator') then
    create role authenticator noinherit login password 'authenticator';
  end if;
end $$;
grant anon, authenticated to authenticator;
SQL

docker run -d --name "$PGRST_CONTAINER" --network host \
  -e PGRST_DB_URI="postgres://authenticator:authenticator@127.0.0.1:${PG_PORT}/postgres" \
  -e PGRST_DB_SCHEMAS=public \
  -e PGRST_DB_ANON_ROLE=anon \
  -e PGRST_JWT_SECRET="$JWT_SECRET" \
  -e PGRST_SERVER_HOST=127.0.0.1 \
  -e PGRST_SERVER_PORT="$PGRST_PORT" \
  -e PGRST_LOG_LEVEL=error \
  postgrest/postgrest:v12.2.3 >/dev/null

ready=0
for _ in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:${PGRST_PORT}/" >/dev/null 2>&1; then
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

echo "export XC_PG_URL=postgres://postgres:pg@127.0.0.1:${PG_PORT}/postgres"
echo "export STRESS_POSTGREST_URL=http://127.0.0.1:${PGRST_PORT}"
echo "export STRESS_JWT_SECRET=${JWT_SECRET}"
