#!/usr/bin/env bash
# ADVERSARIAL PASS — billing_entitlements / webhook_events on a real postgres:16
# with the real migrations (same bring-up as wf-billing-entitlement-sync-db.sh).
#
#   ./supabase/functions/api/__wf__/attack-billing-entitlement-pg16.sh [--keep]
#
#   1. attack-billing-entitlement-pg16.sql — S5 (expires_at=now()-1s, premium
#      user with 2 scored shots → paywall_required), boundary/lapsed variants,
#      FK truth behind the webhook's persist-failed branch, the S7 wall-clock
#      half, mid-flight expiry, client-role write denial, audit-table isolation.
#   2. 40 CONCURRENT service-role upserts of one user's verdict (alternating
#      premium true/false, distinct verified_at) — the DB layer must end with
#      exactly one row and zero errors; whichever landed last is what the app
#      sees (the last-writer-wins property the edge tests pin from the outside).
# Exits non-zero on any violated invariant. --keep leaves the container up.
set -euo pipefail

cd "$(dirname "$0")/../../.."   # → supabase/

if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  echo "Docker is required for this check." >&2
  exit 1
fi

CONTAINER=pickle-attack-billing-db
KEEP=0
[ "${1:-}" = "--keep" ] && KEEP=1
cleanup() {
  if [ "$KEEP" = "0" ]; then docker rm -f "$CONTAINER" >/dev/null 2>&1; fi
  return 0
}
trap cleanup EXIT
docker rm -f "$CONTAINER" >/dev/null 2>&1 || echo "(no previous container)"

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

  echo "── attack invariants (attack-billing-entitlement-pg16.sql)"
  psql -U postgres -v ON_ERROR_STOP=1 -f /wf/attack-billing-entitlement-pg16.sql

  echo "── 40 concurrent service-role verdict upserts for one user"
  UID1=00000000-0000-4000-8000-0000000000e1
  for i in $(seq 1 40); do
    if [ $((i % 2)) -eq 0 ]; then prem=true; else prem=false; fi
    psql -U postgres -q -v ON_ERROR_STOP=1 -c "select pg_sleep(0.02); insert into public.billing_entitlements (user_id, premium, product_key, expires_at, verified_at) values ('"'"'$UID1'"'"', $prem, '"'"'p$i'"'"', now() + interval '"'"'1 day'"'"', clock_timestamp()) on conflict (user_id) do update set premium = excluded.premium, product_key = excluded.product_key, expires_at = excluded.expires_at, verified_at = excluded.verified_at;" >/tmp/upsert_$i.out 2>&1 &
  done
  wait
  errors=$(cat /tmp/upsert_*.out | grep -c "ERROR" || true)
  rows=$(psql -U postgres -tA -c "select count(*) from public.billing_entitlements where user_id = '"'"'$UID1'"'"'")
  final=$(psql -U postgres -tA -c "select premium || '"'"'/'"'"' || product_key from public.billing_entitlements where user_id = '"'"'$UID1'"'"'")
  echo "upsert_errors=$errors rows=$rows final=$final"
  if [ "$errors" != "0" ] || [ "$rows" != "1" ]; then
    echo "CONCURRENT UPSERT: expected 0 errors and exactly 1 row" >&2
    exit 1
  fi
  echo "CONCURRENT UPSERT: one row, no errors, last writer wins (final=$final)"
'
echo "ATTACK BILLING PG16 CHECKS: ALL PASSED"
