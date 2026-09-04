#!/usr/bin/env bash
# S6 — service role UPDATE shots SET user_id = <bob> on alice's scored shot.
# Assert handle_shot_rank_refresh recomputes BOTH users (alice → unranked,
# bob → ranked) and record_scored_shot_in_ledger does NOT credit bob
# (result_kind did not change → trigger early-returns).
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
DB=s6
fresh_db $DB
A=11111111-1111-1111-1111-111111111111
B=22222222-2222-2222-2222-222222222222
SUBA=google-sub-alice@x.test
SUBB=google-sub-bob@x.test
S1=aaaaaaaa-0000-0000-0000-000000000001
S2=aaaaaaaa-0000-0000-0000-000000000002

as() { # as <uid> <sql>
  dpsql $DB -Atq <<SQL
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '$1', true);
$2;
commit;
SQL
}
svc() { dq $DB "set role service_role; $1"; }
ledger() { dq $DB "select coalesce((select scored_count from public.free_rating_ledger where identity_hash = public.free_rating_identity_hash('google','$1')), 0)"; }
rank() { dq $DB "select coalesce((select rating || '/' || tier || '/' || technique_count || '/' || scored_shot_count from public.player_rank_state where user_id='$1'), 'unranked')"; }

dq $DB "select attack.mk_user('$A', 'alice@x.test'); select attack.mk_user('$B', 'bob@x.test');" >/dev/null
# alice: two scored shots (dink 6, drive 8) → ranked; bob: nothing.
for pair in "$S1:dink:6" "$S2:drive:8"; do
  IFS=: read -r sid st sc <<<"$pair"
  as $A "select result from public.reserve_analysis_permit('k-$st')" >/dev/null
  P=$(dq $DB "select id from public.analysis_permits where user_id='$A' and idempotency_key='k-$st'")
  as $A "select public.apply_synced_shot(attack.shot_json('$sid', '$P', 'scored', $sc, '$st'))" | tail -1
done
assert_eq "alice ranked on 2 techniques" "$(rank $A)" "7.00/platinum/2/2"
assert_eq "bob unranked" "$(rank $B)" "unranked"
assert_eq "alice ledger 2" "$(ledger $SUBA)" "2"
assert_eq "bob ledger 0" "$(ledger $SUBB)" "0"

# THE ATTACK: move alice's drive shot to bob.
svc "update public.shots set user_id='$B' where id='$S2'" >/dev/null
assert_eq "alice rank recomputed (old user): dink only" "$(rank $A)" "6.00/gold/1/1"
assert_eq "bob rank recomputed (new user): drive only" "$(rank $B)" "8.00/diamond/1/1"
assert_eq "alice ledger unchanged (monotonic)" "$(ledger $SUBA)" "2"
assert_eq "bob ledger NOT credited" "$(ledger $SUBB)" "0"
assert_eq "bob lifetime_scored_count = greatest(own 1, ledger 0) = 1" \
  "$(as $B "select scored_count from public.access_state()" | tail -1)" "1"
assert_eq "alice lifetime_scored_count = greatest(own 1, ledger 2) = 2" \
  "$(as $A "select scored_count from public.access_state()" | tail -1)" "2"

# Move the other shot too → alice must become unranked (row deleted).
svc "update public.shots set user_id='$B' where id='$S1'" >/dev/null
assert_eq "alice unranked once no shots remain" "$(rank $A)" "unranked"
assert_eq "bob ranked on both" "$(rank $B)" "7.00/platinum/2/2"
assert_eq "bob ledger still 0" "$(ledger $SUBB)" "0"

# Move back with a no-op (same user) update: nothing changes.
svc "update public.shots set user_id='$B' where id='$S1'" >/dev/null
assert_eq "same-user update is a no-op" "$(rank $B)" "7.00/platinum/2/2"

# ---- S6c: DELETE by service role → old user recomputed (bob loses a technique).
svc "delete from public.shots where id='$S2'" >/dev/null
assert_eq "bob rank after delete" "$(rank $B)" "6.00/gold/1/1"
assert_eq "ledgers untouched by delete" "$(ledger $SUBA)|$(ledger $SUBB)" "2|0"

# ---- S6d: move to a NON-EXISTENT user is refused by the FK (trigger can't
# leave a rank row for a ghost).
rc=0
svc "update public.shots set user_id='99999999-9999-9999-9999-999999999999' where id='$S1'" >/dev/null 2>&1 || rc=$?
assert_eq "move to ghost user rejected by FK" "$([ $rc -ne 0 ] && echo denied || echo allowed)" "denied"
assert_eq "no ghost rank row" "$(dq $DB "select count(*) from public.player_rank_state where user_id not in (select id from public.profiles)")" "0"

finish_scenario s6_service_role_user_move
