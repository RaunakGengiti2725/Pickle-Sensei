#!/usr/bin/env bash
# Adversarial pass 3 / tester #2 — db-rls-grants-isolation.
#
# Same throwaway-Postgres model as run_rls_tests.sh (Docker postgres:16, shim
# + every migration in order), then:
#   1. the canonical matrix        tests/security_regression.sql
#   2. the single-connection attack tests/attack_db_rls_grants_isolation_2.sql
#   3. REAL two-connection races    (this file, below) — reserve/reserve,
#      sync/sync and a cancelled-mid-flight reserve, each on a committed
#      baseline so the advisory lock is contended across backends.
#
# Exit code is non-zero on the first failure. Logs go to
# ${ATTACK_OUT:-artifacts/attack-db-rls-2}/. Never points at a hosted project.
set -euo pipefail

cd "$(dirname "$0")/.."

CONTAINER=pickle-rls-attack-2
OUT="${ATTACK_OUT:-$(git rev-parse --show-toplevel)/artifacts/attack-db-rls-2}"
mkdir -p "$OUT"

if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  echo "docker is required for the concurrency stage" >&2
  exit 2
fi

cleanup() {
  if docker container inspect "$CONTAINER" >/dev/null 2>&1; then
    docker rm -f "$CONTAINER" >/dev/null
  fi
}
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

psql_in() { docker exec -i "$CONTAINER" psql -h 127.0.0.1 -U postgres -v ON_ERROR_STOP=1 -q "$@"; }
psql_f()  { docker exec "$CONTAINER" psql -h 127.0.0.1 -U postgres -v ON_ERROR_STOP=1 -q "$@"; }

psql_f -f /tests/shim_auth.sql
for f in $(docker exec "$CONTAINER" sh -c 'ls /migrations/*.sql | sort'); do
  psql_f -f "$f"
done

echo "== stage 1: canonical matrix (security_regression.sql)"
psql_f -f /tests/security_regression.sql 2>&1 | tee "$OUT/01_security_regression.log"

echo "== stage 2: attack scenarios S1-S7 + X1-X6 (attack_db_rls_grants_isolation_2.sql)"
psql_f -f /tests/attack_db_rls_grants_isolation_2.sql 2>&1 | tee "$OUT/02_attack_scenarios.log"

# ---------------------------------------------------------------------------
# stage 3: real concurrency. Committed baseline: Carol (google identity),
# exactly ONE free rating left (one scored shot already synced).
# ---------------------------------------------------------------------------
echo "== stage 3: two-connection races"
CAROL=00000000-0000-4000-8000-00000000000c
psql_in <<SQL 2>&1 | tee "$OUT/03_race_setup.log"
insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data)
values ('$CAROL', 'carol@example.com', '{"full_name":"Carol"}', '{"provider":"google"}');
insert into auth.identities (provider, provider_id, user_id, identity_data)
values ('google', 'google-sub-carol', '$CAROL', '{"sub":"google-sub-carol"}');
insert into public.shots (
  id, user_id, shot_type, camera_view, captured_at, start_ms, contact_ms, end_ms,
  overall_score, analysis_confidence, result_kind,
  app_version, model_bundle_version, pose_model_version, paddle_model_version,
  stroke_detector_version, phase_model_version, scoring_model_version, shot_config_version)
values ('00000000-0000-4000-8000-0000000000c1', '$CAROL', 'drive', 'side', now(), 0, 500, 1000,
        6.0, 0.9, 'scored', '1.0.0','b','p','pd','s','ph','sc','c');
SQL

# as_carol <label> <sql...>: one backend, one transaction, Carol's RLS context.
as_carol() {
  local label="$1"; shift
  docker exec -i "$CONTAINER" psql -h 127.0.0.1 -U postgres -v ON_ERROR_STOP=1 -q -At \
    -c "begin;" \
    -c "set local role authenticated;" \
    -c "set local request.jwt.claim.sub = '$CAROL';" \
    "$@" >"$OUT/03_race_${label}.log" 2>&1 || echo "exit=$?" >>"$OUT/03_race_${label}.log"
}

