#!/usr/bin/env bash
# S11 (own scenario): idempotent replay under concurrency. Two sessions as Alice
# sync the SAME shot id with the SAME reserved permit at the same time (the
# shape a client retry-after-timeout produces while the first request is still
# executing). apply_synced_shot()'s contract is that a replay of a shot the
# user already owns is 'accepted'; both calls must therefore end 'accepted'
# and exactly one shot row must exist.
#
#   order a : session 1 holds its transaction open 2 s after the sync so the
#             second call is guaranteed to arrive while the first is in flight.
#   order b : both fire together (seeded jitter), ROUNDS times.
# Exit 0 = HELD, 1 = BROKEN.
set -uo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
ART=${ATTACK_ARTIFACTS:-"$HERE/artifacts"}
mkdir -p "$ART"
TEMPLATE_DB=${TEMPLATE_DB:-attack_base}
ROUNDS=${ROUNDS:-4}
SEED=${SEED:-20260904}
RANDOM=$SEED
ALICE=00000000-0000-4000-8000-00000000000a
PERMIT=00000000-0000-4000-8000-0000000000a1
SHOT=00000000-0000-4000-8000-0000000000e1
echo "S11: seed=$SEED rounds=$ROUNDS"

broken=0
for round in $(seq 0 "$ROUNDS"); do
  DB="s11_round_${round}"
  psql -d postgres -qc "drop database if exists $DB" -c "create database $DB template $TEMPLATE_DB" >/dev/null 2>&1
  psql -d "$DB" -q -v ON_ERROR_STOP=1 -f "$HERE/_seed_alice.sql" >/dev/null
  psql -d "$DB" -q -v ON_ERROR_STOP=1 -c \
    "insert into public.analysis_permits (id, user_id, idempotency_key) values ('$PERMIT', '$ALICE', 'p1')"

  if [ "$round" -eq 0 ]; then
    pre1=0; post1=2; pre2=0.5; post2=0
  else
    pre1=$(awk -v r=$RANDOM 'BEGIN{printf "%.3f", (r%30)/1000}')
    pre2=$(awk -v r=$RANDOM 'BEGIN{printf "%.3f", (r%30)/1000}')
    post1=0; post2=0
  fi
  psql -d "$DB" -qtA -v permit="$PERMIT" -v shot="$SHOT" -v presleep="$pre1" -v postsleep="$post1" -f "$HERE/_sync_one.sql" >"$ART/s11_r${round}_1.out" 2>&1 &
  p1=$!
  psql -d "$DB" -qtA -v permit="$PERMIT" -v shot="$SHOT" -v presleep="$pre2" -v postsleep="$post2" -f "$HERE/_sync_one.sql" >"$ART/s11_r${round}_2.out" 2>&1 &
  p2=$!
  wait $p1; rc1=$?
  wait $p2; rc2=$?
  r1=$(grep '^SYNC' "$ART/s11_r${round}_1.out" | awk '{print $3}')
  r2=$(grep '^SYNC' "$ART/s11_r${round}_2.out" | awk '{print $3}')
  shots=$(psql -d "$DB" -qtA -c "select count(*) from public.shots where id='$SHOT' and user_id='$ALICE'")
  permit=$(psql -d "$DB" -qtA -c "select status||':'||coalesce(outcome,'-') from public.analysis_permits where id='$PERMIT'")
  echo "S11 round $round (pre1=$pre1 hold1=$post1 pre2=$pre2): s1=${r1:-<exit $rc1>} s2=${r2:-<exit $rc2>} shot_rows=$shots permit=$permit"
  if [ "$rc1" -eq 0 ] && [ "$rc2" -eq 0 ] && [ "$r1" = accepted ] && [ "$r2" = accepted ] && [ "$shots" = 1 ]; then
    echo "RESULT S11 round $round: HELD both calls accepted, one shot row"
  else
    echo "RESULT S11 round $round: BROKEN concurrent replay of an owned shot was not idempotent"
    broken=1
  fi
  psql -d postgres -qc "drop database $DB" >/dev/null
done

# Control: a SEQUENTIAL replay (second call after the first committed) is accepted.
DB=s11_sequential
psql -d postgres -qc "drop database if exists $DB" -c "create database $DB template $TEMPLATE_DB" >/dev/null 2>&1
psql -d "$DB" -q -v ON_ERROR_STOP=1 -f "$HERE/_seed_alice.sql" >/dev/null
psql -d "$DB" -q -v ON_ERROR_STOP=1 -c \
  "insert into public.analysis_permits (id, user_id, idempotency_key) values ('$PERMIT', '$ALICE', 'p1')"
r1=$(psql -d "$DB" -qtA -v permit="$PERMIT" -v shot="$SHOT" -v presleep=0 -v postsleep=0 -f "$HERE/_sync_one.sql" | awk '/^SYNC/{print $3}')
r2=$(psql -d "$DB" -qtA -v permit="$PERMIT" -v shot="$SHOT" -v presleep=0 -v postsleep=0 -f "$HERE/_sync_one.sql" | awk '/^SYNC/{print $3}')
echo "S11 sequential control: first=$r1 replay=$r2"
if [ "$r1" = accepted ] && [ "$r2" = accepted ]; then
  echo "RESULT S11 control: HELD sequential replay accepted"
else
  echo "RESULT S11 control: BROKEN"; broken=1
fi
psql -d postgres -qc "drop database $DB" >/dev/null

if [ "$broken" -ne 0 ]; then echo "RESULT S11: BROKEN"; exit 1; fi
echo "RESULT S11: HELD"
