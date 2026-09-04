#!/usr/bin/env bash
# Repro: an authenticated user can INSERT shot_phases / shot_checkpoints /
# shot_measurements rows that reference ANOTHER user's shot id.
#
# The detail-table INSERT policies (20260829120000_progress_data.sql) only
# check `user_id = auth.uid()`; the FK to public.shots(id) is validated as the
# table owner, so RLS on public.shots does not "close the loop" as the
# migration comment claims.  Expected: the insert is denied (42501 / 23503).
# Observed: the rows are inserted and the script exits 1 ("BROKEN").
#
#   ./stress_pg_up.sh && ./repro/cross_user_detail_attach.sh
set -euo pipefail
CONTAINER=${STRESS_PG_CONTAINER:-pickle-stress-pg}
PSQL=(docker exec -i "$CONTAINER" psql -U postgres)
A=11111111-1111-4111-8111-111111111111
B=22222222-2222-4222-8222-222222222222
SHOT=33333333-3333-4333-8333-333333333333

"${PSQL[@]}" -v ON_ERROR_STOP=1 -q <<SQL
delete from auth.users where id in ('$A','$B');
insert into auth.users (id, email) values ('$A','a-repro@example.test'), ('$B','b-repro@example.test');
insert into auth.identities (id, user_id, provider, provider_id, identity_data)
  values (gen_random_uuid(), '$A', 'apple', 'repro-a', '{}'), (gen_random_uuid(), '$B', 'apple', 'repro-b', '{}');
-- A owns a scored shot (owner-side insert; no JWT sub so the permit gate is bypassed)
insert into public.shots (
  id, user_id, shot_type, camera_view, captured_at, start_ms, contact_ms, end_ms,
  overall_score, analysis_confidence, result_kind, app_version, model_bundle_version,
  pose_model_version, paddle_model_version, stroke_detector_version, phase_model_version,
  scoring_model_version, shot_config_version
) values ('$SHOT', '$A', 'dink', 'side', '2026-09-01T10:00:00Z', 0, 100, 200, 7.5, 0.9, 'scored',
  '1.0.0', 'bundle-1', 'pose-1', 'paddle-1', 'stroke-1', 'phase-1', 'scoring-1', 'config-1');
SQL

echo "--- B attaches detail rows to A's shot as role authenticated (expected: denied) ---"
set +e
"${PSQL[@]}" -v ON_ERROR_STOP=1 -q <<SQL
begin;
set local role authenticated;
set local request.jwt.claims = '{"sub":"$B","role":"authenticated"}';
set local request.jwt.claim.sub = '$B';
insert into public.shot_phases (shot_id, user_id, phase_key, start_ms, representative_ms, end_ms, confidence)
  values ('$SHOT', '$B', 'contact', 0, 5, 10, 0.9);
insert into public.shot_checkpoints (shot_id, user_id, checkpoint_key, score, confidence, band, direction, severity, applicable)
  values ('$SHOT', '$B', 'paddle_up', 50, 0.9, 'yellow', 'up', 0.5, true);
insert into public.shot_measurements (shot_id, user_id, metric_key, value, confidence, unit)
  values ('$SHOT', '$B', 'elbow_angle', 42, 0.9, 'degrees');
commit;
SQL
rc=$?
set -e
echo "authenticated-B insert block exit=$rc (0 = rows were accepted)"
"${PSQL[@]}" -Atc "select 'shot_phases', count(*) from public.shot_phases where shot_id='$SHOT' and user_id<>(select user_id from public.shots where id='$SHOT')
 union all select 'shot_checkpoints', count(*) from public.shot_checkpoints where shot_id='$SHOT' and user_id<>(select user_id from public.shots where id='$SHOT')
 union all select 'shot_measurements', count(*) from public.shot_measurements where shot_id='$SHOT' and user_id<>(select user_id from public.shots where id='$SHOT')"
"${PSQL[@]}" -q -c "delete from auth.users where id in ('$A','$B')"
if [ "$rc" -eq 0 ]; then echo "BROKEN: cross-owner detail rows were inserted"; exit 1; fi
echo "HELD: cross-owner detail insert denied"
