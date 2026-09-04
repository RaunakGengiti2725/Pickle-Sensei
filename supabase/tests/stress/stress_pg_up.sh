#!/usr/bin/env bash
# Disposable postgres:16 for the supabase/tests/stress harnesses: shim_auth.sql
# + every supabase/migrations/*.sql in order, published on 127.0.0.1:5499.
# Thin wrapper over the existing __wf__/xc_pg_up.sh (same image, same shim,
# same migration order) so the two DB-backed suites cannot drift.
#
#   ./stress_pg_up.sh                 # prints STRESS_PG_URL=...
#   STRESS_PG_PORT=5500 ./stress_pg_up.sh
#   ./stress_pg_up.sh down            # tear down
set -euo pipefail
cd "$(dirname "$0")/../../.."
export XC_PG_CONTAINER="${STRESS_PG_CONTAINER:-pickle-stress-pg}"
export XC_PG_PORT="${STRESS_PG_PORT:-5499}"
./supabase/functions/api/__wf__/xc_pg_up.sh "$@" | sed 's/^XC_PG_URL=/STRESS_PG_URL=/'
