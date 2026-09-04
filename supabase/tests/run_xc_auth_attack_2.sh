#!/usr/bin/env bash
# xc-security-auth-attack-2 — run the DB-plane client-identity attack matrix
# (tests/xc_auth_attack_2_client_identity.sql) against a throwaway Postgres.
#
#   ./supabase/tests/run_xc_auth_attack_2.sh            # Docker postgres:16
#
# Same bring-up as run_rls_tests.sh (shim → every migration in order), then
# the attack matrix instead of the regression matrix. Exits non-zero on ANY
# case that lets a client-supplied identity become authoritative. New file:
# run_rls_tests.sh and security_regression.sql are untouched.
set -euo pipefail

cd "$(dirname "$0")/.."

if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  CONTAINER=pickle-xc-auth-attack-2
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

  docker exec "$CONTAINER" bash -c '
    set -euo pipefail
    psql -U postgres -v ON_ERROR_STOP=1 -q -f /tests/shim_auth.sql
    for f in /migrations/*.sql; do
      echo "applying $f"
      psql -U postgres -v ON_ERROR_STOP=1 -q -f "$f"
    done
    psql -U postgres -v ON_ERROR_STOP=1 -f /tests/xc_auth_attack_2_client_identity.sql
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
  if pg_ctl -D "$PGDATA" status >/dev/null 2>&1; then
    pg_ctl -D "$PGDATA" stop -m immediate >/dev/null
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
run_psql -v ON_ERROR_STOP=1 -f tests/xc_auth_attack_2_client_identity.sql
