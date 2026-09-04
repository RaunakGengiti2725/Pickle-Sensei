#!/usr/bin/env bash
# db-rank boundary/malformed stress — one-shot runner.
#
#   supabase/tests/stress/run_db_rank_boundary_malformed.sh                # quick (STRESS_ITER=200)
#   STRESS_ITER=3200 STRESS_CONC_ROUNDS=12 STRESS_INTERLEAVE=10 \
#     supabase/tests/stress/run_db_rank_boundary_malformed.sh              # full campaign
#   STRESS_REPLAY=104 supabase/tests/stress/run_db_rank_boundary_malformed.sh   # replay one seed
#
# Starts a disposable postgres:16 on 127.0.0.1:5499 (pg_up.sh) unless
# STRESS_PG_URL is already set, runs the harness with the TS rank oracle
# (node --experimental-strip-types), and tears the container down unless
# STRESS_KEEP_PG=1. Exit code: 0 = every scenario HELD, 1 = at least one
# BROKEN, 2 = oracle import failed, 3 = harness crash.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"

if [ -z "${STRESS_PG_URL:-}" ]; then
  url_line="$("$HERE/pg_up.sh")"
  export STRESS_PG_URL="${url_line#STRESS_PG_URL=}"
  started=1
else
  started=0
fi

set +e
node --experimental-strip-types --no-warnings "$HERE/db_rank_boundary_malformed.mjs"
code=$?
set -e

if [ "$started" = 1 ] && [ "${STRESS_KEEP_PG:-0}" != 1 ]; then
  "$HERE/pg_up.sh" down
fi
exit "$code"
