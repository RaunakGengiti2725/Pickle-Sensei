#!/usr/bin/env bash
# Structural audit #1 — concurrency probes. Runs INSIDE the postgres container
# (needs psql on PATH and a superuser `postgres`), after probes.sql.
#
# Emits RESULT|<id>|PASS/FAIL/INFO|<detail> lines like probes.sql.
#
#   C1  two apply_synced_shot() calls for ONE user holding DIFFERENT permits,
#       racing the free-limit backstop: exactly one may land the 2nd rating.
#   C2  two users racing the SAME shots.id: loser gets shot.id_conflict and
#       keeps its permit reserved (no lost permit, no foreign row).
#   C3  authenticated raw-SQL caller holding pg_advisory_xact_lock(
#       access_lock_key(<other user>)) stalls the other user's reserve —
#       measures the stall (INFO: requires direct SQL, not reachable via
#       PostgREST which exposes only schema public).
set -uo pipefail

PSQL="psql -U postgres -v ON_ERROR_STOP=1 -qtA"
X=00000000-0000-4000-8000-00000000001a   # racer with 1 scored + 2 reserved permits
Y=00000000-0000-4000-8000-00000000001b   # second user for the id race
PX1=00000000-0000-4000-8000-0000000000b1
PX2=00000000-0000-4000-8000-0000000000b2
PX3=00000000-0000-4000-8000-0000000000b3
PY1=00000000-0000-4000-8000-0000000000b4
SHARED_ID=00000000-0000-4000-8000-0000000000cc

payload() { # $1 shot id, $2 permit id
  cat <<EOF
jsonb_build_object('id','$1','analysisPermitId','$2','resultKind','scored','shotType','drive','cameraView','side',
 'capturedAt','2026-08-31T10:00:00Z','startMs',0,'contactMs',500,'endMs',1000,'overallScore',7.1,'confidence',0.9,
 'versionVector',jsonb_build_object('appVersion','1','modelBundleVersion','1','poseModelVersion','1','paddleModelVersion','1',
  'strokeDetectorVersion','1','phaseModelVersion','1','scoringModelVersion','1','shotConfigVersion','1'),
 'phases','[]'::jsonb,'checkpoints','[]'::jsonb)
EOF
}

$PSQL <<SQL
insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data) values
  ('$X', 'xavier@example.com', '{}', '{"provider":"google"}'),
  ('$Y', 'yara@example.com',   '{}', '{"provider":"apple"}');
insert into auth.identities (provider, provider_id, user_id, identity_data) values
  ('google', 'google-sub-x', '$X', '{"sub":"google-sub-x"}'),
  ('apple',  'apple-sub-y',  '$Y', '{"sub":"apple-sub-y"}');
insert into public.shots (id, user_id, shot_type, captured_at, start_ms, end_ms, overall_score, analysis_confidence,
  result_kind, app_version, model_bundle_version, pose_model_version, paddle_model_version, stroke_detector_version,
  phase_model_version, scoring_model_version, shot_config_version)
values (gen_random_uuid(), '$X', 'dink', now(), 0, 1000, 6.0, 0.9, 'scored', '1','1','1','1','1','1','1','1');
-- over-issued permits (simulates any pre-reserve_analysis_permit build)
insert into public.analysis_permits (id, user_id, idempotency_key) values
  ('$PX1', '$X', 'x1'), ('$PX2', '$X', 'x2'), ('$PX3', '$X', 'x3'), ('$PY1', '$Y', 'y1');
SQL

