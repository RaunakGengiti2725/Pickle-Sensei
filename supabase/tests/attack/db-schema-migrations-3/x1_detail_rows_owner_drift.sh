#!/usr/bin/env bash
# X1 (own attack, follows S6) — shot_phases / shot_checkpoints / shot_measurements
# carry a DENORMALIZED user_id that RLS keys on (progress_data.sql:129/140/151),
# with no constraint tying it to shots.user_id. After a service-role
# `update shots set user_id = bob`, do the detail rows follow the shot?
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
DB=x1
fresh_db $DB
A=11111111-1111-1111-1111-111111111111
B=22222222-2222-2222-2222-222222222222
S=aaaaaaaa-0000-0000-0000-000000000001

as() {
  dpsql $DB -Atq <<SQL
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '$1', true);
$2;
commit;
SQL
}

dq $DB "select attack.mk_user('$A', 'alice@x.test'); select attack.mk_user('$B', 'bob@x.test');" >/dev/null
as $A "select result from public.reserve_analysis_permit('k')" >/dev/null
P=$(dq $DB "select id from public.analysis_permits where user_id='$A' and idempotency_key='k'")
assert_eq "alice syncs a scored shot with 1 phase + 1 checkpoint" \
  "$(as $A "select public.apply_synced_shot(attack.shot_json('$S', '$P', 'scored', 7))" | tail -1)" "accepted"
assert_eq "alice sees her detail rows" \
  "$(as $A "select (select count(*) from public.shot_phases where shot_id='$S') || '|' || (select count(*) from public.shot_checkpoints where shot_id='$S')" | tail -1)" "1|1"

dq $DB "set role service_role; update public.shots set user_id='$B' where id='$S'" >/dev/null

owners=$(dq $DB "select (select user_id from public.shots where id='$S') || ' / phases:' || (select string_agg(distinct user_id::text, ',') from public.shot_phases where shot_id='$S') || ' / checkpoints:' || (select string_agg(distinct user_id::text, ',') from public.shot_checkpoints where shot_id='$S')")
echo "owner columns after move: $owners"
assert_eq "detail-row user_id follows shots.user_id" \
  "$(dq $DB "select count(*) from public.shot_phases p join public.shots s on s.id=p.shot_id where p.user_id <> s.user_id") + $(dq $DB "select count(*) from public.shot_checkpoints c join public.shots s on s.id=c.shot_id where c.user_id <> s.user_id")" "0 + 0"
assert_eq "new owner (bob) can read the moved shot's phases/checkpoints" \
  "$(as $B "select (select count(*) from public.shot_phases where shot_id='$S') || '|' || (select count(*) from public.shot_checkpoints where shot_id='$S')" | tail -1)" "1|1"
assert_eq "old owner (alice) can no longer read them" \
  "$(as $A "select (select count(*) from public.shot_phases where shot_id='$S') || '|' || (select count(*) from public.shot_checkpoints where shot_id='$S')" | tail -1)" "0|0"

# Deleting alice's account: do the orphan-owned detail rows of BOB's shot vanish?
dq $DB "delete from auth.users where id='$A'" >/dev/null
assert_eq "bob's shot survives alice's deletion" "$(dq $DB "select count(*) from public.shots where id='$S'")" "1"
assert_eq "bob's shot keeps its detail rows after alice's deletion" \
  "$(dq $DB "select (select count(*) from public.shot_phases where shot_id='$S') || '|' || (select count(*) from public.shot_checkpoints where shot_id='$S')")" "1|1"

finish_scenario x1_detail_rows_owner_drift
