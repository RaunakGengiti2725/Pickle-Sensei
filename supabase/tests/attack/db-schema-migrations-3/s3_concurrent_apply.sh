#!/usr/bin/env bash
# S3 — two concurrent apply_synced_shot calls (two psql sessions) holding
# DISTINCT reserved permits while lifetime_scored_count()=1. Session A takes
# the per-user advisory lock first and sleeps inside its transaction so B is
# provably blocked on pg_advisory_xact_lock. Assert exactly one 'accepted',
# the other 'access.paywall_required' with its permit released/free_limit_exceeded.
# Then a seeded N-way stampede with no artificial ordering.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
DB=s3
fresh_db $DB
A=11111111-1111-1111-1111-111111111111
SUB=google-sub-alice@x.test
SEED=${ATTACK_SEED:-20260904}

as_alice() {
  dpsql $DB -Atq <<SQL
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '$A', true);
$1;
commit;
SQL
}
ledger() { dq $DB "select coalesce((select scored_count from public.free_rating_ledger where identity_hash = public.free_rating_identity_hash('google','$SUB')), 0)"; }

dq $DB "select attack.mk_user('$A', 'alice@x.test')" >/dev/null
as_alice "select result from public.reserve_analysis_permit('k1')" >/dev/null
P1=$(dq $DB "select id from public.analysis_permits where idempotency_key='k1'")
as_alice "select public.apply_synced_shot(attack.shot_json('aaaaaaaa-0000-0000-0000-000000000001', '$P1', 'scored', 7))" >/dev/null
assert_eq "precondition lifetime_scored_count()=1" "$(as_alice "select scored_count from public.access_state()" | tail -1)" "1"

# Two DISTINCT reserved permits. Only one can legitimately be reserved at
# count=1, so the second is forged directly (authenticated INSERT on own
# permits is granted — this is exactly the "extra permit" the backstop guards).
as_alice "select result from public.reserve_analysis_permit('k2')" >/dev/null
PA=$(dq $DB "select id from public.analysis_permits where idempotency_key='k2'")
PB=bbbbbbbb-0000-0000-0000-000000000002
as_alice "insert into public.analysis_permits (id, user_id, idempotency_key) values ('$PB', '$A', 'k3-forged')" >/dev/null
assert_eq "two reserved permits exist" "$(dq $DB "select count(*) from public.analysis_permits where user_id='$A' and status='reserved'")" "2"

SA=aaaaaaaa-0000-0000-0000-0000000000a1
SB=aaaaaaaa-0000-0000-0000-0000000000b2

# Session A: lock → sleep 3s → apply → commit.  Session B (starts 0.7s later): apply → blocks.
(
  dpsql $DB -Atq <<SQL
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '$A', true);
select pg_advisory_xact_lock(public.access_lock_key('$A'));
select 'A_locked_at=' || clock_timestamp();
select pg_sleep(3);
select 'A=' || public.apply_synced_shot(attack.shot_json('$SA', '$PA', 'scored', 8));
select 'A_commit_at=' || clock_timestamp();
commit;
SQL
) > "$OUT_DIR/s3_sessionA.out" 2>&1 &
pidA=$!
sleep 0.7
(
  dpsql $DB -Atq <<SQL
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '$A', true);
select 'B_start_at=' || clock_timestamp();
select 'B=' || public.apply_synced_shot(attack.shot_json('$SB', '$PB', 'scored', 9));
select 'B_done_at=' || clock_timestamp();
commit;
SQL
) > "$OUT_DIR/s3_sessionB.out" 2>&1 &
pidB=$!
sleep 1.2
# Prove B is actually waiting on the advisory lock while A sleeps.
waiting=$(dq $DB "select count(*) from pg_stat_activity where datname='$DB' and wait_event_type='Lock' and wait_event='advisory'")
assert_eq "session B blocked on advisory lock while A holds it" "$waiting" "1"
wait $pidA; wait $pidB
cat "$OUT_DIR/s3_sessionA.out" "$OUT_DIR/s3_sessionB.out"
ra=$(grep -E '^A=' "$OUT_DIR/s3_sessionA.out" | cut -d= -f2)
rb=$(grep -E '^B=' "$OUT_DIR/s3_sessionB.out" | cut -d= -f2)
assert_eq "A (lock holder) accepted" "$ra" "accepted"
assert_eq "B (waiter) refused" "$rb" "access.paywall_required"
assert_eq "exactly 2 scored shots for alice" "$(dq $DB "select count(*) from public.shots where user_id='$A' and result_kind='scored'")" "2"
assert_eq "ledger = 2" "$(ledger)" "2"
assert_eq "A's permit finalized/scored" "$(dq $DB "select status || '/' || outcome from public.analysis_permits where id='$PA'")" "finalized/scored"
assert_eq "B's permit released/free_limit_exceeded" "$(dq $DB "select status || '/' || outcome from public.analysis_permits where id='$PB'")" "released/free_limit_exceeded"
assert_eq "B's shot id was not written" "$(dq $DB "select count(*) from public.shots where id='$SB'")" "0"
assert_eq "reserved_count now 0" "$(as_alice "select reserved_count from public.access_state()" | tail -1)" "0"

