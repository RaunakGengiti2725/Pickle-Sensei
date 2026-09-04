#!/usr/bin/env bash
# Adjudication reproduction probes for area db-rls-grants-isolation
# (baseline 4d812e1aa699014cc0521fd92fde66908043aaa8).
#
#   ./supabase/tests/adjudication_db_rls/run_adjudication.sh [--out DIR]
#
# Throwaway Docker postgres:16, same recipe as run_rls_tests.sh: shim_auth.sql →
# every migration → the canonical security matrix → the probe files here.
# Every probe prints `RESULT|<id>|<verdict>|<detail>` lines and rolls back its
# own fixtures. Verdicts:
#   REPRODUCED  the auditor-reported behaviour is present on this revision
#   HELD        the boundary that was probed holds
#   BROKEN      a boundary that is expected to hold does not (never expected)
#   INFO        observation only
# Exit code: 0 when the matrix passes and no BROKEN line was emitted;
# 1 on any BROKEN line or matrix failure; 2 on setup failure.
# The REPRODUCED lines are the confirmed findings; once fix migrations land
# they flip to NOT_REPRODUCED and the assertions can be moved into
# security_regression.sql as denied-path cases.
set -euo pipefail

cd "$(dirname "$0")/../.."
HERE=tests/adjudication_db_rls
OUT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --out) OUT="$2"; shift ;;
    *) echo "unknown arg $1" >&2; exit 2 ;;
  esac
  shift
done
[ -n "$OUT" ] || OUT="$(mktemp -d)"
mkdir -p "$OUT"

if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  echo "docker is required for the adjudication probes" >&2
  exit 2
fi

CONTAINER=pickle-adjudication-db-rls
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
  echo "postgres:16 container did not become ready within 60s" >&2
  exit 2
fi

docker cp tests "$CONTAINER":/tests
docker cp migrations "$CONTAINER":/migrations

docker exec "$CONTAINER" bash -c '
  set -euo pipefail
  psql -U postgres -v ON_ERROR_STOP=1 -q -f /tests/shim_auth.sql
  for f in /migrations/*.sql; do
    psql -U postgres -v ON_ERROR_STOP=1 -q -f "$f"
  done
' >"$OUT/setup.log" 2>&1

docker exec "$CONTAINER" psql -U postgres -v ON_ERROR_STOP=1 -f /tests/security_regression.sql \
  >"$OUT/matrix.log" 2>&1
grep -q "SECURITY REGRESSION MATRIX: ALL CASES PASSED" "$OUT/matrix.log"

: >"$OUT/results.txt"
for probe in c1_c2_permits_direct_insert c3_c4_c5_details_triggers m_residuals; do
  docker exec "$CONTAINER" psql -U postgres -v ON_ERROR_STOP=1 -f "/tests/adjudication_db_rls/$probe.sql" \
    >"$OUT/$probe.log" 2>&1
  sed -n 's/^.*RESULT|/RESULT|/p' "$OUT/$probe.log" >>"$OUT/results.txt"
done

cat "$OUT/results.txt"
echo "artifacts: $OUT"
if grep -q "|BROKEN|" "$OUT/results.txt"; then
  echo "ADJUDICATION: a boundary expected to hold is BROKEN" >&2
  exit 1
fi
echo "ADJUDICATION: matrix passed; $(grep -c '|REPRODUCED|' "$OUT/results.txt") REPRODUCED, $(grep -c '|HELD|' "$OUT/results.txt") HELD"
