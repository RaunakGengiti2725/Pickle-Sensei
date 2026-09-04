#!/usr/bin/env bash
# Multi-connection attacks for adversarial pass 3 (db-rls-grants-isolation #1).
# Runs INSIDE the throwaway Postgres host after attack_rls_isolation_1.sql
# (which seeds alice/bob/dave/erin and Dave's five direct permits).
#
#   S2  Alice holds pg_advisory_xact_lock(access_lock_key(<bob>)) in an open
#       transaction while Bob calls reserve_analysis_permit in another
#       session → does Bob block?
#   C1  Dave (1 scored, 5 self-inserted reserved permits) fires 5 concurrent
#       scored syncs → exactly ONE may be accepted (lifetime 2).
#   C2  Erin (0 scored) fires 6 concurrent reserve_analysis_permit calls with
#       distinct keys → at most 2 permits may be reserved.
#   C3  Five concurrent replays of the SAME shot id/permit → one row, all
#       'accepted'.
#
# Verdicts are appended to public.attack_results and printed; exits non-zero
# on any BROKEN verdict. Requires: psql on PATH with superuser access as
# $PGUSER (default postgres) to the target database.
set -euo pipefail

ALICE='00000000-0000-4000-8000-0000000000a1'
BOB='00000000-0000-4000-8000-0000000000b1'
DAVE='00000000-0000-4000-8000-0000000000d1'
ERIN='00000000-0000-4000-8000-0000000000e1'
OUT="${ATTACK_OUT:-/tmp/attack_sessions}"
mkdir -p "$OUT"
export PGUSER="${PGUSER:-postgres}"

q() { psql -X -q -At -v ON_ERROR_STOP=1 "$@"; }
record() { # scenario verdict detail
  q -c "select public.attack_record(\$\$$1\$\$, '$2', \$\$$3\$\$)" >/dev/null
}

# ───────────────────────────── S2: cross-user advisory lock ─────────────────
# Session A (Alice) takes Bob's lock and sleeps 8s inside the transaction.
psql -X -q -At -v ON_ERROR_STOP=1 >"$OUT/s2_holder.log" 2>&1 <<SQL &
begin;
set local role authenticated;
set local request.jwt.claim.sub = '$ALICE';
select 'alice acquired bob lock at ' || clock_timestamp()
  from pg_catalog.pg_advisory_xact_lock(public.access_lock_key('$BOB'));
select pg_sleep(8);
select 'alice released at ' || clock_timestamp();
commit;
SQL
HOLDER=$!

# Wait until the advisory lock is actually granted.
for _ in $(seq 1 50); do
  n=$(q -c "select count(*) from pg_locks where locktype = 'advisory' and granted")
  [ "$n" -ge 1 ] && break
  sleep 0.1
done
if [ "${n:-0}" -lt 1 ]; then
  record 'S2 alice acquires bob lock key' BROKEN 'advisory lock never appeared in pg_locks'
else
  record 'S2 alice acquires bob lock key' INFO "granted advisory locks=$n (authenticated may call access_lock_key + pg_advisory_xact_lock)"
fi

# Session B (Bob) reserves with a 3s statement timeout.
set +e
psql -X -q -At -v ON_ERROR_STOP=0 >"$OUT/s2_bob.log" 2>&1 <<SQL &
set role authenticated;
set request.jwt.claim.sub = '$BOB';
set statement_timeout = '3000ms';
select 'bob reserve start ' || clock_timestamp();
select result from public.reserve_analysis_permit('bob-lock-probe');
select 'bob reserve end ' || clock_timestamp();
SQL
BOBPID=$!
set -e

