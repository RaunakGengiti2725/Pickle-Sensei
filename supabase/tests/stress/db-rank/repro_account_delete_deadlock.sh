#!/usr/bin/env bash
# Deterministic 2-session repro: account deletion (auth.users DELETE →
# profiles → analysis_permits/shots cascade, what auth.admin.deleteUser
# performs) deadlocks with an in-flight apply_synced_shot for the same user.
#
# apply_synced_shot's lock order (20260906000000_apply_synced_shot_replay_after_lock.sql):
#   :72  pg_advisory_xact_lock(access_lock_key(uid))
#   :86  select … from analysis_permits where id = permit for update   ← holds permit row
#   :133 insert into public.shots (…)  ← needs KEY SHARE on profiles(uid) for the FK
# The deletion holds the profiles row (X) and its cascade then waits on the
# permit row → cycle → 40P01 on one side (the RPC maps it to
# 'shot.write_failed:40P01', the deletion surfaces as a failed statement).
#
# S1 replays the RPC's statements one by one so the window between :86 and
# :133 is deterministic; the seeded harness (account_delete_vs_sync) hits the
# same cycle through the real RPC.
#
#   PG_URL=postgres://postgres:pg@127.0.0.1:5499/postgres \
#     ./supabase/tests/stress/db-rank/repro_account_delete_deadlock.sh
#
# Exit 1 (BROKEN) when either session reports SQLSTATE 40P01.
HERE="$(cd "$(dirname "$0")" && pwd)"
PG_URL=${PG_URL:-${STRESS_PG_URL:-}}
[ -n "$PG_URL" ] || { echo "PG_URL required (see pg_up.sh)"; exit 2; }
# shellcheck source=lib_psql_sessions.sh
source "$HERE/lib_psql_sessions.sh"

U=1f0c0a3e-0000-4000-8000-00000000d1d1
P=1f0c0a3e-0000-4000-8000-00000000a1a1
NEW=1f0c0a3e-0000-4000-8000-00000000f1f1

pq -q -v ON_ERROR_STOP=1 <<SQL
delete from auth.users where id = '$U';
insert into auth.users (id, email, raw_app_meta_data) values ('$U', 'deadlock@example.com', '{"provider":"google"}');
insert into public.billing_entitlements (user_id, premium) values ('$U', true);
insert into public.analysis_permits (id, user_id, idempotency_key, status) values ('$P', '$U', 'dl-$P', 'reserved');
SQL

open_session S1; open_session S2
AUTH="set local role authenticated; set local request.jwt.claim.sub = '$U';"

echo "== S1 (authenticated sync): advisory lock + permit row FOR UPDATE (RPC :72/:86)"
run S1 "begin; $AUTH
select pg_advisory_xact_lock(public.access_lock_key('$U'));
select status from public.analysis_permits where id = '$P' and user_id = '$U' for update;"

echo "== S2 (auth admin): delete auth.users → cascade blocks on the permit row"
start S2 "begin; delete from auth.users where id = '$U'; select 'account_deleted';"
wait_until_blocked "a.query ilike 'delete from auth.users%'" public.profiles
if [ -n "${REPRO_DEBUG:-}" ]; then
  pq -At -c "select a.pid, a.state, a.wait_event_type, a.wait_event, pg_blocking_pids(a.pid), left(a.query, 60)
               from pg_stat_activity a where a.datname = current_database() and a.pid <> pg_backend_pid()"
  pq -At -c "select l.pid, l.locktype, l.relation::regclass, l.mode, l.granted from pg_locks l
               join pg_stat_activity a on a.pid = l.pid where a.query ilike 'delete from auth.users%' order by 1,2,3"
fi

echo "== S1: insert the shot (RPC :133) → FK needs the profiles row S2 is deleting"
start S1 "insert into public.shots (id, user_id, session_id, shot_type, camera_view, captured_at, start_ms, contact_ms, end_ms,
  overall_score, analysis_confidence, result_kind, app_version, model_bundle_version, pose_model_version,
  paddle_model_version, stroke_detector_version, phase_model_version, scoring_model_version, shot_config_version)
values ('$NEW', '$U', null, 'dink', 'side', '2026-09-01T10:00:00Z', 0, 100, 200,
  7.00, 0.9, 'scored', '1.0.0', 'b', 'p', 'pa', 's', 'ph', 'sc', 'c');
select 'shot_inserted';"
out1=$(finish S1); out2=$(finish S2)
printf '%s\n%s\n' "$out1" "$out2"
if [ -n "${REPRO_DEBUG:-}" ]; then
  pq -At -c "select a.pid, a.state, a.wait_event_type, a.wait_event, pg_blocking_pids(a.pid), left(a.query, 60)
               from pg_stat_activity a where a.datname = current_database() and a.pid <> pg_backend_pid()"
  printf 'S2 raw: %q\n' "$out2"
fi
run S1 "commit;" >/dev/null || true
run S2 "commit;" >/dev/null || true
close_session S1; close_session S2

if printf '%s\n%s' "$out1" "$out2" | grep -q "deadlock detected"; then
  echo "BROKEN: deadlock (SQLSTATE 40P01) between account deletion and in-flight sync"; exit 1
fi
echo "HELD: no deadlock"
