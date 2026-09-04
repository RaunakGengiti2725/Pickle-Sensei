#!/usr/bin/env bash
# S10 (own scenario): three concurrent reserve_analysis_permit() calls with
# DIFFERENT idempotency keys from a fresh account (2 free ratings left) must
# yield exactly 2 accepted + 1 access.paywall_required, and the table must hold
# exactly 2 reserved permits. Repeated ROUNDS times with seeded jitter.
# Exit 0 = HELD, 1 = BROKEN.
set -uo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
ART=${ATTACK_ARTIFACTS:-"$HERE/artifacts"}
mkdir -p "$ART"
TEMPLATE_DB=${TEMPLATE_DB:-attack_base}
ROUNDS=${ROUNDS:-5}
SEED=${SEED:-20260904}
RANDOM=$SEED
ALICE=00000000-0000-4000-8000-00000000000a
echo "S10: seed=$SEED rounds=$ROUNDS"

reserve() { # db key presleep outfile
  psql -d "$1" -qtA -v ON_ERROR_STOP=1 \
    -c "begin" -c "set local role authenticated" \
    -c "set local request.jwt.claim.sub = '$ALICE'" \
    -c "select pg_sleep($3)" \
    -c "select 'RESERVE $2 ' || result from public.reserve_analysis_permit('$2')" \
    -c "commit" >"$4" 2>&1
}

broken=0
for round in $(seq 1 "$ROUNDS"); do
  DB="s10_round_${round}"
  psql -d postgres -qc "drop database if exists $DB" -c "create database $DB template $TEMPLATE_DB" >/dev/null 2>&1
  psql -d "$DB" -q -v ON_ERROR_STOP=1 -f "$HERE/_seed_alice.sql" >/dev/null
  pids=()
  for k in 1 2 3; do
    j=$(awk -v r=$RANDOM 'BEGIN{printf "%.3f", (r%40)/1000}')
    reserve "$DB" "k$k" "$j" "$ART/s10_r${round}_k$k.out" &
    pids+=($!)
  done
  rc=0
  for p in "${pids[@]}"; do wait "$p" || rc=1; done
  results=$(cat "$ART"/s10_r${round}_k*.out | grep '^RESERVE' | awk '{print $3}' | sort | uniq -c | awk '{printf "%s=%s ", $2, $1}')
  accepted=$(cat "$ART"/s10_r${round}_k*.out | grep -c 'RESERVE k[0-9] accepted')
  paywall=$(cat "$ART"/s10_r${round}_k*.out | grep -c 'access.paywall_required')
  reserved=$(psql -d "$DB" -qtA -c "select count(*) from public.analysis_permits where user_id='$ALICE' and status='reserved'")
  echo "S10 round $round: psql_rc=$rc results: ${results}reserved_rows=$reserved"
  if [ "$rc" -eq 0 ] && [ "$accepted" -eq 2 ] && [ "$paywall" -eq 1 ] && [ "$reserved" = 2 ]; then
    echo "RESULT S10 round $round: HELD"
  else
    echo "RESULT S10 round $round: BROKEN"
    broken=1
  fi
  psql -d postgres -qc "drop database $DB" >/dev/null
done
if [ "$broken" -ne 0 ]; then echo "RESULT S10: BROKEN"; exit 1; fi
echo "RESULT S10: HELD across $ROUNDS rounds (seed $SEED)"