# Third session: observe Bob's wait state while he is blocked.
sleep 1
WAIT=$(q -c "select coalesce(string_agg(wait_event_type || '/' || wait_event || ' state=' || state, ','), '<none>')
  from pg_stat_activity
  where query ilike '%reserve_analysis_permit(''bob-lock-probe'')%' and pid <> pg_backend_pid()")
echo "bob wait state while alice holds lock: $WAIT" | tee "$OUT/s2_wait_state.log"

wait "$BOBPID" || true
wait "$HOLDER" || true
cat "$OUT/s2_holder.log" "$OUT/s2_bob.log"

if grep -q 'canceling statement due to statement timeout' "$OUT/s2_bob.log" \
   && [[ "$WAIT" == *"Lock/advisory"* ]]; then
  record 'S2 bob reserve blocks behind alice-held lock' BROKEN \
    "bob's reserve_analysis_permit waited on Lock/advisory and hit statement_timeout(3s) while alice held access_lock_key(bob) from another session; wait_state=$WAIT"
else
  record 'S2 bob reserve blocks behind alice-held lock' HELD \
    "bob was not blocked (wait_state=$WAIT); see $OUT/s2_bob.log"
fi

# Control: Bob's reserve proceeds once the lock is gone.
CTRL=$(q -c "set role authenticated; set request.jwt.claim.sub = '$BOB'; select result from public.reserve_analysis_permit('bob-lock-probe-2');" | tail -1)
record 'S2 control: bob reserve without contention' "$( [ "$CTRL" = 'access.paywall_required' ] || [ "$CTRL" = 'accepted' ] && echo INFO || echo BROKEN )" "result=$CTRL"

# Blast radius: apply_synced_shot for Bob shares the same key.
psql -X -q -At -v ON_ERROR_STOP=1 >"$OUT/s2b_holder.log" 2>&1 <<SQL &
begin;
set local role authenticated;
set local request.jwt.claim.sub = '$ALICE';
select pg_catalog.pg_advisory_xact_lock(public.access_lock_key('$BOB'));
select pg_sleep(5);
commit;
SQL
HOLDER=$!
for _ in $(seq 1 50); do
  n=$(q -c "select count(*) from pg_locks where locktype = 'advisory' and granted")
  [ "$n" -ge 1 ] && break
  sleep 0.1
done
set +e
psql -X -q -At -v ON_ERROR_STOP=0 >"$OUT/s2b_bob_sync.log" 2>&1 <<SQL
set role authenticated;
set request.jwt.claim.sub = '$BOB';
set statement_timeout = '2000ms';
select public.apply_synced_shot(public.attack_shot(
  gen_random_uuid(), '00000000-0000-4000-8000-00000000a0b8', 'low_confidence', null));
SQL
set -e
wait "$HOLDER" || true
if grep -q 'canceling statement due to statement timeout' "$OUT/s2b_bob_sync.log"; then
  record 'S2b bob apply_synced_shot blocks behind alice-held lock' BROKEN \
    "apply_synced_shot (non-replay path) also waits on access_lock_key(bob) held by alice's session"
else
  record 'S2b bob apply_synced_shot blocks behind alice-held lock' HELD "not blocked: $(tr '\n' ' ' <"$OUT/s2b_bob_sync.log")"
fi

# S2c: would revoking EXECUTE on access_lock_key help? Alice recomputes the
# key from the public hashtextextended() without calling access_lock_key.
psql -X -q -At -v ON_ERROR_STOP=1 >"$OUT/s2c_holder.log" 2>&1 <<SQL &
begin;
set local role authenticated;
set local request.jwt.claim.sub = '$ALICE';
select pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended('pickle.access:' || '$BOB', 0));
select pg_sleep(4);
commit;
SQL
HOLDER=$!
for _ in $(seq 1 50); do
  n=$(q -c "select count(*) from pg_locks where locktype = 'advisory' and granted")
  [ "$n" -ge 1 ] && break
  sleep 0.1
