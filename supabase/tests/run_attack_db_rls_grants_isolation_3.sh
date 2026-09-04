#!/usr/bin/env bash
# Adversarial pass 3 — db-rls-grants-isolation — against a throwaway Postgres.
#
#   ./supabase/tests/run_attack_db_rls_grants_isolation_3.sh [--strict]
#   ATTACK_STRICT=1 ./supabase/tests/run_attack_db_rls_grants_isolation_3.sh
#
# Same bootstrap as run_rls_tests.sh (postgres:16 in Docker, or a throwaway
# initdb/pg_ctl cluster): shim, every migration in order, then
#   1. tests/security_regression.sql              (the shipped matrix — must pass)
#   2. tests/attack_db_rls_grants_isolation_3.sql (HELD attack matrix — must pass)
#   3. tests/attack_db_rls_grants_isolation_3_findings.sql
#      (secure expectations for attacks that SUCCEED on 4d812e1a; each open
#      hole prints `WARNING:  FINDING <id> REPRODUCED`, each closed one
#      `NOTICE:  FINDING <id> FIXED`)
# Exit status: non-zero if 1 or 2 fail or 3 aborts on an infrastructure error.
# With --strict / ATTACK_STRICT=1 any REPRODUCED finding is also a failure, so
# the script doubles as the regression gate once the fix migrations land.
# Output is written to $ATTACK_OUT (default: artifacts/attack-db-rls-3/<ts>/).
set -euo pipefail

cd "$(dirname "$0")/.."

STRICT="${ATTACK_STRICT:-0}"
[ "${1:-}" = "--strict" ] && STRICT=1

OUT="${ATTACK_OUT:-$PWD/../artifacts/attack-db-rls-3/$(date -u +%Y%m%dT%H%M%SZ)}"
mkdir -p "$OUT"
LOG="$OUT/run.log"
echo "revision: $(git rev-parse HEAD 2>/dev/null || echo unknown)" | tee "$LOG"

run_sql_stage() {  # name, psql runner..., file
  local name=$1; shift
  local file=${!#}
  local stage_log="$OUT/$name.log"
  set +e
  "$@" 2>&1 | tee "$stage_log"
  local rc=${PIPESTATUS[0]}
  set -e
  echo "stage $name: exit $rc ($stage_log)" | tee -a "$LOG"
  return "$rc"
}

summarize_findings() {
  local log=$1
  local reproduced fixed
  reproduced=$(grep -c 'FINDING F[0-9a-z]* REPRODUCED' "$log" || true)
  fixed=$(grep -c 'FINDING F[0-9a-z]* FIXED' "$log" || true)
  {
    echo "findings reproduced: $reproduced"
    echo "findings fixed: $fixed"
    grep -o 'FINDING F[0-9a-z]* \(REPRODUCED\|FIXED\)[^"]*' "$log" || true
  } | tee -a "$LOG" | tee "$OUT/findings.txt"
  if [ "$STRICT" = "1" ] && [ "$reproduced" -gt 0 ]; then
    echo "ATTACK_STRICT=1: $reproduced finding(s) still reproduce" | tee -a "$LOG" >&2
    return 1
  fi
}

if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  CONTAINER=pickle-rls-attack3
  cleanup() { docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; }
  trap cleanup EXIT
  cleanup

  docker run -d --name "$CONTAINER" -e POSTGRES_PASSWORD=pg postgres:16 >/dev/null
  # The image's entrypoint first runs a bootstrap server that answers on the
  # unix socket only, then restarts it for real; probe over TCP so we do not
  # attach during that window.
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

  docker exec "$CONTAINER" bash -c '
    set -euo pipefail
    psql -U postgres -v ON_ERROR_STOP=1 -q -f /tests/shim_auth.sql
    for f in /migrations/*.sql; do
      echo "applying $f"
      psql -U postgres -v ON_ERROR_STOP=1 -q -f "$f"
    done
  ' 2>&1 | tee "$OUT/bootstrap.log"

  dpsql() { docker exec "$CONTAINER" psql -U postgres -v ON_ERROR_STOP=1 -f "$1"; }
  run_sql_stage security_regression dpsql /tests/security_regression.sql
  run_sql_stage attack_held        dpsql /tests/attack_db_rls_grants_isolation_3.sql
  run_sql_stage attack_findings    dpsql /tests/attack_db_rls_grants_isolation_3_findings.sql
  summarize_findings "$OUT/attack_findings.log"
  echo "artifacts: $OUT" | tee -a "$LOG"
  exit 0
fi

if ! command -v initdb >/dev/null 2>&1 || ! command -v pg_ctl >/dev/null 2>&1; then
  echo "Neither Docker nor a local Postgres toolchain (initdb/pg_ctl) is available." >&2
  exit 1
fi

WORK=$(mktemp -d)
PGDATA="$WORK/data"
cleanup() {
  pg_ctl -D "$PGDATA" stop -m immediate >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

initdb -D "$PGDATA" -U postgres --auth=trust >/dev/null
pg_ctl -D "$PGDATA" -o "-k $WORK -c listen_addresses=''" -l "$WORK/pg.log" start >/dev/null

run_psql() { psql -h "$WORK" -U postgres -d postgres "$@"; }
{
  run_psql -v ON_ERROR_STOP=1 -q -f tests/shim_auth.sql
  for f in migrations/*.sql; do
    echo "applying $f"
    run_psql -v ON_ERROR_STOP=1 -q -f "$f"
  done
} 2>&1 | tee "$OUT/bootstrap.log"

lpsql() { run_psql -v ON_ERROR_STOP=1 -f "$1"; }
run_sql_stage security_regression lpsql tests/security_regression.sql
run_sql_stage attack_held        lpsql tests/attack_db_rls_grants_isolation_3.sql
run_sql_stage attack_findings    lpsql tests/attack_db_rls_grants_isolation_3_findings.sql
summarize_findings "$OUT/attack_findings.log"
echo "artifacts: $OUT" | tee -a "$LOG"
