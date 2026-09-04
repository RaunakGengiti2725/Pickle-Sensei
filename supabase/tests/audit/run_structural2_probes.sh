#!/usr/bin/env bash
# Structural audit #2 (db-rls-grants-isolation) — additive probe runner.
#
# Mirrors supabase/tests/run_rls_tests.sh (throwaway postgres:16 in Docker):
#   shim_auth.sql → every migration → audit/structural2_probes.sql
# and then a two-session CONCURRENCY harness that the single-connection psql
# matrix cannot express:
#   C1  two syncs holding DIFFERENT reserved permits race the free-limit
#       backstop for one user who has one free rating left;
#   C2  two users race the same client-generated shots.id.
#
# Exit code: 0 only when every probe AND every concurrency assertion passed.
# Never modifies existing tests or production code.
set -euo pipefail

cd "$(dirname "$0")/../.."

if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  echo "docker is required for run_structural2_probes.sh" >&2
  exit 2
fi

CONTAINER=pickle-rls-structural2
cleanup() { docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup

docker run -d --name "$CONTAINER" -e POSTGRES_PASSWORD=pg postgres:16 >/dev/null
ready=0
for _ in $(seq 1 60); do
  if docker exec "$CONTAINER" pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done
if [ "$ready" -ne 1 ]; then
  echo "postgres:16 container did not become ready within 60s" >&2
  exit 2
fi

docker cp tests "$CONTAINER":/tests
docker cp migrations "$CONTAINER":/migrations

docker exec "$CONTAINER" bash -c '
  set -euo pipefail
  export PGOPTIONS="-c client_min_messages=warning"
  psql -U postgres -v ON_ERROR_STOP=1 -q -f /tests/shim_auth.sql
  for f in /migrations/*.sql; do
    psql -U postgres -v ON_ERROR_STOP=1 -q -f "$f" >/dev/null
  done
  echo "migrations applied: $(ls /migrations/*.sql | wc -l)"
'

probe_rc=0
docker exec "$CONTAINER" psql -U postgres -v ON_ERROR_STOP=1 \
  -f /tests/audit/structural2_probes.sql || probe_rc=$?
echo "structural2_probes.sql exit=$probe_rc"

# ---------------------------------------------------------------------------
# Concurrency harness (committed fixture, two real sessions).
# ---------------------------------------------------------------------------
conc_rc=0
docker exec "$CONTAINER" bash -c '
  set -euo pipefail
  psql -U postgres -v ON_ERROR_STOP=1 -q <<SQL
insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data) values
  (\$\$00000000-0000-4000-8000-0000000000d1\$\$, \$\$dave@example.com\$\$, \$\${}\$\$, \$\${"provider":"google"}\$\$),
  (\$\$00000000-0000-4000-8000-0000000000e1\$\$, \$\$erin@example.com\$\$, \$\${}\$\$, \$\${"provider":"google"}\$\$);
insert into auth.identities (provider, provider_id, user_id, identity_data) values
  (\$\$google\$\$, \$\$g-dave\$\$, \$\$00000000-0000-4000-8000-0000000000d1\$\$, \$\${}\$\$),
  (\$\$google\$\$, \$\$g-erin\$\$, \$\$00000000-0000-4000-8000-0000000000e1\$\$, \$\${}\$\$);
-- dave: one scored shot already (one free rating left) + TWO reserved permits.
insert into public.shots (id, user_id, shot_type, captured_at, start_ms, end_ms,
  overall_score, analysis_confidence, result_kind, app_version, model_bundle_version,
  pose_model_version, paddle_model_version, stroke_detector_version, phase_model_version,
  scoring_model_version, shot_config_version)
values (\$\$20000000-0000-4000-8000-0000000000d0\$\$, \$\$00000000-0000-4000-8000-0000000000d1\$\$,
  \$\$drive\$\$, now(), 0, 1000, 6.0, 0.9, \$\$scored\$\$, \$\$1.0\$\$, \$\$mb\$\$, \$\$pose\$\$, \$\$paddle\$\$,
  \$\$sd\$\$, \$\$ph\$\$, \$\$score-v2\$\$, \$\$cfg\$\$);
insert into public.analysis_permits (id, user_id, idempotency_key) values
  (\$\$40000000-0000-4000-8000-0000000000d1\$\$, \$\$00000000-0000-4000-8000-0000000000d1\$\$, \$\$dave-p1\$\$),
  (\$\$40000000-0000-4000-8000-0000000000d2\$\$, \$\$00000000-0000-4000-8000-0000000000d1\$\$, \$\$dave-p2\$\$),
  (\$\$40000000-0000-4000-8000-0000000000e1\$\$, \$\$00000000-0000-4000-8000-0000000000e1\$\$, \$\$erin-p1\$\$);
SQL

  payload() { # id permit kind score
    printf "%s" "{\"id\":\"$1\",\"analysisPermitId\":\"$2\",\"shotType\":\"drive\",\"cameraView\":\"side\",\"capturedAt\":\"2026-09-04T12:00:00Z\",\"startMs\":0,\"contactMs\":400,\"endMs\":1000,\"overallScore\":$4,\"confidence\":0.9,\"resultKind\":\"$3\",\"versionVector\":{\"appVersion\":\"1.0\",\"modelBundleVersion\":\"mb\",\"poseModelVersion\":\"pose\",\"paddleModelVersion\":\"paddle\",\"strokeDetectorVersion\":\"sd\",\"phaseModelVersion\":\"ph\",\"scoringModelVersion\":\"score-v2\",\"shotConfigVersion\":\"cfg\"}}"
  }

  # Session 1 holds its transaction open for 4s after the RPC returned so
  # session 2 provably waits on the advisory lock rather than racing.
  run_sync() { # uid payload sleep_after tag
    psql -U postgres -At -v ON_ERROR_STOP=1 <<SQL
begin;
set local role authenticated;
select set_config(\$\$request.jwt.claim.sub\$\$, \$\$$1\$\$, true);
select \$\$$4 \$\$ || public.apply_synced_shot(\$j\$$2\$j\$::jsonb) || \$\$ at \$\$ || clock_timestamp()::text;
select pg_sleep($3);
commit;
SQL
  }

  echo "--- C1: two DIFFERENT permits race the backstop (dave has 1 free rating left)"
  t0=$(date +%s%3N)
  run_sync 00000000-0000-4000-8000-0000000000d1 "$(payload 20000000-0000-4000-8000-0000000000d1 40000000-0000-4000-8000-0000000000d1 scored 7.0)" 4 S1 > /tmp/c1_s1.out &
  sleep 1
  run_sync 00000000-0000-4000-8000-0000000000d1 "$(payload 20000000-0000-4000-8000-0000000000d2 40000000-0000-4000-8000-0000000000d2 scored 7.5)" 0 S2 > /tmp/c1_s2.out &
  wait
  t1=$(date +%s%3N)
  elapsed_ms=$((t1 - t0))
  cat /tmp/c1_s1.out /tmp/c1_s2.out
  echo "elapsed=${elapsed_ms}ms (>=4000ms proves S2 blocked on S1 lock)"
  psql -U postgres -At -v ON_ERROR_STOP=1 -c "
    select format(\$\$C1 scored=%s p1=%s/%s p2=%s/%s\$\$,
      (select count(*) from public.shots where user_id = \$\$00000000-0000-4000-8000-0000000000d1\$\$ and result_kind = \$\$scored\$\$),
      (select status from public.analysis_permits where id = \$\$40000000-0000-4000-8000-0000000000d1\$\$),
      (select coalesce(outcome, \$\$-\$\$) from public.analysis_permits where id = \$\$40000000-0000-4000-8000-0000000000d1\$\$),
      (select status from public.analysis_permits where id = \$\$40000000-0000-4000-8000-0000000000d2\$\$),
      (select coalesce(outcome, \$\$-\$\$) from public.analysis_permits where id = \$\$40000000-0000-4000-8000-0000000000d2\$\$))" > /tmp/c1_state.out
  cat /tmp/c1_state.out
  c1_ok=1
  grep -q "S1 accepted" /tmp/c1_s1.out || c1_ok=0
  grep -q "S2 access.paywall_required" /tmp/c1_s2.out || c1_ok=0
  grep -q "C1 scored=2 p1=finalized/scored p2=released/free_limit_exceeded" /tmp/c1_state.out || c1_ok=0
  [ "$elapsed_ms" -ge 4000 ] || c1_ok=0
  echo "C1 result: $([ $c1_ok = 1 ] && echo PASS || echo FAIL)"

  echo "--- C2: two USERS race the same shots.id (erin vs dave, dave holds the row open)"
  psql -U postgres -q -c "insert into public.analysis_permits (id, user_id, idempotency_key) values (\$\$40000000-0000-4000-8000-0000000000d3\$\$, \$\$00000000-0000-4000-8000-0000000000d1\$\$, \$\$dave-p3\$\$);"
  psql -U postgres -q -c "insert into public.billing_entitlements (user_id, premium) values (\$\$00000000-0000-4000-8000-0000000000d1\$\$, true);"
  run_sync 00000000-0000-4000-8000-0000000000d1 "$(payload 20000000-0000-4000-8000-0000000000ee 40000000-0000-4000-8000-0000000000d3 scored 7.0)" 4 S1 > /tmp/c2_s1.out &
  sleep 1
  run_sync 00000000-0000-4000-8000-0000000000e1 "$(payload 20000000-0000-4000-8000-0000000000ee 40000000-0000-4000-8000-0000000000e1 scored 7.5)" 0 S2 > /tmp/c2_s2.out &
  wait
  cat /tmp/c2_s1.out /tmp/c2_s2.out
  psql -U postgres -At -c "
    select format(\$\$C2 owner=%s erin_permit=%s/%s erin_shots=%s\$\$,
      (select user_id from public.shots where id = \$\$20000000-0000-4000-8000-0000000000ee\$\$),
      (select status from public.analysis_permits where id = \$\$40000000-0000-4000-8000-0000000000e1\$\$),
      (select coalesce(outcome, \$\$-\$\$) from public.analysis_permits where id = \$\$40000000-0000-4000-8000-0000000000e1\$\$),
      (select count(*) from public.shots where user_id = \$\$00000000-0000-4000-8000-0000000000e1\$\$))" > /tmp/c2_state.out
  cat /tmp/c2_state.out
  c2_ok=1
  grep -q "S1 accepted" /tmp/c2_s1.out || c2_ok=0
  grep -q "S2 shot.id_conflict" /tmp/c2_s2.out || c2_ok=0
  grep -q "C2 owner=00000000-0000-4000-8000-0000000000d1 erin_permit=reserved/- erin_shots=0" /tmp/c2_state.out || c2_ok=0
  echo "C2 result: $([ $c2_ok = 1 ] && echo PASS || echo FAIL)"

  [ $c1_ok = 1 ] && [ $c2_ok = 1 ]
' || conc_rc=$?
echo "concurrency harness exit=$conc_rc"

if [ "$probe_rc" -ne 0 ] || [ "$conc_rc" -ne 0 ]; then
  echo "STRUCTURAL2: FAILURES (probes=$probe_rc concurrency=$conc_rc)"
  exit 1
fi
echo "STRUCTURAL2: ALL PASSED"
