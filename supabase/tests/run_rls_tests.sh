#!/usr/bin/env bash
# Run the Supabase security regression matrix against a throwaway Postgres.
#
#   ./supabase/tests/run_rls_tests.sh
#
# Prefers postgres:16 in Docker (CI); falls back to a throwaway local cluster
# via initdb/pg_ctl when Docker is unavailable (macOS dev boxes). Either way:
# install the minimal Supabase shim (auth schema + roles + hosted-like default
# privileges), apply every migration in order, run security_regression.sql,
# then race two REAL connections through reserve_analysis_permit() and
# apply_synced_shot() (see free_rating_races below). Exits non-zero on ANY
# boundary regression.
set -euo pipefail

cd "$(dirname "$0")/.."

# ─────────────── two-connection free-rating races (needs 2 sessions) ──────────
#
# security_regression.sql runs in ONE psql session, so it can only observe
# that the per-user advisory lock is HELD (K1/K2 via pg_locks) — it cannot
# prove a second session actually waits on it. These probes do: session A
# takes the lock inside an open transaction and sleeps; session B, on its own
# connection, waits until A is asleep and then makes the competing call.
# Correct code blocks B until A commits, so B sees A's row and is refused.
# Without the lock B reads the pre-A state and both calls succeed — a third
# free rating. Each probe asserts the invariant on the committed rows.
#
# `run_sql` must run psql (superuser, autocommit, ON_ERROR_STOP=1)
# reading SQL from stdin on a FRESH connection per call.
RACE_UID='00000000-0000-4000-8000-0000000000ac'
RACE_PERMIT_1='00000000-0000-4000-8000-00000000ac01'
RACE_PERMIT_2='00000000-0000-4000-8000-00000000ac02'
RACE_SHOT_1='00000000-0000-4000-8000-00000000ac11'
RACE_SHOT_2='00000000-0000-4000-8000-00000000ac12'

race_shot_json() {
  # $1 shot id, $2 permit id
  cat <<EOF
jsonb_build_object(
  'id', '$1', 'analysisPermitId', '$2', 'resultKind', 'scored',
  'shotType', 'drive', 'cameraView', 'side',
  'capturedAt', '2026-08-31T10:00:00Z',
  'startMs', 0, 'contactMs', 500, 'endMs', 1000,
  'overallScore', 7.1, 'confidence', 0.9,
  'versionVector', jsonb_build_object(
    'appVersion', '1.0.0', 'modelBundleVersion', 'bundle-1',
    'poseModelVersion', 'pose-1', 'paddleModelVersion', 'paddle-1',
    'strokeDetectorVersion', 'stroke-1', 'phaseModelVersion', 'phase-1',
    'scoringModelVersion', 'scoring-1', 'shotConfigVersion', 'config-1'))
EOF
}

# Session A: run $2 as the race user inside a transaction, then hold the
# transaction (and therefore every xact-scoped lock it took) open for 3s.
race_session_a() {
  run_sql <<EOF
set application_name = '$1';
begin;
set local role authenticated;
set local request.jwt.claim.sub = '$RACE_UID';
$2
select pg_sleep(3);
commit;
EOF
}

# Session B: wait (≤10s) until session A ($2) is inside its transaction and
# asleep, then run $3 as the race user. If A never gets there the probe is
# inconclusive and fails loudly rather than passing by accident.
race_session_b() {
  run_sql <<EOF
set application_name = '$1';
do \$\$
declare i int;
begin
  for i in 1..200 loop
    -- pg_stat_activity is snapshotted per transaction; refresh it each poll.
    perform pg_stat_clear_snapshot();
    exit when exists (
      select 1 from pg_stat_activity
      where application_name = '$2'
        and xact_start is not null
        and query ilike '%pg_sleep%');
    perform pg_sleep(0.05);
  end loop;
  if not exists (
      select 1 from pg_stat_activity
      where application_name = '$2'
        and xact_start is not null
        and query ilike '%pg_sleep%') then
    raise exception 'RACE: session % did not enter its transaction within 10s (probe inconclusive)', '$2';
  end if;
end \$\$;
begin;
set local role authenticated;
set local request.jwt.claim.sub = '$RACE_UID';
select clock_timestamp() as b_started \gset
$3
select round(extract(epoch from clock_timestamp() - :'b_started'::timestamptz) * 1000)
  as b_blocked_ms;
commit;
EOF
}

free_rating_races() {
  echo "free-rating races: two connections through reserve_analysis_permit / apply_synced_shot"
  run_sql <<EOF
insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data)
values ('$RACE_UID', 'race@example.com', '{"full_name":"Race"}', '{"provider":"google"}');
insert into auth.identities (provider, provider_id, user_id, identity_data)
values ('google', 'google-sub-race', '$RACE_UID',
        '{"sub":"google-sub-race","email":"race@example.com"}');
-- One lifetime rating already spent (via the identity ledger, so no shot row
-- is needed): exactly ONE free reserve / ONE scored sync may still succeed.
insert into public.free_rating_ledger (identity_hash, scored_count)
values (public.free_rating_identity_hash('google', 'google-sub-race'), 1);
EOF

  # RACE 1: two concurrent reserves with DIFFERENT idempotency keys at 1 scored.
  race_session_a race-reserve-a \
    "select 'A ' || result as reserve_a from public.reserve_analysis_permit('race-reserve-a');" &
  local a_pid=$!
  race_session_b race-reserve-b race-reserve-a \
    "select 'B ' || result as reserve_b from public.reserve_analysis_permit('race-reserve-b');"
  wait "$a_pid"
  run_sql <<EOF
