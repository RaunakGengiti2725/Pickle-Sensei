#!/usr/bin/env bash
# X3 (own attack) — the free-rating backstop lives INSIDE apply_synced_shot
# (SECURITY INVOKER), but `authenticated` still holds a table-level INSERT
# grant on public.shots (progress_data.sql:303 + shots_insert_own policy).
# Can a signed-in user with both free ratings spent write a THIRD scored shot
# by inserting directly (i.e. PostgREST /rest/v1/shots with a user JWT),
# skipping permits and the paywall? Also probes detail tables + permits.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
A=11111111-1111-1111-1111-111111111111
SUB=google-sub-alice@x.test
DB=x3
fresh_db $DB

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
for i in 1 2; do
  as_alice "select result from public.reserve_analysis_permit('k$i'); select public.apply_synced_shot(attack.shot_json(gen_random_uuid(), (select id from public.analysis_permits where idempotency_key='k$i'), 'scored', 7));" >/dev/null
done
assert_eq "precondition: both free ratings spent" "$(as_alice "select scored_count from public.access_state()" | tail -1)" "2"
assert_eq "RPC path refuses a third rating" "$(as_alice "select result from public.reserve_analysis_permit('k3')" | tail -1)" "access.paywall_required"

# THE ATTACK: direct INSERT of a scored shot, no permit at all.
S3=aaaaaaaa-0000-0000-0000-000000000003
rc=0
out=$(as_alice "insert into public.shots (id, user_id, shot_type, captured_at, start_ms, end_ms, overall_score, analysis_confidence, result_kind, app_version, model_bundle_version, pose_model_version, paddle_model_version, stroke_detector_version, phase_model_version, scoring_model_version, shot_config_version) values ('$S3', '$A', 'dink', now(), 0, 900, 9.5, 0.9, 'scored', 'a','a','a','a','a','a','a','a')" 2>&1) || rc=$?
echo "direct insert rc=$rc out=$out"
assert_eq "direct INSERT of a scored shot without a permit is denied" "$([ $rc -ne 0 ] && echo denied || echo allowed)" "denied"
assert_eq "third scored shot not present" "$(dq $DB "select count(*) from public.shots where user_id='$A' and result_kind='scored'")" "2"
echo "X3 INFO | ledger after direct insert attempt: $(ledger); rank: $(dq $DB "select coalesce((select rating || '/' || scored_shot_count from public.player_rank_state where user_id='$A'),'unranked')")"

# Detail rows for a shot the user owns can be appended directly, bypassing the RPC.
S1=$(dq $DB "select id from public.shots where user_id='$A' order by captured_at limit 1")
rc=0
as_alice "insert into public.shot_checkpoints (shot_id, user_id, checkpoint_key, score, confidence, band, direction, severity, applicable) values ('$S1', '$A', 'forged_cp', 100, 1, 'green', 'x', 0, true)" >/dev/null 2>&1 || rc=$?
echo "X3 INFO | direct shot_checkpoints INSERT: $([ $rc -ne 0 ] && echo denied || echo allowed)"

# Detail rows pointing at ANOTHER user's shot but stamped with own user_id.
B=22222222-2222-2222-2222-222222222222
dq $DB "select attack.mk_user('$B', 'bob@x.test')" >/dev/null
dpsql $DB -Atq <<SQL >/dev/null
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '$B', true);
select result from public.reserve_analysis_permit('kb');
select public.apply_synced_shot(attack.shot_json('bbbbbbbb-0000-0000-0000-000000000001', (select id from public.analysis_permits where idempotency_key='kb'), 'scored', 3));
commit;
SQL
rc=0
as_alice "insert into public.shot_checkpoints (shot_id, user_id, checkpoint_key, score, confidence, band, direction, severity, applicable) values ('bbbbbbbb-0000-0000-0000-000000000001', '$A', 'poison', 0, 1, 'red', 'x', 1, true)" >/dev/null 2>&1 || rc=$?
assert_eq "cannot attach detail rows to another user's shot" "$([ $rc -ne 0 ] && echo denied || echo allowed)" "denied"
bob_sees=$(dpsql $DB -Atq <<SQL | tail -1
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '$B', true);
select count(*) from public.shot_checkpoints where shot_id='bbbbbbbb-0000-0000-0000-000000000001' and checkpoint_key='poison';
commit;
SQL
)
assert_eq "bob's shot has no poisoned checkpoint" "$bob_sees" "0"

finish_scenario x3_direct_insert_bypass
