#!/usr/bin/env bash
# billing-entitlement-sync audit — database-level checks for the free-rating
# counter and the entitlement predicate used by access_state(),
# reserve_analysis_permit() and apply_synced_shot().
#
#   ./supabase/functions/api/__wf__/wf-billing-entitlement-sync-db.sh
#
# Spins up a throwaway postgres:16 (Docker), installs the Supabase shim,
# applies every migration in order, then:
#   1. runs wf-billing-entitlement-sync-db.sql (sequential invariants:
#      exactly two scored free ratings, abstentions do not consume, expired
#      permits ignored, expired/legacy entitlement predicate, premium bypass),
#   2. fires 24 CONCURRENT reserve_analysis_permit() calls with DISTINCT
#      idempotency keys for one free user and asserts exactly 2 permits were
#      minted (the advisory-lock fix in 20260901000000_permit_reservation_race).
# Exits non-zero on any violated invariant.
set -euo pipefail

cd "$(dirname "$0")/../../.."   # → supabase/

if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  echo "Docker is required for this check." >&2
  exit 1
fi

CONTAINER=pickle-wf-billing-db
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
docker cp functions/api/__wf__ "$CONTAINER":/wf

docker exec "$CONTAINER" bash -c '
  set -euo pipefail
  psql -U postgres -v ON_ERROR_STOP=1 -q -f /tests/shim_auth.sql
  for f in /migrations/*.sql; do
    psql -U postgres -v ON_ERROR_STOP=1 -q -f "$f" >/dev/null 2>&1
  done

  echo "── sequential invariants"
  psql -U postgres -v ON_ERROR_STOP=1 -f /wf/wf-billing-entitlement-sync-db.sql

  echo "── concurrent reserve (24 distinct idempotency keys, one free user)"
  psql -U postgres -v ON_ERROR_STOP=1 -q <<SQL
insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data)
values ('"'"'00000000-0000-4000-8000-0000000000c0'"'"', '"'"'race@example.com'"'"', '"'"'{}'"'"', '"'"'{"provider":"google"}'"'"');
SQL
  for i in $(seq 1 24); do
    key=$(printf "%08d-0000-4000-8000-%012d" "$i" "$i")
    psql -U postgres -q -c "set role authenticated; set request.jwt.claim.sub = '"'"'00000000-0000-4000-8000-0000000000c0'"'"'; select pg_sleep(0.05); select result from public.reserve_analysis_permit('"'"'$key'"'"');" >/tmp/race_$i.out 2>&1 &
  done
  wait
  accepted=$(cat /tmp/race_*.out | grep -c "^ accepted" || true)
  denied=$(cat /tmp/race_*.out | grep -c "access.paywall_required" || true)
  reserved=$(psql -U postgres -tA -c "select count(*) from public.analysis_permits where user_id = '"'"'00000000-0000-4000-8000-0000000000c0'"'"' and status = '"'"'reserved'"'"'")
  echo "accepted=$accepted denied=$denied reserved_rows=$reserved"
  if [ "$accepted" != "2" ] || [ "$reserved" != "2" ] || [ "$denied" != "22" ]; then
    echo "FREE-RATING RACE: expected exactly 2 accepted / 22 denied / 2 reserved rows" >&2
    exit 1
  fi
  echo "CONCURRENT RESERVE: exactly two permits minted"
'
echo "BILLING-ENTITLEMENT-SYNC DB CHECKS: ALL PASSED"
