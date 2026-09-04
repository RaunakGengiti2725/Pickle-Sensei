#!/usr/bin/env bash
# Boundary/malformed-input stress run for the service-only billing tables
# (public.billing_entitlements, public.webhook_events).
#
#   ./supabase/tests/stress/run_boundary_malformed.sh              # 200 seeded iterations (suite default)
#   STRESS_ITER=3000 ./supabase/tests/stress/run_boundary_malformed.sh
#   PGURL=postgres://postgres:x@localhost:5499/postgres ./supabase/tests/stress/run_boundary_malformed.sh
#
# Without PGURL it starts a throwaway postgres:16 container on port 5499,
# installs the supabase/tests shim, applies every migration in order, runs the
# exact SQL repros (boundary_malformed_repro.sql) and then the seeded node-pg
# harness (boundary_malformed.mjs). Exits non-zero on ANY held-invariant
# violation. The JSON seed→outcome table lands in STRESS_OUT
# (default supabase/tests/stress/out/boundary_malformed.json).
set -euo pipefail

cd "$(dirname "$0")/../.."
STRESS_ITER="${STRESS_ITER:-200}"
STRESS_SEED="${STRESS_SEED:-20260904}"
export STRESS_ITER STRESS_SEED

if [ -z "${PGURL:-}" ]; then
  if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
    echo "PGURL is unset and Docker is unavailable; set PGURL to a database with shim + migrations applied." >&2
    exit 1
  fi
  CONTAINER=pickle-stress-boundary
  PORT="${STRESS_PG_PORT:-5499}"
  cleanup() {
    if docker ps -a --format '{{.Names}}' | grep -qx "$CONTAINER"; then
      docker rm -f "$CONTAINER" >/dev/null
    fi
  }
  trap cleanup EXIT
  cleanup

  docker run -d --name "$CONTAINER" -p "$PORT":5432 -e POSTGRES_PASSWORD=x postgres:16 >/dev/null
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

  docker cp tests "$CONTAINER":/tests
  docker cp migrations "$CONTAINER":/migrations
  docker exec "$CONTAINER" bash -c '
    set -euo pipefail
    psql -U postgres -v ON_ERROR_STOP=1 -q -f /tests/shim_auth.sql
    for f in /migrations/*.sql; do
      echo "applying $f"
      psql -U postgres -v ON_ERROR_STOP=1 -q -f "$f"
    done
  '
  export PGURL="postgres://postgres:x@localhost:$PORT/postgres"
fi

echo "== exact SQL repros"
if command -v psql >/dev/null 2>&1; then
  psql "$PGURL" -v ON_ERROR_STOP=1 -f tests/stress/boundary_malformed_repro.sql
else
  docker exec -i "${CONTAINER:?psql is not installed and no container was started}" psql -U postgres -v ON_ERROR_STOP=1 < tests/stress/boundary_malformed_repro.sql
fi

echo "== seeded harness (STRESS_ITER=$STRESS_ITER STRESS_SEED=$STRESS_SEED)"
node tests/stress/boundary_malformed.mjs
