#!/usr/bin/env bash
# Candidate: apply_synced_shot() checks "already own this shot id" BEFORE taking
# the per-user advisory lock. Two concurrent syncs of the SAME shot id (e.g.
# foreground + background outbox drains) => the loser passes the replay check,
# waits on the lock, then finds the permit finalized and returns
# 'access.permit_not_reserved' (a permanent rejection on the client) even though
# the shot IS on the server.
# Runs against the container prepared by run.sh (template_adj present).
set -uo pipefail
CONTAINER=${CONTAINER:-pickle-adj-pg}
OUT=${OUT:-$(cd "$(dirname "$0")/../../../.." && pwd)/artifacts/adjudication/db-schema-migrations}
mkdir -p "$OUT"
LOG="$OUT/09_concurrent_replay.log"
DB=adj_09
docker exec "$CONTAINER" psql -U postgres -q -c "drop database if exists $DB" -c "create database $DB template template_adj" >/dev/null
docker exec -i "$CONTAINER" psql -U postgres -d "$DB" -q -f /tests/adjudication/db-schema-migrations/00_seed.sql >/dev/null 2>&1
docker exec "$CONTAINER" psql -U postgres -d "$DB" -q -c "
insert into public.sessions (id, user_id, started_at)
values ('00000000-0000-4000-8000-0000000000d1', '00000000-0000-4000-8000-00000000000a', now());
insert into public.analysis_permits (id, user_id, idempotency_key)
values ('00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-00000000000a', 'permit-1');"

PAYLOAD=$(cat <<'SQL'
jsonb_build_object(
  'id', '00000000-0000-4000-8000-0000000000e1',
  'analysisPermitId', '00000000-0000-4000-8000-0000000000a1',
  'sessionId', '00000000-0000-4000-8000-0000000000d1',
  'resultKind', 'scored', 'shotType', 'drive', 'cameraView', 'side',
  'capturedAt', '2026-08-31T10:00:00Z',
  'startMs', 0, 'contactMs', 500, 'endMs', 1000,
  'overallScore', 7.1, 'confidence', 0.9,
  'versionVector', jsonb_build_object('appVersion','1','modelBundleVersion','1','poseModelVersion','1',
    'paddleModelVersion','1','strokeDetectorVersion','1','phaseModelVersion','1','scoringModelVersion','1','shotConfigVersion','1'),
  'phases', '[]'::jsonb, 'checkpoints', '[]'::jsonb)
SQL
)

{
echo "== 09: session A syncs shot e1 and holds its transaction open 3s; session B syncs the SAME shot concurrently =="
docker exec "$CONTAINER" psql -U postgres -d "$DB" -c "
begin;
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000000a';
select 'A: ' || public.apply_synced_shot($PAYLOAD) as a_status;
select pg_sleep(3);
commit;" &
A_PID=$!
sleep 1
docker exec "$CONTAINER" psql -U postgres -d "$DB" -c "
begin;
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000000a';
select 'B: ' || public.apply_synced_shot($PAYLOAD) as b_status;
commit;" | tee /tmp/adj_09_b.txt
wait $A_PID
docker exec "$CONTAINER" psql -U postgres -d "$DB" -c "
select count(*) as shots_on_server from public.shots where id = '00000000-0000-4000-8000-0000000000e1';
select status, outcome from public.analysis_permits where id = '00000000-0000-4000-8000-0000000000a1';"
if grep -q "B: accepted" /tmp/adj_09_b.txt; then
  echo "HELD 09: concurrent replay of the same shot was accepted"
else
  echo "DEFECT_REPRODUCED 09: concurrent same-shot sync returned $(grep -o 'B: [a-z_.]*' /tmp/adj_09_b.txt) although the shot is on the server"
fi
} 2>&1 | tee "$LOG"
