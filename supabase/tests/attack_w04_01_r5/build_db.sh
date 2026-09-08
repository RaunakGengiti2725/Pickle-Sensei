#!/usr/bin/env bash
# Build a disposable database from the shim + every migration in
# supabase/migrations (fresh history) inside the postgres:16 container
# `pickle-attack`, then run the attack matrix against it.
#
#   ./supabase/tests/attack_w04_01_r5/build_db.sh [database name]
#
# The candidate's own security_regression.sql is NOT run here; run_rls_tests.sh
# owns that. This script only prepares the schema the attacks target.
set -euo pipefail

cd "$(dirname "$0")/../.."

CONTAINER="${PICKLE_ATTACK_CONTAINER:-pickle-attack}"
DB="${1:-pickle_attack_w04}"

run_psql() { docker exec -i "$CONTAINER" psql -U postgres "$@"; }

run_psql -d postgres -v ON_ERROR_STOP=1 -q -c "drop database if exists $DB;" -c "create database $DB;"
docker exec "$CONTAINER" rm -rf /tests /migrations
docker cp tests "$CONTAINER":/tests >/dev/null
docker cp migrations "$CONTAINER":/migrations >/dev/null
run_psql -d "$DB" -v ON_ERROR_STOP=1 -q -f /tests/shim_auth.sql
for file in migrations/*.sql; do
  name="${file##*/}"
  run_psql -d "$DB" -v ON_ERROR_STOP=1 -q -f "/migrations/$name"
done
printf 'built %s from %d migrations\n' "$DB" "$(ls migrations/*.sql | wc -l)"
