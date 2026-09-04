#!/usr/bin/env bash
# Concurrency stress campaign for public.user_saved_drills (saved drills +
# their grants/policies) against a THROWAWAY Postgres 16.
#
#   ./supabase/tests/stress/run_saved_drills_concurrency.sh            # quick (default STRESS_ITER)
#   STRESS_ITER=560 STRESS_SEED=20260904 ./supabase/tests/stress/run_saved_drills_concurrency.sh
#
# Spins up postgres:16 in Docker, installs the Supabase shim
# (supabase/tests/shim_auth.sql), applies every supabase/migrations/*.sql in
# order, then drives saved_drills_concurrency.mjs (node-pg, parallel
# `authenticated` sessions) against it. Exits non-zero on any violated
# invariant. Nothing here touches a real project.
#
# Env:
#   STRESS_ITER  iterations (default 56 — one pass over every scenario ×4)
#   STRESS_SEED  base seed for the deterministic scheduler (default 1)
#   STRESS_OUT   JSON report path (default artifacts/stress/db-drills-saved/<seed>.json)
#   STRESS_PORT  host port for the throwaway container (default 5499)
set -euo pipefail

cd "$(dirname "$0")/../../.."          # → repo root

ITER="${STRESS_ITER:-56}"
SEED="${STRESS_SEED:-1}"
PORT="${STRESS_PORT:-5499}"
OUT="${STRESS_OUT:-artifacts/stress/db-drills-saved/seed-${SEED}-iter-${ITER}.json}"

if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  echo "Docker is required for this stress campaign." >&2
  exit 1
fi

CONTAINER="pickle-stress-drills-${PORT}"
cleanup() { docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup

docker run -d --name "$CONTAINER" -p "${PORT}:5432" -e POSTGRES_PASSWORD=x postgres:16 >/dev/null
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

docker cp supabase/tests "$CONTAINER":/tests >/dev/null
docker cp supabase/migrations "$CONTAINER":/migrations >/dev/null
docker exec "$CONTAINER" bash -c '
  set -euo pipefail
  psql -U postgres -v ON_ERROR_STOP=1 -q -f /tests/shim_auth.sql >/dev/null
  for f in /migrations/*.sql; do
    psql -U postgres -v ON_ERROR_STOP=1 -q -f "$f" >/dev/null 2>&1
  done
  echo "migrations applied"
'
# The harness opens up to 24 parallel sessions.
docker exec "$CONTAINER" psql -U postgres -q -c "alter system set max_connections = 200" >/dev/null
docker restart "$CONTAINER" >/dev/null
for _ in $(seq 1 60); do
  docker exec "$CONTAINER" pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1 && break
  sleep 1
done

PICKLE_STRESS_PG_URL="postgres://postgres:x@127.0.0.1:${PORT}/postgres" \
  node supabase/tests/stress/saved_drills_concurrency.mjs \
  --iter "$ITER" --seed "$SEED" --out "$OUT"
