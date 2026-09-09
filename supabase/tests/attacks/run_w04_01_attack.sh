#!/usr/bin/env bash
# W04-01 adversarial attack runner (candidate 77b5814e).
#
# Builds a disposable database (shim_auth.sql + every migration, like
# run_rls_tests.sh's fresh matrix) and runs w04_01_attack_77b5814e.sql
# WITHOUT ON_ERROR_STOP so every attack reports HELD or BREAK. Exit codes:
#   0  every attack HELD
#   1  at least one attack reported BREAK
#   2  the database could not be prepared
#
# Requires a reachable PostgreSQL superuser connection:
#   ATTACK_PG_HOST (127.0.0.1) ATTACK_PG_PORT (55433) ATTACK_PG_USER (postgres)
#   PGPASSWORD for that user. ATTACK_DB (w04_01_attack) is dropped and re-created.
# Never point this at a shared or production database.
set -uo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
host="${ATTACK_PG_HOST:-127.0.0.1}"
port="${ATTACK_PG_PORT:-55433}"
user="${ATTACK_PG_USER:-postgres}"
db="${ATTACK_DB:-w04_01_attack}"
log="${ATTACK_LOG:-/tmp/w04_01_attack.log}"

psql_admin() { psql -v ON_ERROR_STOP=1 -q -h "$host" -p "$port" -U "$user" "$@"; }

psql_admin -d postgres -c "drop database if exists \"$db\"" -c "create database \"$db\"" >/dev/null || exit 2
psql_admin -d "$db" -f "$repo_root/supabase/tests/shim_auth.sql" >/dev/null || exit 2
for migration in "$repo_root"/supabase/migrations/*.sql; do
  psql_admin -d "$db" -f "$migration" >/dev/null || { echo "migration failed: $migration"; exit 2; }
done

psql -h "$host" -p "$port" -U "$user" -d "$db" -f "$repo_root/supabase/tests/attacks/w04_01_attack_77b5814e.sql" 2>&1 | tee "$log"

if ! grep -q 'W04-01 ATTACK SUITE: DONE' "$log"; then
  echo "attack suite did not run to completion"
  exit 2
fi
held="$(grep -c '^ATTACK A[0-9]*.*: HELD$' "$log")"
broke="$(grep -c '^ATTACK A[0-9]*.*: BREAK' "$log")"
echo "W04-01 attacks: held=$held break=$broke"
[ "$broke" -eq 0 ]
