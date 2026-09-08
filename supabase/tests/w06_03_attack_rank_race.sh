#!/usr/bin/env bash
# W06-03 ADVERSARIAL — lost update between two overlapping shots writers of
# ONE player (owner/service path: no JWT subject, no advisory lock).
#
#   session A: begin; insert dink 4.00  (AFTER trigger recomputes → 4.00, row locked)
#   session B:        insert serve 8.00 (trigger recomputes from B's snapshot,
#                     which cannot see A's uncommitted dink → 8.00; its upsert
#                     waits on A's row lock)
#   session A: commit → B's DO UPDATE applies 8.00 / 1 technique / 1 shot
#
# Both shots are committed; v2 over the committed evidence is 6.00 / 2 / 2
# (gold). The saved row says 8.00 / 1 / 1 (diamond) and — on the candidate —
# is stamped rank-form-weighted-v2, a definition that does not produce it.
#
# Usage (psql must reach a database with every migration applied):
#   PSQL="docker exec -i <container> psql -U postgres -d <db>" \
#     ./supabase/tests/w06_03_attack_rank_race.sh
# Exit 0 = saved row equals the recompute (no break); 1 = break reproduced.
set -euo pipefail

PSQL=${PSQL:-"psql"}
USER_ID=${ATTACK_USER_ID:-"0d0d0d0d-0d0d-4d0d-8d0d-0d0d0d0d0d0d"}

INSERT_ROW() {
  cat <<SQL
insert into public.shots
  (id, user_id, shot_type, camera_view, captured_at, start_ms, contact_ms, end_ms,
   overall_score, analysis_confidence, result_kind, source,
   app_version, model_bundle_version, pose_model_version, paddle_model_version,
   stroke_detector_version, phase_model_version, scoring_model_version, shot_config_version)
values ('$1', '$USER_ID', '$2', 'side', '$3', 0, 100, 200, $4, 0.9, 'scored', 'real',
        '1', '1', '1', '1', '1', '1', '1', '1');
SQL
}

$PSQL -v ON_ERROR_STOP=1 -q <<SQL
delete from auth.users where id = '$USER_ID';
insert into auth.users (id, email) values ('$USER_ID', 'race@attack.example');
SQL

# Session A holds its transaction open for ~3s after inserting.
{
  echo "begin;"
  INSERT_ROW 0d0d0d0d-0d0d-4d0d-8d0d-00000000000a dink '2026-01-01T00:00:00Z' 4.00
  echo "do \$\$ begin perform pg_sleep(3); end \$\$;"
  echo "commit;"
} | $PSQL -v ON_ERROR_STOP=1 -q &
A_PID=$!
sleep 1
# Session B autocommits while A is still open.
INSERT_ROW 0d0d0d0d-0d0d-4d0d-8d0d-00000000000b serve '2026-01-02T00:00:00Z' 8.00 \
  | $PSQL -v ON_ERROR_STOP=1 -q
wait "$A_PID"

$PSQL -v ON_ERROR_STOP=1 -At <<SQL
select 'shots=' || count(*) from public.shots where user_id = '$USER_ID';
select 'saved=' || rating || '/' || tier || '/' || technique_count || '/' || scored_shot_count
       || coalesce('/' || (to_jsonb(s) ->> 'definition_version'), '')
  from public.player_rank_state s where user_id = '$USER_ID';
select 'live=' || round(sum(confidence_weight * round(score * 100)) / sum(confidence_weight)) / 100.0
       || '/' || count(*) || ' techniques'
  from public.player_technique_rating where user_id = '$USER_ID';
SQL

STALE=$($PSQL -At -c "
  select count(*) from public.player_rank_state s
  where s.user_id = '$USER_ID' and s.rating is distinct from (
    select round(sum(confidence_weight * round(score * 100)) / sum(confidence_weight)) / 100.0
    from public.player_technique_rating v where v.user_id = s.user_id)")

$PSQL -q -c "delete from auth.users where id = '$USER_ID';"

if [ "$STALE" != "0" ]; then
  echo "W06-03 ATTACK RACE: BREAK — saved rank is not the recompute of the committed evidence"
  exit 1
fi
echo "W06-03 ATTACK RACE: no break"
