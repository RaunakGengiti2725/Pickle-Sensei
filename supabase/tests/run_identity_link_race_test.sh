#!/usr/bin/env bash
# DB-01 concurrency variant: an identity linked WHILE a scored sync is in
# flight must still inherit the ledger count.
#
#   ./supabase/tests/run_identity_link_race_test.sh
#
# 20260904140000_ledger_backfill_on_identity_link copies the identity-max of
# the user's other identities onto a newly inserted auth.identities row. The
# trigger reads public.free_rating_ledger without taking the per-user advisory
# lock apply_synced_shot() holds, so a link that lands while a scored sync's
# transaction is open sees the ledger BEFORE that sync's write (READ COMMITTED)
# and inherits nothing; the sync in turn wrote every identity that existed when
# it ran — which excludes the one being linked. Both commit; the late-linked
# identity has no ledger row. Deleting the account and signing in with that
# identity alone then yields fresh free ratings — the original DB-01 outcome.
#
# Two psql sessions against a throwaway postgres:16 (Docker required; a
# missing Docker is reported as exit 2, never as a pass).
set -euo pipefail

cd "$(dirname "$0")/.."

if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  echo "Docker is required for the two-session race test." >&2
  exit 2
fi

CONTAINER=pickle-link-race-test
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
  psql -U postgres -v ON_ERROR_STOP=1 -q -f /tests/shim_auth.sql
  for f in /migrations/*.sql; do
    psql -U postgres -v ON_ERROR_STOP=1 -q -f "$f"
  done
'

U=00000000-0000-4000-8000-0000000000e9
psql_once() { docker exec -i "$CONTAINER" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -qAt "$@"; }

psql_once <<SQL
insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data)
values ('$U', 'race@example.com', '{"full_name":"Race"}', '{"provider":"google"}');
insert into auth.identities (provider, provider_id, user_id, identity_data)
values ('google', 'google-sub-race', '$U', '{"sub":"google-sub-race"}');
SQL

PERMIT=$(psql_once <<SQL | tail -1
set role authenticated;
set request.jwt.claim.sub = '$U';
select permit_id from public.reserve_analysis_permit('race-key-1');
SQL
)

# Session 1: the scored sync, transaction held open after the RPC returned.
S1OUT=$(mktemp)
coproc S1 { docker exec -i "$CONTAINER" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -qAt >"$S1OUT" 2>&1; }
cat >&"${S1[1]}" <<SQL
begin;
set local role authenticated;
set local request.jwt.claim.sub = '$U';
select 'sync -> ' || public.apply_synced_shot(jsonb_build_object(
  'id', '00000000-0000-4000-8000-0000000000ea'::uuid,
  'analysisPermitId', '$PERMIT'::uuid,
  'resultKind', 'scored', 'shotType', 'drive', 'cameraView', 'side',
  'capturedAt', '2026-08-31T10:00:00Z',
  'startMs', 0, 'contactMs', 500, 'endMs', 1000,
  'overallScore', 7.1, 'confidence', 0.9,
  'phases', jsonb_build_array(jsonb_build_object(
    'key', 'prepare', 'startMs', 0, 'representativeMs', 100,
    'endMs', 200, 'confidence', 0.9)),
  'versionVector', jsonb_build_object(
    'appVersion', '1.0.0', 'modelBundleVersion', 'bundle-1',
    'poseModelVersion', 'pose-1', 'paddleModelVersion', 'paddle-1',
    'strokeDetectorVersion', 'stroke-1', 'phaseModelVersion', 'phase-1',
    'scoringModelVersion', 'scoring-1', 'shotConfigVersion', 'config-1')));
SQL
sleep 2

# Session 2: GoTrue links the Apple identity while session 1 is still open.
# (Blocks here if the link trigger serializes on the user's advisory lock —
# the expected behaviour; the bounded wait below turns a hang into a pass.)
LINK_LOG=$(mktemp)
timeout 20 docker exec -i "$CONTAINER" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -qAt >"$LINK_LOG" 2>&1 <<SQL &
insert into auth.identities (provider, provider_id, user_id, identity_data)
values ('apple', 'apple-sub-race', '$U', '{"sub":"apple-sub-race"}');
select 'link committed';
SQL
LINK_PID=$!
sleep 2

echo "commit;" >&"${S1[1]}"
echo "\\q" >&"${S1[1]}"
wait "$S1_PID"
if ! wait "$LINK_PID"; then
  cat "$LINK_LOG" >&2
  echo "precondition failed: the identity link session did not commit" >&2
  exit 2
fi
cat "$S1OUT"
cat "$LINK_LOG"

if ! grep -q 'sync -> accepted' "$S1OUT"; then
  echo "precondition failed: the scored sync was not accepted" >&2
  exit 2
fi

LEDGER=$(psql_once <<SQL
select coalesce((select scored_count::text from public.free_rating_ledger
  where identity_hash = public.free_rating_identity_hash('google','google-sub-race')), 'NONE');
select coalesce((select scored_count::text from public.free_rating_ledger
  where identity_hash = public.free_rating_identity_hash('apple','apple-sub-race')), 'NONE');
SQL
)
GOOGLE=$(sed -n 1p <<<"$LEDGER")
APPLE=$(sed -n 2p <<<"$LEDGER")
echo "ledger after both commits: google=$GOOGLE apple=$APPLE"

# Delete the account, sign in again with ONLY the late-linked Apple identity.
LIFETIME=$(psql_once <<SQL | tail -1
delete from auth.users where id = '$U';
insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data)
values ('$U', 'race@example.com', '{"full_name":"Race"}', '{"provider":"apple"}');
insert into auth.identities (provider, provider_id, user_id, identity_data)
values ('apple', 'apple-sub-race', '$U', '{"sub":"apple-sub-race"}');
set role authenticated;
set request.jwt.claim.sub = '$U';
select public.lifetime_scored_count();
SQL
)
echo "recreated Apple-only account: lifetime_scored_count=$LIFETIME"

if [ "$APPLE" != "1" ] || [ "$LIFETIME" != "1" ]; then
  echo "FAIL: identity linked during an in-flight scored sync inherited no ledger count (apple=$APPLE, lifetime after delete + Apple-only re-sign-in=$LIFETIME; expected 1 and 1)" >&2
  exit 1
fi
echo "IDENTITY LINK RACE: HELD"
