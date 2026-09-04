#!/usr/bin/env bash
# Start a disposable PostgREST in front of the disposable postgres:16 that
# ./xc_pg_up.sh started, so stress_analysis_permits_pg.test.ts can drive the
# REAL edge handler → REAL PostgREST → REAL reserve_analysis_permit() RPC
# (every migration applied) instead of the modelled database.
#
#   ./xc_pg_up.sh                       # prints XC_PG_URL
#   ./stress_postgrest_up.sh            # prints STRESS_POSTGREST_URL + STRESS_PG_JWT_SECRET
#   XC_PG_URL=… STRESS_POSTGREST_URL=… STRESS_PG_JWT_SECRET=… \
#     deno test -A --no-check --config deno.json stress_analysis_permits_pg.test.ts
#
# Hosted Supabase's auth.uid() reads the `request.jwt.claims` GUC that
# PostgREST ≥ 9 sets; supabase/tests/shim_auth.sql only reads the legacy
# `request.jwt.claim.sub` (what the direct-SQL tests set). The disposable
# database gets an auth.uid() that honours BOTH so the same shim serves the
# direct-SQL matrix and this PostgREST path. Test infrastructure only — no
# migration is touched.
set -euo pipefail

CONTAINER="${STRESS_POSTGREST_CONTAINER:-pickle-xc-postgrest}"
PORT="${STRESS_POSTGREST_PORT:-55434}"
PG_CONTAINER="${XC_PG_CONTAINER:-pickle-xc-pg}"
PG_URL="${XC_PG_URL:-postgres://postgres:pg@127.0.0.1:55433/postgres}"
IMAGE="${STRESS_POSTGREST_IMAGE:-postgrest/postgrest:v12.2.3}"
# ≥ 32 bytes as PostgREST requires; disposable, never a real secret.
JWT_SECRET="${STRESS_PG_JWT_SECRET:-stress-disposable-jwt-secret-0123456789abcdef}"

if ! docker ps --format '{{.Names}}' | grep -qx "$PG_CONTAINER"; then
  echo "postgres container $PG_CONTAINER is not running — run ./xc_pg_up.sh first" >&2
  exit 1
fi

docker exec -i "$PG_CONTAINER" psql -v ON_ERROR_STOP=1 -q -U postgres -d postgres <<'SQL'
create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
  )::uuid
$$;
SQL

if docker ps -a --format '{{.Names}}' | grep -qx "$CONTAINER"; then
  docker rm -f "$CONTAINER" >/dev/null
fi
docker run -d --name "$CONTAINER" --network host \
  -e PGRST_DB_URI="$PG_URL" \
  -e PGRST_DB_SCHEMAS=public \
  -e PGRST_DB_ANON_ROLE=anon \
  -e PGRST_JWT_SECRET="$JWT_SECRET" \
  -e PGRST_SERVER_HOST=127.0.0.1 \
  -e PGRST_SERVER_PORT="$PORT" \
  -e PGRST_DB_POOL=20 \
  -e PGRST_LOG_LEVEL=warn \
  "$IMAGE" >/dev/null

for _ in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:${PORT}/" >/dev/null 2>&1; then
    echo "STRESS_POSTGREST_URL=http://127.0.0.1:${PORT}"
    echo "STRESS_PG_JWT_SECRET=${JWT_SECRET}"
    exit 0
  fi
  sleep 0.5
done
echo "PostgREST did not become ready" >&2
docker logs "$CONTAINER" >&2
exit 1
