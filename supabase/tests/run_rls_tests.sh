#!/usr/bin/env bash
# Run the Supabase security regression matrix against a throwaway Postgres.
#
#   ./supabase/tests/run_rls_tests.sh
#
# Prefers postgres:16 in Docker (CI); falls back to a throwaway local cluster
# via initdb/pg_ctl when Docker is unavailable (macOS dev boxes). Either way:
# install the minimal Supabase shim (auth schema + roles + hosted-like default
# privileges), apply every migration in order, then run
# security_regression.sql. Exits non-zero on ANY boundary regression.
set -euo pipefail

cd "$(dirname "$0")/.."

if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  CONTAINER=pickle-rls-test
  cleanup() { docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; }
  trap cleanup EXIT
  cleanup

  docker run -d --name "$CONTAINER" -e POSTGRES_PASSWORD=pg postgres:16 >/dev/null
  # The image's entrypoint first runs a bootstrap server that answers on the
  # unix socket only, then restarts it for real; probe over TCP so we do not
  # attach during that window.
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
    psql -U postgres -v ON_ERROR_STOP=1 -f /tests/security_regression.sql
  '
  exit 0
fi

if ! command -v initdb >/dev/null 2>&1 || ! command -v pg_ctl >/dev/null 2>&1; then
  echo "Neither Docker nor a local Postgres toolchain (initdb/pg_ctl) is available." >&2
  exit 1
fi

WORK=$(mktemp -d)
PGDATA="$WORK/data"
cleanup() {
  pg_ctl -D "$PGDATA" stop -m immediate >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

initdb -D "$PGDATA" -U postgres --auth=trust >/dev/null
# Unix socket only, in a private dir — never collides with a running server.
pg_ctl -D "$PGDATA" -o "-k $WORK -c listen_addresses=''" -l "$WORK/pg.log" start >/dev/null

run_psql() { psql -h "$WORK" -U postgres -d postgres "$@"; }
run_psql -v ON_ERROR_STOP=1 -q -f tests/shim_auth.sql
for f in migrations/*.sql; do
  echo "applying $f"
  run_psql -v ON_ERROR_STOP=1 -q -f "$f"
done
run_psql -v ON_ERROR_STOP=1 -f tests/security_regression.sql
