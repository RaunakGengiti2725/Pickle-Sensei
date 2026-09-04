#!/usr/bin/env bash
# xc-security-injection-sanitization: run the direct-RPC adversarial matrix
# (apply_synced_shot_injection.sql) against a throwaway postgres:16 with the
# repo's auth shim + every migration applied — the same isolation model as
# supabase/tests/run_rls_tests.sh. Never touches a hosted project.
#
#   ./supabase/tests/xc_security/run_xc_security_pg.sh
#     XC_SEC_ARTIFACT_DIR=<dir>   where the JSON tables + log land
#                                 (default artifacts/xc-security-injection/pg)
#     XC_SEC_STRICT=1             contract observations fail the run
#     XC_SEC_PG_SEED=<float>      setseed() value for the seeded batch
#
# Exit codes: 0 all hard invariants held; 1 container failure; 2 Docker
# unavailable; 3 (psql's ON_ERROR_STOP code) the SQL raised — an invariant
# breach, a SQL error, or in strict mode the recorded contract observations
# (see <dir>/pg_run.log).
set -euo pipefail

cd "$(dirname "$0")/../../.."

if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  echo "Docker is required for the xc-security Postgres harness." >&2
  exit 2
fi

ARTIFACT_DIR="${XC_SEC_ARTIFACT_DIR:-$PWD/artifacts/xc-security-injection/pg}"
mkdir -p "$ARTIFACT_DIR"
LOG="$ARTIFACT_DIR/pg_run.log"
: > "$LOG"

CONTAINER=pickle-xc-sec-pg
cleanup() { docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup

docker run -d --name "$CONTAINER" -e POSTGRES_PASSWORD=pg postgres:16 >/dev/null
ready=0
for _ in $(seq 1 60); do
  if docker exec "$CONTAINER" pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done
if [ "$ready" -ne 1 ]; then
  echo "postgres:16 container did not become ready within 60s" >&2 | tee -a "$LOG"
  docker logs "$CONTAINER" 2>&1 | tail -20 >&2
  exit 1
fi

docker cp supabase/tests "$CONTAINER":/tests
docker cp supabase/migrations "$CONTAINER":/migrations

STRICT_FLAG=0
if [ "${XC_SEC_STRICT:-0}" = "1" ]; then STRICT_FLAG=1; fi
SEED="${XC_SEC_PG_SEED:-0.20260904}"

echo "== shim + migrations" | tee -a "$LOG"
docker exec "$CONTAINER" bash -c '
  set -euo pipefail
  psql -U postgres -v ON_ERROR_STOP=1 -q -f /tests/shim_auth.sql
  for f in /migrations/*.sql; do
    psql -U postgres -v ON_ERROR_STOP=1 -q -f "$f"
  done
  psql -U postgres -At -c "select count(*) from pg_proc where proname = '"'"'apply_synced_shot'"'"'"
' >>"$LOG" 2>&1

echo "== matrix (strict=$STRICT_FLAG seed=$SEED)" | tee -a "$LOG"
set +e
docker exec "$CONTAINER" psql -U postgres -q -v ON_ERROR_STOP=1 -v strict="$STRICT_FLAG" -v seed="$SEED" \
  -f /tests/xc_security/apply_synced_shot_injection.sql >>"$LOG" 2>&1
MATRIX_EXIT=$?
set -e
echo "matrix exit=$MATRIX_EXIT" | tee -a "$LOG"

# Export whatever was recorded (even on failure, so a breach is inspectable).
export_json() {
  local query="$1" out="$2"
  docker exec "$CONTAINER" psql -U postgres -At -c "$query" >"$out" 2>>"$LOG" || echo "null" >"$out"
  [ -s "$out" ] || echo "null" >"$out"
}
export_json "select coalesce(json_agg(r order by seq), '[]'::json) from xcsec.results r" "$ARTIFACT_DIR/pg_rpc_matrix.json"
export_json "select coalesce(json_agg(r order by seq), '[]'::json) from xcsec.seeded_results r" "$ARTIFACT_DIR/pg_seeded_results.json"
export_json "select coalesce(json_agg(r order by seq), '[]'::json) from xcsec.seeded_inputs r" "$ARTIFACT_DIR/pg_seeded_inputs.json"
export_json "select coalesce(json_agg(o order by seq), '[]'::json) from xcsec.observations o" "$ARTIFACT_DIR/pg_observations.json"
export_json "select json_build_object(
  'matrixExit', $MATRIX_EXIT,
  'strict', $STRICT_FLAG,
  'seed', $SEED,
  'postgres', version(),
  'cases', (select count(*) from xcsec.results),
  'byResult', (select json_object_agg(k, n) from (select coalesce(case when result like 'shot.write_failed:%' then 'shot.write_failed:*' else result end, 'raised:' || sqlstate) k, count(*) n from xcsec.results group by 1) t),
  'byCategory', (select json_object_agg(category, n) from (select category, count(*) n from xcsec.results group by 1) t),
  'seeded', (select json_object_agg(k, n) from (select coalesce(case when result like 'shot.write_failed:%' then 'shot.write_failed:*' else result end, 'raised:' || sqlstate) k, count(*) n from xcsec.seeded_results group by 1) t),
  'observations', (select count(*) from xcsec.observations),
  'echoedInputCases', (select count(*) from xcsec.results where echoed_input),
  'maxEchoLen', (select max(coalesce(length(result), sqlerrm_len)) from xcsec.results where echoed_input),
  'attackerShots', (select count(*) from public.shots where user_id = 'a0000000-0000-4000-8000-00000000000a'),
  'victimShots', (select count(*) from public.shots where user_id = 'b0000000-0000-4000-8000-00000000000b'),
  'heap', (select json_build_object('shared_buffers', current_setting('shared_buffers'), 'work_mem', current_setting('work_mem'), 'db_size_bytes', pg_database_size(current_database())))
)" "$ARTIFACT_DIR/pg_summary.json"

echo "artifacts: $ARTIFACT_DIR" | tee -a "$LOG"
exit "$MATRIX_EXIT"
