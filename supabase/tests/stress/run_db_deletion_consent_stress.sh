#!/usr/bin/env bash
# Boundary / malformed-input stress campaign for the db-deletion-consent unit.
#
#   ./supabase/tests/stress/run_db_deletion_consent_stress.sh            # STRESS_ITER default 300
#   STRESS_ITER=3000 STRESS_SEED=20260904 STRESS_OUT=/tmp/results.json \
#     ./supabase/tests/stress/run_db_deletion_consent_stress.sh
#   STRESS_REPLAY=<seed> ./supabase/tests/stress/run_db_deletion_consent_stress.sh
#
# Boots a throwaway postgres:16 in Docker on PICKLE_STRESS_PG_PORT (default
# 5499), installs the Supabase shim (auth schema + roles + hosted-like default
# privileges), applies every migration in order, then runs
# db_deletion_consent_boundary.ts with the given campaign. The container is
# removed on exit. Set PICKLE_STRESS_PG_URL to reuse an already-provisioned
# database instead (no container is started, nothing is applied).
#
# Exit codes: 0 = every iteration HELD; 1 = at least one BROKEN iteration
# (details in STRESS_OUT); 2 = environment failure.
set -euo pipefail

cd "$(dirname "$0")/../.."   # supabase/

if ! command -v deno >/dev/null 2>&1; then
  echo "deno is required (curl -fsSL https://deno.land/install.sh | sh)" >&2
  exit 2
fi

if [ -z "${PICKLE_STRESS_PG_URL:-}" ]; then
  if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
    echo "Docker is required unless PICKLE_STRESS_PG_URL points at a prepared database." >&2
    exit 2
  fi
  PORT="${PICKLE_STRESS_PG_PORT:-5499}"
  CONTAINER="pickle-stress-db-$$"
  cleanup() { docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; }
  trap cleanup EXIT

  docker run -d --name "$CONTAINER" -p "127.0.0.1:${PORT}:5432" \
    -e POSTGRES_PASSWORD=x postgres:16 >/dev/null
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
      psql -U postgres -v ON_ERROR_STOP=1 -q -f "$f"
    done
  '
  export PICKLE_STRESS_PG_URL="postgres://postgres:x@127.0.0.1:${PORT}/postgres"
fi

# Not exec: the EXIT trap must still remove the container afterwards.
deno run -A --no-check --config tests/stress/deno.json \
  tests/stress/db_deletion_consent_boundary.ts
