#!/usr/bin/env bash
# Deterministic repro — billing_entitlements upsert is last-committer-wins, not
# newest-verdict-wins (harness scenario S3, invariant `newest_verdict_wins`).
#
# Two concurrent server-side verifications of the SAME user (e.g. a launch
# `POST /v1/billing/sync` racing the post-purchase sync / RevenueCat webhook):
#   session N: verdict verified at T+5s  → premium=true   (newer)
#   session O: verdict verified at T     → premium=false  (older, started earlier,
#              its RevenueCat round trip took longer)
# Both run the exact statement `.from("billing_entitlements").upsert(..., {onConflict:"user_id"})`
# emits. Ordering forced with row locks: N holds its update open, O blocks on the
# row, N commits, O applies. Expected (freshness): row keeps N's premium=true.
# Observed: O's stale premium=false overwrites it (verified_at goes BACKWARDS).
#
# Usage: ../stress_pg_up.sh && ./repro_entitlement_lost_update.sh ; exit 0 = anomaly reproduced.
HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=_lib.sh
source "$HERE/_lib.sh"

USER_A=$(new_uuid)
create_user "$USER_A"
N_PID=""; O_PID=""
cleanup() {
  exec 3>&- 2>/dev/null
  kill_pids $N_PID $O_PID
  psql_owner "select pg_terminate_backend(pid) from pg_stat_activity where query ilike '%billing_entitlements%' and pid <> pg_backend_pid()" >/dev/null
  drop_user "$USER_A"
}
trap cleanup EXIT

T0=$(psql_owner "select to_char(now() at time zone 'utc', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')")
T5=$(psql_owner "select to_char((now() + interval '5 seconds') at time zone 'utc', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')")

upsert_sql() { # $1 premium, $2 product_key (sql literal), $3 verified_at
  echo "insert into public.billing_entitlements (user_id, premium, product_key, expires_at, verified_at)
        values ('$USER_A', $1, $2, null, '$3'::timestamptz)
        on conflict (user_id) do update set
          premium = excluded.premium, product_key = excluded.product_key,
          expires_at = excluded.expires_at, verified_at = excluded.verified_at;"
}

# Session N: newer verdict, held open.
FIFO=$(mktemp -u); mkfifo "$FIFO"
docker exec -i "$CONTAINER" psql -X -v ON_ERROR_STOP=1 -qAt -U postgres -d postgres < "$FIFO" > /tmp/repro_lost_update_N.out 2>&1 &
N_PID=$!
exec 3>"$FIFO"
echo "begin; set local role service_role; $(upsert_sql true "'pickle_sensei_pro_yearly'" "$T5")" >&3
sleep 0.5

# Session O: older verdict, blocks on N's row lock.
psql_as service_role "" "$(upsert_sql false null "$T0")" > /tmp/repro_lost_update_O.out 2>&1 &
O_PID=$!
wait_for_lock_waiter public.billing_entitlements

echo "commit;" >&3
exec 3>&-
wait "$N_PID"; wait "$O_PID"

ROW=$(psql_owner "select premium || ' ' || coalesce(product_key,'∅') || ' ' || to_char(verified_at at time zone 'utc','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')
                  from public.billing_entitlements where user_id = '$USER_A'")
echo "newest verdict issued : premium=true  product_key=pickle_sensei_pro_yearly verified_at=$T5"
echo "final row             : $ROW"
case "$ROW" in
  "false ∅ $T0") echo "REPRODUCED: older verdict (verified_at=$T0) overwrote the newer one — lost update"; exit 0 ;;
  *) echo "not reproduced (final row carries the newest verdict)"; exit 1 ;;
esac