# R1: two backends reserve DIFFERENT keys for the last slot. A holds the
# advisory lock for 2s after its insert (uncommitted); B must block on the
# lock and, once A commits, see A's row → exactly ONE accepted.
as_carol r1_a -c "select 'A:'||result from public.reserve_analysis_permit('race-a');" -c "select pg_sleep(2);" -c "commit;" &
sleep 0.5
as_carol r1_b -c "create temp table t0 as select clock_timestamp() ts;" \
  -c "select 'B:'||result||' waited_ms='||round(extract(epoch from clock_timestamp() - (select ts from t0)) * 1000) from public.reserve_analysis_permit('race-b');" -c "commit;" &
wait
cat "$OUT/03_race_r1_a.log" "$OUT/03_race_r1_b.log"
# B must have BLOCKED on A's advisory lock (>= 1s of the 2s A held it).
assert_waited() { awk -F'waited_ms=' '/waited_ms=/{ if ($2+0 >= 1000) ok=1 } END { exit ok ? 0 : 1 }' "$1"; }
assert_waited "$OUT/03_race_r1_b.log"
psql_in <<'SQL' 2>&1 | tee "$OUT/03_race_r1_verify.log"
do $$
declare n int;
begin
  select count(*) into n from public.analysis_permits
   where user_id = '00000000-0000-4000-8000-00000000000c' and status = 'reserved';
  if n <> 1 then raise exception 'R1: % reserved permits after the race (expected exactly 1)', n; end if;
  raise notice 'R1 HELD: reserve/reserve race issued exactly 1 permit';
end $$;
SQL
grep -q '^A:accepted$' "$OUT/03_race_r1_a.log"
grep -q '^B:access.paywall_required waited_ms=' "$OUT/03_race_r1_b.log"

# R2: sync/sync race. Give Carol a SECOND reserved permit by hand (an
# "over-issued" permit, as postgres) so two syncs each hold a valid permit
# for the single remaining rating. A holds the lock 2s; exactly ONE accepted,
# the other must hit the backstop (access.paywall_required).
psql_in <<'SQL' >"$OUT/03_race_r2_setup.log" 2>&1
insert into public.analysis_permits (id, user_id, idempotency_key)
values ('00000000-0000-4000-8000-0000000000c2', '00000000-0000-4000-8000-00000000000c', 'over-issued');
SQL
PERMIT_A=$(psql_f -At -c "select id from public.analysis_permits where user_id='$CAROL' and idempotency_key in ('race-a','race-b') and status='reserved'")
payload() {
  # $1 = shot id, $2 = permit id → a jsonb_build_object(...) SQL expression
  printf "jsonb_build_object('id', '%s', 'analysisPermitId', '%s', 'resultKind', 'scored', 'shotType', 'drive', 'cameraView', 'side', 'capturedAt', '2026-08-31T10:00:00Z', 'startMs', 0, 'contactMs', 500, 'endMs', 1000, 'overallScore', 7.1, 'confidence', 0.9, 'versionVector', jsonb_build_object('appVersion', '1.0.0', 'modelBundleVersion', 'b', 'poseModelVersion', 'p', 'paddleModelVersion', 'pd', 'strokeDetectorVersion', 's', 'phaseModelVersion', 'ph', 'scoringModelVersion', 'sc', 'shotConfigVersion', 'c'), 'phases', '[]'::jsonb, 'checkpoints', '[]'::jsonb)" "$1" "$2"
}
PA=$(payload 00000000-0000-4000-8000-0000000000c3 "$PERMIT_A")
PB=$(payload 00000000-0000-4000-8000-0000000000c4 00000000-0000-4000-8000-0000000000c2)
as_carol r2_a -c "select 'A:'||public.apply_synced_shot($PA);" -c "select pg_sleep(2);" -c "commit;" &
sleep 0.5
as_carol r2_b -c "create temp table t0 as select clock_timestamp() ts;" \
  -c "select 'B:'||public.apply_synced_shot($PB)||' waited_ms='||round(extract(epoch from clock_timestamp() - (select ts from t0)) * 1000);" -c "commit;" &
