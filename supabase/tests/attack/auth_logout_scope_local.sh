#!/usr/bin/env bash
# Adversarial pass 3 · S1 — LIVE Supabase Auth fixture for `logout?scope=local`.
#
#   ./supabase/tests/attack/auth_logout_scope_local.sh [artifact-dir]
#
# Stands up a throwaway stack in Docker that mirrors the pieces of hosted
# Supabase the mobile sign-out path depends on — real GoTrue (supabase/gotrue,
# the Auth server behind /auth/v1/*), a postgres:16 with this repo's shim +
# every migration applied, and PostgREST enforcing the repo's RLS policies
# with GoTrue-minted JWTs — then drives the attack the mobile edge function
# performs on `POST /v1/auth/logout` (supabase/functions/api/index.ts
# logoutRoute → `${SUPABASE_URL}/auth/v1/logout?scope=local` with the calling
# device's ACCESS token) and asserts:
#
#   1. device 1's refresh token is dead after its own scope=local logout;
#   2. device 1's access token no longer resolves a user (GoTrue /user, the
#      call authenticate() makes through auth.getUser);
#   3. device 2 (same account) still refreshes, still resolves /user, and
#      still reads exactly ITS OWN profiles row through RLS;
#   4. a different account never sees that row before or after;
#   5. (probe for the double-hydrate finding) a refresh token that was just
#      rotated can be re-spent inside GoTrue's reuse interval, and not after.
#
# Nothing here touches the production project; everything is local Docker
# and is torn down on exit. Exits non-zero on ANY assertion failure.
set -euo pipefail

cd "$(dirname "$0")/../../.."

ART=${1:-/tmp/attack3-s1}
mkdir -p "$ART"
LOG="$ART/auth_logout_scope_local.log"
RESULTS="$ART/auth_logout_scope_local.json"
: >"$LOG"

NET=pickle-attack3-net
PG=pickle-attack3-pg
GOTRUE=pickle-attack3-gotrue
PGRST=pickle-attack3-postgrest
GOTRUE_IMAGE=${GOTRUE_IMAGE:-supabase/gotrue:v2.177.0}
POSTGREST_IMAGE=${POSTGREST_IMAGE:-postgrest/postgrest:v12.2.3}
GOTRUE_PORT=${GOTRUE_PORT:-19999}
PGRST_PORT=${PGRST_PORT:-13000}
JWT_SECRET=$(openssl rand -hex 32) # throwaway, printed nowhere

cleanup() {
  docker rm -f "$PGRST" "$GOTRUE" "$PG" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
}
trap cleanup EXIT
cleanup

log() { printf '%s %s\n' "$(date -u +%H:%M:%S)" "$*" | tee -a "$LOG" >&2; }

if ! docker info >/dev/null 2>&1; then
  log "docker unavailable — S1 is UNKNOWN on this box"
  exit 2
fi

docker network create "$NET" >/dev/null
docker run -d --name "$PG" --network "$NET" -e POSTGRES_PASSWORD=pg postgres:16 >/dev/null
for _ in $(seq 1 60); do
  docker exec "$PG" pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1 && break
  sleep 1
done
docker exec "$PG" pg_isready -h 127.0.0.1 -U postgres >/dev/null

psql_pg() { docker exec -i "$PG" psql -U postgres -v ON_ERROR_STOP=1 -q "$@"; }

# Roles hosted Supabase provisions before GoTrue/PostgREST start.
psql_pg <<'SQL'
create role supabase_auth_admin login createrole password 'pg' noinherit;
create schema auth authorization supabase_auth_admin;
create role authenticator login password 'pg' noinherit;
SQL

