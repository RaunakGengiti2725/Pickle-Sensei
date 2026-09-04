#!/usr/bin/env bash
# Disposable Postgres 16 for the stress harnesses under supabase/tests/stress/.
# Applies tests/shim_auth.sql + EVERY supabase/migrations/*.sql in order (the
# same recipe as supabase/tests/run_rls_tests.sh) and prints STRESS_PG_URL.
#
#   ./supabase/tests/stress/pg_up.sh            # start (idempotent)
#   ./supabase/tests/stress/pg_up.sh down       # stop + remove
#
# Requires Docker. pg_cron is NOT in the stock postgres:16 image: migration
# 20260831000000 logs "pg_cron unavailable" and skips scheduling, so the
# harness drives the scheduled SQL itself (extracted from the migration file).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
CONTAINER="${STRESS_PG_CONTAINER:-pickle-stress-pg}"
PORT="${STRESS_PG_PORT:-5499}"
IMAGE="${STRESS_PG_IMAGE:-postgres:16}"

if [[ "${1:-}" == "down" ]]; then
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || echo "no container $CONTAINER"
  exit 0
fi

if docker ps --format '{{.Names}}' | grep -qx "$CONTAINER"; then
  echo "container $CONTAINER already running" >&2
else
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || :
  docker run -d --name "$CONTAINER" -p "127.0.0.1:${PORT}:5432" \
    -e POSTGRES_PASSWORD=pg "$IMAGE" >/dev/null
  for _ in $(seq 1 60); do
    if docker exec "$CONTAINER" pg_isready -U postgres -q 2>/dev/null; then break; fi
    sleep 1
  done
  docker exec "$CONTAINER" pg_isready -U postgres -q
  docker cp "$ROOT/supabase/tests" "$CONTAINER:/tests"
  docker cp "$ROOT/supabase/migrations" "$CONTAINER:/migrations"
  docker exec "$CONTAINER" psql -v ON_ERROR_STOP=1 -q -U postgres -f /tests/shim_auth.sql
  for f in $(cd "$ROOT/supabase/migrations" && ls *.sql | sort); do
    echo "applying $f" >&2
    docker exec "$CONTAINER" psql -v ON_ERROR_STOP=1 -q -U postgres -f "/migrations/$f"
  done
fi

echo "STRESS_PG_URL=postgres://postgres:pg@127.0.0.1:${PORT}/postgres"
