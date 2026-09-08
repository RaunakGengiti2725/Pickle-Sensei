#!/usr/bin/env bash
# W01-03 adversarial test: account deletion vs the settlement_receipts lifecycle
# guard when the receipt's referential cascade fires BEFORE the shot's.
#
#   ./supabase/tests/attack_w01_03/run_cascade_order_attack.sh
#
# Postgres fires the AFTER DELETE referential-integrity triggers of one table
# in trigger-NAME order ("RI_ConstraintTrigger_a_<oid>"), i.e. as strings, not
# as numbers. On a fresh install the shots→profiles cascade (5-digit oid) sorts
# before the settlement_receipts→profiles cascade (larger 5-digit oid), so the
# candidate's own T7 passes. In a cluster whose oid counter has crossed 100000
# the receipts trigger becomes "RI_ConstraintTrigger_a_1xxxxx", which sorts
# BEFORE "RI_ConstraintTrigger_a_1xxxx": the receipt cascade runs first, the
# guard sees the shot still present and raises — account deletion fails.
#
# This runner reproduces exactly that: a throwaway cluster, every migration
# but the candidate's applied, the oid counter advanced past 100000 (large
# objects; the counter is cluster-global and non-transactional), then the
# candidate's migration, then a real settlement and `delete from auth.users`.
#
# ATTACK_BURN_OIDS=0 runs the same steps WITHOUT advancing the counter (the
# control: identical schema and data, only the trigger names differ).
set -euo pipefail

cd "$(dirname "$0")/../.."

CONTAINER=${ATTACK_PG_CONTAINER:-pickle-attack-pg}
IMAGE=${ATTACK_PG_IMAGE:-postgres:16}
LAST=20260908110000_settlement_receipt_lineage.sql
BURN=${ATTACK_BURN_OIDS:-1}
LOG=${ATTACK_LOG:-tests/attack_w01_03/cascade_order_attack.log}

cleanup() { docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup

docker run -d --name "$CONTAINER" -e POSTGRES_PASSWORD=pg "$IMAGE" >/dev/null
for _ in $(seq 1 60); do
  if docker exec "$CONTAINER" pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1; then break; fi
  sleep 1
done
docker cp tests "$CONTAINER":/tests
docker cp migrations "$CONTAINER":/migrations

run_psql() { docker exec "$CONTAINER" psql -U postgres "$@"; }

run_psql -v ON_ERROR_STOP=1 -q -f /tests/shim_auth.sql
for file in migrations/*.sql; do
  name="${file##*/}"
  [ "$name" = "$LAST" ] && continue
  run_psql -v ON_ERROR_STOP=1 -q -f "/migrations/$name" >/dev/null 2>&1
done

before=$(run_psql -Atc "select lo_create(0)")
run_psql -Atc "select lo_unlink($before)" >/dev/null
# Advance the cluster oid counter past 100000 in lock-friendly batches.
cur=$before
while [ "$BURN" = 1 ]; do
  cur=$(run_psql -Atc "select lo_create(0)")
  run_psql -Atc "select lo_unlink($cur)" >/dev/null
  if [ "$cur" -gt 100000 ]; then break; fi
  run_psql -qAtc "select count(lo_unlink(lo_create(0))) from generate_series(1, 4000)" >/dev/null
done
run_psql -v ON_ERROR_STOP=1 -q -f "/migrations/$LAST" >/dev/null 2>&1

{
  echo "== oid counter before candidate migration: $before, after burn: $cur"
  echo "== RI cascade triggers on public.profiles, in the order Postgres fires them (name order):"
  run_psql -Atc "
    select tgname || ' -> ' || tgconstrrelid::regclass
    from pg_trigger
    where tgrelid = 'public.profiles'::regclass
      and tgfoid = '\"RI_FKey_cascade_del\"'::regproc
      and tgconstrrelid in ('public.shots'::regclass, 'public.settlement_receipts'::regclass)
    order by tgname"
  echo "== settle one scored shot through apply_synced_shot, then delete the account:"
} > "$LOG" 2>&1
set +e
run_psql -v ON_ERROR_STOP=1 -f /tests/attack_w01_03/fixture_settled_shot.sql \
  -f /tests/attack_w01_03/cascade_order_attack.sql >> "$LOG" 2>&1
status=$?
set -e
echo "== psql exit code: $status" >> "$LOG"
cat "$LOG"
exit "$status"
