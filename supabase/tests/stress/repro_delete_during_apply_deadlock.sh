#!/usr/bin/env bash
# Deterministic two-session repro of the harness finding
#   delete_during_apply: account deletion racing an in-flight
#   apply_synced_shot() deadlocks (SQLSTATE 40P01) — one of the two loses.
#
# Lock order inside apply_synced_shot():
#   (1) analysis_permits row  FOR UPDATE          (2) INSERT public.shots
#                                                     → FK KEY SHARE on
#                                                       public.profiles(id)
# Lock order of `delete from auth.users` (what Auth admin deleteUser does):
#   (1) profiles row (cascade)                    (2) analysis_permits rows
#                                                     (cascade from profiles)
# Opposite orders → S1 holds permit, S2 holds profile & waits for the permit,
# S1 then waits for the profile → deadlock.
#
#   S1  begin; select … from analysis_permits where id = P for update
#             (the RPC's first lock, taken up front so the interleaving
#              is fixed instead of racing inside one statement)
#   S2  begin; delete from auth.users where id = U   (blocks on the permit,
#              already holding the profile row — run in the background)
#   S1  select apply_synced_shot(...)                 (needs the profile row)
#   → Postgres detects the cycle after deadlock_timeout and kills one side.
#
# In production the victim is either the account-deletion request (Auth
# admin deleteUser fails → DELETE /v1/account returns 503 and the user must
# retry) or the sync (apply returns 'shot.write_failed:40P01' → the outbox
# retries, then gets access.permit_not_found once the account is gone).
#
# Usage: ./pg_up.sh && ./repro_delete_during_apply_deadlock.sh
#   exit 0 = deadlock reproduced (40P01 seen), 1 = no deadlock
set -euo pipefail
cd "$(dirname "$0")"
. ./repro_lib.sh

UID_=$(lower_uuid); TAG=${UID_:0:8}
SHOT=$(lower_uuid)
make_user "$UID_" "$TAG"
PERMIT=$(make_permit "$UID_" "k-$TAG")

open_session S1
send S1 "begin;" "set local role authenticated;" \
  "select set_config('request.jwt.claim.sub', '$UID_', true);" \
  "select 'S1 holds permit ' || id from public.analysis_permits where id = '$PERMIT' for update;" \
  '\echo S1_LOCKED'
wait_marker S1 S1_LOCKED

# S2 in the background: cascades from auth.users → profiles (row locked) →
# analysis_permits (blocked by S1).
open_session S2
send S2 "\\set VERBOSITY terse" "begin;" '\echo S2_BEGIN' \
  "delete from auth.users where id = '$UID_';" '\echo S2_AFTER_DELETE' "commit;" '\echo S2_DONE'
wait_marker S2 S2_BEGIN
# give S2 time to reach the permit lock wait
for _ in 1 2 3 4 5 6 7 8 9 10; do
  WAITING=$(psql1 -c "select count(*) from pg_stat_activity where wait_event_type = 'Lock' and query ilike 'delete from auth.users%'")
  [[ "$WAITING" == "1" ]] && break
  sleep 0.2
done
echo "host> S2 is waiting on a lock: $WAITING"

send S1 "\\set VERBOSITY terse" "$(apply_sql "$SHOT" "$PERMIT")" '\echo S1_APPLIED' "commit;" '\echo S1_DONE'
S1_OUT=$(wait_marker S1 S1_DONE)
echo "$S1_OUT"
S2_OUT=$(wait_marker S2 S2_DONE)
echo "$S2_OUT"
close_session S1; close_session S2

if grep -q "40P01\|deadlock detected" <<<"$S1_OUT$S2_OUT"; then
  echo "REPRODUCED: deadlock (40P01) between account deletion and apply_synced_shot"
  psql1 -c "select 'after: users=' || (select count(*) from auth.users where id = '$UID_')
    || ' shots=' || (select count(*) from public.shots where user_id = '$UID_')
    || ' permits=' || (select count(*) from public.analysis_permits where user_id = '$UID_')
    || ' ledger(google)=' || coalesce((select scored_count::text from public.free_rating_ledger
         where identity_hash = public.free_rating_identity_hash('google','google-$TAG')), '<no row>')"
  exit 0
fi
echo "NOT REPRODUCED"
exit 1
