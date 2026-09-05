#!/usr/bin/env bash
# Deterministic repro — apply_synced_shot() reads the entitlement twice under
# READ COMMITTED (harness scenario S5, invariant `no_transient_write_failed_on_premium_flip`).
#
#   apply_synced_shot():  pg_advisory_xact_lock(access_lock_key(uid))
#                         read billing_entitlements → premium=true → backstop passes
#                         insert into public.shots
#                           └─ BEFORE INSERT enforce_scored_shot_permit(): NEW snapshot,
#                              premium=false now, lifetime_scored_count()>=2
#                              → raise insufficient_privilege (42501)
#                         exception handler → returns 'shot.write_failed:42501'
#
# The premium flip is a service-role upsert (webhook / billing sync) that commits
# between the two reads. Neither read takes a row lock, so the advisory lock does
# not serialize against it. The window is forced open here by holding an EXCLUSIVE
# lock on public.shots while the RPC is between its backstop read and the insert.
#
# Expected: the contract verdict 'access.paywall_required' (permit released, outcome
#           free_limit_exceeded) — what the RPC returns when the flip lands before it.
# Observed: 'shot.write_failed:42501' (the edge maps it to the transient code
#           shot.write_failed, logs an error line, the outbox retries) and the permit
#           stays 'reserved' until that retry or the 24h sweep. The retry then yields
#           access.paywall_required — self-healing, one extra round trip.
#
# Usage: ../stress_pg_up.sh && ./repro_apply_premium_flip_toctou.sh ; exit 0 = anomaly reproduced.
HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=_lib.sh
source "$HERE/_lib.sh"

USER_E=$(new_uuid)
create_user "$USER_E"
X_PID=""; A_PID=""
cleanup() {
  exec 3>&- 2>/dev/null
  kill_pids $X_PID $A_PID
  psql_owner "select pg_terminate_backend(pid) from pg_stat_activity
              where (query ilike '%public.shots%' or query ilike '%apply_synced_shot%') and pid <> pg_backend_pid()" >/dev/null
  drop_user "$USER_E"
}
trap cleanup EXIT

# Premium user with two ratings already scored (the free allowance is spent; premium bypasses it).
psql_as service_role "" "insert into public.billing_entitlements (user_id, premium, product_key, expires_at, verified_at)
  values ('$USER_E', true, 'pickle_sensei_pro_monthly', null, now());" >/dev/null
for i in 1 2; do
  PERMIT=$(psql_as authenticated "$USER_E" "select x.permit_id from public.reserve_analysis_permit('setup-$i') x;" | tail -1)
  SHOT=$(new_uuid)
  R=$(psql_as authenticated "$USER_E" "select public.apply_synced_shot('$(shot_json "$SHOT" "$PERMIT")'::jsonb);" | tail -1)
  [ "$R" = "accepted" ] || { echo "setup apply $i returned $R" >&2; exit 2; }
done
PERMIT3=$(psql_as authenticated "$USER_E" "select x.permit_id from public.reserve_analysis_permit('race') x;" | tail -1)
SHOT3=$(new_uuid)
echo "setup: user=$USER_E premium=true scored=2 permit3=$PERMIT3 (reserved)"

# X: hold public.shots so the RPC parks between its backstop read and the insert.
FIFO=$(mktemp -u); mkfifo "$FIFO"
docker exec -i "$CONTAINER" psql -X -v ON_ERROR_STOP=1 -qAt -U postgres -d postgres < "$FIFO" > /tmp/repro_toctou_X.out 2>&1 &
X_PID=$!
exec 3>"$FIFO"
echo "begin; lock table public.shots in exclusive mode;" >&3
sleep 0.5

# A: the client's sync — blocks on the table lock AFTER passing the backstop.
psql_as authenticated "$USER_E" "select public.apply_synced_shot('$(shot_json "$SHOT3" "$PERMIT3")'::jsonb);" > /tmp/repro_toctou_A.out 2>&1 &
A_PID=$!
wait_for_lock_waiter apply_synced_shot

# F: the entitlement flips to non-premium (webhook / billing sync verdict) and commits.
psql_as service_role "" "insert into public.billing_entitlements (user_id, premium, product_key, expires_at, verified_at)
  values ('$USER_E', false, null, null, now())
  on conflict (user_id) do update set premium = excluded.premium, product_key = excluded.product_key,
    expires_at = excluded.expires_at, verified_at = excluded.verified_at;" >/dev/null

# X releases; A resumes into the trigger with a fresh snapshot.
echo "commit;" >&3
exec 3>&-
wait "$X_PID"; wait "$A_PID"

RESULT=$(tail -1 /tmp/repro_toctou_A.out)
PERMIT_STATE=$(psql_owner "select status || '/' || coalesce(outcome, '∅') from public.analysis_permits where id = '$PERMIT3'")
RETRY=$(psql_as authenticated "$USER_E" "select public.apply_synced_shot('$(shot_json "$SHOT3" "$PERMIT3")'::jsonb);" | tail -1)
PERMIT_AFTER=$(psql_owner "select status || '/' || coalesce(outcome, '∅') from public.analysis_permits where id = '$PERMIT3'")
echo "apply during flip     : $RESULT   (expected access.paywall_required)"
echo "permit after apply    : $PERMIT_STATE   (expected released/free_limit_exceeded)"
echo "outbox retry          : $RETRY   permit now $PERMIT_AFTER"
if [ "$RESULT" = "shot.write_failed:42501" ] && [ "$PERMIT_STATE" = "reserved/∅" ]; then
  echo "REPRODUCED: backstop/trigger TOCTOU → transient shot.write_failed:42501 with the permit left reserved"
  exit 0
fi
echo "not reproduced"
exit 1