# ─────────────────────────────── C1 ──────────────────────────────────────────
$PSQL <<SQL > /tmp/c1_s1.out 2>&1 &
begin;
set local role authenticated;
set local request.jwt.claim.sub = '$X';
select 'S1=' || public.apply_synced_shot($(payload 00000000-0000-4000-8000-0000000000c1 $PX1));
select pg_sleep(3);
commit;
SQL
sleep 1
t0=$(date +%s%N)
$PSQL <<SQL > /tmp/c1_s2.out 2>&1
begin;
set local role authenticated;
set local request.jwt.claim.sub = '$X';
select 'S2=' || public.apply_synced_shot($(payload 00000000-0000-4000-8000-0000000000c2 $PX2));
commit;
SQL
t1=$(date +%s%N)
wait
s1=$(grep -o 'S1=.*' /tmp/c1_s1.out | head -1)
s2=$(grep -o 'S2=.*' /tmp/c1_s2.out | head -1)
blocked_ms=$(( (t1 - t0) / 1000000 ))
final=$($PSQL -c "select (select count(*) from public.shots where user_id='$X' and result_kind='scored') || ' scored; p1=' ||
  (select status||'/'||coalesce(outcome,'null') from public.analysis_permits where id='$PX1') || ' p2=' ||
  (select status||'/'||coalesce(outcome,'null') from public.analysis_permits where id='$PX2')")
if [ "$s1" = "S1=accepted" ] && [ "$s2" = "S2=access.paywall_required" ] && [ "$blocked_ms" -ge 1500 ] \
   && [[ "$final" == "2 scored; p1=finalized/scored p2=released/free_limit_exceeded" ]]; then
  echo "RESULT|C1-different-permits-race-backstop|PASS|$s1 $s2 s2_blocked_ms=$blocked_ms final: $final"
else
  echo "RESULT|C1-different-permits-race-backstop|FAIL|$s1 $s2 s2_blocked_ms=$blocked_ms final: $final"
  cat /tmp/c1_s1.out /tmp/c1_s2.out
fi

# ─────────────────────────────── C2 ──────────────────────────────────────────
# Y (never scored) inserts SHARED_ID and holds the txn; X (premium so the
# backstop is not what stops it) races the same id with a fresh permit.
$PSQL -c "insert into public.billing_entitlements (user_id, premium) values ('$X', true)"
$PSQL <<SQL > /tmp/c2_s1.out 2>&1 &
begin;
set local role authenticated;
set local request.jwt.claim.sub = '$Y';
select 'S1=' || public.apply_synced_shot($(payload $SHARED_ID $PY1));
select pg_sleep(3);
commit;
SQL
sleep 1
t0=$(date +%s%N)
$PSQL <<SQL > /tmp/c2_s2.out 2>&1
begin;
set local role authenticated;
set local request.jwt.claim.sub = '$X';
select 'S2=' || public.apply_synced_shot($(payload $SHARED_ID $PX3));
commit;
SQL
t1=$(date +%s%N)
wait
s1=$(grep -o 'S1=.*' /tmp/c2_s1.out | head -1)
s2=$(grep -o 'S2=.*' /tmp/c2_s2.out | head -1)
blocked_ms=$(( (t1 - t0) / 1000000 ))
final=$($PSQL -c "select 'owner=' || (select case when user_id='$Y' then 'Y' else 'X' end from public.shots where id='$SHARED_ID') ||
  ' px3=' || (select status||'/'||coalesce(outcome,'null') from public.analysis_permits where id='$PX3') ||
  ' py1=' || (select status||'/'||coalesce(outcome,'null') from public.analysis_permits where id='$PY1') ||
  ' x_rows_with_shared_id=' || (select count(*) from public.shots where id='$SHARED_ID' and user_id='$X')")
if [ "$s1" = "S1=accepted" ] && [ "$s2" = "S2=shot.id_conflict" ] && [ "$blocked_ms" -ge 1500 ] \
   && [[ "$final" == "owner=Y px3=reserved/null py1=finalized/scored x_rows_with_shared_id=0" ]]; then
  echo "RESULT|C2-cross-user-id-race|PASS|$s1 $s2 s2_blocked_ms=$blocked_ms final: $final"
else
  echo "RESULT|C2-cross-user-id-race|FAIL|$s1 $s2 s2_blocked_ms=$blocked_ms final: $final"
  cat /tmp/c2_s1.out /tmp/c2_s2.out
fi

# ─────────────────────────────── C3 ──────────────────────────────────────────
$PSQL <<SQL > /tmp/c3_s1.out 2>&1 &
begin;
set local role authenticated;
set local request.jwt.claim.sub = '$Y';
select 'S1=' || coalesce(pg_catalog.pg_advisory_xact_lock(public.access_lock_key('$X'))::text, 'locked');
select pg_sleep(3);
commit;
SQL
sleep 1
t0=$(date +%s%N)
$PSQL <<SQL > /tmp/c3_s2.out 2>&1
begin;
set local role authenticated;
set local request.jwt.claim.sub = '$X';
select 'S2=' || result from public.reserve_analysis_permit('x-after-dos');
commit;
SQL
t1=$(date +%s%N)
wait
s1=$(grep -o 'S1=.*' /tmp/c3_s1.out | head -1)
s2=$(grep -o 'S2=.*' /tmp/c3_s2.out | head -1)
blocked_ms=$(( (t1 - t0) / 1000000 ))
echo "RESULT|C3-foreign-advisory-lock-stall|INFO|Y held X's lock via raw SQL: $s1; X reserve $s2 stalled_ms=$blocked_ms (raw SQL only; PostgREST cannot reach pg_catalog.pg_advisory_xact_lock)"
echo "CONCURRENCY COMPLETE"
