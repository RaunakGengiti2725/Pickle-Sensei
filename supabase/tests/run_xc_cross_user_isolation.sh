#!/usr/bin/env bash
# Adversarial cross-user isolation harness (companion to run_rls_tests.sh —
# that runner and security_regression.sql are NOT touched by this script).
#
#   ./supabase/tests/run_xc_cross_user_isolation.sh [OUT_DIR]
#
# Fresh postgres:16 in Docker → shim_auth.sql → every migration in order →
# tests/xc_cross_user_isolation.sql (SQL plane: set role + JWT-sub GUC).
# Then, unless XC_SKIP_POSTGREST=1, a real PostgREST (postgrest/postgrest:v12)
# is attached to the SAME seeded database and tests/xc_postgrest_attack.py
# replays the cross-user matrix over HTTP with HS256 bearer tokens
# (PostgREST-style upserts, embedded selects, RPC, role forgery).
#
# Exports into OUT_DIR (default artifacts/xc-cross-user-isolation/<utc ts>/):
# results.json/csv (every SQL probe), failures.json, matrix.json
# (table×op×role), fuzz_meta.json, ids.json, client_table_grants.json,
# http_results.json / http_failures.json / http_summary.json, harness.log,
# summary.json.
#
# Exit codes: 0 = every probe passed; 1 = one or more P0/P1 probes FAILED
# (cross-user leak/mutation, either plane); 3 = only hygiene (P3) probes
# failed; 2 = infrastructure (docker/postgres/postgrest) problem.
set -euo pipefail

ORIG_PWD=$(pwd)
cd "$(dirname "$0")/.."
REPO_ROOT=$(cd .. && pwd)

