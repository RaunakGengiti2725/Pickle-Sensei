#!/usr/bin/env bash
# ============================================================================
# X1 — real two-connection interleavings on the free-rating gate.
#
# reserve_analysis_permit() and apply_synced_shot() both take
# pg_advisory_xact_lock(access_lock_key(uid)). This drives two genuinely
# concurrent psql sessions (two backend PIDs) against the same owner:
#
#   A. Reserve race at scored=1: session 1 holds the lock inside an open
#      transaction for 3s after reserving key 'k1'; session 2 starts 1s later
#      with key 'k2'. Exactly one permit must exist afterwards and session 2
#      must see access.paywall_required (not 'accepted', not a timeout).
#   C. Cancellation mid-flight (run second, still at scored=1): session 1
#      reserves 'k3' then ROLLS BACK (client died). The permit must not
#      exist, and session 2's reserve of 'k4' must be accepted (no phantom
#      hold, lock released).
#   B. Sync race at scored=1 with TWO hand-made reserved permits (S4 shape):
#      both sessions sync a scored shot, each through its own permit, session
#      1 pausing 3s inside its transaction after the write. Exactly one
#      'accepted', the other access.paywall_required with its permit released
#      free_limit_exceeded; ledger ends at 2.
#
# Fixture rows are created by the harness and deleted at the end (the two
# sessions must see committed state, so this cannot run inside one rolled
# back transaction like the SQL probes).
#
# Usage: x1_concurrent_reserve_and_sync.sh [container]   (default pickle-attack-db)
# Exit 0 = HELD, non-zero = BROKEN (details on stderr).
# ============================================================================
set -euo pipefail

container="${1:-${ATTACK_CONTAINER:-pickle-attack-db}}"
uid='00000000-0000-4000-8000-00000000c0f1'
psql_super() { docker exec -i "$container" psql -U postgres -v ON_ERROR_STOP=1 -X -q -At "$@"; }

cleanup() {
  psql_super <<SQL
delete from auth.users where id = '$uid';
delete from public.free_rating_ledger
 where identity_hash = public.free_rating_identity_hash('apple', 'apple-sub-x1');
drop schema if exists attack cascade;
SQL
}
trap cleanup EXIT

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
docker cp "$here/_helpers.sql" "$container:/attack/_helpers.sql" >/dev/null

cleanup
psql_super <<SQL
\i /attack/_helpers.sql
select attack.new_user('$uid'::uuid, 'x1-owner@attack.example', 'apple', 'apple-sub-x1');
-- one legitimate scored shot so exactly ONE free rating remains
set role authenticated;
set request.jwt.claim.sub = '$uid';
select public.reserve_analysis_permit('x1-seed');
select public.apply_synced_shot(attack.shot_payload(
  '00000000-0000-4000-8000-00000000c0e0'::uuid,
  (select id from public.analysis_permits where idempotency_key = 'x1-seed')));
reset role;
SQL

as_owner() {
  # $1 = SQL body executed as the owner inside ONE transaction
  docker exec -i "$container" psql -U postgres -X -q -At <<SQL
begin;
set local role authenticated;
set local request.jwt.claim.sub = '$uid';
$1
commit;
SQL
}

fail=0
note() { echo "OBSERVED $*"; }
broken() { echo "BROKEN [$1] $2" >&2; fail=$((fail + 1)); }

# ---- A: reserve race -------------------------------------------------------
a1=$(as_owner "select 'S1 ' || result from public.reserve_analysis_permit('x1-k1'); select pg_sleep(3);" &
     sleep 1
     as_owner "select 'S2 ' || result from public.reserve_analysis_permit('x1-k2');"
     wait)