# ---- S3b: seeded N-way stampede at count=1 with N forged permits, no ordering.
N=8
DB2=s3b
fresh_db $DB2
dq $DB2 "select attack.mk_user('$A', 'alice@x.test')" >/dev/null
dpsql $DB2 -Atq <<SQL >/dev/null
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '$A', true);
select result from public.reserve_analysis_permit('k1');
commit;
SQL
P1=$(dq $DB2 "select id from public.analysis_permits where idempotency_key='k1'")
dpsql $DB2 -Atq <<SQL >/dev/null
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '$A', true);
select public.apply_synced_shot(attack.shot_json('aaaaaaaa-0000-0000-0000-000000000001', '$P1', 'scored', 7));
insert into public.analysis_permits (id, user_id, idempotency_key)
  select ('cccccccc-0000-0000-0000-0000000000' || lpad(g::text, 2, '0'))::uuid, '$A', 'forged-' || g from generate_series(1, $N) g;
commit;
SQL
RANDOM=$SEED
echo "S3b seed=$SEED N=$N"
pids=()
for g in $(seq 1 $N); do
  jitter=$((RANDOM % 300))
  (
    sleep "0.$(printf '%03d' $jitter)"
    dpsql $DB2 -Atq <<SQL 2>&1 | grep -E '^R='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '$A', true);
select 'R=' || public.apply_synced_shot(attack.shot_json(('dddddddd-0000-0000-0000-0000000000' || lpad('$g', 2, '0'))::uuid, ('cccccccc-0000-0000-0000-0000000000' || lpad('$g', 2, '0'))::uuid, 'scored', 8));
commit;
SQL
  ) > "$OUT_DIR/s3b_$g.out" &
  pids+=($!)
done
for p in "${pids[@]}"; do wait "$p"; done
cat "$OUT_DIR"/s3b_*.out | sort | uniq -c
accepted=$(cat "$OUT_DIR"/s3b_*.out | grep -c '^R=accepted' || true)
refused=$(cat "$OUT_DIR"/s3b_*.out | grep -c '^R=access.paywall_required' || true)
assert_eq "stampede: exactly one accepted" "$accepted" "1"
assert_eq "stampede: N-1 refused" "$refused" "$((N - 1))"
assert_eq "stampede: 2 scored shots total" "$(dq $DB2 "select count(*) from public.shots where user_id='$A' and result_kind='scored'")" "2"
assert_eq "stampede: finalized permits = 2 (k1 + winner), released/free_limit_exceeded = N-1" \
  "$(dq $DB2 "select (select count(*) from public.analysis_permits where user_id='$A' and status='finalized') || '|' || (select count(*) from public.analysis_permits where user_id='$A' and status='released' and outcome='free_limit_exceeded')")" "2|$((N - 1))"
assert_eq "stampede: ledger 2" "$(dq $DB2 "select scored_count from public.free_rating_ledger where identity_hash = public.free_rating_identity_hash('google','$SUB')")" "2"
assert_eq "stampede: no reserved permits left" "$(dq $DB2 "select count(*) from public.analysis_permits where user_id='$A' and status='reserved'")" "0"

finish_scenario s3_concurrent_apply
