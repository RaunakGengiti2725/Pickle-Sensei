#!/usr/bin/env bash
# Boot a throwaway postgres:16 (Docker), install supabase/tests/shim_auth.sql
# + every migration exactly like supabase/tests/run_rls_tests.sh, then run the
# live grant/RLS/RPC matrix (grant_matrix.ts) against it. Never touches hosted
# Supabase.
#
#   tools/audit/static_health_edge_db/run_live.sh [out_dir]
#
# Writes <out_dir>/grant_matrix.json, grant_matrix.stderr, migrations_apply.log
# and propagates grant_matrix.ts's exit code.
set -euo pipefail

cd "$(dirname "$0")/../../.."
OUT_DIR=${1:-artifacts/xc-static-health/$(date -u +%Y%m%dT%H%M%SZ)}
mkdir -p "$OUT_DIR"
DENO=${DENO:-deno}
if ! command -v "$DENO" >/dev/null 2>&1 && [ -x "$HOME/.deno/bin/deno" ]; then
  DENO="$HOME/.deno/bin/deno"
fi

CONTAINER=pickle-xc-static-health
PORT=${PICKLE_XC_PG_PORT:-55433}
cleanup() {
  if docker ps -a --format '{{.Names}}' | grep -qx "$CONTAINER"; then
    docker rm -f "$CONTAINER" >/dev/null
  fi
}
trap cleanup EXIT
cleanup

docker run -d --name "$CONTAINER" -p "127.0.0.1:${PORT}:5432" -e POSTGRES_PASSWORD=pg postgres:16 >/dev/null
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

docker cp supabase/tests "$CONTAINER":/tests
docker cp supabase/migrations "$CONTAINER":/migrations
docker exec "$CONTAINER" bash -c '
  set -euo pipefail
  psql -U postgres -v ON_ERROR_STOP=1 -q -f /tests/shim_auth.sql
  for f in /migrations/*.sql; do
    echo "applying $f"
    psql -U postgres -v ON_ERROR_STOP=1 -q -f "$f"
  done
' >"$OUT_DIR/migrations_apply.log" 2>&1

set +e
PICKLE_AUDIT_PG_URL="postgres://postgres:pg@127.0.0.1:${PORT}/postgres" \
  "$DENO" run -A --no-check --config tools/audit/static_health_edge_db/deno.json \
  tools/audit/static_health_edge_db/grant_matrix.ts --out "$OUT_DIR/grant_matrix.json" \
  2>"$OUT_DIR/grant_matrix.stderr"
status=$?
set -e
cat "$OUT_DIR/grant_matrix.stderr" >&2
echo "grant_matrix exit=$status → $OUT_DIR/grant_matrix.json"
exit $status
