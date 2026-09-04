#!/usr/bin/env bash
# Postgres-backed half of the GET /v1/me/saved-drills fuzz campaign: a
# disposable postgres:16 (same recipe as supabase/tests/run_rls_tests.sh —
# shim_auth.sql + every migration in order) running stress_saved_drills_pg.sql
# with a seeded RNG. Never points at a hosted project.
#
#   ./stress_saved_drills_pg.sh                 # 500 iterations, seed 0.20260904
#   STRESS_PG_ITER=3000 ./stress_saved_drills_pg.sh
#   STRESS_PG_SEED=0.42 STRESS_PG_OUT=/tmp/pg.json ./stress_saved_drills_pg.sh
#
# Exit 0 iff every iteration HELD; the JSON result goes to stdout (and to
# STRESS_PG_OUT when set).
set -euo pipefail

ITER=${STRESS_PG_ITER:-500}
SEED=${STRESS_PG_SEED:-0.20260904}
OUT=${STRESS_PG_OUT:-}
CONTAINER=${STRESS_PG_CONTAINER:-pickle-stress-saved-drills-pg}
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../../.." && pwd)"

if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  echo "docker is required (postgres:16 container); refusing to run against anything else" >&2
  exit 2
fi

cleanup() { docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup

docker run -d --name "$CONTAINER" -e POSTGRES_PASSWORD=pg postgres:16 >/dev/null
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
docker cp "$HERE/stress_saved_drills_pg.sql" "$CONTAINER":/stress_saved_drills_pg.sql

docker exec "$CONTAINER" bash -c '
  set -euo pipefail
  psql -U postgres -v ON_ERROR_STOP=1 -q -f /tests/shim_auth.sql
  for f in /migrations/*.sql; do
    psql -U postgres -v ON_ERROR_STOP=1 -q -f "$f"
  done
' >&2

RESULT=$(docker exec "$CONTAINER" psql -U postgres -v ON_ERROR_STOP=1 -qAt \
  -v seed="$SEED" -v iterations="$ITER" -f /stress_saved_drills_pg.sql)

if [ -n "$OUT" ]; then
  printf '%s\n' "$RESULT" > "$OUT"
fi
printf '%s\n' "$RESULT"

BROKEN=$(printf '%s' "$RESULT" | python3 -c 'import json,sys; print(json.load(sys.stdin)["broken"])')
EXECUTED=$(printf '%s' "$RESULT" | python3 -c 'import json,sys; print(json.load(sys.stdin)["executed"])')
if [ "$EXECUTED" != "$ITER" ]; then
  echo "executed $EXECUTED of $ITER iterations" >&2
  exit 1
fi
if [ "$BROKEN" != "0" ]; then
  echo "$BROKEN iteration(s) BROKEN (seed $SEED)" >&2
  exit 1
fi
echo "stress_saved_drills_pg: $EXECUTED iterations HELD (seed $SEED)" >&2