note "A reserve race: $(echo "$a1" | tr '\n' ' ')"
a_permits=$(psql_super -c "select count(*) from public.analysis_permits where user_id = '$uid' and status = 'reserved'")
note "A reserved permits after race = $a_permits"
grep -q '^S1 accepted$' <<<"$a1" || broken X1-A "first reserver did not get 'accepted'"
grep -q '^S2 access.paywall_required$' <<<"$a1" || broken X1-A "second concurrent reserver was not refused with access.paywall_required"
[[ "$a_permits" == "1" ]] || broken X1-A "expected exactly 1 reserved permit, found $a_permits"

# ---- C: cancellation mid-flight -------------------------------------------
psql_super -c "delete from public.analysis_permits where user_id = '$uid' and status = 'reserved';" >/dev/null
c1=$(docker exec -i "$container" psql -U postgres -X -q -At <<SQL &
begin;
set local role authenticated;
set local request.jwt.claim.sub = '$uid';
select 'S1 ' || result from public.reserve_analysis_permit('x1-k3');
select pg_sleep(2);
rollback;
SQL
     sleep 1
     as_owner "select 'S2 ' || result from public.reserve_analysis_permit('x1-k4');"
     wait)
note "C cancel mid-flight: $(echo "$c1" | tr '\n' ' ')"
c_keys=$(psql_super -c "select coalesce(string_agg(idempotency_key, ',' order by idempotency_key), '(none)') from public.analysis_permits where user_id = '$uid' and status = 'reserved'")
note "C reserved permits after rollback = $c_keys"
grep -q '^S2 accepted$' <<<"$c1" || broken X1-C "reserve after a rolled-back concurrent reserve was refused"
[[ "$c_keys" == "x1-k4" ]] || broken X1-C "expected only x1-k4 to survive, found: $c_keys"

# ---- B: sync race with two hand-made permits -------------------------------
psql_super <<SQL
delete from public.analysis_permits where user_id = '$uid' and status = 'reserved';
insert into public.analysis_permits (id, user_id, idempotency_key) values
  ('00000000-0000-4000-8000-00000000c0f2', '$uid', 'x1-hand-1'),
  ('00000000-0000-4000-8000-00000000c0f3', '$uid', 'x1-hand-2');
SQL
b1=$(as_owner "select 'S1 ' || public.apply_synced_shot(attack.shot_payload('00000000-0000-4000-8000-00000000c0e1'::uuid, '00000000-0000-4000-8000-00000000c0f2'::uuid)); select pg_sleep(3);" &
     sleep 1
     as_owner "select 'S2 ' || public.apply_synced_shot(attack.shot_payload('00000000-0000-4000-8000-00000000c0e2'::uuid, '00000000-0000-4000-8000-00000000c0f3'::uuid));"
     wait)
note "B sync race: $(echo "$b1" | tr '\n' ' ')"
b_state=$(psql_super <<SQL
select (select count(*) from public.shots where user_id = '$uid' and result_kind = 'scored') || ' scored shots; ledger='
    || (select coalesce(max(scored_count), 0) from public.free_rating_ledger
        where identity_hash = public.free_rating_identity_hash('apple', 'apple-sub-x1'))
    || '; permits=' || (select string_agg(idempotency_key || ':' || status || '/' || coalesce(outcome, 'null'), ', ' order by idempotency_key)
                        from public.analysis_permits where user_id = '$uid');
SQL
)
note "B state: $b_state"
accepted=$(grep -c ' accepted$' <<<"$b1" || true)
[[ "$accepted" == "1" ]] || broken X1-B "expected exactly one accepted sync, got $accepted"
grep -q ' access.paywall_required$' <<<"$b1" || broken X1-B "the losing sync was not refused with access.paywall_required"
grep -q '^2 scored shots; ledger=2;' <<<"$b_state" || broken X1-B "final state is not 2 scored / ledger 2: $b_state"
grep -q 'released/free_limit_exceeded' <<<"$b_state" || broken X1-B "the losing permit was not released free_limit_exceeded"

if (( fail > 0 )); then
  echo "X1: BROKEN ($fail)" >&2
  exit 1
fi
echo "X1: HELD"
