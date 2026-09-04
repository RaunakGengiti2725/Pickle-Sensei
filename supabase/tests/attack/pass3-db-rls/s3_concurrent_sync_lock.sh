#!/usr/bin/env bash
# S3: two concurrent psql sessions as Alice sync two DIFFERENT reserved permits
# while lifetime_scored_count() = 1. Exactly one must be 'accepted' and the
# other 'access.paywall_required'; the account must end with 2 scored shots.
#
# Requires a superuser connection via PGHOST/PGPORT/PGUSER/PGPASSWORD to a
# server that has database $TEMPLATE_DB (shim + all migrations applied; see
# run_attack.sh). Each round uses a fresh database cloned from the template.
#
#   round 1      : deterministic interleave — session A holds the lock 3 s
#                  after its sync, session B starts 1 s later and must wait.
#   rounds 2..N  : both sessions fire at once with seeded random jitter.
# Exit 0 = HELD, 1 = BROKEN.
set -uo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
ART=${ATTACK_ARTIFACTS:-"$HERE/artifacts"}
mkdir -p "$ART"
TEMPLATE_DB=${TEMPLATE_DB:-attack_base}
ROUNDS=${ROUNDS:-6}
SEED=${SEED:-20260904}
RANDOM=$SEED
echo "S3: seed=$SEED rounds=$ROUNDS template=$TEMPLATE_DB"

ALICE=00000000-0000-4000-8000-00000000000a
P_FIRST=00000000-0000-4000-8000-0000000000a1
P_A=00000000-0000-4000-8000-0000000000a2
P_B=00000000-0000-4000-8000-0000000000a3
S_FIRST=00000000-0000-4000-8000-0000000000e1
S_A=00000000-0000-4000-8000-0000000000e2
S_B=00000000-0000-4000-8000-0000000000e3

broken=0
for round in $(seq 1 "$ROUNDS"); do
  DB="s3_round_${round}"
  psql -d postgres -qc "drop database if exists $DB" -c "create database $DB template $TEMPLATE_DB" >/dev/null
  psql -d "$DB" -q -v ON_ERROR_STOP=1 -f "$HERE/_seed_alice.sql" >/dev/null

  # lifetime = 1: reserve + sync the first scored shot.
  psql -d "$DB" -q -v ON_ERROR_STOP=1 -c \
    "insert into public.analysis_permits (id, user_id, idempotency_key) values ('$P_FIRST', '$ALICE', 'first')"
  first=$(psql -d "$DB" -qtA -v ON_ERROR_STOP=1 -v permit="$P_FIRST" -v shot="$S_FIRST" -v presleep=0 -v postsleep=0 -f "$HERE/_sync_one.sql")
  case "$first" in *accepted) ;; *) echo "S3 round $round: setup sync failed: $first"; exit 1;; esac
  lifetime=$(psql -d "$DB" -qtA -c "begin; set local role authenticated; set local request.jwt.claim.sub='$ALICE'; select public.lifetime_scored_count(); rollback;" | sed -n 1p)
  [ "$lifetime" = "1" ] || { echo "S3 round $round: lifetime_scored_count()=$lifetime, expected 1"; exit 1; }

  # Two DIFFERENT reserved permits (the second is the over-issued artifact a
  # lost reserve race leaves behind; reserve_analysis_permit would refuse it).
  psql -d "$DB" -q -v ON_ERROR_STOP=1 -c \
    "insert into public.analysis_permits (id, user_id, idempotency_key) values ('$P_A', '$ALICE', 'race-a'), ('$P_B', '$ALICE', 'race-b')"

  if [ "$round" -eq 1 ]; then
    pre_a=0; post_a=3; pre_b=1; post_b=0
  else
    pre_a=$(awk -v r=$RANDOM 'BEGIN{printf "%.3f", (r%50)/1000}')
    pre_b=$(awk -v r=$RANDOM 'BEGIN{printf "%.3f", (r%50)/1000}')
    post_a=$(awk -v r=$RANDOM 'BEGIN{printf "%.3f", (r%300)/1000}')
    post_b=$(awk -v r=$RANDOM 'BEGIN{printf "%.3f", (r%300)/1000}')
  fi
  echo "S3 round $round: pre_a=$pre_a post_a=$post_a pre_b=$pre_b post_b=$post_b"

  psql -d "$DB" -qtA -v ON_ERROR_STOP=1 -v permit="$P_A" -v shot="$S_A" -v presleep="$pre_a" -v postsleep="$post_a" -f "$HERE/_sync_one.sql" >"$ART/s3_r${round}_a.out" 2>&1 &
  pa=$!
  psql -d "$DB" -qtA -v ON_ERROR_STOP=1 -v permit="$P_B" -v shot="$S_B" -v presleep="$pre_b" -v postsleep="$post_b" -f "$HERE/_sync_one.sql" >"$ART/s3_r${round}_b.out" 2>&1 &
  pb=$!
  wait $pa; ra=$?
  wait $pb; rb=$?
  out_a=$(grep '^SYNC' "$ART/s3_r${round}_a.out" | awk '{print $3}')
  out_b=$(grep '^SYNC' "$ART/s3_r${round}_b.out" | awk '{print $3}')
  echo "S3 round $round: A exit=$ra result=$out_a | B exit=$rb result=$out_b"

  scored=$(psql -d "$DB" -qtA -c "select count(*) from public.shots where user_id='$ALICE' and result_kind='scored'")
  ledger=$(psql -d "$DB" -qtA -c "select coalesce(max(scored_count),-1) from public.free_rating_ledger")
  permits=$(psql -d "$DB" -qtA -c "select string_agg(idempotency_key||':'||status||':'||coalesce(outcome,'-'), ',' order by idempotency_key) from public.analysis_permits where user_id='$ALICE'")
  echo "S3 round $round: scored_shots=$scored ledger_max=$ledger permits=$permits"

  accepted=0; paywall=0
  for r in "$out_a" "$out_b"; do
    [ "$r" = "accepted" ] && accepted=$((accepted+1))
    [ "$r" = "access.paywall_required" ] && paywall=$((paywall+1))
  done
  if [ "$ra" -ne 0 ] || [ "$rb" -ne 0 ] || [ "$accepted" -ne 1 ] || [ "$paywall" -ne 1 ] || [ "$scored" != "2" ] || [ "$ledger" != "2" ]; then
    echo "RESULT S3 round $round: BROKEN accepted=$accepted paywall=$paywall scored=$scored ledger=$ledger"
    broken=1
  else
    echo "RESULT S3 round $round: HELD exactly one accepted, one access.paywall_required, 2 scored shots"
  fi
  psql -d postgres -qc "drop database $DB" >/dev/null
done

if [ "$broken" -ne 0 ]; then
  echo "RESULT S3: BROKEN"
  exit 1
fi
echo "RESULT S3: HELD across $ROUNDS rounds (seed $SEED)"
