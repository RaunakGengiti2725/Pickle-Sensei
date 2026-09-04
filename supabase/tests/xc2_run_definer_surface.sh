#!/usr/bin/env bash
# Cross-user isolation audit #2 — SECURITY DEFINER / RPC parameter surface.
#
#   ./supabase/tests/xc2_run_definer_surface.sh [ARTIFACT_DIR]
#
# Same bootstrap as run_rls_tests.sh (throwaway postgres:16 in Docker, or a
# local initdb cluster when Docker is absent): install the Supabase shim,
# apply every migration in order, then run xc2_definer_surface.sql. Writes
# three JSON artifacts + the full psql transcript into ARTIFACT_DIR (default
# artifacts/xc2-definer-surface/<utc-timestamp>/):
#   results.json      every deterministic case {case, passed, detail}
#   fuzz.json         every fuzz iteration {seed, iteration, mutation,
#                     payload, result, sqlstate, passed, problems} — a failure
#                     is replayed by feeding its payload back to the RPC as
#                     the attacker
#   fuzz_matrix.json  mutation × result-code counts
#   psql.log          the transcript
# Exits non-zero when any case fails or the bootstrap cannot run. Never
# touches a hosted Supabase project.
set -euo pipefail

cd "$(dirname "$0")/.."

ARTIFACT_DIR=${1:-artifacts/xc2-definer-surface/$(date -u +%Y%m%dT%H%M%SZ)}
mkdir -p "$ARTIFACT_DIR"
ARTIFACT_DIR=$(cd "$ARTIFACT_DIR" && pwd)
LOG="$ARTIFACT_DIR/psql.log"

if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  CONTAINER=pickle-xc2-definer-test
  cleanup() {
    if docker ps -a --format '{{.Names}}' | grep -qx "$CONTAINER"; then
      docker rm -f "$CONTAINER" >/dev/null
    fi
  }
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

  docker cp tests "$CONTAINER":/tests
  docker cp migrations "$CONTAINER":/migrations

  status=0
  docker exec "$CONTAINER" bash -c '
    set -euo pipefail
    psql -U postgres -v ON_ERROR_STOP=1 -q -f /tests/shim_auth.sql
    for f in /migrations/*.sql; do
      echo "applying $f"
      psql -U postgres -v ON_ERROR_STOP=1 -q -f "$f"
    done
    psql -U postgres -v ON_ERROR_STOP=1 -f /tests/xc2_definer_surface.sql
  ' 2>&1 | tee "$LOG" || status=$?

  for f in results fuzz fuzz_matrix; do
    if ! docker cp "$CONTAINER":/tmp/xc2_definer_${f}.json "$ARTIFACT_DIR/${f}.json" >/dev/null 2>&1; then
      echo "artifact ${f}.json was not produced (the script aborted before its \\copy)" >&2
      [ "$status" -ne 0 ] || status=3
    fi
  done
  echo "artifacts: $ARTIFACT_DIR"
  exit "$status"
fi

if ! command -v initdb >/dev/null 2>&1 || ! command -v pg_ctl >/dev/null 2>&1; then
  echo "Neither Docker nor a local Postgres toolchain (initdb/pg_ctl) is available." >&2
  exit 1
fi

WORK=$(mktemp -d)
PGDATA="$WORK/data"
cleanup() {
  if pg_ctl -D "$PGDATA" status >/dev/null 2>&1; then
    pg_ctl -D "$PGDATA" stop -m immediate >/dev/null 2>&1
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT

initdb -D "$PGDATA" -U postgres --auth=trust >/dev/null
pg_ctl -D "$PGDATA" -o "-k $WORK -c listen_addresses=''" -l "$WORK/pg.log" start >/dev/null

run_psql() { psql -h "$WORK" -U postgres -d postgres "$@"; }
run_psql -v ON_ERROR_STOP=1 -q -f tests/shim_auth.sql
for f in migrations/*.sql; do
  echo "applying $f"
  run_psql -v ON_ERROR_STOP=1 -q -f "$f"
done
status=0
run_psql -v ON_ERROR_STOP=1 -f tests/xc2_definer_surface.sql 2>&1 | tee "$LOG" || status=$?
for f in results fuzz fuzz_matrix; do
  if [ -f "/tmp/xc2_definer_${f}.json" ]; then
    mv "/tmp/xc2_definer_${f}.json" "$ARTIFACT_DIR/${f}.json"
  else
    echo "artifact ${f}.json was not produced (the script aborted before its \\copy)" >&2
    [ "$status" -ne 0 ] || status=3
  fi
done
echo "artifacts: $ARTIFACT_DIR"
exit "$status"