done
set +e
psql -X -q -At -v ON_ERROR_STOP=0 >"$OUT/s2c_bob.log" 2>&1 <<SQL
set role authenticated;
set request.jwt.claim.sub = '$BOB';
set statement_timeout = '2000ms';
select result from public.reserve_analysis_permit('bob-lock-probe-3');
SQL
set -e
wait "$HOLDER" || true
if grep -q 'canceling statement due to statement timeout' "$OUT/s2c_bob.log"; then
  record 'S2c same block via public hashtextextended (no access_lock_key call)' BROKEN \
    "key derivable without EXECUTE on access_lock_key → revoking that grant would not close the cross-user hold"
else
  record 'S2c same block via public hashtextextended (no access_lock_key call)' HELD "not blocked: $(tr '\n' ' ' <"$OUT/s2c_bob.log")"
fi

# ───────────────────────────── C1: 5 concurrent scored syncs (Dave) ─────────
for i in 1 2 3 4 5; do
  psql -X -q -At -v ON_ERROR_STOP=1 >"$OUT/c1_dave_$i.log" 2>&1 <<SQL &
set role authenticated;
set request.jwt.claim.sub = '$DAVE';
select public.apply_synced_shot(public.attack_shot(
  '00000000-0000-4000-8000-0000000ee0d${i}'::uuid,
  '00000000-0000-4000-8000-00000000d0d${i}'::uuid, 'scored', ${i}.5));
