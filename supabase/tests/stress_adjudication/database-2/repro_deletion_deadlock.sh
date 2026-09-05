#!/usr/bin/env bash
# database-2 adjudication — deterministic repro of the account-deletion vs
# apply_synced_shot() deadlock (40P01).
#
#   deleter : delete from auth.users              → cascades profiles (row X-lock)
#             → cascades analysis_permits          → waits on the permit row the RPC updated
#   RPC     : update analysis_permits (row lock)   → insert into public.shots
#             → FK check on profiles(id)           → waits on the deleter's profile row
#
# The window is forced open by holding an EXCLUSIVE lock on public.shots so the
# RPC parks between its permit update and the shots insert.
#
#   ADJ_PG_CONTAINER=<postgres:16 container with shim + migrations> \
#     ./supabase/tests/stress_adjudication/database-2/repro_deletion_deadlock.sh
#   exit 0 = deadlock reproduced (defect present); exit 1 = no deadlock (fixed).
set -euo pipefail
CONTAINER=${ADJ_PG_CONTAINER:-pickle-adj-pg}

psql_owner() { docker exec -i "$CONTAINER" psql -X -v ON_ERROR_STOP=1 -qAt -U postgres -d postgres -c "$1"; }
psql_as() {
  docker exec -i "$CONTAINER" psql -X -v ON_ERROR_STOP=1 -qAt -U postgres -d postgres -c "
    begin;
    set local role $1;
    select set_config('request.jwt.claim.sub', '$2', true);
    $3
    commit;"
}
new_uuid() { docker exec "$CONTAINER" psql -X -qAt -U postgres -d postgres -c "select gen_random_uuid()"; }

U=$(new_uuid); SHOT=$(new_uuid)
X_PID=""; A_PID=""; D_PID=""
cleanup() {
  exec 3>&- 2>/dev/null || true
  for p in $X_PID $A_PID $D_PID; do kill "$p" 2>/dev/null || true; done
  psql_owner "delete from auth.users where id = '$U'" >/dev/null 2>&1 || true
}
trap cleanup EXIT

psql_owner "insert into auth.users (id, email, raw_app_meta_data) values ('$U', '$U@example.com', '{\"provider\":\"google\"}');
            insert into auth.identities (provider, provider_id, user_id, identity_data) values ('google', 'adj-dl-$U', '$U', '{\"sub\":\"adj-dl-$U\"}');" >/dev/null
PERMIT=$(psql_as authenticated "$U" "select x.permit_id from public.reserve_analysis_permit('adj-deadlock') x;" | tail -1)
PAYLOAD="{\"id\":\"$SHOT\",\"analysisPermitId\":\"$PERMIT\",\"sessionId\":null,\"shotType\":\"dink\",\"cameraView\":\"side\",\"capturedAt\":\"2026-09-01T10:00:00.000Z\",\"startMs\":0,\"contactMs\":100,\"endMs\":200,\"overallScore\":7,\"confidence\":0.9,\"resultKind\":\"scored\",\"phases\":[],\"checkpoints\":[],\"versionVector\":{\"appVersion\":\"1.0.0\",\"modelBundleVersion\":\"b\",\"poseModelVersion\":\"p\",\"paddleModelVersion\":\"pa\",\"strokeDetectorVersion\":\"s\",\"phaseModelVersion\":\"ph\",\"scoringModelVersion\":\"sc\",\"shotConfigVersion\":\"c\"}}"

wait_for_waiter() {
  for _ in $(seq 1 100); do
    n=$(psql_owner "select count(*) from pg_stat_activity where wait_event_type = 'Lock' and query ilike '%$1%' and pid <> pg_backend_pid()")
    [ "$n" != "0" ] && return 0
    sleep 0.1
  done
  echo "no backend waiting on $1 after 10s" >&2; return 1
}

FIFO=$(mktemp -u); mkfifo "$FIFO"
docker exec -i "$CONTAINER" psql -X -v ON_ERROR_STOP=1 -qAt -U postgres -d postgres < "$FIFO" > /tmp/adj_deadlock_X.out 2>&1 &
X_PID=$!
exec 3>"$FIFO"
echo "begin; lock table public.shots in exclusive mode;" >&3
sleep 0.5

# A: the user's sync RPC — locks the permit row, then parks on public.shots.
psql_as authenticated "$U" "select public.apply_synced_shot('$PAYLOAD'::jsonb);" > /tmp/adj_deadlock_A.out 2>&1 &
A_PID=$!
wait_for_waiter apply_synced_shot

# D: account deletion (auth.admin.deleteUser → delete from auth.users) — cascades
# through profiles and parks on the permit row A holds.
psql_owner "delete from auth.users where id = '$U';" > /tmp/adj_deadlock_D.out 2>&1 &
D_PID=$!
wait_for_waiter "delete from auth.users"

# X releases; A resumes into the shots insert → FK check on the profile row D is deleting.
echo "commit;" >&3
exec 3>&-
wait "$X_PID" || true
set +e
wait "$A_PID"; A_RC=$?
wait "$D_PID"; D_RC=$?
set -e
echo "--- RPC lane (exit $A_RC):";    cat /tmp/adj_deadlock_A.out
echo "--- delete lane (exit $D_RC):"; cat /tmp/adj_deadlock_D.out
EXISTS=$(psql_owner "select count(*) from auth.users where id = '$U'")
echo "auth.users row still present after deletion attempt: $EXISTS"
if grep -q "deadlock detected" /tmp/adj_deadlock_A.out /tmp/adj_deadlock_D.out; then
  echo "REPRODUCED: 40P01 deadlock between account deletion cascade and apply_synced_shot"
  exit 0
fi
echo "not reproduced"
exit 1
