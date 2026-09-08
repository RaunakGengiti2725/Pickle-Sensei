#!/usr/bin/env bash
# W07-03 adversarial harness: build a fresh database (shim + every migration in
# order) inside an already running postgres:16 container and run the attack
# probes in supabase/tests/w07_03_attack/*.sql against it.
#
#   docker run -d --name w07-attack-pg -e POSTGRES_PASSWORD=pg postgres:16
#   PG_CONTAINER=w07-attack-pg ./supabase/tests/w07_03_attack/run.sh
#
# Each probe file runs in its own psql invocation with ON_ERROR_STOP so a
# `raise exception` inside a probe is a non-zero exit for that probe. The
# script prints one PASS/FAIL line per probe and exits non-zero when any probe
# raised (a raised probe is a CONFIRMED BREAK unless the probe says otherwise).
set -uo pipefail

cd "$(dirname "$0")/../.."

CONTAINER="${PG_CONTAINER:-w07-attack-pg}"
DATABASE="${W07_ATTACK_DB:-w07_attack_$(date +%s)}"

run_psql() {
  docker exec -i "$CONTAINER" psql -U postgres -X "$@"
}

run_psql -d postgres -v ON_ERROR_STOP=1 -q -c "create database $DATABASE;"
run_psql -d "$DATABASE" -v ON_ERROR_STOP=1 -q -f - < tests/shim_auth.sql
for file in migrations/*.sql; do
  run_psql -d "$DATABASE" -v ON_ERROR_STOP=1 -q -f - < "$file" || {
    echo "migration failed: $file" >&2
    exit 2
  }
done

status=0
executed=0
failed=0
for probe in tests/w07_03_attack/attack_*.sql; do
  executed=$((executed + 1))
  if run_psql -d "$DATABASE" -v ON_ERROR_STOP=1 -f - < "$probe"; then
    printf 'PASS %s\n' "$probe"
  else
    printf 'FAIL %s\n' "$probe"
    failed=$((failed + 1))
    status=1
  fi
done
printf 'W07-03 attack probes: executed=%s passed=%s failed=%s database=%s\n' \
  "$executed" "$((executed - failed))" "$failed" "$DATABASE"
exit "$status"
