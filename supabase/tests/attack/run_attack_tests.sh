#!/usr/bin/env bash
# Adversarial companion to supabase/tests/run_rls_tests.sh (audit harness —
# db-rls-grants-isolation execution pass). Same disposable postgres:16 flow:
#
#   1. shim_auth.sql                         (repo shim, unchanged)
#      + shim_fidelity_probe.sql             (prints anon EXECUTE canary: f)
#   2. shim_hosted_function_defaults.sql     (hosted FUNCTIONS default privs)
#      + shim_fidelity_probe.sql             (canary again: t)
#   3. every migration in order
#   4. security_regression.sql  — the existing matrix, now under hosted-shaped
#                                 function ACLs (must still pass)
#   5. attack_matrix.sql        — K1..K10 (records every verdict, raises at the
#                                 end if any FAIL; JSON copied to $OUT_DIR)
#
# Usage: supabase/tests/attack/run_attack_tests.sh [--out-dir DIR] [--skip-hosted-shim]
# Exit: 0 when both matrices pass; 3 (psql) when a case fails; 1 on setup error.
# Never touches production; needs Docker (no local-postgres fallback here —
# the repo runner covers that path).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUPABASE_DIR="$(cd "$HERE/../.." && pwd)"
OUT_DIR="${OUT_DIR:-$SUPABASE_DIR/../artifacts/rls-attack}"
HOSTED_SHIM=1
while [ $# -gt 0 ]; do
  case "$1" in
    --out-dir) OUT_DIR="$2"; shift 2 ;;
    --skip-hosted-shim) HOSTED_SHIM=0; shift ;;
    *) echo "unknown arg: $1" >&2; exit 1 ;;
  esac
done
mkdir -p "$OUT_DIR"

if ! docker info >/dev/null 2>&1; then
  echo "run_attack_tests: Docker is required" >&2
  exit 1
fi

CONTAINER="pickle-rls-attack-$$"
cleanup() { docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; }
trap cleanup EXIT

docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
docker run -d --name "$CONTAINER" \
  -e POSTGRES_PASSWORD=postgres -e POSTGRES_HOST_AUTH_METHOD=trust \
  postgres:16 >/dev/null

ready=0
for _ in $(seq 1 60); do
  if docker exec "$CONTAINER" pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1; then
    ready=1; break
  fi
  sleep 1
done
if [ "$ready" -ne 1 ]; then
  echo "run_attack_tests: postgres did not become ready over TCP within 60s" >&2
  docker logs "$CONTAINER" >&2 || true
  exit 1
fi

docker cp "$SUPABASE_DIR/tests" "$CONTAINER":/tests
docker cp "$SUPABASE_DIR/migrations" "$CONTAINER":/migrations

PSQL=(docker exec "$CONTAINER" psql -U postgres -v ON_ERROR_STOP=1)

echo "── shim (repo)"
"${PSQL[@]}" -q -f /tests/shim_auth.sql
"${PSQL[@]}" -q -f /tests/attack/shim_fidelity_probe.sql
if [ "$HOSTED_SHIM" -eq 1 ]; then
  echo "── shim (hosted function default privileges)"
  "${PSQL[@]}" -q -f /tests/attack/shim_hosted_function_defaults.sql
  "${PSQL[@]}" -q -f /tests/attack/shim_fidelity_probe.sql
fi

echo "── migrations"
for f in "$SUPABASE_DIR"/migrations/*.sql; do
  "${PSQL[@]}" -q -f "/migrations/$(basename "$f")" 2>&1 | { grep -v 'NOTICE:' || true; }
  test "${PIPESTATUS[0]}" -eq 0
done

echo "── security_regression.sql (existing matrix)"
"${PSQL[@]}" -f /tests/security_regression.sql 2>&1 | tee "$OUT_DIR/security_regression.log"
test "${PIPESTATUS[0]}" -eq 0

echo "── attack_matrix.sql"
set +e
"${PSQL[@]}" -f /tests/attack/attack_matrix.sql 2>&1 | tee "$OUT_DIR/attack_matrix.log"
rc="${PIPESTATUS[0]}"
set -e
docker cp "$CONTAINER":/tmp/attack_results.json "$OUT_DIR/attack_results.json" 2>/dev/null \
  || echo "run_attack_tests: attack_results.json not produced" >&2
echo "attack_matrix exit=$rc (results: $OUT_DIR/attack_results.json)"
exit "$rc"