SQL
done
wait
ACCEPTED=$(cat "$OUT"/c1_dave_*.log | grep -c '^accepted$' || true)
PAYWALL=$(cat "$OUT"/c1_dave_*.log | grep -c '^access.paywall_required$' || true)
DAVE_SCORED=$(q -c "select count(*) from public.shots where user_id = '$DAVE' and result_kind = 'scored'")
DAVE_LEDGER=$(q -c "select coalesce(max(scored_count), -1) from public.free_rating_ledger l
  where l.identity_hash = public.free_rating_identity_hash('google', 'google-sub-dave')")
DAVE_RESERVED=$(q -c "select count(*) from public.analysis_permits where user_id = '$DAVE' and status = 'reserved'")
DAVE_RELEASED=$(q -c "select count(*) from public.analysis_permits where user_id = '$DAVE' and outcome = 'free_limit_exceeded'")
echo "C1: accepted=$ACCEPTED paywall=$PAYWALL scored=$DAVE_SCORED ledger=$DAVE_LEDGER reserved_left=$DAVE_RESERVED released_limit=$DAVE_RELEASED"
if [ "$ACCEPTED" = 1 ] && [ "$PAYWALL" = 4 ] && [ "$DAVE_SCORED" = 2 ] && [ "$DAVE_LEDGER" = 2 ] \
   && [ "$DAVE_RESERVED" = 0 ] && [ "$DAVE_RELEASED" = 4 ]; then
  record 'C1 5 concurrent scored syncs on 5 permits' HELD \
    "accepted=$ACCEPTED paywall=$PAYWALL scored=$DAVE_SCORED ledger=$DAVE_LEDGER reserved_left=$DAVE_RESERVED released_free_limit_exceeded=$DAVE_RELEASED"
else
  record 'C1 5 concurrent scored syncs on 5 permits' BROKEN \
    "accepted=$ACCEPTED paywall=$PAYWALL scored=$DAVE_SCORED ledger=$DAVE_LEDGER reserved_left=$DAVE_RESERVED released_free_limit_exceeded=$DAVE_RELEASED"
fi

# ───────────────────────────── C2: 6 concurrent reserves (Erin) ─────────────
for i in 1 2 3 4 5 6; do
  psql -X -q -At -v ON_ERROR_STOP=1 >"$OUT/c2_erin_$i.log" 2>&1 <<SQL &
set role authenticated;
set request.jwt.claim.sub = '$ERIN';
select result from public.reserve_analysis_permit('erin-race-$i');
SQL
done
wait
ERIN_ACCEPTED=$(cat "$OUT"/c2_erin_*.log | grep -c '^accepted$' || true)
ERIN_ROWS=$(q -c "select count(*) from public.analysis_permits where user_id = '$ERIN'")
echo "C2: accepted=$ERIN_ACCEPTED permit_rows=$ERIN_ROWS"
if [ "$ERIN_ACCEPTED" = 2 ] && [ "$ERIN_ROWS" = 2 ]; then
  record 'C2 6 concurrent reserves for a fresh user' HELD "accepted=$ERIN_ACCEPTED permit_rows=$ERIN_ROWS"
else
  record 'C2 6 concurrent reserves for a fresh user' BROKEN "accepted=$ERIN_ACCEPTED permit_rows=$ERIN_ROWS"
fi

# ───────────────────────────── C3: 5 concurrent replays of one shot ─────────
ERIN_PERMIT=$(q -c "select id from public.analysis_permits where user_id = '$ERIN' order by created_at limit 1")
for i in 1 2 3 4 5; do
  psql -X -q -At -v ON_ERROR_STOP=1 >"$OUT/c3_replay_$i.log" 2>&1 <<SQL &
set role authenticated;
set request.jwt.claim.sub = '$ERIN';
select public.apply_synced_shot(public.attack_shot(
  '00000000-0000-4000-8000-00000000e0e1', '$ERIN_PERMIT', 'scored', 7.0));
SQL
done
wait
REPLAY_ACCEPTED=$(cat "$OUT"/c3_replay_*.log | grep -c '^accepted$' || true)
REPLAY_OTHER=$(cat "$OUT"/c3_replay_*.log | grep -vc '^accepted$' || true)
ERIN_SHOTS=$(q -c "select count(*) from public.shots where id = '00000000-0000-4000-8000-00000000e0e1'")
ERIN_LEDGER=$(q -c "select coalesce(max(scored_count), -1) from public.free_rating_ledger l
  where l.identity_hash = public.free_rating_identity_hash('apple', 'apple-sub-erin')")
echo "C3: accepted=$REPLAY_ACCEPTED other=$REPLAY_OTHER rows=$ERIN_SHOTS ledger=$ERIN_LEDGER"
if [ "$ERIN_SHOTS" = 1 ] && [ "$ERIN_LEDGER" = 1 ] && [ "$REPLAY_ACCEPTED" -ge 1 ]; then
  record 'C3 5 concurrent replays of one shot: single row, single ledger tick' HELD "accepted=$REPLAY_ACCEPTED rows=$ERIN_SHOTS ledger=$ERIN_LEDGER"
else
  record 'C3 5 concurrent replays of one shot: single row, single ledger tick' BROKEN "accepted=$REPLAY_ACCEPTED other=$REPLAY_OTHER rows=$ERIN_SHOTS ledger=$ERIN_LEDGER"
fi
RESULTS=$(cat "$OUT"/c3_replay_*.log | sort | uniq -c | tr -s ' ' | tr '\n' ';')
if [ "$REPLAY_ACCEPTED" = 5 ]; then
  record 'C3b concurrent replays all report accepted' HELD "results=$RESULTS"
else
  record 'C3b concurrent replays all report accepted' BROKEN "losers of the race see a non-accepted status for a shot that IS stored: results=$RESULTS"
fi

# ───────────────────────────── report ────────────────────────────────────────
psql -X -v ON_ERROR_STOP=1 -c "select ord, scenario, verdict, detail from public.attack_results
  where scenario like 'S2%' or scenario like 'C%' order by ord"
BROKEN=$(q -c "select count(*) from public.attack_results where verdict = 'BROKEN'")
echo "attack_results BROKEN verdicts (all scenarios): $BROKEN"
psql -X -q -At -v ON_ERROR_STOP=1 -c "select json_agg(json_build_object('ord', ord, 'scenario', scenario, 'verdict', verdict, 'detail', detail) order by ord) from public.attack_results" >"$OUT/attack_results.json"
[ "$BROKEN" = 0 ]
