#!/usr/bin/env bash
# Disposable Postgres + PostgREST for stress_permits_finalize_pg.test.ts.
#
# Reuses ./xc_pg_up.sh (postgres:16 + supabase/tests/shim_auth.sql + every
# migration in supabase/migrations, in order) and puts a PostgREST in front of
# it so the REAL edge handler's supabase-js calls (SELECT / guarded PATCH /
# rpc/access_state) hit real RLS, real column grants and the real RPCs instead
# of the in-memory model used by stress_permits_finalize_fuzz.test.ts.
#
#   ./stress_permits_finalize_pg_up.sh          # start (idempotent)
#   ./stress_permits_finalize_pg_up.sh down     # remove both containers
#
# Prints the three env vars the test needs. Everything here is local and
# throwaway: the JWT secret below signs test tokens for THIS PostgREST only
# (it is not a credential for anything) and nothing points at a hosted project.
#
# STRESS_PGRST_IMAGE selects the PostgREST version. Behaviour differs across
# major versions in ways this route is sensitive to (PostgREST <= 9 answers a
# zero-row PATCH with 404 `[]`, >= 10 with 200 `[]`), so run the suite against
# more than one. The bridge overrides auth.uid() to read the JSON
# `request.jwt.claims` GUC (what PostgREST >= 9 on PostgreSQL >= 14 publishes)
# with a fallback to the legacy `request.jwt.claim.sub` that
# supabase/tests/shim_auth.sql reads; hosted Supabase's auth.uid() reads both.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
PG_CONTAINER=${STRESS_PG_CONTAINER:-pickle-stress-pg}
PG_PORT=${STRESS_PG_PORT:-55434}
PGRST_CONTAINER=${STRESS_PGRST_CONTAINER:-pickle-stress-postgrest}
PGRST_PORT=${STRESS_PGRST_PORT:-55435}
PGRST_IMAGE=${STRESS_PGRST_IMAGE:-postgrest/postgrest:v12.2.12}
JWT_SECRET=${STRESS_JWT_SECRET:-stress-permits-finalize-local-postgrest-test-secret-0001}

if [ "${1:-up}" = "down" ]; then
  docker rm -f "$PGRST_CONTAINER" >/dev/null 2>&1 || true
  XC_PG_CONTAINER="$PG_CONTAINER" XC_PG_PORT="$PG_PORT" "$HERE/xc_pg_up.sh" down
  exit 0
fi

docker rm -f "$PGRST_CONTAINER" >/dev/null 2>&1 || true
XC_PG_CONTAINER="$PG_CONTAINER" XC_PG_PORT="$PG_PORT" "$HERE/xc_pg_up.sh" >/dev/null

# PostgREST connects as a hosted-like `authenticator` (login, noinherit) and
# SET ROLEs to anon / authenticated per request — never as the owner.
docker exec -i "$PG_CONTAINER" psql -U postgres -v ON_ERROR_STOP=1 -q <<'SQL'
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'authenticator') then
    create role authenticator login password 'pg' noinherit;
  end if;
end $$;
grant anon, authenticated to authenticator;

-- shim_auth.sql's auth.uid() reads the pre-PG14 text GUC request.jwt.claim.sub,
-- which the SQL-driven RLS tests set by hand. PostgREST on postgres >= 14 only
-- sets the json GUC request.jwt.claims, so give the disposable DB the hosted
-- definition (json claims first, legacy text GUC as fallback) — the shim file
-- itself is untouched.
create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$$;
SQL

# PostgREST reaches Postgres over the docker bridge (the published host port
# is for the test's own driver connections).
PG_IP="$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$PG_CONTAINER")"
docker run -d --name "$PGRST_CONTAINER" -p "127.0.0.1:${PGRST_PORT}:3000" \
  -e PGRST_DB_URI="postgres://authenticator:pg@${PG_IP}:5432/postgres" \
  -e PGRST_DB_SCHEMAS=public \
  -e PGRST_DB_ANON_ROLE=anon \
  -e PGRST_JWT_SECRET="$JWT_SECRET" \
  -e PGRST_SERVER_PORT=3000 \
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
  echo "PostgREST did not become ready within 60s" >&2
  docker logs "$PGRST_CONTAINER" 2>&1 | tail -20 >&2
  exit 2
fi

echo "STRESS_PG_URL=postgres://postgres:pg@127.0.0.1:${PG_PORT}/postgres"
echo "STRESS_POSTGREST_URL=http://127.0.0.1:${PGRST_PORT}"
echo "STRESS_JWT_SECRET=${JWT_SECRET}"
