#!/usr/bin/env bash
# xc-i18n-unicode-names-text — run supabase/tests/xc_i18n_unicode_probe.sql
# against a throwaway postgres:16 with the Supabase shim + every migration
# applied (same recipe as supabase/tests/run_rls_tests.sh). Never points at a
# hosted project.
#
#   scripts/xc-i18n/run_pg_probe.sh [out_dir]
#
# Writes <out_dir>/pg_probe.jsonl (one JSON document per probe section) and
# <out_dir>/pg_probe.log. Exit code is psql's (ON_ERROR_STOP): a non-zero exit
# means the harness itself broke, not that a probe "failed" — expected DB
# errors are captured as {ok:false, sqlstate, message} inside the JSON.
set -euo pipefail

cd "$(dirname "$0")/../.."
OUT=${1:-artifacts/xc-i18n}
mkdir -p "$OUT"

if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  echo "docker is required for the throwaway postgres" >&2
  exit 2
fi

CONTAINER=xc-i18n-pg-probe
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

docker cp supabase/tests "$CONTAINER":/tests
docker cp supabase/migrations "$CONTAINER":/migrations

docker exec "$CONTAINER" bash -c '
  set -euo pipefail
  psql -U postgres -v ON_ERROR_STOP=1 -q -f /tests/shim_auth.sql
  for f in /migrations/*.sql; do
    psql -U postgres -v ON_ERROR_STOP=1 -q -f "$f" >/dev/null
  done
' > "$OUT/pg_probe.log" 2>&1

set +e
docker exec "$CONTAINER" psql -U postgres -v ON_ERROR_STOP=1 -q -f /tests/xc_i18n_unicode_probe.sql \
  > "$OUT/pg_probe.jsonl" 2>> "$OUT/pg_probe.log"
status=$?
set -e

echo "[xc-i18n] pg probe exit=$status sections=$(grep -c '"section"' "$OUT/pg_probe.jsonl" || true) -> $OUT/pg_probe.jsonl"
exit "$status"
