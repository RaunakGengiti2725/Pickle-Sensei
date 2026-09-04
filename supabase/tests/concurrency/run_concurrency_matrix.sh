#!/usr/bin/env bash
# Concurrency matrix for the Postgres access-control paths (throwaway DB only).
#
# Boots a disposable postgres:16 container, installs the same hosted-like auth
# shim run_rls_tests.sh uses, applies every migration in order, then drives
# N parallel sessions (psycopg, one connection per worker) against
#   reserve_analysis_permit / apply_synced_shot / shots_record_free_rating_ledger
#   / the auth.users -> profiles deletion cascade
# under READ COMMITTED (production: PostgREST default) and SERIALIZABLE, with
# REPEATABLE READ recorded as an observation. Every scenario runs from a
# recorded seed; every invariant violation (and every round that saw a deadlock
# or shot.write_failed) is written out as a self-contained replay script —
# fixture SQL verbatim, one psql per worker launched together — next to the
# JSON result table (--repro-all writes one for every round).
#
# Usage:
#   ./supabase/tests/concurrency/run_concurrency_matrix.sh [--workers N] [--rounds N] [--seed N]
#       [--isolation read_committed|serializable|repeatable_read]... [--scenario NAME]... [--repro-all]
#   CONCURRENCY_PG_URL=postgresql://... ./supabase/tests/concurrency/run_concurrency_matrix.sh --no-docker
#
# Deterministic two-session repros of the anomalies the matrix surfaced live in
# ./repro/ (PGURL=<throwaway> bash supabase/tests/concurrency/repro/<name>.sh).
#
# Artifacts: artifacts/concurrency-matrix/<run-id>/{results.json,matrix.md,matrix.log,
#            harness.log,migrate.log,postgres.log,heap.json,repro/*.sh}
#
# Note: the plain postgres:16 image has no pg_cron; the sweep_vs_sync scenario
# runs the sweep UPDATE the cron job would run, it does not exercise pg_cron.
#
# Exit code: 0 only when no invariant was violated under a production isolation
# level. Never points at a hosted Supabase project.
set -euo pipefail

cd "$(dirname "$0")/../../.."
ROOT=$(pwd)
RUN_ID=${CONCURRENCY_RUN_ID:-$(date -u +%Y%m%dT%H%M%SZ)}
OUT_DIR="$ROOT/artifacts/concurrency-matrix/$RUN_ID"
mkdir -p "$OUT_DIR"

USE_DOCKER=1
PY_ARGS=()
for arg in "$@"; do
  case "$arg" in
    --no-docker) USE_DOCKER=0 ;;
    *) PY_ARGS+=("$arg") ;;
  esac
done

CONTAINER="pickle_concurrency_pg_$$"
HOST_PORT=${CONCURRENCY_PG_PORT:-55433}

container_exists() {
  docker container inspect "$CONTAINER" >/dev/null 2>&1
}

cleanup() {
  if [[ $USE_DOCKER -eq 1 ]] && container_exists; then
    docker logs "$CONTAINER" > "$OUT_DIR/postgres.log" 2>&1
    docker rm -f "$CONTAINER" >/dev/null
  fi
}
trap cleanup EXIT

if [[ $USE_DOCKER -eq 1 ]]; then
  command -v docker >/dev/null || { echo "docker is required (or pass --no-docker with CONCURRENCY_PG_URL)"; exit 2; }
  if container_exists; then docker rm -f "$CONTAINER" >/dev/null; fi
  docker run -d --name "$CONTAINER" -e POSTGRES_PASSWORD=pg -p "$HOST_PORT:5432" postgres:16 \
    -c max_connections=300 -c deadlock_timeout=200ms -c log_lock_waits=on >/dev/null
  ready=0
  for _ in $(seq 1 60); do
    if docker exec "$CONTAINER" pg_isready -U postgres >/dev/null 2>&1; then ready=1; break; fi
    sleep 1
  done
  if [[ $ready -ne 1 ]]; then echo "postgres did not become ready"; exit 3; fi
  # Applying the shim + migrations through the container's own psql keeps this
  # identical to run_rls_tests.sh (ON_ERROR_STOP, one file at a time).
  docker cp "$ROOT/supabase/migrations" "$CONTAINER:/migrations"
  docker cp "$ROOT/supabase/tests" "$CONTAINER:/tests"
  docker exec "$CONTAINER" bash -c '
    set -euo pipefail
    psql -U postgres -v ON_ERROR_STOP=1 -q -f /tests/shim_auth.sql
    for f in /migrations/*.sql; do
      psql -U postgres -v ON_ERROR_STOP=1 -q -f "$f"
    done
  ' > "$OUT_DIR/migrate.log" 2>&1
  export CONCURRENCY_PG_URL="postgresql://postgres:pg@127.0.0.1:$HOST_PORT/postgres"
else
  : "${CONCURRENCY_PG_URL:?CONCURRENCY_PG_URL must point at a THROWAWAY database with migrations applied}"
fi

case "$CONCURRENCY_PG_URL" in
  *supabase.co*|*ucqnaiwqwjtgvlduiuib*)
    echo "refusing to run against a hosted Supabase URL"; exit 2 ;;
esac

VENV="$ROOT/artifacts/concurrency-matrix/.venv"
if [[ ! -x "$VENV/bin/python" ]]; then
  python3 -m venv "$VENV"
  "$VENV/bin/pip" install -q 'psycopg[binary]==3.2.9'
fi

set +e
"$VENV/bin/python" "$ROOT/supabase/tests/concurrency/matrix.py" \
  --out-dir "$OUT_DIR" "${PY_ARGS[@]}" 2>&1 | tee "$OUT_DIR/harness.log"
status=${PIPESTATUS[0]}
set -e
echo "artifacts: $OUT_DIR"
exit "$status"
