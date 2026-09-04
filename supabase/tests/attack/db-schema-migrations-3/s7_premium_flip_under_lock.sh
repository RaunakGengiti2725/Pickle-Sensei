#!/usr/bin/env bash
# S7 — service role flips billing_entitlements.premium=false WHILE a
# reserve_analysis_permit call is blocked on the per-user advisory lock.
# alice has spent both free ratings and is premium; her reserve is only legal
# because of premium. Session A holds the lock and sleeps; session B calls
# reserve (fast path misses → blocks on the lock); at t=1s the service role
# revokes premium and commits; A releases at t=3s. B's post-lock read must see
# premium=false → access.paywall_required and NO permit row.
# Control run: identical interleaving without the flip → accepted.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
A=11111111-1111-1111-1111-111111111111

setup() { # setup <db>
  local db="$1"
  fresh_db "$db"
  dq "$db" "select attack.mk_user('$A', 'alice@x.test')" >/dev/null
  for i in 1 2; do
    dpsql "$db" -Atq <<SQL >/dev/null
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '$A', true);
select result from public.reserve_analysis_permit('k$i');
select public.apply_synced_shot(attack.shot_json(gen_random_uuid(), (select id from public.analysis_permits where idempotency_key='k$i'), 'scored', 7));
commit;
SQL
  done
  dq "$db" "set role service_role; insert into public.billing_entitlements (user_id, premium, product_key) values ('$A', true, 'pickle_sensei_pro')" >/dev/null
}

interleave() { # interleave <db> <flip:0|1> <tag>
  local db="$1" flip="$2" tag="$3"
  (
    dpsql "$db" -Atq <<SQL
begin;
select pg_advisory_xact_lock(public.access_lock_key('$A'));
select 'A_locked_at=' || clock_timestamp();
select pg_sleep(3);
select 'A_release_at=' || clock_timestamp();
commit;
SQL
  ) > "$OUT_DIR/s7_${tag}_A.out" 2>&1 &
  local pidA=$!
  sleep 0.5
  (
    dpsql "$db" -Atq <<SQL
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '$A', true);
select 'B_pre_lock_premium=' || premium from public.access_state();
select 'B_reserve_start=' || clock_timestamp();
select 'B=' || result || '|' || coalesce(permit_id::text, 'no-permit') from public.reserve_analysis_permit('k-under-lock');
select 'B_reserve_done=' || clock_timestamp();
commit;
SQL
  ) > "$OUT_DIR/s7_${tag}_B.out" 2>&1 &
  local pidB=$!
  sleep 0.6
  local waiting
  waiting=$(dq "$db" "select count(*) from pg_stat_activity where datname='$db' and wait_event_type='Lock' and wait_event='advisory'")
  assert_eq "$tag: B blocked on advisory lock" "$waiting" "1"
  if [ "$flip" = "1" ]; then
    dq "$db" "set role service_role; update public.billing_entitlements set premium=false, verified_at=now() where user_id='$A'" >/dev/null
    echo "$tag: premium flipped to false at $(date -u +%H:%M:%S.%N) while B waits"
  fi
  wait $pidA; wait $pidB
  cat "$OUT_DIR/s7_${tag}_A.out" "$OUT_DIR/s7_${tag}_B.out"
}

# Attack run.
setup s7
interleave s7 1 flip
rb=$(grep -E '^B=' "$OUT_DIR/s7_flip_B.out" | cut -d= -f2-)
assert_eq "flip: B saw premium=true before blocking" "$(grep -E '^B_pre_lock_premium=' "$OUT_DIR/s7_flip_B.out" | cut -d= -f2)" "true"
assert_eq "flip: post-lock read sees premium=false → refused" "$rb" "access.paywall_required|no-permit"
assert_eq "flip: no permit row inserted" "$(dq s7 "select count(*) from public.analysis_permits where user_id='$A' and idempotency_key='k-under-lock'")" "0"

# Control run: same interleaving, no flip → accepted.
setup s7c
interleave s7c 0 control
rb=$(grep -E '^B=' "$OUT_DIR/s7_control_B.out" | cut -d= -f2-)
assert_eq "control: premium reserve accepted after lock wait" "${rb%%|*}" "accepted"
assert_eq "control: permit row inserted" "$(dq s7c "select count(*) from public.analysis_permits where user_id='$A' and idempotency_key='k-under-lock'")" "1"

# ---- S7c: the mirror image — flip premium=TRUE under the lock for a user
# out of free ratings → post-lock read must GRANT (no stale paywall).
fresh_db s7g
dq s7g "select attack.mk_user('$A', 'alice@x.test')" >/dev/null
for i in 1 2; do
  dpsql s7g -Atq <<SQL >/dev/null
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '$A', true);
select result from public.reserve_analysis_permit('k$i');
select public.apply_synced_shot(attack.shot_json(gen_random_uuid(), (select id from public.analysis_permits where idempotency_key='k$i'), 'scored', 7));
commit;
SQL
done
(
  dpsql s7g -Atq <<SQL >/dev/null
begin;
select pg_advisory_xact_lock(public.access_lock_key('$A'));
select pg_sleep(3);
commit;
SQL
) &
pidA=$!
sleep 0.5
(
  dpsql s7g -Atq <<SQL
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '$A', true);
select 'B=' || result from public.reserve_analysis_permit('k-grant');
commit;
SQL
) > "$OUT_DIR/s7_grant_B.out" 2>&1 &
pidB=$!
sleep 0.6
dq s7g "set role service_role; insert into public.billing_entitlements (user_id, premium) values ('$A', true)" >/dev/null
wait $pidA; wait $pidB
assert_eq "grant: premium granted under the lock is honoured post-lock" "$(grep -E '^B=' "$OUT_DIR/s7_grant_B.out" | cut -d= -f2)" "accepted"

finish_scenario s7_premium_flip_under_lock
