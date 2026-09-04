#!/usr/bin/env bash
# S5 — service role UPDATE shots SET result_kind='scored', overall_score=5 on a
# low_confidence row (P20: ledger 0 → 1). Assert rank + ledger update exactly
# once, and an identical repeated UPDATE is a no-op for both.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
DB=s5
fresh_db $DB
A=11111111-1111-1111-1111-111111111111
SUB=google-sub-alice@x.test
S_LOW=aaaaaaaa-0000-0000-0000-00000000000a

as_alice() {
  dpsql $DB -Atq <<SQL
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '$A', true);
$1;
commit;
SQL
}
svc() { dq $DB "set role service_role; $1"; }
ledger() { dq $DB "select coalesce((select scored_count from public.free_rating_ledger where identity_hash = public.free_rating_identity_hash('google','$SUB')), 0)"; }
rank() { dq $DB "select coalesce((select rating || '/' || tier || '/' || technique_count || '/' || scored_shot_count from public.player_rank_state where user_id='$A'), 'unranked')"; }

dq $DB "select attack.mk_user('$A', 'alice@x.test')" >/dev/null
# One honest abstention through the real path → ledger 0, unranked, permit released/low_confidence.
as_alice "select result from public.reserve_analysis_permit('k-low')" >/dev/null
P=$(dq $DB "select id from public.analysis_permits where idempotency_key='k-low'")
assert_eq "abstention synced" "$(as_alice "select public.apply_synced_shot(attack.shot_json('$S_LOW', '$P', 'low_confidence'))" | tail -1)" "accepted"
assert_eq "ledger 0 after abstention" "$(ledger)" "0"
assert_eq "unranked after abstention" "$(rank)" "unranked"
assert_eq "access_state scored_count 0" "$(as_alice "select scored_count from public.access_state()" | tail -1)" "0"

# THE ATTACK (service role): flip low_confidence → scored 5.
svc "update public.shots set result_kind='scored', overall_score=5 where id='$S_LOW'" >/dev/null
assert_eq "ledger advanced exactly once (0→1)" "$(ledger)" "1"
assert_eq "rank recomputed from the flipped row" "$(rank)" "5.00/gold/1/1"
assert_eq "lifetime_scored_count sees 1" "$(as_alice "select scored_count from public.access_state()" | tail -1)" "1"
u1=$(dq $DB "select updated_at from public.free_rating_ledger where identity_hash = public.free_rating_identity_hash('google','$SUB')")

# Identical UPDATE repeated (rapid ×5): no-op for ledger AND rank values.
for _ in 1 2 3 4 5; do
  svc "update public.shots set result_kind='scored', overall_score=5 where id='$S_LOW'" >/dev/null
done
assert_eq "ledger unchanged after 5 identical repeats" "$(ledger)" "1"
assert_eq "ledger updated_at unchanged (trigger early-returned)" \
  "$(dq $DB "select updated_at = '$u1' from public.free_rating_ledger where identity_hash = public.free_rating_identity_hash('google','$SUB')")" "t"
assert_eq "rank values unchanged after repeats" "$(rank)" "5.00/gold/1/1"

# Score-only change on an already-scored row: rank moves, ledger does not.
svc "update public.shots set overall_score=9 where id='$S_LOW'" >/dev/null
assert_eq "ledger unchanged when only score changes" "$(ledger)" "1"
assert_eq "rank follows the new score" "$(rank)" "9.00/diamond/1/1"

# Reverse flip scored → low_confidence: ledger is monotonic (stays 1), rank drops.
svc "update public.shots set result_kind='low_confidence', overall_score=null where id='$S_LOW'" >/dev/null
assert_eq "ledger monotonic on reverse flip" "$(ledger)" "1"
assert_eq "unranked after reverse flip" "$(rank)" "unranked"
# Flip forward again → the ledger credits AGAIN (2) although the same shot is
# scored only once. Recorded: is a flip-flop double-credit possible?
svc "update public.shots set result_kind='scored', overall_score=5 where id='$S_LOW'" >/dev/null
echo "S5b INFO | ledger after low→scored→low→scored flip-flop on ONE shot: $(ledger) (own scored shots = $(dq $DB "select count(*) from public.shots where user_id='$A' and result_kind='scored'"))"

# ---- S5c: the client cannot do any of this (UPDATE on shots revoked from authenticated).
rc=0
as_alice "update public.shots set result_kind='scored', overall_score=10 where id='$S_LOW'" >/dev/null 2>&1 || rc=$?
assert_eq "authenticated UPDATE shots denied" "$([ $rc -ne 0 ] && echo denied || echo allowed)" "denied"

# ---- S5d: scored shot with NULL score is rejected by CHECK, so the trigger can
# never credit a ledger for a row the rank ignores.
rc=0
svc "update public.shots set result_kind='scored', overall_score=null where id='$S_LOW'" >/dev/null 2>&1 || rc=$?
assert_eq "scored+null score rejected by scored_shots_have_scores" "$([ $rc -ne 0 ] && echo denied || echo allowed)" "denied"

finish_scenario s5_service_role_result_flip
