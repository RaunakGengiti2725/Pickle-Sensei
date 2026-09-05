# Shared helpers for the deterministic SQL repros. Source, do not execute.
# Requires the disposable container from ../stress_pg_up.sh (psql runs inside it).
set -euo pipefail

CONTAINER=${STRESS_PG_CONTAINER:-pickle-stress-pg}

psql_owner() {
  # $1 = SQL. Runs as the cluster owner (the pg_cron / migration role).
  docker exec -i "$CONTAINER" psql -X -v ON_ERROR_STOP=1 -qAt -U postgres -d postgres -c "$1"
}

psql_as() {
  # $1 = role (authenticated|anon|service_role), $2 = jwt sub or '', $3 = SQL.
  # One explicit transaction so `set local` scopes exactly like PostgREST/the RPC.
  local claims="{}"
  if [ -n "$2" ]; then claims="{\"sub\":\"$2\",\"role\":\"$1\"}"; fi
  docker exec -i "$CONTAINER" psql -X -v ON_ERROR_STOP=1 -qAt -U postgres -d postgres -c "
    begin;
    set local role $1;
    select set_config('request.jwt.claims', '$claims', true);
    select set_config('request.jwt.claim.sub', '$2', true);
    $3
    commit;"
}

create_user() {
  # $1 = uuid. The identity subject carries a nonce: free_rating_ledger is
  # identity-keyed and survives deletion by design.
  local nonce
  nonce=$(head -c 6 /dev/urandom | od -An -tx1 | tr -d ' \n')
  psql_owner "
    insert into auth.users (id, email, raw_app_meta_data)
      values ('$1', '$1@example.com', '{\"provider\":\"google\"}');
    insert into auth.identities (provider, provider_id, user_id, identity_data)
      values ('google', 'sub-$1-$nonce', '$1', '{\"sub\":\"sub-$1-$nonce\"}');"
}

drop_user() { psql_owner "delete from auth.users where id = '$1';"; }

new_uuid() { docker exec "$CONTAINER" psql -X -qAt -U postgres -d postgres -c "select gen_random_uuid()"; }

wait_for_lock_waiter() {
  # Block until a backend whose current query mentions $1 is waiting on a heavyweight
  # lock (row/transaction/relation — all surface as wait_event_type='Lock'), or fail after ~10s.
  for _ in $(seq 1 100); do
    local n
    n=$(psql_owner "select count(*) from pg_stat_activity
                    where wait_event_type = 'Lock' and query ilike '%$1%' and pid <> pg_backend_pid()")
    if [ "$n" != "0" ]; then return 0; fi
    sleep 0.1
  done
  echo "no backend is waiting on $1 after 10s" >&2
  return 1
}

kill_pids() {
  local p
  for p in "$@"; do
    if [ -n "$p" ] && kill -0 "$p" 2>/dev/null; then kill "$p"; fi
  done
}

shot_json() {
  # $1 = shot id, $2 = permit id
  cat <<EOF
{"id":"$1","analysisPermitId":"$2","sessionId":null,"shotType":"dink","cameraView":"side","capturedAt":"2026-09-01T10:00:00.000Z","startMs":0,"contactMs":100,"endMs":200,"overallScore":7,"confidence":0.9,"resultKind":"scored","phases":[],"checkpoints":[],"versionVector":{"appVersion":"1.0.0","modelBundleVersion":"bundle-1","poseModelVersion":"pose-1","paddleModelVersion":"paddle-1","strokeDetectorVersion":"stroke-1","phaseModelVersion":"phase-1","scoringModelVersion":"scoring-1","shotConfigVersion":"config-1"}}
EOF
}
