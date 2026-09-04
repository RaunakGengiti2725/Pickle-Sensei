#!/usr/bin/env bash
# Deterministic two-session repro (READ COMMITTED):
#   two concurrent apply_synced_shot() calls for the SAME shot id / permit.
# The loser of the per-user lock returns `access.permit_not_reserved` instead of
# the replay verdict `accepted`, because the idempotent-replay check runs BEFORE
# the lock and is not repeated after it. A third, sequential call then returns
# `accepted` — the same payload, two different verdicts.
#
# Requires a FRESH THROWAWAY postgres with shim_auth.sql + all migrations applied
# and PGURL pointing at it (superuser). Never point this at a hosted project.
#
# Exit code: 0 when the anomaly reproduced (loser != accepted while the sequential
# replay == accepted); 1 otherwise.
set -euo pipefail
: "${PGURL:?set PGURL to the throwaway database}"
case "$PGURL" in *supabase.co*|*ucqnaiwqwjtgvlduiuib*) echo "refusing hosted URL"; exit 2 ;; esac

U=55555555-5555-4555-8555-555555555555
S=66666666-6666-4666-8666-666666666666
P=77777777-7777-4777-8777-777777777777
SHOT=88888888-8888-4888-8888-888888888888
W=$(mktemp -d)
trap 'rm -rf "$W"' EXIT

psql "$PGURL" -v ON_ERROR_STOP=1 -q <<SQL
insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data)
  values ('$U', 'replay@example.test', '{}', '{"provider":"apple"}');
insert into auth.identities (provider, provider_id, user_id, identity_data)
  values ('apple', 'replay-sub', '$U', '{}');
insert into public.sessions (id, user_id, started_at) values ('$S', '$U', now());
insert into public.analysis_permits (id, user_id, idempotency_key, status)
  values ('$P', '$U', 'replay-key', 'reserved');
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

as_user_prefix="begin isolation level read committed;
set local role authenticated;
select set_config('request.jwt.claim.sub', '$U', true);"

# Session B (winner): takes the same locks apply_synced_shot takes, in the same
# order, holds them long enough for the concurrent replay to queue, then syncs.
psql "$PGURL" -q -At <<SQL > "$W/B.out" 2>&1 &
$as_user_prefix
select pg_catalog.pg_advisory_xact_lock(public.access_lock_key('$U'));
select id from public.analysis_permits where id = '$P' for update;
select pg_sleep(1.0);
select public.apply_synced_shot('$PAYLOAD'::jsonb);
commit;
SQL
B=$!

sleep 0.3
# Session A (concurrent replay of the SAME shot): passes the pre-lock replay
# check (no shot row yet), then blocks on the per-user lock until B commits.
psql "$PGURL" -q -At <<SQL > "$W/A.out" 2>&1 &
$as_user_prefix
select public.apply_synced_shot('$PAYLOAD'::jsonb);
commit;
SQL
A=$!
wait "$A" "$B"

# Sequential replay of the same payload after both committed.
psql "$PGURL" -q -At <<SQL > "$W/C.out" 2>&1
$as_user_prefix
select public.apply_synced_shot('$PAYLOAD'::jsonb);
commit;
SQL

B_RES=$(grep -E '^(accepted|access\.|shot\.)' "$W/B.out" | tail -1)
A_RES=$(grep -E '^(accepted|access\.|shot\.)' "$W/A.out" | tail -1)
C_RES=$(grep -E '^(accepted|access\.|shot\.)' "$W/C.out" | tail -1)
echo "winner (B)              : $B_RES"
echo "concurrent replay (A)   : $A_RES"
echo "sequential replay (C)   : $C_RES"
psql "$PGURL" -c "select id, status, outcome from public.analysis_permits where id = '$P';" \
     -c "select count(*) as shots from public.shots where id = '$SHOT';"

if [[ "$B_RES" == "accepted" && "$C_RES" == "accepted" && "$A_RES" != "accepted" ]]; then
  echo "REPRODUCED: concurrent replay returned '$A_RES' while the sequential replay returned 'accepted'"
  exit 0
fi
echo "NOT REPRODUCED"
exit 1