OUT_DIR=${1:-"$REPO_ROOT/artifacts/xc-cross-user-isolation/$(date -u +%Y%m%dT%H%M%SZ)"}
case "$OUT_DIR" in
  /*) ;;
  *) OUT_DIR="$ORIG_PWD/$OUT_DIR" ;;
esac
mkdir -p "$OUT_DIR"
OUT_DIR=$(cd "$OUT_DIR" && pwd)
LOG="$OUT_DIR/harness.log"

if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  echo "docker is required for this harness" >&2
  exit 2
fi

CONTAINER=pickle-xc-isolation
PGRST_CONTAINER=pickle-xc-postgrest
NETWORK=pickle-xc-net
PGRST_PORT=${XC_PGRST_PORT:-3999}
PGRST_JWT_SECRET=${XC_PGRST_JWT_SECRET:-xc-throwaway-jwt-secret-0123456789abcdef0123456789}
cleanup() {
  docker rm -f "$PGRST_CONTAINER" >/dev/null 2>&1 || true
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  docker network rm "$NETWORK" >/dev/null 2>&1 || true
}
trap cleanup EXIT
cleanup

docker network create "$NETWORK" >/dev/null
docker run -d --name "$CONTAINER" --network "$NETWORK" -e POSTGRES_PASSWORD=pg postgres:16 >/dev/null
ready=0
for _ in $(seq 1 60); do
  if docker exec "$CONTAINER" pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done
if [ "$ready" -ne 1 ]; then
  echo "postgres:16 container did not become ready within 60s" >&2
  docker logs "$CONTAINER" 2>&1 | tail -20 >&2
  exit 2
fi

docker cp tests "$CONTAINER":/tests
docker cp migrations "$CONTAINER":/migrations

{
  echo "# xc-cross-user-isolation $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "# commit: $(git rev-parse HEAD 2>/dev/null || echo unknown)"
  docker exec "$CONTAINER" psql -U postgres -At -c 'select version()'
} | tee "$LOG"

docker exec "$CONTAINER" bash -c '
  set -euo pipefail
  psql -U postgres -v ON_ERROR_STOP=1 -q -f /tests/shim_auth.sql
  for f in /migrations/*.sql; do
    echo "applying $f"
    psql -U postgres -v ON_ERROR_STOP=1 -q -f "$f"
  done
' 2>&1 | tee -a "$LOG"

set +e
docker exec "$CONTAINER" psql -U postgres -v ON_ERROR_STOP=1 \
  -f /tests/xc_cross_user_isolation.sql 2>&1 | tee -a "$LOG"
harness_rc=${PIPESTATUS[0]}
set -e

psql_json() {
  docker exec "$CONTAINER" psql -U postgres -At -c "$1"
}

if ! psql_json "select 1 from pg_namespace where nspname = 'xc'" | grep -q 1; then
  echo "xc schema missing — harness aborted before committing results" >&2
  exit 2
fi

psql_json "select coalesce(json_agg(r order by r.seq), '[]'::json)
           from xc.results r" > "$OUT_DIR/results.json"

docker exec "$CONTAINER" psql -U postgres -c "\\copy (select * from xc.results order by seq) to stdout with csv header" \
  > "$OUT_DIR/results.csv"

psql_json "select coalesce(json_agg(r order by r.seq), '[]'::json)
           from xc.results r where not r.pass" > "$OUT_DIR/failures.json"

psql_json "select json_object_agg(k, v) from xc.fuzz_meta" > "$OUT_DIR/fuzz_meta.json"

psql_json "select coalesce(json_agg(i order by i.name), '[]'::json) from xc.ids i" > "$OUT_DIR/ids.json"

psql_json "select coalesce(json_agg(t), '[]'::json) from (
             select table_name, grantee, string_agg(privilege_type, ',' order by privilege_type) as privileges
             from information_schema.role_table_grants
             where table_schema = 'public' and grantee in ('anon', 'authenticated')
             group by 1, 2 order by 1, 2) t" > "$OUT_DIR/client_table_grants.json"

# ---------------------------------------------------------------------------
# HTTP plane: real PostgREST against the seeded database.
# ---------------------------------------------------------------------------
http_rc=0
http_fail_p0=0
if [ "${XC_SKIP_POSTGREST:-0}" != "1" ]; then
  docker exec "$CONTAINER" psql -U postgres -v ON_ERROR_STOP=1 -q -f /tests/xc_postgrest_setup.sql 2>&1 | tee -a "$LOG"
  docker run -d --name "$PGRST_CONTAINER" --network "$NETWORK" \
    -p "127.0.0.1:${PGRST_PORT}:3000" \
    -e PGRST_DB_URI="postgres://authenticator:xc-postgrest-throwaway@${CONTAINER}:5432/postgres" \
    -e PGRST_DB_SCHEMAS=public \
    -e PGRST_DB_ANON_ROLE=anon \
    -e PGRST_JWT_SECRET="$PGRST_JWT_SECRET" \
    -e PGRST_SERVER_PORT=3000 \
    -e PGRST_LOG_LEVEL=info \
    postgrest/postgrest:v12.2.3 >/dev/null
  pgrst_ready=0
  for _ in $(seq 1 60); do
    if curl -fsS -o /dev/null "http://127.0.0.1:${PGRST_PORT}/" 2>/dev/null; then
      pgrst_ready=1
      break
    fi
    sleep 1
  done
  if [ "$pgrst_ready" -ne 1 ]; then
    echo "postgrest did not become ready within 60s" >&2
    docker logs "$PGRST_CONTAINER" 2>&1 | tail -20 >&2
    exit 2
  fi
  set +e
  python3 tests/xc_postgrest_attack.py \
    --base-url "http://127.0.0.1:${PGRST_PORT}" \
    --jwt-secret "$PGRST_JWT_SECRET" \
    --ids "$OUT_DIR/ids.json" \
    --out "$OUT_DIR" 2>&1 | tee -a "$LOG"
  http_rc=${PIPESTATUS[0]}
  set -e
  docker logs "$PGRST_CONTAINER" > "$OUT_DIR/postgrest.log" 2>&1 || true
  if [ "$http_rc" -eq 2 ]; then
    echo "postgrest attack client could not run" >&2
    exit 2
  fi
  http_fail_p0=$(python3 -c 'import json,sys; print(sum(1 for r in json.load(open(sys.argv[1])) if r["severity"] in ("P0","P1")))' "$OUT_DIR/http_failures.json")
  # Row-space integrity: the HTTP plane may only have changed what the owner
  # controls (O91 patches bob's own session; P90 upserts bob's own request).
  psql_json "select coalesce(json_agg(json_build_object('name', b.name, 'unchanged', b.snap = xc.snapshot(b.id)) order by b.name), '[]'::json)
             from xc.http_before b" > "$OUT_DIR/http_rowspace.json"
  http_leak=$(psql_json "select count(*) from xc.http_before b where b.name <> 'bob' and b.snap <> xc.snapshot(b.id)")
  if [ "$http_leak" -gt 0 ]; then
    echo "XC-HTTP FAIL: $http_leak non-attacker row-space(s) changed during the HTTP plane — see $OUT_DIR/http_rowspace.json" | tee -a "$LOG" >&2
    http_fail_p0=$((http_fail_p0 + http_leak))
  fi
else
  echo "XC: PostgREST plane SKIPPED (XC_SKIP_POSTGREST=1) — not a pass" | tee -a "$LOG"
fi

# Table × operation × role matrix: how many probes touched each (table, kind,
# role) and how many passed. Table is inferred from the statement text.
psql_json "
with t as (
  select r.*,
         coalesce(
           (regexp_match(r.statement, '(?:from|into|update|table|truncate)\s+(public\.[a-z_]+)', 'i'))[1],
           (regexp_match(r.statement, '(public\.[a-z_]+)\s*\(', 'i'))[1],
           '(none)') as target
  from xc.results r
)
select coalesce(json_agg(m order by m.target, m.kind, m.actor_role), '[]'::json)
from (
  select target, kind, actor_role,
         count(*) as probes,
         count(*) filter (where pass) as passed,
         count(*) filter (where not pass and severity in ('P0','P1')) as failed_isolation,
         count(*) filter (where not pass and severity not in ('P0','P1')) as failed_hygiene
  from t group by 1, 2, 3
) m" > "$OUT_DIR/matrix.json"

psql_json "
select json_build_object(
  'commit', '$(git rev-parse HEAD 2>/dev/null || echo unknown)',
  'harness_exit', $harness_rc,
  'postgrest_plane', $([ "${XC_SKIP_POSTGREST:-0}" = "1" ] && echo "'skipped'" || echo "'ran'"),
  'postgrest_exit', $http_rc,
  'postgrest_failed_p0_p1', $http_fail_p0,
  'total', count(*),
  'passed', count(*) filter (where pass),
  'failed_isolation_p0_p1', count(*) filter (where not pass and severity in ('P0','P1')),
  'failed_hygiene', count(*) filter (where not pass and severity not in ('P0','P1')),
  'by_section', (select json_object_agg(section, n) from
                   (select section, json_build_object('total', count(*), 'passed', count(*) filter (where pass)) n
                    from xc.results group by section) s),
  'fuzz', (select json_object_agg(k, v) from xc.fuzz_meta),
  'fuzz_failures', (select count(*) from xc.results where section = 'Q' and not pass)
) from xc.results" > "$OUT_DIR/summary.json"

echo
echo "artifacts: $OUT_DIR"
cat "$OUT_DIR/summary.json"
echo

fail_iso=$(psql_json "select count(*) from xc.results where not pass and severity in ('P0','P1')")
fail_hyg=$(psql_json "select count(*) from xc.results where not pass and severity not in ('P0','P1')")

if [ "$harness_rc" -ne 0 ] || [ "$fail_iso" -gt 0 ] || [ "$http_fail_p0" -gt 0 ] || [ "$http_rc" -ne 0 ]; then
  echo "XC: $fail_iso SQL + $http_fail_p0 HTTP P0/P1 isolation failure(s) — see $OUT_DIR/failures.json and $OUT_DIR/http_failures.json" >&2
  exit 1
fi
if [ "$fail_hyg" -gt 0 ]; then
  echo "XC: no isolation failures; $fail_hyg hygiene (P3) probe(s) failed — see $OUT_DIR/failures.json" >&2
  exit 3
fi
echo "XC: all probes passed"
