#!/usr/bin/env bash
# Disposable Postgres for the access/permit stress harness — the same shape as
# supabase/tests/run_rls_tests.sh (postgres:16 + shim_auth.sql + every
# migration in lexical order), published on a host port so N independent
# client connections contend on the RPCs' per-user advisory locks for real.
#
#   ./supabase/tests/stress/db_up.sh         # start (idempotent), prints STRESS_PG_URL
#   ./supabase/tests/stress/db_up.sh down    # remove the container
#
# Delegates to supabase/functions/api/__wf__/xc_pg_up.sh with its own container
# name and port (5499 by default) so it never collides with the xc-matrix run.
# Never points at a hosted project.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
export XC_PG_CONTAINER=${STRESS_PG_CONTAINER:-pickle-stress-pg}
export XC_PG_PORT=${STRESS_PG_PORT:-5499}

if [ "${1:-up}" = "down" ]; then
  exec "$ROOT/supabase/functions/api/__wf__/xc_pg_up.sh" down
fi

"$ROOT/supabase/functions/api/__wf__/xc_pg_up.sh" | sed 's/^XC_PG_URL=/STRESS_PG_URL=/'
