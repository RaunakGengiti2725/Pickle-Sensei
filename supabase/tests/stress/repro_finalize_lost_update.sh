#!/usr/bin/env bash
# Exact two-backend SQL repro for the session finalize lost update
# (POST /v1/sessions/:id/finalize, supabase/functions/api/index.ts finalizeSession:
#  SELECT id, ended_at ... then an UPDATE that is NOT guarded by `ended_at is null`).
#
# Requires the disposable database from ./stress_pg_up.sh (container pickle-stress-pg).
# Exit 0 = the row kept the FIRST committed stamp (invariant held);
# exit 1 = a later duplicate finalize moved ended_at (lost update reproduced).
set -euo pipefail

CONTAINER=${STRESS_PG_CONTAINER:-pickle-stress-pg}
UID_A=11111111-1111-4111-8111-111111111111
SID=22222222-2222-4222-8222-222222222222
T_FIRST='2026-08-31T10:30:00Z'   # backend 2 commits this first
T_LATE='2026-08-31T10:30:07Z'    # backend 1 (the retry that read ended_at IS NULL earlier) applies this after

psql_su() { docker exec -i "$CONTAINER" psql -v ON_ERROR_STOP=1 -qAt -U postgres -d postgres "$@"; }

as_user() {  # $1 uid, then SQL body on stdin; runs one READ COMMITTED transaction as the authenticated role
  local uid=$1
  {
    echo "begin isolation level read committed;"
    echo "set local role authenticated;"
    echo "select set_config('request.jwt.claim.sub', '$uid', true), set_config('request.jwt.claims', '{\"sub\":\"$uid\",\"role\":\"authenticated\"}', true);"
    cat
    echo "commit;"
  } | psql_su
}

# fixture (owner plane)
psql_su <<SQL
delete from auth.users where id = '$UID_A';
insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data)
  values ('$UID_A', 'repro@stress.test', '{"full_name":"Repro"}', '{"provider":"google"}');
insert into public.sessions (id, user_id, started_at) values ('$SID', '$UID_A', '2026-08-31T10:00:00Z');
SQL

# backend 1: the edge fn's read sees ended_at IS NULL, then (network gap) issues the unguarded update
as_user "$UID_A" <<SQL &
select 'b1_read_ended_at=' || coalesce(ended_at::text, 'NULL') from public.sessions where id = '$SID' and user_id = '$UID_A';
select pg_sleep(2);
update public.sessions set ended_at = '$T_LATE' where id = '$SID' and user_id = '$UID_A';
select 'b1_updated=' || ended_at from public.sessions where id = '$SID';
SQL
B1=$!
sleep 0.7

# backend 2: a duplicate finalize (outbox replay / double tap) that reads NULL and commits FIRST
as_user "$UID_A" <<SQL
select 'b2_read_ended_at=' || coalesce(ended_at::text, 'NULL') from public.sessions where id = '$SID' and user_id = '$UID_A';
update public.sessions set ended_at = '$T_FIRST' where id = '$SID' and user_id = '$UID_A';
select 'b2_updated=' || ended_at from public.sessions where id = '$SID';
SQL

wait "$B1"

FINAL=$(psql_su -c "select ended_at from public.sessions where id = '$SID'")
echo "final_ended_at=$FINAL (first committed stamp was $T_FIRST)"
psql_su -c "delete from auth.users where id = '$UID_A'" >/dev/null

if [[ "$FINAL" == "2026-08-31 10:30:00+00" ]]; then
  echo "HELD: ended_at kept the first committed stamp"
  exit 0
fi
echo "BROKEN: duplicate finalize moved ended_at ($T_FIRST -> $FINAL) — lost update"
exit 1
