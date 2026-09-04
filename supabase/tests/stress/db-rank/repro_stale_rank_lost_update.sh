#!/usr/bin/env bash
# Deterministic 2-session repro: player_rank_state loses an update when a
# writer that does NOT hold access_lock_key(uid) (here: the client-reachable
# `delete from public.sessions` whose `on delete set null` UPDATEs shots and
# fires handle_shot_rank_refresh) overlaps a committed apply_synced_shot for
# the same user. recompute_player_rank() reads its snapshot BEFORE it blocks
# on the state row and then upserts the stale numbers over the newer ones.
#
#   PG_URL=postgres://postgres:pg@127.0.0.1:5499/postgres \
#     ./supabase/tests/stress/db-rank/repro_stale_rank_lost_update.sh
#
# Exit 1 (BROKEN) when the stored state differs from a fresh recompute.
# Both sessions run as `authenticated` with a JWT sub (PostgREST-equivalent).
HERE="$(cd "$(dirname "$0")" && pwd)"
PG_URL=${PG_URL:-${STRESS_PG_URL:-}}
[ -n "$PG_URL" ] || { echo "PG_URL required (see pg_up.sh)"; exit 2; }
# shellcheck source=lib_psql_sessions.sh
source "$HERE/lib_psql_sessions.sh"

U=1f0c0a3e-0000-4000-8000-00000000d0d0
S=1f0c0a3e-0000-4000-8000-00000000c0c0
P=1f0c0a3e-0000-4000-8000-00000000a0a0
SEED=1f0c0a3e-0000-4000-8000-00000000e0e0
NEW=1f0c0a3e-0000-4000-8000-00000000f0f0

pq -q -v ON_ERROR_STOP=1 <<SQL
delete from auth.users where id = '$U';
insert into auth.users (id, email, raw_app_meta_data) values ('$U', 'stale@example.com', '{"provider":"google"}');
insert into public.billing_entitlements (user_id, premium) values ('$U', true);
insert into public.sessions (id, user_id, kind, started_at) values ('$S', '$U', 'practice', now());
insert into public.shots (id, user_id, session_id, shot_type, camera_view, captured_at, start_ms, contact_ms, end_ms,
  overall_score, analysis_confidence, result_kind, app_version, model_bundle_version, pose_model_version,
  paddle_model_version, stroke_detector_version, phase_model_version, scoring_model_version, shot_config_version)
values ('$SEED', '$U', '$S', 'dink', 'side', '2026-09-01T10:00:00Z', 0, 100, 200,
  4.00, 0.9, 'scored', '1.0.0', 'b', 'p', 'pa', 's', 'ph', 'sc', 'c');
insert into public.analysis_permits (id, user_id, idempotency_key, status) values ('$P', '$U', 'stale-$P', 'reserved');
SQL

open_session S1; open_session S2
AUTH="set local role authenticated; set local request.jwt.claim.sub = '$U';"

echo "== S1: authenticated apply_synced_shot (scored 8.00) in an open transaction"
run S1 "begin; $AUTH
select public.apply_synced_shot(jsonb_build_object(
  'id','$NEW','analysisPermitId','$P','sessionId',null,'shotType','drive','cameraView','side',
  'capturedAt','2026-09-01T11:00:00Z','startMs',0,'contactMs',100,'endMs',200,'overallScore',8.0,
  'confidence',0.9,'resultKind','scored','phases','[]'::jsonb,'checkpoints','[]'::jsonb,
  'versionVector', jsonb_build_object('appVersion','1.0.0','modelBundleVersion','b','poseModelVersion','p',
    'paddleModelVersion','pa','strokeDetectorVersion','s','phaseModelVersion','ph','scoringModelVersion','sc',
    'shotConfigVersion','c'))) as rpc;"

echo "== S2: authenticated session delete -> shots.session_id set null -> rank trigger (blocks on the state row)"
start S2 "begin; $AUTH delete from public.sessions where id = '$S'; select 'session_deleted';"
wait_until_blocked "a.query ilike 'delete from public.sessions%'" public.player_rank_state

echo "== S1 commit, then S2 commit"
run S1 "commit;"
finish S2
run S2 "commit;"
close_session S1; close_session S2

pq -At -v ON_ERROR_STOP=1 <<SQL
\echo committed scored rows for U:
select count(*) from public.shots where user_id = '$U' and result_kind = 'scored';
\echo stored player_rank_state:
select rating, tier, technique_count, scored_shot_count from public.player_rank_state where user_id = '$U';
SQL
stored=$(pq -At -c "select rating||'|'||tier||'|'||technique_count||'|'||scored_shot_count from public.player_rank_state where user_id = '$U'")
pq -At -q -c "select public.recompute_player_rank('$U')" >/dev/null
fresh=$(pq -At -c "select rating||'|'||tier||'|'||technique_count||'|'||scored_shot_count from public.player_rank_state where user_id = '$U'")
echo "after fresh recompute_player_rank: $fresh"
if [ "$stored" != "$fresh" ]; then
  echo "BROKEN: stale player_rank_state (stored=$stored, recompute=$fresh)"; exit 1
fi
echo "HELD: stored state == recompute"
