#!/usr/bin/env bash
# Run the Supabase security regression matrix against a throwaway Postgres.
#
#   ./supabase/tests/run_rls_tests.sh
#
# Boots postgres:15 in Docker, installs the minimal Supabase shim
# (auth schema + roles), applies every migration in order, then runs
# security_regression.sql. Exits non-zero on ANY boundary regression.
set -euo pipefail

cd "$(dirname "$0")/.."

CONTAINER=pickle-rls-test

cleanup() { docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup

docker run -d --name "$CONTAINER" -e POSTGRES_PASSWORD=pg postgres:15 >/dev/null
for _ in $(seq 1 30); do
  docker exec "$CONTAINER" pg_isready -U postgres >/dev/null 2>&1 && break
  sleep 1
done

docker cp tests "$CONTAINER":/tests
docker cp migrations "$CONTAINER":/migrations

docker exec "$CONTAINER" bash -c '
  set -euo pipefail
  psql -U postgres -v ON_ERROR_STOP=1 -q -f /tests/shim_auth.sql
  for f in /migrations/*.sql; do
    echo "applying $f"
    psql -U postgres -v ON_ERROR_STOP=1 -q -f "$f"
  done
  psql -U postgres -v ON_ERROR_STOP=1 -f /tests/security_regression.sql
'
