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
export PATH="/opt/homebrew/bin:$PATH"
export LC_ALL="${LC_ALL:-C}"
unset PGHOST PGHOSTADDR PGPORT PGDATABASE PGUSER PGSERVICE PGSERVICEFILE PGOPTIONS

if [[ $# -ne 0 ]]; then
  echo "This runner accepts no database target; it only creates disposable scratch databases." >&2
  exit 2
fi
if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 is required for the independent-connection quota tests." >&2
  exit 1
fi

WORK=$(mktemp -d /tmp/pickle-rls.XXXXXXXX)
PGDATA="$WORK/data"
DB="pickle_rls_${WORK##*.}"
CONTAINER_ID=""
PSQL_ROOT=""
cleanup() {
  status=$?
  trap - EXIT INT TERM
  if [[ -n "$CONTAINER_ID" ]]; then
    if ! docker rm -f "$CONTAINER_ID" >/dev/null; then
      echo "CLEANUP FAILED: retained scratch container $CONTAINER_ID and $WORK" >&2
      exit 1
    fi
    echo "CLEANUP: removed newly created container $CONTAINER_ID"
  elif [[ -d "$PGDATA" ]] && pg_ctl -D "$PGDATA" status >/dev/null 2>&1; then
    if ! pg_ctl -D "$PGDATA" -w stop -m fast >/dev/null; then
      echo "CLEANUP FAILED: retained scratch cluster $WORK" >&2
      exit 1
    fi
    echo "CLEANUP: stopped socket-only scratch cluster $WORK"
  fi
  if [[ "$status" -ne 0 ]]; then
    echo "FAILED RUN: retained scratch logs and data at $WORK" >&2
    exit "$status"
  fi
  if [[ "$WORK" == /tmp/pickle-rls.???????? && -d "$WORK" && ! -L "$WORK" && "$DB" == "pickle_rls_${WORK##*.}" ]]; then
    rm -r -- "$WORK"
    echo "CLEANUP: removed scratch database $DB and directory $WORK"
  else
    echo "CLEANUP FAILED: refusing unexpected scratch path $WORK" >&2
    exit 1
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  CONTAINER_ID=$(docker create --name "pickle-rls-${WORK##*.}" \
    --label "pickle.rls-scratch=$DB" -e POSTGRES_PASSWORD=pg -e "POSTGRES_DB=$DB" postgres:16)
  docker start "$CONTAINER_ID" >/dev/null
  ready=0
  for _ in $(seq 1 30); do
    if docker exec "$CONTAINER_ID" pg_isready -U postgres -d "$DB" >/dev/null 2>&1; then
      ready=1
      break
    fi
    sleep 1
  done
  if [[ "$ready" -ne 1 ]]; then
    echo "Scratch container did not become ready." >&2
    exit 1
  fi
  docker cp tests "$CONTAINER_ID":/tests
  docker cp migrations "$CONTAINER_ID":/migrations
  PSQL_ROOT="/"
  run_psql() { docker exec -i "$CONTAINER_ID" psql -X -w -h /var/run/postgresql -p 5432 -U postgres -d "$DB" "$@"; }
  RACE_TARGET=(--container "$CONTAINER_ID")
else
  if ! command -v initdb >/dev/null 2>&1 || ! command -v pg_ctl >/dev/null 2>&1 || ! command -v psql >/dev/null 2>&1; then
    echo "Neither Docker nor a local Postgres toolchain (initdb/pg_ctl/psql) is available." >&2
    exit 1
  fi
  initdb -D "$PGDATA" -U postgres --auth=trust --encoding=UTF8 >/dev/null
# Unix socket only, in a private dir — never collides with a running server.
  pg_ctl -D "$PGDATA" -w -o "-k $WORK -c listen_addresses=''" -l "$WORK/pg.log" start >/dev/null
  psql -X -w -h "$WORK" -p 5432 -U postgres -d postgres -v ON_ERROR_STOP=1 -q -c "create database \"$DB\""
  run_psql() { psql -X -w -h "$WORK" -p 5432 -U postgres -d "$DB" "$@"; }
  RACE_TARGET=(--socket "$WORK")
fi

echo "SCRATCH TARGET: $DB ($WORK)"
run_psql -v ON_ERROR_STOP=1 -q -f "${PSQL_ROOT}tests/shim_auth.sql"
for f in migrations/*.sql; do
  echo "applying $f"
  run_psql -v ON_ERROR_STOP=1 -q -f "${PSQL_ROOT}$f"
done
run_psql -v ON_ERROR_STOP=1 -f "${PSQL_ROOT}tests/security_regression.sql"
python3 tests/quota_concurrency.py "${RACE_TARGET[@]}" --database "$DB"