do \$\$
declare n int; accepted int;
begin
  select count(*) into n from public.analysis_permits
   where user_id = '$RACE_UID' and idempotency_key like 'race-reserve-%';
  select count(*) into accepted from public.analysis_permits
   where user_id = '$RACE_UID' and idempotency_key like 'race-reserve-%'
     and status = 'reserved';
  if n <> 1 or accepted <> 1 then
    raise exception
      'RACE1: two concurrent different-key reserves at 1 scored must yield exactly ONE permit (got % rows, % reserved) — reserve_analysis_permit no longer serializes on the per-user advisory lock', n, accepted;
  end if;
end \$\$;
EOF
  echo "RACE1 ok: concurrent different-key reserves issued exactly one permit"

  # Reset to 1 scored / 0 reserved, then plant two over-issued reserved
  # permits — the artifact a lost reserve race leaves behind.
  run_sql <<EOF
delete from public.analysis_permits where user_id = '$RACE_UID';
insert into public.analysis_permits (id, user_id, idempotency_key)
values ('$RACE_PERMIT_1', '$RACE_UID', 'race-apply-1'),
       ('$RACE_PERMIT_2', '$RACE_UID', 'race-apply-2');
EOF

  # RACE 2: two concurrent scored syncs holding DIFFERENT reserved permits at
  # 1 scored. The backstop must refuse the second even though its permit is
  # valid — that is the whole point of taking the lock in apply_synced_shot.
  race_session_a race-apply-a \
    "select 'A ' || public.apply_synced_shot($(race_shot_json "$RACE_SHOT_1" "$RACE_PERMIT_1")) as apply_a;" &
  a_pid=$!
  race_session_b race-apply-b race-apply-a \
    "select 'B ' || public.apply_synced_shot($(race_shot_json "$RACE_SHOT_2" "$RACE_PERMIT_2")) as apply_b;"
  wait "$a_pid"
  run_sql <<EOF
do \$\$
declare scored int; refused int;
begin
  select count(*) into scored from public.shots
   where user_id = '$RACE_UID' and result_kind = 'scored';
  select count(*) into refused from public.analysis_permits
   where id in ('$RACE_PERMIT_1', '$RACE_PERMIT_2')
     and status = 'released' and outcome = 'free_limit_exceeded';
  if scored <> 1 or refused <> 1 then
    raise exception
      'RACE2: two concurrent scored syncs with different permits at 1 scored must record exactly ONE shot and refuse the other (got % scored, % refused) — apply_synced_shot no longer serializes on the per-user advisory lock', scored, refused;
  end if;
  if not exists (select 1 from public.free_rating_ledger
                 where identity_hash = public.free_rating_identity_hash('google', 'google-sub-race')
                   and scored_count = 2) then
    raise exception 'RACE2: the identity ledger must read exactly 2 after the race';
  end if;
end \$\$;
EOF
  echo "RACE2 ok: concurrent different-permit scored syncs recorded exactly one shot"
}

if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  CONTAINER=pickle-rls-test
  cleanup() { docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; }
  trap cleanup EXIT
  cleanup

  docker run -d --name "$CONTAINER" -e POSTGRES_PASSWORD=pg postgres:16 >/dev/null
  # The image's entrypoint first runs a bootstrap server that answers on the
  # unix socket only, then restarts it for real; probe over TCP so we do not
  # attach during that window.
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
    docker logs "$CONTAINER" 2>&1 | tail -20 >&2
    exit 2
  fi

  docker cp tests "$CONTAINER":/tests
  docker cp migrations "$CONTAINER":/migrations

  docker exec "$CONTAINER" bash -c '
    set -euo pipefail
    psql -U postgres -v ON_ERROR_STOP=1 -q -f /tests/shim_auth.sql
    for f in /migrations/*.sql; do
      echo "applying $f"
      psql -U postgres -v ON_ERROR_STOP=1 -q -f "$f"
    done
    psql -U postgres -v ON_ERROR_STOP=1 -f /tests/security_regression.sql
  '

  run_sql() { docker exec -i "$CONTAINER" psql -U postgres -v ON_ERROR_STOP=1 -f -; }
  free_rating_races
  exit 0
fi

if ! command -v initdb >/dev/null 2>&1 || ! command -v pg_ctl >/dev/null 2>&1; then
  echo "Neither Docker nor a local Postgres toolchain (initdb/pg_ctl) is available." >&2
  exit 1
fi

WORK=$(mktemp -d)
PGDATA="$WORK/data"
cleanup() {
  pg_ctl -D "$PGDATA" stop -m immediate >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

initdb -D "$PGDATA" -U postgres --auth=trust >/dev/null
# Unix socket only, in a private dir — never collides with a running server.
pg_ctl -D "$PGDATA" -o "-k $WORK -c listen_addresses=''" -l "$WORK/pg.log" start >/dev/null

run_psql() { psql -h "$WORK" -U postgres -d postgres "$@"; }
run_psql -v ON_ERROR_STOP=1 -q -f tests/shim_auth.sql
for f in migrations/*.sql; do
  echo "applying $f"
  run_psql -v ON_ERROR_STOP=1 -q -f "$f"
done
run_psql -v ON_ERROR_STOP=1 -f tests/security_regression.sql

run_sql() { run_psql -v ON_ERROR_STOP=1 -f -; }
free_rating_races
