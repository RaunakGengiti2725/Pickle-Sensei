#!/usr/bin/env bash
# Minimal 2-session repro of the player_rank_state lost update, stripped to
# its root cause: two writers that do NOT serialize on access_lock_key(uid)
# (owner/service-role direct INSERTs into public.shots, as the campaign's
# `owner_direct_scored_inserts` scenario does) each run
# handle_shot_rank_refresh → recompute_player_rank() inside their own
# READ COMMITTED transaction. The second writer aggregates public.shots from a
# snapshot that cannot see the first writer's uncommitted row, blocks on the
# first writer's player_rank_state row in `insert … on conflict do update`,
# and once unblocked overwrites the newer state with its stale numbers.
#
#   PG_URL=postgres://postgres:pg@127.0.0.1:5499/postgres \
#     ./supabase/tests/stress/db-rank/repro_owner_direct_lost_update.sh
#
# Exit 1 (BROKEN) when the stored state differs from a fresh recompute.
HERE="$(cd "$(dirname "$0")" && pwd)"
PG_URL=${PG_URL:-${STRESS_PG_URL:-}}
[ -n "$PG_URL" ] || { echo "PG_URL required (see pg_up.sh)"; exit 2; }
# shellcheck source=lib_psql_sessions.sh
source "$HERE/lib_psql_sessions.sh"

U=1f0c0a3e-0000-4000-8000-00000000d1d1
A=1f0c0a3e-0000-4000-8000-00000000a1a1
B=1f0c0a3e-0000-4000-8000-00000000b1b1

shot_sql() {                # shot_sql <id> <shot_type> <score>
  cat <<SQL
insert into public.shots (id, user_id, session_id, shot_type, camera_view, captured_at, start_ms, contact_ms, end_ms,
  overall_score, analysis_confidence, result_kind, app_version, model_bundle_version, pose_model_version,
  paddle_model_version, stroke_detector_version, phase_model_version, scoring_model_version, shot_config_version)
values ('$1', '$U', null, '$2', 'side', '2026-09-01T10:00:00Z', 0, 100, 200,
  $3, 0.9, 'scored', '1.0.0', 'b', 'p', 'pa', 's', 'ph', 'sc', 'c');
SQL
}

pq -q -v ON_ERROR_STOP=1 <<SQL
delete from auth.users where id = '$U';
insert into auth.users (id, email, raw_app_meta_data) values ('$U', 'owner-lost@example.com', '{"provider":"google"}');
SQL

open_session S1; open_session S2

echo "== S1: owner inserts scored shot A (dink 8.00) in an open transaction → trigger writes state {8.00, 1 technique, 1 shot}"
run S1 "begin; $(shot_sql "$A" dink 8.00) select 'A_inserted';"

echo "== S2: owner inserts scored shot B (drive 2.00) → recompute sees only B, then blocks on S1's state row"
start S2 "begin; $(shot_sql "$B" drive 2.00) select 'B_inserted';"
wait_until_blocked "a.query ilike 'insert into public.shots%'" public.player_rank_state

echo "== S1 commit, then S2 completes and commits"
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
