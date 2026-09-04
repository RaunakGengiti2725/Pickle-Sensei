#!/usr/bin/env bash
# S1 — re-run 20260902150000_free_rating_identity_ledger.sql on a POPULATED db.
# Assert: ledger rows byte-identical (on conflict greatest), trigger/function
# inventory unchanged (no duplicates), grants unchanged, and the three RPCs
# (access_state / reserve_analysis_permit / apply_synced_shot) still behave.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
DB=s1
fresh_db $DB

A=11111111-1111-1111-1111-111111111111
B=22222222-2222-2222-2222-222222222222
C=33333333-3333-3333-3333-333333333333
C2=44444444-4444-4444-4444-444444444444

# Populate: alice 2 scored, bob 1 scored, carol 2 scored then account deleted,
# carol re-created (same Google subject, new identity row) with 0 own shots.
dpsql $DB -q <<SQL
select attack.mk_user('$A', 'alice@x.test');
select attack.mk_user('$B', 'bob@x.test');
select attack.mk_user('$C', 'carol@x.test', 'google', 'google-sub-carol');

create or replace function attack.score_n(p_uid uuid, p_n int) returns void
language plpgsql as \$\$
declare i int; r record; sid uuid;
begin
  perform set_config('request.jwt.claim.sub', p_uid::text, true);
  perform set_config('role', 'authenticated', true);
  for i in 1..p_n loop
    select * into r from public.reserve_analysis_permit('k-' || p_uid || '-' || i);
    if r.result <> 'accepted' then raise exception 'reserve failed: %', r.result; end if;
    sid := gen_random_uuid();
    if public.apply_synced_shot(attack.shot_json(sid, r.permit_id, 'scored', 6 + i)) <> 'accepted' then
      raise exception 'apply failed';
    end if;
  end loop;
  perform set_config('role', 'postgres', true);
end \$\$;

begin; select attack.score_n('$A', 2); commit;
begin; select attack.score_n('$B', 1); commit;
begin; select attack.score_n('$C', 2); commit;
delete from auth.users where id = '$C';
select attack.mk_user('$C2', 'carol-new@x.test', 'google', 'google-sub-carol');
SQL

snap() {
  dq $DB "select string_agg(t, E'\n') from attack.ledger_snapshot() t"
}
inv() {
  dq $DB "select
    (select count(*) from pg_trigger where tgrelid = 'public.shots'::regclass and not tgisinternal) || '|' ||
    (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public') || '|' ||
    (select count(*) from pg_policies where schemaname = 'public') || '|' ||
    (select count(*) from information_schema.role_table_grants where table_schema = 'public') || '|' ||
    (select count(*) from information_schema.role_routine_grants where routine_schema = 'public')"
}
before_ledger=$(snap); before_inv=$(inv)
before_defs=$(dq $DB "select md5(string_agg(pg_get_functiondef(p.oid), '' order by p.proname)) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'")
echo "ledger before:"; echo "$before_ledger"
echo "inventory before (shots triggers|public fns|policies|table grants|routine grants): $before_inv"

# THE ATTACK: re-apply the migration file verbatim.
docker exec -i "$CONTAINER" psql -X -U postgres -d $DB -v ON_ERROR_STOP=1 -q -f /migrations/20260902150000_free_rating_identity_ledger.sql
rerun_rc=$?
assert_eq "migration re-run exit code" "$rerun_rc" "0"

after_ledger=$(snap); after_inv=$(inv)
after_defs=$(dq $DB "select md5(string_agg(pg_get_functiondef(p.oid), '' order by p.proname)) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'")
echo "ledger after:"; echo "$after_ledger"
assert_eq "ledger rows identical after re-run" "$after_ledger" "$before_ledger"
assert_eq "object inventory identical after re-run" "$after_inv" "$before_inv"
assert_eq "function bodies identical after re-run" "$after_defs" "$before_defs"
assert_eq "ledger has exactly 3 identities" "$(dq $DB "select count(*) from public.free_rating_ledger")" "3"
assert_eq "carol's identity ledger still 2 after delete+recreate+rerun" \
  "$(dq $DB "select scored_count from public.free_rating_ledger where identity_hash = public.free_rating_identity_hash('google','google-sub-carol')")" "2"

# The three RPCs after the re-run (as each user).
rpc() { # rpc <uid> <sql>
  dpsql $DB -Atq <<SQL
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '$1', true);
$2;
commit;
SQL
}
alice_state=$(rpc $A "select premium || '|' || scored_count || '|' || reserved_count from public.access_state()" | tail -1)
assert_eq "access_state(alice) after re-run" "$alice_state" "false|2|0"
carol2_state=$(rpc $C2 "select premium || '|' || scored_count || '|' || reserved_count from public.access_state()" | tail -1)
assert_eq "access_state(carol-recreated) honours identity ledger" "$carol2_state" "false|2|0"
bob_reserve=$(rpc $B "select result from public.reserve_analysis_permit('k-post-rerun')" | tail -1)
assert_eq "reserve_analysis_permit(bob, 1 scored) after re-run" "$bob_reserve" "accepted"
bob_permit=$(dq $DB "select id from public.analysis_permits where user_id='$B' and idempotency_key='k-post-rerun'")
bob_apply=$(rpc $B "select public.apply_synced_shot(attack.shot_json('aaaaaaaa-0000-0000-0000-000000000001', '$bob_permit', 'scored', 8))" | tail -1)
assert_eq "apply_synced_shot(bob) after re-run" "$bob_apply" "accepted"
assert_eq "bob ledger advanced to 2 by trigger after re-run" \
  "$(dq $DB "select scored_count from public.free_rating_ledger where identity_hash = public.free_rating_identity_hash('google','google-sub-bob@x.test')")" "2"
