#!/usr/bin/env bash
# Deterministic two-session repro (READ COMMITTED):
#   auth.users deletion cascade  vs  apply_synced_shot() holding the permit row
# ends in `deadlock detected` (SQLSTATE 40P01) for one of the two sessions.
#
# Lock order that conflicts:
#   session A  delete from auth.users        -> profiles row (deleted) -> ... -> waits on analysis_permits row
#   session B  apply_synced_shot(payload)    -> analysis_permits row FOR UPDATE -> insert shots
#                                              -> RI check on profiles/sessions waits on A
#
# Requires a FRESH THROWAWAY postgres with shim_auth.sql + all migrations applied
# and PGURL pointing at it (superuser). Never point this at a hosted project.
#
# Exit code: 0 when the deadlock reproduced (one session reported 40P01, either as
# an ERROR or inside apply_synced_shot's `shot.write_failed:` status); 1 otherwise.
set -euo pipefail
: "${PGURL:?set PGURL to the throwaway database}"
case "$PGURL" in *supabase.co*|*ucqnaiwqwjtgvlduiuib*) echo "refusing hosted URL"; exit 2 ;; esac

U=11111111-1111-4111-8111-111111111111
S=22222222-2222-4222-8222-222222222222
P=33333333-3333-4333-8333-333333333333
SHOT=44444444-4444-4444-8444-444444444444
W=$(mktemp -d)
trap 'rm -rf "$W"' EXIT

psql "$PGURL" -v ON_ERROR_STOP=1 -q <<SQL
insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data)
  values ('$U', 'deadlock@example.test', '{}', '{"provider":"apple"}');
insert into auth.identities (provider, provider_id, user_id, identity_data)
  values ('apple', 'deadlock-sub', '$U', '{}');
insert into public.sessions (id, user_id, started_at) values ('$S', '$U', now());
insert into public.analysis_permits (id, user_id, idempotency_key, status)
  values ('$P', '$U', 'deadlock-key', 'reserved');
SQL

PAYLOAD=$(cat <<JSON
{"id":"$SHOT","sessionId":"$S","analysisPermitId":"$P","shotType":"dink","cameraView":"side",
 "capturedAt":"2026-09-04T00:00:00Z","startMs":0,"contactMs":400,"endMs":900,
 "overallScore":7.5,"confidence":0.9,"resultKind":"scored",
 "versionVector":{"appVersion":"1.0.0-repro","modelBundleVersion":"b","poseModelVersion":"p",
   "paddleModelVersion":"pd","strokeDetectorVersion":"s","phaseModelVersion":"ph",
   "scoringModelVersion":"sc","shotConfigVersion":"cfg"},
 "phases":[{"key":"ready","startMs":0,"representativeMs":75,"endMs":150,"confidence":0.9}],
 "checkpoints":[{"key":"paddle_ready","score":80,"confidence":0.9,"band":"green","direction":"up","severity":0.1,"applicable":true}]}
JSON
)

# Session B: the user's sync. It takes the permit row lock first (exactly what
# apply_synced_shot does at its FOR UPDATE), pauses so the delete can queue
# behind it, then runs the RPC in the same transaction.
psql "$PGURL" -q <<SQL > "$W/B.out" 2>&1 &
begin isolation level read committed;
set local role authenticated;
select set_config('request.jwt.claim.sub', '$U', true);
select id from public.analysis_permits where id = '$P' for update;
select pg_sleep(1.5);
select public.apply_synced_shot('$PAYLOAD'::jsonb) as sync_result;
commit;
SQL
B=$!

sleep 0.5
# Session A: what auth.admin.deleteUser does (GoTrue deletes the auth.users row).
psql "$PGURL" -q -c "delete from auth.users where id = '$U';" > "$W/A.out" 2>&1 &
A=$!

set +e
wait "$A"; A_EXIT=$?
wait "$B"; B_EXIT=$?
set -e
echo "== session A (delete from auth.users) exit=$A_EXIT"; cat "$W/A.out"
echo "== session B (apply_synced_shot) exit=$B_EXIT"; cat "$W/B.out"
echo "== rows left for $U"
psql "$PGURL" -At -c "select 'profiles', count(*) from public.profiles where id = '$U'
  union all select 'shots', count(*) from public.shots where user_id = '$U'
  union all select 'permits', count(*) from public.analysis_permits where user_id = '$U'
  union all select 'auth.users', count(*) from auth.users where id = '$U';"

if grep -q "deadlock detected" "$W/A.out" "$W/B.out"; then
  echo "REPRODUCED: deadlock detected (40P01) between account deletion and apply_synced_shot"
  exit 0
fi
echo "NOT REPRODUCED"
exit 1
