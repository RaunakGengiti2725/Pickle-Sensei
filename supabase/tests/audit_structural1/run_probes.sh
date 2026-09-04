#!/usr/bin/env bash
# Structural audit #1 (db-rls-grants-isolation) — additive probe runner.
#
#   ./supabase/tests/audit_structural1/run_probes.sh [--hosted-fn] [--out DIR]
#
# Same lifecycle as ../run_rls_tests.sh (Docker postgres:16, shim, every
# migration in order) but then runs, instead of / in addition to the pinned
# matrix:
#   1. security_regression.sql   (the existing matrix — must still pass)
#   2. probes.sql                (sequential probes, RESULT| lines)
#   3. concurrency.sh            (multi-session probes, RESULT| lines)
#
# --hosted-fn additionally applies hosted_function_defaults.sql after the
# shim, so functions get hosted Supabase's default EXECUTE grants and only
# explicit migration REVOKEs can take them away.
#
# Exit 0 iff the matrix passed AND no probe emitted RESULT|…|FAIL|.
# Never modifies anything outside the throwaway container and $OUT.
set -euo pipefail

HOSTED_FN=0
OUT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --hosted-fn) HOSTED_FN=1 ;;
    --out) OUT="$2"; shift ;;
    *) echo "unknown arg $1" >&2; exit 2 ;;
  esac
  shift
done

cd "$(dirname "$0")/../.."          # supabase/
OUT=${OUT:-"$(pwd)/tests/audit_structural1/out"}
mkdir -p "$OUT"

if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  echo "Docker is required for the audit probes (the pinned matrix has an initdb fallback; this runner does not)." >&2
  exit 2
fi

CONTAINER=pickle-rls-audit-structural1
cleanup() { docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup

docker run -d --name "$CONTAINER" -e POSTGRES_PASSWORD=pg postgres:16 >/dev/null
ready=0
for _ in $(seq 1 60); do
  if docker exec "$CONTAINER" pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1; then ready=1; break; fi
  sleep 1
done
if [ "$ready" -ne 1 ]; then
  echo "postgres:16 container did not become ready within 60s" >&2
  docker logs "$CONTAINER" 2>&1 | tail -20 >&2
  exit 2
fi

docker cp tests "$CONTAINER":/tests
docker cp migrations "$CONTAINER":/migrations

docker exec -e HOSTED_FN="$HOSTED_FN" "$CONTAINER" bash -c '
  set -euo pipefail
  psql -U postgres -v ON_ERROR_STOP=1 -q -f /tests/shim_auth.sql
  if [ "$HOSTED_FN" = "1" ]; then
    psql -U postgres -v ON_ERROR_STOP=1 -q -f /tests/audit_structural1/hosted_function_defaults.sql
  fi
  for f in /migrations/*.sql; do
    psql -U postgres -v ON_ERROR_STOP=1 -q -f "$f"
  done
' | tee "$OUT/setup.log"

set +e
docker exec "$CONTAINER" psql -U postgres -v ON_ERROR_STOP=1 -f /tests/security_regression.sql \
  > "$OUT/matrix.log" 2>&1
MATRIX_EXIT=$?
echo "MATRIX_EXIT=$MATRIX_EXIT" | tee -a "$OUT/matrix.log"

docker exec "$CONTAINER" psql -U postgres -f /tests/audit_structural1/probes.sql \
  > "$OUT/probes.raw.log" 2>&1
PROBES_EXIT=$?
echo "PROBES_EXIT=$PROBES_EXIT" >> "$OUT/probes.raw.log"

docker exec "$CONTAINER" bash /tests/audit_structural1/concurrency.sh \
  > "$OUT/concurrency.raw.log" 2>&1
CONC_EXIT=$?
echo "CONC_EXIT=$CONC_EXIT" >> "$OUT/concurrency.raw.log"
set -e

grep -h 'RESULT|' "$OUT/probes.raw.log" "$OUT/concurrency.raw.log" \
  | sed -E 's/^(psql:[^ ]* )?(NOTICE|INFO):\s*//' > "$OUT/results.txt"

PASS=$(grep -c '|PASS|' "$OUT/results.txt" || true)
FAIL=$(grep -c '|FAIL|' "$OUT/results.txt" || true)
INFO=$(grep -c '|INFO|' "$OUT/results.txt" || true)
UNEXPECTED=$(grep -c 'UNEXPECTED' "$OUT/results.txt" || true)

{
  echo "mode=$([ "$HOSTED_FN" = 1 ] && echo hosted-fn || echo shim-default)"
  echo "commit=$(git rev-parse HEAD 2>/dev/null || echo unknown)"
  echo "matrix_exit=$MATRIX_EXIT probes_exit=$PROBES_EXIT concurrency_exit=$CONC_EXIT"
  echo "pass=$PASS fail=$FAIL info=$INFO unexpected=$UNEXPECTED"
  grep -c 'PROBES COMPLETE' "$OUT/probes.raw.log" >/dev/null || echo "WARNING: probes.sql did not reach the end"
  grep -c 'CONCURRENCY COMPLETE' "$OUT/concurrency.raw.log" >/dev/null || echo "WARNING: concurrency.sh did not reach the end"
} | tee "$OUT/summary.txt"

cat "$OUT/results.txt"

if [ "$MATRIX_EXIT" -ne 0 ] || [ "$FAIL" -ne 0 ] || [ "$PROBES_EXIT" -ne 0 ] || [ "$CONC_EXIT" -ne 0 ] \
   || ! grep -q 'PROBES COMPLETE' "$OUT/probes.raw.log" || ! grep -q 'CONCURRENCY COMPLETE' "$OUT/concurrency.raw.log"; then
  echo "AUDIT PROBES: FAILURES PRESENT (matrix_exit=$MATRIX_EXIT fail=$FAIL)"
  exit 1
fi
echo "AUDIT PROBES: ALL PINNED INVARIANTS HELD (pass=$PASS info=$INFO)"
