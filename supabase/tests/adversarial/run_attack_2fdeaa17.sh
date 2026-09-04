#!/usr/bin/env bash
# Adversarial matrix for 2fdeaa17 (DB-01/02/03): sequential variants
# (attack_2fdeaa17.sql) plus three concurrency variants that the sequential
# file cannot express:
#   C1 two concurrent direct scored inserts by one free user holding one
#      reserved permit at 1 lifetime rating -> exactly one may land;
#   C2 identity link committed while a DIRECT scored insert holds the per-user
#      lock -> the late identity inherits the count;
#   C3 client reopen UPDATE (no status filter) racing an in-flight finalize ->
#      must raise access.permit_already_finalized, never win.
#
#   ./supabase/tests/adversarial/run_attack_2fdeaa17.sh
set -euo pipefail

cd "$(dirname "$0")/../.."   # -> supabase/

if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  echo "Docker is required for this check." >&2
  exit 1
fi

CONTAINER=pickle-attack-2fdeaa17
cleanup() { docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup

docker run -d --name "$CONTAINER" -e POSTGRES_PASSWORD=pg postgres:16 >/dev/null
for _ in $(seq 1 30); do
  docker exec "$CONTAINER" pg_isready -U postgres >/dev/null 2>&1 && break
  sleep 1
done

docker cp tests "$CONTAINER":/tests
docker cp migrations "$CONTAINER":/migrations

docker exec "$CONTAINER" bash -c '
  set -euo pipefail
  psql -U postgres -v ON_ERROR_STOP=1 -q -f /tests/shim_auth.sql
  for f in /migrations/*.sql; do
    psql -U postgres -v ON_ERROR_STOP=1 -q -f "$f" >/dev/null 2>&1
  done
  echo "── sequential variants"
  psql -U postgres -v ON_ERROR_STOP=1 -f /tests/adversarial/attack_2fdeaa17.sql
'

P() { docker exec -i "$CONTAINER" psql -U postgres -d postgres -v ON_ERROR_STOP=0 -Atq "$@"; }
U1=00000000-0000-4000-8000-0000000000c1
U2=00000000-0000-4000-8000-0000000000c2
U3=00000000-0000-4000-8000-0000000000c3
COLS='(id,user_id,shot_type,camera_view,captured_at,start_ms,contact_ms,end_ms,overall_score,analysis_confidence,result_kind,app_version,model_bundle_version,pose_model_version,paddle_model_version,stroke_detector_version,phase_model_version,scoring_model_version,shot_config_version,source)'
VALS="'drive','side',now(),0,500,1000,9.5,0.9,'scored','1.0.0','b','p','pa','s','ph','sc','c','real'"
PAYLOAD="jsonb_build_object('id','00000000-0000-4000-8000-0000000000d1','analysisPermitId',(select id from public.analysis_permits where idempotency_key='c1-a'),'resultKind','scored','shotType','drive','cameraView','side','capturedAt','2026-08-31T10:00:00Z','startMs',0,'contactMs',500,'endMs',1000,'overallScore',7.1,'confidence',0.9,'versionVector',jsonb_build_object('appVersion','1','modelBundleVersion','b','poseModelVersion','p','paddleModelVersion','pa','strokeDetectorVersion','s','phaseModelVersion','ph','scoringModelVersion','sc','shotConfigVersion','c'))"

P <<SQL
insert into auth.users (id,email,raw_app_meta_data) values
  ('$U1','c1@example.com','{"provider":"google"}'),
  ('$U2','c2@example.com','{"provider":"google"}'),
  ('$U3','c3@example.com','{"provider":"google"}');
insert into auth.identities (provider,provider_id,user_id,identity_data) values
  ('google','c1-g','$U1','{}'),('google','c2-g','$U2','{}'),('google','c3-g','$U3','{}');
SQL

echo "── C1: concurrent direct scored inserts, free user at 1 rating with one reserved permit"
P <<SQL
set role authenticated; set request.jwt.claim.sub = '$U1';
select public.reserve_analysis_permit('c1-a');
select public.apply_synced_shot($PAYLOAD);
select public.reserve_analysis_permit('c1-b');
SQL
( P <<SQL
begin; set local role authenticated; set local request.jwt.claim.sub = '$U1';
insert into public.shots $COLS values ('00000000-0000-4000-8000-0000000000d2','$U1',$VALS);
select pg_sleep(2);
commit;
SQL
) >/tmp/attack_c1a.out 2>&1 &
sleep 0.7
( P <<SQL
begin; set local role authenticated; set local request.jwt.claim.sub = '$U1';
insert into public.shots $COLS values ('00000000-0000-4000-8000-0000000000d3','$U1',$VALS);
commit;
SQL
) >/tmp/attack_c1b.out 2>&1 &
wait
C1=$(P -c "select count(*) from public.shots where user_id='$U1' and result_kind='scored'")
if [ "$C1" != "2" ]; then echo "C1 FAILED: scored rows=$C1 (expected 2)"; cat /tmp/attack_c1a.out /tmp/attack_c1b.out; exit 1; fi
if ! grep -q "access.paywall_required" /tmp/attack_c1a.out /tmp/attack_c1b.out; then
  echo "C1 FAILED: no paywall refusal recorded"; cat /tmp/attack_c1a.out /tmp/attack_c1b.out; exit 1
fi
echo "C1 HELD: one of two concurrent inserts refused with access.paywall_required"

echo "── C2: identity link while a direct scored insert holds the lock"
P <<SQL
set role authenticated; set request.jwt.claim.sub = '$U2';
select public.reserve_analysis_permit('c2-a');
SQL
( P <<SQL
begin; set local role authenticated; set local request.jwt.claim.sub = '$U2';
insert into public.shots $COLS values ('00000000-0000-4000-8000-0000000000d4','$U2',$VALS);
select pg_sleep(2);
commit;
SQL
) >/tmp/attack_c2a.out 2>&1 &
sleep 0.7
( P -c "insert into auth.identities (provider,provider_id,user_id,identity_data) values ('apple','c2-a','$U2','{}');" ) >/tmp/attack_c2b.out 2>&1 &
wait
G=$(P -c "select coalesce((select scored_count from public.free_rating_ledger where identity_hash=public.free_rating_identity_hash('google','c2-g')),0)")
A=$(P -c "select coalesce((select scored_count from public.free_rating_ledger where identity_hash=public.free_rating_identity_hash('apple','c2-a')),0)")
if [ "$G" != "1" ] || [ "$A" != "1" ]; then echo "C2 FAILED: google=$G apple=$A"; cat /tmp/attack_c2a.out /tmp/attack_c2b.out; exit 1; fi
echo "C2 HELD: late-linked identity inherited the in-flight count (google=$G apple=$A)"

echo "── C3: client reopen racing an in-flight finalize"
P <<SQL
set role authenticated; set request.jwt.claim.sub = '$U3';
select public.reserve_analysis_permit('c3-a');
SQL
PID=$(P -c "select id from public.analysis_permits where idempotency_key='c3-a'")
( P <<SQL
begin; set local role authenticated; set local request.jwt.claim.sub = '$U3';
update public.analysis_permits set status='finalized', outcome='scored' where id='$PID' and status='reserved';
select pg_sleep(2);
commit;
SQL
) >/tmp/attack_c3a.out 2>&1 &
sleep 0.7
( P <<SQL
set role authenticated; set request.jwt.claim.sub = '$U3';
update public.analysis_permits set status='reserved', outcome=null where id='$PID';
SQL
) >/tmp/attack_c3b.out 2>&1 &
wait
S=$(P -c "select status || '/' || coalesce(outcome,'') from public.analysis_permits where id='$PID'")
if [ "$S" != "finalized/scored" ] || ! grep -q "access.permit_already_finalized" /tmp/attack_c3b.out; then
  echo "C3 FAILED: permit=$S"; cat /tmp/attack_c3a.out /tmp/attack_c3b.out; exit 1
fi
echo "C3 HELD: reopen raised access.permit_already_finalized; permit stays $S"

echo "ATTACK 2fdeaa17: ALL VARIANTS HELD"
