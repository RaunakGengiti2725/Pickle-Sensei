#!/usr/bin/env bash
# Exact two-session SQL reproduction of stress finding F6:
# account deletion (delete from auth.users → cascade profiles → cascade
# analysis_permits) deadlocks with an in-flight apply_synced_shot().
#
#   STRESS_PG_URL=postgres://postgres:pg@127.0.0.1:5499/postgres \
#     ./supabase/tests/stress/repro_delete_vs_apply_deadlock.sh
#
# Lock order inside apply_synced_shot (20260906000000):
#   advisory(uid) → analysis_permits row FOR UPDATE → insert shots (FK KEY
#   SHARE on profiles(id))
# Lock order of the cascade:
#   profiles row (x-lock, deleted) → analysis_permits rows (delete)
# Session A holds the permit FOR UPDATE (what the RPC does first), session B
# starts the deletion and blocks on that permit row while holding the profile
# x-lock; A then reaches the shots INSERT whose FK check waits on the profile
# → cycle → 40P01 after deadlock_timeout for one of the two.
# Exit 1 when the deadlock reproduces (the expected result today).
set -euo pipefail

if command -v psql >/dev/null 2>&1; then
  URL=${STRESS_PG_URL:?set STRESS_PG_URL (see supabase/tests/stress/db_up.sh)}
  PSQL=(psql "$URL" -v ON_ERROR_STOP=1 -X -q -At)
else
  PSQL=(docker exec -i "${STRESS_PG_CONTAINER:-pickle-stress-pg}" psql -U postgres -v ON_ERROR_STOP=1 -X -q -At)
fi

U=$(uuidgen | tr 'A-Z' 'a-z')
SUB="repro-deadlock-$U"
SHOT=$(uuidgen | tr 'A-Z' 'a-z')
OUT=$(mktemp -d)

payload() {
  cat <<JSON
{"id":"$1","analysisPermitId":"$2","sessionId":null,"shotType":"dink","cameraView":"side","capturedAt":"2026-09-01T10:00:00.000Z","startMs":0,"contactMs":100,"endMs":200,"overallScore":7,"confidence":0.9,"resultKind":"scored","phases":[],"checkpoints":[],"versionVector":{"appVersion":"1.0.0","modelBundleVersion":"bundle-1","poseModelVersion":"pose-1","paddleModelVersion":"paddle-1","strokeDetectorVersion":"stroke-1","phaseModelVersion":"phase-1","scoringModelVersion":"scoring-1","shotConfigVersion":"config-1"}}
JSON
}

echo "== setup: user $U with one reserved permit"
"${PSQL[@]}" <<SQL
delete from public.free_rating_ledger where identity_hash = public.free_rating_identity_hash('apple', '$SUB');
insert into auth.users (id, email, raw_app_meta_data)
  values ('$U', '$U@example.com', '{"provider":"apple"}'::jsonb);
insert into auth.identities (provider, provider_id, user_id, identity_data)
  values ('apple', '$SUB', '$U', '{"sub":"$SUB"}'::jsonb);
SQL
P=$("${PSQL[@]}" <<SQL | tail -1
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '$U', true) as jwt_sub \gset
select permit_id from public.reserve_analysis_permit('repro-deadlock');
commit;
SQL
)
echo "   permit $P"

echo "== session A (user): lock the permit the way the RPC does, then sync the shot 1.5s later"
"${PSQL[@]}" <<SQL >"$OUT/a.log" 2>&1 &
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '$U', true) as jwt_sub \gset
select 'A locked permit ' || id from public.analysis_permits where id = '$P' for update;
select pg_sleep(1.5);
select 'A apply → ' || public.apply_synced_shot('$(payload "$SHOT" "$P")'::jsonb);
commit;
SQL
A_PID=$!
sleep 0.5

echo "== session B (Auth admin deleteUser): delete the account while A holds the permit"
set +e
"${PSQL[@]}" <<SQL >"$OUT/b.log" 2>&1
delete from auth.users where id = '$U';
select 'B deleted user';
SQL
B_RC=$?
wait "$A_PID"
A_RC=$?
set -e

echo "-- session A (exit $A_RC):"; sed 's/^/   /' "$OUT/a.log"
echo "-- session B (exit $B_RC):"; sed 's/^/   /' "$OUT/b.log"
"${PSQL[@]}" -c "delete from auth.users where id = '$U'" >/dev/null 2>&1 || true

if grep -qi 'deadlock detected' "$OUT/a.log" "$OUT/b.log"; then
  echo "ANOMALY REPRODUCED: 40P01 deadlock between account deletion and apply_synced_shot"
  exit 1
fi
if grep -q 'shot.write_failed:40P01' "$OUT/a.log"; then
  echo "ANOMALY REPRODUCED: apply_synced_shot swallowed the 40P01 as shot.write_failed:40P01 (deletion won)"
  exit 1
fi
echo "HELD: no deadlock"