carol2_reserve=$(rpc $C2 "select result from public.reserve_analysis_permit('k-carol2')" | tail -1)
assert_eq "reserve_analysis_permit(carol-recreated) refused" "$carol2_reserve" "access.paywall_required"
alice_reserve=$(rpc $A "select result from public.reserve_analysis_permit('k-alice-3')" | tail -1)
assert_eq "reserve_analysis_permit(alice, 2 scored) refused" "$alice_reserve" "access.paywall_required"

# Second re-run (rapid repeat) must also be a no-op.
docker exec -i "$CONTAINER" psql -X -U postgres -d $DB -v ON_ERROR_STOP=1 -q -f /migrations/20260902150000_free_rating_identity_ledger.sql
mid=$(snap)
docker exec -i "$CONTAINER" psql -X -U postgres -d $DB -v ON_ERROR_STOP=1 -q -f /migrations/20260902150000_free_rating_identity_ledger.sql
assert_eq "third re-run leaves ledger identical" "$(snap)" "$mid"

# ---- S1b (own attack): backfill rule vs trigger rule after a service-role
# user_id reassignment. The trigger never credits the new owner (S6), but the
# backfill counts shots by CURRENT user_id — is a re-run still a no-op?
dq $DB "set role service_role; update public.shots set user_id = '$B' where user_id = '$A' and id = (select id from public.shots where user_id='$A' order by captured_at limit 1);" >/dev/null
b_before=$(dq $DB "select scored_count from public.free_rating_ledger where identity_hash = public.free_rating_identity_hash('google','google-sub-bob@x.test')")
docker exec -i "$CONTAINER" psql -X -U postgres -d $DB -v ON_ERROR_STOP=1 -q -f /migrations/20260902150000_free_rating_identity_ledger.sql
b_after=$(dq $DB "select scored_count from public.free_rating_ledger where identity_hash = public.free_rating_identity_hash('google','google-sub-bob@x.test')")
echo "S1b bob ledger before re-run=$b_before after re-run=$b_after (bob owns 3 shots after reassignment; trigger credited 2)"
if [ "$b_before" == "$b_after" ]; then
  echo "S1b INFO | re-run is a no-op even after reassignment"
else
  echo "S1b INFO | re-run RE-CREDITS reassigned shot: ledger $b_before -> $b_after (backfill counts by current user_id; trigger does not)"
fi

finish_scenario s1_migration_rerun
