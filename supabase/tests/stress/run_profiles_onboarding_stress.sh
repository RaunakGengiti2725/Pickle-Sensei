#!/usr/bin/env bash
# Concurrency stress campaign for the db-profiles-onboarding unit against a
# throwaway postgres:16 (Docker). Mirrors run_rls_tests.sh setup: install the
# Supabase shim, apply every migration in order, then drive the seeded node
# harness. All STRESS_* env vars are forwarded (STRESS_ITER, STRESS_SEED,
# STRESS_ISOLATION, STRESS_ONLY, STRESS_REPLAY, STRESS_OUT, STRESS_STRICT).
#
#   ./supabase/tests/stress/run_profiles_onboarding_stress.sh            # default 40 iterations
#   STRESS_ITER=600 ./supabase/tests/stress/run_profiles_onboarding_stress.sh
#   STRESS_REPLAY=clock_skew_updated_at:1000012 ./supabase/tests/stress/run_profiles_onboarding_stress.sh
#
# Exits with the harness's exit code (non-zero on any P0–P2 violation; P3
# observations are reported in the JSON table but only fail under
# STRESS_STRICT=1). KEEP_DB=1 leaves the container running for manual repro.
set -euo pipefail

cd "$(dirname "$0")/../.."

if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  echo "Docker is required for the stress campaign (postgres:16 on port ${STRESS_PG_PORT:-5499})." >&2
  exit 1
fi

CONTAINER=${STRESS_PG_CONTAINER:-pickle-stress-pg}
PORT=${STRESS_PG_PORT:-5499}
cleanup() {
  if [ "${KEEP_DB:-0}" != "1" ]; then docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; fi
}
trap cleanup EXIT
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true

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

export STRESS_PG_URL="postgres://postgres:x@127.0.0.1:${PORT}/postgres"
node tests/stress/profiles_onboarding_concurrency.mjs
