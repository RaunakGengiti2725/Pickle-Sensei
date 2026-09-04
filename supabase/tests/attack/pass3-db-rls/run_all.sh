#!/usr/bin/env bash
# Adversarial pass 3 — db-rls-grants-isolation (cloud/Linux plane).
#
# Builds a template database (`attack_base`) exactly like run_rls_tests.sh
# does — tests/shim_auth.sql, then every migration in order — on an existing
# throwaway PostgreSQL 16 server, then runs every scenario against a fresh
# clone. Never point this at a real project: it needs superuser and creates /
# drops databases.
#
#   PGHOST=127.0.0.1 PGPORT=55432 PGUSER=postgres PGPASSWORD=pg \
#   ATTACK_ARTIFACTS=/tmp/attack supabase/tests/attack/pass3-db-rls/run_all.sh
#
# Each scenario prints RESULT lines; a scenario exits non-zero when a BROKEN
# assertion fires. S1 and S11 are EXPECTED to report BROKEN on 4d812e1a (they
# are the two findings of this pass); the runner records every verdict and
# exits 0 only when each scenario matched its expected verdict, so a future
# fix flips the expectation here rather than silently passing.
set -uo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
SUPABASE_DIR=$(cd "$HERE/../../.." && pwd)
export ATTACK_ARTIFACTS=${ATTACK_ARTIFACTS:-"$HERE/artifacts"}
mkdir -p "$ATTACK_ARTIFACTS"
TEMPLATE_DB=${TEMPLATE_DB:-attack_base}
export TEMPLATE_DB

echo "== building template $TEMPLATE_DB from shim + $(ls "$SUPABASE_DIR"/migrations/*.sql | wc -l) migrations"
psql -d postgres -qc "drop database if exists $TEMPLATE_DB" -c "create database $TEMPLATE_DB" || exit 1
psql -d "$TEMPLATE_DB" -q -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/tests/shim_auth.sql" || exit 1
for f in "$SUPABASE_DIR"/migrations/*.sql; do
  psql -d "$TEMPLATE_DB" -q -v ON_ERROR_STOP=1 -f "$f" || { echo "migration failed: $f"; exit 1; }
done

# name | kind | expected verdict
SCENARIOS=(
  "s1_trigger_depth_passthrough.sql|sql|BROKEN"
  "s2_docker_stub_fallback.sh|sh|HELD"
  "s3_concurrent_sync_lock.sh|sh|HELD"
  "s4_cross_provider_identity.sql|sql|HELD"
  "s5_cascade_vs_for_update.sh|sh|HELD"
  "s6_expired_entitlement.sql|sql|HELD"
  "s7_identity_max_plus_one.sql|sql|HELD"
  "s8_sweep_index_100k.sql|sql|HELD"
  "s9_anon_count_functions.sql|sql|HELD"
  "s10_concurrent_reserve.sh|sh|HELD"
  "s11_concurrent_same_shot_replay.sh|sh|BROKEN"
)

fail=0
for entry in "${SCENARIOS[@]}"; do
  IFS='|' read -r name kind expected <<<"$entry"
  id=${name%%_*}
  log="$ATTACK_ARTIFACTS/$id.log"
  if [ "$kind" = sql ]; then
    psql -d postgres -qc "drop database if exists $id" -c "create database $id template $TEMPLATE_DB" >/dev/null || { echo "clone failed for $id"; fail=1; continue; }
    psql -d "$id" -v ON_ERROR_STOP=1 -f "$HERE/$name" >"$log" 2>&1
    rc=$?
    psql -d postgres -qc "drop database if exists $id" >/dev/null
  else
    "$HERE/$name" >"$log" 2>&1
    rc=$?
  fi
  # SQL scenarios: BROKEN is reported through RESULT lines (the script itself
  # exits 0 so every probe runs); shell scenarios exit 1 on BROKEN.
  if grep -q "BROKEN" "$log"; then verdict=BROKEN; else verdict=HELD; fi
  if [ "$rc" -ne 0 ] && [ "$verdict" = HELD ]; then verdict="ERROR(exit $rc)"; fi
  printf '%-40s exit=%-3s verdict=%-7s expected=%s  log=%s\n' "$name" "$rc" "$verdict" "$expected" "$log"
  grep -E '^(psql:[^ ]+ NOTICE:  )?RESULT ' "$log" | sed 's/^psql:[^ ]* NOTICE:  //; s/^/    /'
  [ "$verdict" = "$expected" ] || fail=1
done

if [ "$fail" -ne 0 ]; then
  echo "PASS3 DB-RLS: at least one scenario did not match its expected verdict"
  exit 1
fi
echo "PASS3 DB-RLS: all ${#SCENARIOS[@]} scenarios matched expected verdicts (S1, S11 BROKEN; rest HELD)"
