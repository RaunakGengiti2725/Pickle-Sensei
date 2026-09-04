#!/usr/bin/env bash
# S2 — permit at the 24h expiry boundary, NO cron (pg_cron is absent here).
# alice has 1 scored shot (remaining 1). Reserve permit P, back-date it to
# now() - 24h + 1s. access_state() must still count it (reserved 1) and a
# second reserve must be refused; ~1.5s later apply_synced_shot(P) must
# return access.permit_expired, flip P to released/expired, and
# access_state().reserved_count must read 0 so a new reserve is accepted.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
DB=s2
fresh_db $DB
A=11111111-1111-1111-1111-111111111111

as_alice() {
  dpsql $DB -Atq <<SQL
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '$A', true);
$1;
commit;
SQL
}

dpsql $DB -q <<SQL >/dev/null
select attack.mk_user('$A', 'alice@x.test');
SQL
# 1 scored shot through the real RPC path.
as_alice "select result from public.reserve_analysis_permit('k1')" >/dev/null
P1=$(dq $DB "select id from public.analysis_permits where idempotency_key='k1'")
as_alice "select public.apply_synced_shot(attack.shot_json('aaaaaaaa-0000-0000-0000-000000000001', '$P1', 'scored', 7))" | tail -1

# Reserve P and back-date it to 1s before expiry (clock_timestamp → wall clock).
assert_eq "reserve P" "$(as_alice "select result from public.reserve_analysis_permit('kP')" | tail -1)" "accepted"
P=$(dq $DB "select id from public.analysis_permits where idempotency_key='kP'")
dq $DB "update public.analysis_permits set created_at = clock_timestamp() - interval '24 hours' + interval '1 second' where id = '$P'" >/dev/null
t0=$(date +%s.%N)

# Before the boundary: access_state counts it, and a further reserve is refused.
assert_eq "access_state before boundary (premium|scored|reserved)" \
  "$(as_alice "select premium || '|' || scored_count || '|' || reserved_count from public.access_state()" | tail -1)" "false|1|1"
assert_eq "extra reserve refused while P is fresh" \
  "$(as_alice "select result from public.reserve_analysis_permit('kExtra')" | tail -1)" "access.paywall_required"

# Cross the boundary.
sleep 1.6
echo "elapsed since back-date: $(awk "BEGIN{print $(date +%s.%N) - $t0}")s"

# After the boundary: sync with P must be refused as expired; no shot written.
assert_eq "apply_synced_shot(P) after boundary" \
  "$(as_alice "select public.apply_synced_shot(attack.shot_json('aaaaaaaa-0000-0000-0000-000000000002', '$P', 'scored', 8))" | tail -1)" "access.permit_expired"
assert_eq "P is released/expired without cron" \
  "$(dq $DB "select status || '/' || outcome from public.analysis_permits where id='$P'")" "released/expired"
assert_eq "no shot written for the expired permit" \
  "$(dq $DB "select count(*) from public.shots where id='aaaaaaaa-0000-0000-0000-000000000002'")" "0"
assert_eq "access_state after boundary reserved_count=0" \
  "$(as_alice "select premium || '|' || scored_count || '|' || reserved_count from public.access_state()" | tail -1)" "false|1|0"
assert_eq "new reserve accepted once P expired (slot freed lazily)" \
  "$(as_alice "select result from public.reserve_analysis_permit('kAfter')" | tail -1)" "accepted"

# Replay of the expired permit is idempotent (still permit_not_reserved, no state change).
assert_eq "replaying sync with expired P" \
  "$(as_alice "select public.apply_synced_shot(attack.shot_json('aaaaaaaa-0000-0000-0000-000000000002', '$P', 'scored', 8))" | tail -1)" "access.permit_not_reserved"

# ---- S2b: exact boundary inside ONE snapshot. Within a single transaction
# now() is frozen, so a permit set to exactly now()-24h is simultaneously
# "not fresh" for access_state (>) and "expired" for apply (<=): the two
# predicates must be complementary — no timestamp may be counted AND refused
# or ignored AND accepted.
res=$(dpsql $DB -Atq <<SQL
begin;
select set_config('request.jwt.claim.sub', '$A', true);
insert into public.analysis_permits (id, user_id, idempotency_key, created_at)
  values ('bbbbbbbb-0000-0000-0000-000000000001', '$A', 'kExact', now() - interval '24 hours');
set local role authenticated;
select 'reserved=' || reserved_count from public.access_state();
select 'apply=' || public.apply_synced_shot(attack.shot_json('aaaaaaaa-0000-0000-0000-000000000003', 'bbbbbbbb-0000-0000-0000-000000000001', 'scored', 8));
rollback;
SQL
)
echo "$res"
assert_eq "exact boundary: access_state ignores (kAfter still reserved → 1) and apply refuses" \
  "$(echo "$res" | grep -E '^(reserved|apply)=' | paste -sd' ')" "reserved=1 apply=access.permit_expired"

# One microsecond newer than the boundary: counted AND accepted.
res=$(dpsql $DB -Atq <<SQL
begin;
select set_config('request.jwt.claim.sub', '$A', true);
update public.analysis_permits set status='released', outcome='expired' where idempotency_key='kAfter';
insert into public.analysis_permits (id, user_id, idempotency_key, created_at)
  values ('bbbbbbbb-0000-0000-0000-000000000002', '$A', 'kExact2', now() - interval '24 hours' + interval '1 microsecond');
set local role authenticated;
select 'reserved=' || reserved_count from public.access_state();
select 'apply=' || public.apply_synced_shot(attack.shot_json('aaaaaaaa-0000-0000-0000-000000000004', 'bbbbbbbb-0000-0000-0000-000000000002', 'scored', 8));
rollback;
SQL
)
echo "$res"
assert_eq "boundary+1µs: access_state counts and apply accepts" \
  "$(echo "$res" | grep -E '^(reserved|apply)=' | paste -sd' ')" "reserved=1 apply=accepted"

# ---- S2c: clock skew the other way — a permit with created_at in the FUTURE
# (client/server skew can't cause it, but a corrupt row can). It is counted
# as reserved forever-ish and never expires by the lazy rule.
res=$(dpsql $DB -Atq <<SQL
begin;
select set_config('request.jwt.claim.sub', '$A', true);
update public.analysis_permits set status='released', outcome='expired' where idempotency_key='kAfter';
insert into public.analysis_permits (id, user_id, idempotency_key, created_at)
  values ('bbbbbbbb-0000-0000-0000-000000000003', '$A', 'kFuture', now() + interval '400 days');
set local role authenticated;
select 'reserved=' || reserved_count from public.access_state();
select 'reserve=' || result from public.reserve_analysis_permit('kBlocked');
rollback;
SQL
)
echo "$res"
echo "S2c INFO | future-dated permit: $(echo "$res" | grep -E '^(reserved|reserve)=' | paste -sd' ') (only writable by service role / corruption; recorded, not asserted)"

finish_scenario s2_permit_boundary