wait
cat "$OUT/03_race_r2_a.log" "$OUT/03_race_r2_b.log"
assert_waited "$OUT/03_race_r2_b.log"
psql_in <<'SQL' 2>&1 | tee "$OUT/03_race_r2_verify.log"
do $$
declare n int; r record;
begin
  select count(*) into n from public.shots
   where user_id = '00000000-0000-4000-8000-00000000000c' and result_kind = 'scored';
  if n <> 2 then raise exception 'R2: Carol has % scored shots after the race (expected 2 = the lifetime limit)', n; end if;
  select status, outcome into r from public.analysis_permits where id = '00000000-0000-4000-8000-0000000000c2';
  if r.status <> 'released' or r.outcome <> 'free_limit_exceeded' then
    raise exception 'R2: loser permit left %/% (expected released/free_limit_exceeded)', r.status, r.outcome;
  end if;
  select coalesce(max(l.scored_count), 0) into n
    from auth.identities i join public.free_rating_ledger l
      on l.identity_hash = public.free_rating_identity_hash(i.provider, i.provider_id)
   where i.user_id = '00000000-0000-4000-8000-00000000000c';
  if n <> 2 then raise exception 'R2: ledger=% (expected 2)', n; end if;
  raise notice 'R2 HELD: sync/sync race recorded exactly 2 lifetime ratings; loser permit released';
end $$;
SQL
grep -q '^A:accepted$' "$OUT/03_race_r2_a.log"
grep -q '^B:access.paywall_required waited_ms=' "$OUT/03_race_r2_b.log"

# R3: cancellation mid-flight. Dave (fresh, remaining=2 → make it 1 via a
# reserved permit) — backend A reserves the last slot then is CANCELLED by
# statement_timeout while still holding the lock; its transaction aborts,
# B (blocked on the lock) then gets the slot. Exactly one permit must exist
# and it must be B's.
DAVE=00000000-0000-4000-8000-00000000000d
psql_in <<SQL >"$OUT/03_race_r3_setup.log" 2>&1
insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data)
values ('$DAVE', 'dave@example.com', '{"full_name":"Dave"}', '{"provider":"apple"}');
insert into auth.identities (provider, provider_id, user_id, identity_data)
values ('apple', 'apple-sub-dave', '$DAVE', '{"sub":"apple-sub-dave"}');
insert into public.analysis_permits (user_id, idempotency_key) values ('$DAVE', 'dave-held');
SQL
as_dave() {
  local label="$1"; shift
  docker exec -i "$CONTAINER" psql -h 127.0.0.1 -U postgres -v ON_ERROR_STOP=1 -q -At \
    -c "begin;" \
    -c "set local role authenticated;" \
    -c "set local request.jwt.claim.sub = '$DAVE';" \
    "$@" >"$OUT/03_race_${label}.log" 2>&1 || echo "exit=$?" >>"$OUT/03_race_${label}.log"
}
as_dave r3_a -c "select 'A:'||result from public.reserve_analysis_permit('cancel-a');" -c "set local statement_timeout = '700ms';" -c "select pg_sleep(5);" -c "commit;" &
sleep 0.3
as_dave r3_b -c "create temp table t0 as select clock_timestamp() ts;" \
  -c "select 'B:'||result||' waited_ms='||round(extract(epoch from clock_timestamp() - (select ts from t0)) * 1000) from public.reserve_analysis_permit('cancel-b');" -c "commit;" &
wait
cat "$OUT/03_race_r3_a.log" "$OUT/03_race_r3_b.log"
awk -F'waited_ms=' '/waited_ms=/{ if ($2+0 >= 300) ok=1 } END { exit ok ? 0 : 1 }' "$OUT/03_race_r3_b.log"
grep -q '^A:accepted$' "$OUT/03_race_r3_a.log"
grep -q 'canceling statement due to statement timeout' "$OUT/03_race_r3_a.log"
grep -q '^B:accepted waited_ms=' "$OUT/03_race_r3_b.log"
psql_in <<'SQL' 2>&1 | tee "$OUT/03_race_r3_verify.log"
do $$
declare n int;
begin
  if exists (select 1 from public.analysis_permits where idempotency_key = 'cancel-a') then
    raise exception 'R3: cancelled backend''s permit survived';
  end if;
  select count(*) into n from public.analysis_permits
   where user_id = '00000000-0000-4000-8000-00000000000d' and status = 'reserved';
  if n <> 2 then raise exception 'R3: % reserved permits (expected 2: dave-held + cancel-b)', n; end if;
  raise notice 'R3 HELD: cancelled reserve rolled back; blocked peer took the slot; no over-issue';
end $$;
SQL

echo "ATTACK db-rls-grants-isolation-2: ALL STAGES PASSED (logs in $OUT)"
