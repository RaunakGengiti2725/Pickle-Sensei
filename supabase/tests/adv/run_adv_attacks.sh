#!/usr/bin/env bash
# INT-backend-sql-rls adversary harness (attacks HEAD 30a4065036a917514fb4984fde73f87867f38619).
#
#   ./supabase/tests/adv/run_adv_attacks.sh            # every attack, every history
#   ./supabase/tests/adv/run_adv_attacks.sh adv_05     # only attacks matching a prefix
#
# Same throwaway-Postgres model as ../run_rls_tests.sh (Docker postgres:16 or a
# local initdb cluster), the same shim and the same four migration histories
# (fresh, production_20260906, upstream_20260906, ordered_20260907). Each
# attack file under this directory is self-contained (begin ... rollback, or
# cleans up after itself) and is run on its own psql invocation with
# ON_ERROR_STOP, so one broken boundary never hides another: every attack is
# executed against every history and the harness reports one PASS/FAIL line per
# (history, attack), a final tally, and exits non-zero if ANY attack failed.
# A FAIL is a confirmed break of the boundary the attack asserts.
set -uo pipefail

cd "$(dirname "$0")/../.."
FILTER="${1:-adv_}"

declare -a RESULTS=()
MIGRATION_LOG=$(mktemp)
PASSED=0
FAILED=0
EXECUTED=0

run_attacks() {
  local migration_root="$1" test_root="$2" socket_dir="$3"
  local history database phase file name version applied attack rc
  for history in fresh production_20260906 upstream_20260906 ordered_20260907; do
    database="pickle_adv_$history"
    printf '\n=== adversary history: %s ===\n' "$history"
    run_psql -d postgres -v ON_ERROR_STOP=1 -q -c "drop database if exists $database;" -c "create database $database;"
    run_psql -d "$database" -v ON_ERROR_STOP=1 -q -f "$test_root/shim_auth.sql"
    for phase in base pending; do
      for file in migrations/*.sql; do
        name="${file##*/}"
        version="${name%%_*}"
        applied=0
        case "$history" in
          production_20260906)
            if [[ "$version" < "20260902150000" || "$version" == "20260902150000" || "$version" == "20260905190106" ]]; then
              applied=1
            fi
            ;;
          upstream_20260906)
            if [[ ( "$version" < "20260907100000" || "$version" == "20260907100000" ) && "$version" != "20260905190106" && "$version" != "20260906233000" && "$version" != "20260907001500" ]]; then
              applied=1
            fi
            ;;
          ordered_20260907)
            if [[ "$version" < "20260902150000" || "$version" == "20260902150000" || "$version" == "20260905190106" || "$version" == "20260906233000" || "$version" == "20260907001500" ]]; then
              applied=1
            fi
            ;;
        esac
        if { [ "$phase" = base ] && [ "$applied" = 1 ]; } || { [ "$phase" = pending ] && [ "$applied" = 0 ]; }; then
          if ! run_psql -d "$database" -v ON_ERROR_STOP=1 -q -f "$migration_root/$name" >"$MIGRATION_LOG" 2>&1; then
            echo "MIGRATION FAILED ($history): $name" >&2
            cat "$MIGRATION_LOG" >&2
            exit 2
          fi
        fi
      done
    done
    for attack in tests/adv/${FILTER}*.sql; do
      [ -e "$attack" ] || continue
      name="${attack##*/}"
      printf -- '--- %s / %s\n' "$history" "$name"
      run_psql -d "$database" -v ON_ERROR_STOP=1 -v socket_dir="$socket_dir" -v dbname="$database" -f "$test_root/adv/$name"
      rc=$?
      EXECUTED=$((EXECUTED + 1))
      if [ "$rc" -eq 0 ]; then
        PASSED=$((PASSED + 1))
        RESULTS+=("PASS $history $name")
      else
        FAILED=$((FAILED + 1))
        RESULTS+=("FAIL $history $name (psql exit $rc)")
      fi
    done
  done
}

report() {
  printf '\n=== adversary tally ===\n'
  printf '%s\n' "${RESULTS[@]}"
  printf 'executed=%d passed=%d failed=%d skipped=0\n' "$EXECUTED" "$PASSED" "$FAILED"
  if [ "$EXECUTED" -eq 0 ]; then
    echo "no attack executed — that is not a pass" >&2
    exit 3
  fi
  [ "$FAILED" -eq 0 ]
}

if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  CONTAINER=pickle-adv-test
  cleanup() { docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; }
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

  run_psql() { docker exec "$CONTAINER" psql -U postgres "$@"; }
  run_attacks /migrations /tests /var/run/postgresql
  report
  exit $?
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
pg_ctl -D "$PGDATA" -o "-k $WORK -c listen_addresses=''" -l "$WORK/pg.log" start >/dev/null

run_psql() { psql -h "$WORK" -U postgres "$@"; }
run_attacks migrations tests "$WORK"
report
