#!/usr/bin/env bash
# Pickle Sensei — db-schema-migrations execution audit runner.
#
#   ./supabase/tests/audit/run_audit_probes.sh [artifact-dir]
#
# Builds a throwaway PostgreSQL 16 image WITH pg_cron (postgres:16 +
# postgresql-16-cron from the image's own apt repo), starts it with pg_cron
# preloaded for the `postgres` database, installs supabase/tests/shim_auth.sql,
# applies every migration in lexical order with ON_ERROR_STOP, then runs, in
# order, each writing its own log under the artifact dir:
#
#   00_apply_migrations.log   every migration, every NOTICE (pg_cron branch taken)
#   01_security_regression    the production RLS matrix, on a pg_cron-enabled server
#   02_probe_rpc_states       RPC state matrix (probe_rpc_states.sql)
#   03_probe_cascade_indexes  cascade timing / FK-index coverage / hot-path plans
#   04_probe_concurrency      parallel psql races (probe_concurrency.sh)
#   05_probe_pg_cron          jobs registered + scheduler executes the sweeps
#
# Exit status is non-zero if ANY stage fails; the summary line per stage names
# the exit code so a partial run is never mistaken for a pass. Nothing here
# touches a hosted project: the only connection is to the local container.
set -uo pipefail

cd "$(dirname "$0")/../../.."   # → repo root
ART="${1:-artifacts/db-audit/$(date -u +%Y%m%dT%H%M%SZ)}"
mkdir -p "$ART"

if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  echo "Docker is required for this audit." >&2
  exit 1
fi

IMAGE=pickle-audit-pgcron:16
CONTAINER=pickle-audit-probes
cleanup() { docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup

echo "── building $IMAGE"
docker build -t "$IMAGE" -f - . >"$ART/00_build_image.log" 2>&1 <<'DOCKERFILE'
FROM postgres:16
RUN apt-get update \
 && apt-get install -y --no-install-recommends postgresql-16-cron \
 && rm -rf /var/lib/apt/lists/*
DOCKERFILE
build_rc=$?
echo "image build → exit $build_rc ($ART/00_build_image.log)"
[ $build_rc -eq 0 ] || exit $build_rc

docker run -d --name "$CONTAINER" -e POSTGRES_PASSWORD=pg "$IMAGE" \
  -c shared_preload_libraries=pg_cron -c cron.database_name=postgres >/dev/null
for _ in $(seq 1 60); do
  # TCP probe: the image's bootstrap server only listens on the socket.
  docker exec "$CONTAINER" pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1 && break
  sleep 1
done
docker exec "$CONTAINER" pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1 \
  || { echo "postgres did not become ready" >&2; exit 1; }

docker cp supabase/tests "$CONTAINER":/tests
docker cp supabase/migrations "$CONTAINER":/migrations

overall=0
stage() { # $1 name, $2 rc
  if [ "$2" -eq 0 ]; then echo "$1 → exit 0"; else echo "$1 → exit $2  ✗"; overall=1; fi
}

docker exec "$CONTAINER" bash -c '
  set -euo pipefail
  psql -U postgres -v ON_ERROR_STOP=1 -q -f /tests/shim_auth.sql
  for f in /migrations/*.sql; do
    echo "== $f"
    psql -U postgres -v ON_ERROR_STOP=1 -q -f "$f"
  done
' >"$ART/00_apply_migrations.log" 2>&1
rc=$?; stage "00_apply_migrations ($ART/00_apply_migrations.log)" $rc
[ $rc -eq 0 ] || exit 1
if grep -q "pg_cron unavailable" "$ART/00_apply_migrations.log"; then
  echo "pg_cron branch NOT taken — the cron probe would be meaningless" >&2
  overall=1
fi

docker exec "$CONTAINER" psql -U postgres -v ON_ERROR_STOP=1 -q -f /tests/security_regression.sql \
  >"$ART/01_security_regression.log" 2>&1
rc=$?; stage "01_security_regression ($ART/01_security_regression.log)" $rc
grep -q "SECURITY REGRESSION MATRIX: ALL CASES PASSED" "$ART/01_security_regression.log" || overall=1

docker exec "$CONTAINER" psql -U postgres -v ON_ERROR_STOP=1 -f /tests/audit/probe_rpc_states.sql \
  >"$ART/02_probe_rpc_states.log" 2>&1
rc=$?; stage "02_probe_rpc_states ($ART/02_probe_rpc_states.log)" $rc
grep -q "RPC STATE MATRIX: ALL CASES PASSED" "$ART/02_probe_rpc_states.log" || overall=1

docker exec "$CONTAINER" psql -U postgres -v ON_ERROR_STOP=1 -f /tests/audit/probe_cascade_indexes.sql \
  >"$ART/03_probe_cascade_indexes.log" 2>&1
rc=$?; stage "03_probe_cascade_indexes ($ART/03_probe_cascade_indexes.log)" $rc
grep -q "CASCADE / INDEX PROBES: ALL CASES PASSED" "$ART/03_probe_cascade_indexes.log" || overall=1

docker exec "$CONTAINER" bash /tests/audit/probe_concurrency.sh \
  >"$ART/04_probe_concurrency.log" 2>&1
rc=$?; stage "04_probe_concurrency ($ART/04_probe_concurrency.log)" $rc
grep -q "CONCURRENCY PROBES: ALL CASES PASSED" "$ART/04_probe_concurrency.log" || overall=1

docker exec "$CONTAINER" psql -U postgres -v ON_ERROR_STOP=1 -f /tests/audit/probe_pg_cron.sql \
  >"$ART/05_probe_pg_cron.log" 2>&1
rc=$?; stage "05_probe_pg_cron ($ART/05_probe_pg_cron.log)" $rc
grep -q "PG_CRON PROBES: ALL CASES PASSED" "$ART/05_probe_pg_cron.log" || overall=1

# Anything the probes flagged without failing (planner notes, contract notes).
grep -h "NOTE:" "$ART"/0*.log | sed 's/^/note: /' || true

if [ $overall -eq 0 ]; then
  echo "DB SCHEMA/MIGRATIONS AUDIT: ALL STAGES PASSED ($ART)"
else
  echo "DB SCHEMA/MIGRATIONS AUDIT: STAGE FAILURES ($ART)" >&2
fi
exit $overall
