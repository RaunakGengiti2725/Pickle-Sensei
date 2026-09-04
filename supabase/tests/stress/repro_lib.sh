# Shared helpers for the two-session psql repros (sourced, not executed).
# Requires a database prepared by ./pg_up.sh (default container
# pickle-stress-pg); every session goes through `docker exec … psql`.
CONTAINER=${STRESS_PG_CONTAINER:-pickle-stress-pg}

psql1() { docker exec -i "$CONTAINER" psql -U postgres -v ON_ERROR_STOP=1 -qAt "$@"; }

lower_uuid() { docker exec "$CONTAINER" psql -U postgres -qAt -c "select gen_random_uuid()"; }

# make_user <uid> <tag>  — auth.users (+ profile via handle_new_user) with one
# google identity, exactly like the harness fixture.
make_user() {
  psql1 <<SQL
insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data)
  values ('$1', '$2@stress.example.com', '{"full_name":"Repro"}', '{"provider":"google"}');
insert into auth.identities (provider, provider_id, user_id, identity_data)
  values ('google', 'google-$2', '$1', jsonb_build_object('sub', 'google-$2'));
SQL
}

# make_permit <uid> <key> → permit id (owner-issued reserved permit)
make_permit() {
  psql1 -c "insert into public.analysis_permits (user_id, idempotency_key) values ('$1', '$2') returning id"
}

# apply_sql <shot> <permit>  — the apply_synced_shot(jsonb) call text
apply_sql() {
  cat <<SQL
select (public.apply_synced_shot(jsonb_build_object(
  'id','$1','analysisPermitId','$2','sessionId',null,'shotType','dink','cameraView','side',
  'capturedAt','2026-09-01T10:00:00.000Z','startMs',0,'contactMs',100,'endMs',200,
  'overallScore',7,'confidence',0.9,'resultKind','scored','phases','[]'::jsonb,'checkpoints','[]'::jsonb,
  'versionVector', jsonb_build_object('appVersion','1.0.0','modelBundleVersion','bundle-1',
    'poseModelVersion','pose-1','paddleModelVersion','paddle-1','strokeDetectorVersion','stroke-1',
    'phaseModelVersion','phase-1','scoringModelVersion','scoring-1','shotConfigVersion','config-1')
)::jsonb)) as rpc_status;
SQL
}

# open_session <name>  — start a long-lived psql; talk to it with
# send <name> "<sql>" and wait_marker <name> <marker>.
open_session() {
  local n=$1
  # bash warns when a second coproc is opened while one exists; harmless here
  { eval "coproc $n { docker exec -i \"\$CONTAINER\" psql -U postgres -v ON_ERROR_STOP=0 -qAt 2>&1; }"; } 2>/dev/null
}
send() { local n=$1; shift; local fd; eval "fd=\${$n[1]}"; printf '%s\n' "$@" >&"$fd"; }
wait_marker() {
  local n=$1 marker=$2 fd line; eval "fd=\${$n[0]}"
  while IFS= read -r -u "$fd" line; do
    echo "$n> $line"
    [[ "$line" == "$marker" ]] && return 0
  done
  return 1
}
close_session() { local n=$1 pid; send "$n" '\q'; eval "pid=\${${n}_PID}"; wait "$pid" 2>/dev/null || true; }
