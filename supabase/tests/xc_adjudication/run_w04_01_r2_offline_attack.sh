#!/usr/bin/env bash
# W04-01 round-2 adversarial SQL matrix on a disposable postgres:16 (shim +
# every migration, via supabase/functions/api/__wf__/xc_pg_up.sh). Exit 0 only
# when every attack HELD; a BROKEN attack is a non-zero exit (psql
# ON_ERROR_STOP). Set XC_PG_KEEP=1 to leave the container up (e.g. to run
# xc_pg_offline_grants_attack.test.ts against the same database).
#
#   ./supabase/tests/xc_adjudication/run_w04_01_r2_offline_attack.sh [log-path]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
LOG="${1:-$ROOT/artifacts/w04_01_r2_offline_attack.log}"
export XC_PG_CONTAINER="${XC_PG_CONTAINER:-pickle-w04-01-r2-attack-pg}"
export XC_PG_PORT="${XC_PG_PORT:-55435}"

mkdir -p "$(dirname "$LOG")"
"$ROOT/supabase/functions/api/__wf__/xc_pg_up.sh" >"$LOG.setup" 2>&1
if [ "${XC_PG_KEEP:-0}" != "1" ]; then
  trap '"$ROOT/supabase/functions/api/__wf__/xc_pg_up.sh" down' EXIT
fi

docker exec "$XC_PG_CONTAINER" mkdir -p /tests/xc_adjudication
docker cp "$ROOT/supabase/tests/xc_adjudication/w04_01_r2_offline_attack.sql" \
  "$XC_PG_CONTAINER":/tests/xc_adjudication/w04_01_r2_offline_attack.sql
set +e
docker exec "$XC_PG_CONTAINER" psql -U postgres -v ON_ERROR_STOP=1 \
  -f /tests/xc_adjudication/w04_01_r2_offline_attack.sql >"$LOG" 2>&1
status=$?
set -e
awk '/^ +R[0-9]+b? |held \| broken|^ +[0-9]+ \| +[0-9]+ \| +[0-9]+$|ERROR:/' "$LOG"
echo "w04_01_r2_offline_attack.sql exit=$status log=$LOG"
exit "$status"