log "starting GoTrue ($GOTRUE_IMAGE)"
docker run -d --name "$GOTRUE" --network "$NET" -p "127.0.0.1:${GOTRUE_PORT}:9999" \
  -e GOTRUE_API_HOST=0.0.0.0 -e PORT=9999 \
  -e API_EXTERNAL_URL="http://127.0.0.1:${GOTRUE_PORT}" \
  -e GOTRUE_DB_DRIVER=postgres \
  -e GOTRUE_DB_DATABASE_URL="postgres://supabase_auth_admin:pg@${PG}:5432/postgres?search_path=auth" \
  -e GOTRUE_SITE_URL=http://localhost -e GOTRUE_URI_ALLOW_LIST='*' \
  -e GOTRUE_JWT_SECRET="$JWT_SECRET" -e GOTRUE_JWT_EXP=3600 \
  -e GOTRUE_JWT_DEFAULT_GROUP_NAME=authenticated -e GOTRUE_JWT_AUD=authenticated \
  -e GOTRUE_JWT_ADMIN_ROLES=service_role \
  -e GOTRUE_EXTERNAL_EMAIL_ENABLED=true -e GOTRUE_MAILER_AUTOCONFIRM=true \
  -e GOTRUE_DISABLE_SIGNUP=false \
  -e GOTRUE_SECURITY_REFRESH_TOKEN_ROTATION_ENABLED=true \
  -e GOTRUE_SECURITY_REFRESH_TOKEN_REUSE_INTERVAL=10 \
  -e GOTRUE_LOG_LEVEL=info \
  "$GOTRUE_IMAGE" >/dev/null
AUTH="http://127.0.0.1:${GOTRUE_PORT}"
for _ in $(seq 1 90); do
  curl -fsS "$AUTH/health" >/dev/null 2>&1 && break
  sleep 1
done
curl -fsS "$AUTH/health" | tee -a "$LOG" >/dev/null || {
  docker logs "$GOTRUE" 2>&1 | tail -40 | tee -a "$LOG" >&2
  exit 2
}
log "GoTrue healthy; auth schema migrated"

# Repo shim (roles, hosted default privileges, auth.uid()) + every migration,
# exactly like supabase/tests/run_rls_tests.sh. auth.users/identities already
# exist from GoTrue's migrations; the shim's CREATE IF NOT EXISTS are no-ops.
docker cp supabase/tests "$PG":/tests
docker cp supabase/migrations "$PG":/migrations
docker exec "$PG" bash -c '
  set -euo pipefail
  psql -U postgres -v ON_ERROR_STOP=1 -q -f /tests/shim_auth.sql
  for f in /migrations/*.sql; do
    psql -U postgres -v ON_ERROR_STOP=1 -q -f "$f"
  done
' 2>&1 | tee -a "$LOG"
# PostgREST ≥ 9 publishes the JWT as request.jwt.claims (JSON); hosted
# Supabase's auth.uid() reads that. The shim's version reads the legacy
# per-claim GUC, which is right for psql-driven tests but blank here.
psql_pg <<'SQL'
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(
    coalesce(
      current_setting('request.jwt.claim.sub', true),
      current_setting('request.jwt.claims', true)::jsonb ->> 'sub'
    ), '')::uuid
$$;
grant anon, authenticated, service_role to authenticator;
grant usage on schema auth to supabase_auth_admin;
SQL
log "migrations applied"

log "starting PostgREST ($POSTGREST_IMAGE)"
docker run -d --name "$PGRST" --network "$NET" -p "127.0.0.1:${PGRST_PORT}:3000" \
  -e PGRST_DB_URI="postgres://authenticator:pg@${PG}:5432/postgres" \
  -e PGRST_DB_SCHEMAS=public -e PGRST_DB_ANON_ROLE=anon \
  -e PGRST_JWT_SECRET="$JWT_SECRET" -e PGRST_JWT_AUD=authenticated \
  "$POSTGREST_IMAGE" >/dev/null
REST="http://127.0.0.1:${PGRST_PORT}"
for _ in $(seq 1 60); do
  code=$(curl -s -o /dev/null -w '%{http_code}' "$REST/" || true)
  [ "$code" = "200" ] && break
  sleep 1
done
log "PostgREST answering ($code)"

AUTH_URL="$AUTH" REST_URL="$REST" ART_DIR="$ART" node supabase/tests/attack/auth_logout_scope_local.mjs 2>&1 | tee -a "$LOG"
status=${PIPESTATUS[0]}
log "node harness exit=$status; results: $RESULTS"
exit "$status"
