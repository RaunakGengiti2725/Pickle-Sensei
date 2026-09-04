#!/usr/bin/env bash
# X2 (own attack, follows S7) — premium is honoured "while expires_at > now()".
# now() is frozen at TRANSACTION start, so a premium row whose expires_at
# passes while the caller waits on the advisory lock is still treated as
# valid by the post-lock read (the flag flip in S7 is seen because the ROW is
# re-read; the clock is not). Measures the window and contrasts with the
# same call issued fresh after expiry.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
A=11111111-1111-1111-1111-111111111111
DB=x2
fresh_db $DB
dq $DB "select attack.mk_user('$A', 'alice@x.test')" >/dev/null
for i in 1 2; do
  dpsql $DB -Atq <<SQL >/dev/null
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '$A', true);
select result from public.reserve_analysis_permit('k$i');
select public.apply_synced_shot(attack.shot_json(gen_random_uuid(), (select id from public.analysis_permits where idempotency_key='k$i'), 'scored', 7));
commit;
SQL
done
# premium that expires 1.5s from now.
dq $DB "set role service_role; insert into public.billing_entitlements (user_id, premium, expires_at) values ('$A', true, clock_timestamp() + interval '1.5 seconds')" >/dev/null
EXP=$(dq $DB "select expires_at from public.billing_entitlements where user_id='$A'")

(
  dpsql $DB -Atq <<SQL >/dev/null
begin;
select pg_advisory_xact_lock(public.access_lock_key('$A'));
select pg_sleep(3);
commit;
SQL
) &
pidA=$!
sleep 0.5
(
  dpsql $DB -Atq <<SQL
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '$A', true);
select 'B_tx_now=' || now();
select 'B=' || result || '|' || coalesce(permit_id::text, 'no-permit') from public.reserve_analysis_permit('k-lapse');
select 'B_wall_after=' || clock_timestamp();
commit;
SQL
) > "$OUT_DIR/x2_B.out" 2>&1 &
pidB=$!
sleep 0.6
assert_eq "B blocked on advisory lock" "$(dq $DB "select count(*) from pg_stat_activity where datname='$DB' and wait_event_type='Lock' and wait_event='advisory'")" "1"
wait $pidA; wait $pidB
cat "$OUT_DIR/x2_B.out"
echo "expires_at=$EXP"
rb=$(grep -E '^B=' "$OUT_DIR/x2_B.out" | cut -d= -f2-)
assert_eq "wall clock at decision time is past expires_at" \
  "$(dq $DB "select '$(grep -E '^B_wall_after=' "$OUT_DIR/x2_B.out" | cut -d= -f2-)'::timestamptz > '$EXP'::timestamptz")" "t"
assert_eq "premium that lapsed during the lock wait is refused" "$rb" "access.paywall_required|no-permit"

# Same call issued fresh (new transaction) after expiry → refused, as designed.
sleep 0.2
fresh=$(dpsql $DB -Atq <<SQL | grep -E '^F=' | cut -d= -f2-
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '$A', true);
select 'F=' || result from public.reserve_analysis_permit('k-fresh');
commit;
SQL
)
assert_eq "fresh call after expiry is refused" "$fresh" "access.paywall_required"
echo "X2 INFO | window = lock-wait duration (bounded by the longest concurrent reserve/apply tx for this user; ms in production, 3s here)"

finish_scenario x2_premium_expiry_frozen_now
