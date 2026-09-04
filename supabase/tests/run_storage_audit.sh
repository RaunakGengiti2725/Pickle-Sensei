#!/usr/bin/env bash
# Storage-surface audit for the Supabase schema on a THROWAWAY Postgres.
#
# Mirrors run_rls_tests.sh: a fresh postgres:16 container gets the hosted-like
# shim (auth schema, roles, default privileges), every migration in order, then
# storage_audit.sql. Also greps the migrations and the edge function for any
# Supabase Storage API usage, so "no bucket exists" is asserted from BOTH the
# schema and the code, not assumed.
#
#   ./supabase/tests/run_storage_audit.sh [--out <dir>]
#
# Writes <dir>/storage_audit.log (full psql output) and <dir>/storage_inventory.json
# (the JSON inventory the SQL emits). Exit 0 only when every case passed.
# Never touches a hosted project: the only database is the container it starts.
set -euo pipefail

cd "$(dirname "$0")/.."

OUT_DIR=""
while [ $# -gt 0 ]; do
  case "$1" in
    --out) OUT_DIR="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
if [ -z "$OUT_DIR" ]; then
  OUT_DIR="../artifacts/storage-policies/$(date -u +%Y%m%dT%H%M%SZ)/supabase"
fi
mkdir -p "$OUT_DIR"
LOG="$OUT_DIR/storage_audit.log"
: > "$LOG"

echo "== static: Supabase Storage API references (migrations + edge function)" | tee -a "$LOG"
# storage.buckets / storage.objects / storage.from(...) / createSignedUrl /
# getPublicUrl / supabase.storage — any hit means a bucket path exists that the
# SQL audit below cannot see.
set +e
STATIC_HITS=$(grep -rniE 'storage\.(buckets|objects|from\(|createSignedUrl|getPublicUrl|upload\()|supabase\.storage|createSignedUploadUrl' \
  migrations functions --include='*.sql' --include='*.ts')
GREP_STATUS=$?
set -e
# grep: 0 = hits (audit fails), 1 = no hits (expected), 2+ = grep itself failed.
if [ "$GREP_STATUS" -eq 0 ]; then
  echo "FAIL: Supabase Storage API references found:" | tee -a "$LOG"
  echo "$STATIC_HITS" | tee -a "$LOG"
  exit 1
elif [ "$GREP_STATUS" -ne 1 ]; then
  echo "FAIL: grep exited $GREP_STATUS" | tee -a "$LOG"
  exit "$GREP_STATUS"
fi
echo "ok: no Supabase Storage API references in supabase/migrations or supabase/functions" | tee -a "$LOG"

if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  echo "FAIL: Docker is required for the throwaway postgres:16 (no fallback here)" | tee -a "$LOG"
  exit 1
fi

CONTAINER="pickle-storage-audit-$$"
cleanup() {
  if docker ps -a --format '{{.Names}}' | grep -qx "$CONTAINER"; then
    docker rm -f "$CONTAINER" >/dev/null 2>&1
  fi
}
trap cleanup EXIT

echo "== throwaway postgres:16 ($CONTAINER)" | tee -a "$LOG"
docker run -d --name "$CONTAINER" -e POSTGRES_PASSWORD=pg postgres:16 >/dev/null
for _ in $(seq 1 60); do
  if docker exec "$CONTAINER" pg_isready -U postgres >/dev/null 2>&1; then break; fi
  sleep 1
done
docker exec "$CONTAINER" pg_isready -U postgres >/dev/null

docker cp tests "$CONTAINER":/tests
docker cp migrations "$CONTAINER":/migrations

set +e
docker exec "$CONTAINER" bash -c '
  set -euo pipefail
  psql -U postgres -v ON_ERROR_STOP=1 -q -f /tests/shim_auth.sql
  for f in /migrations/*.sql; do
    echo "applying $f"
    psql -U postgres -v ON_ERROR_STOP=1 -q -f "$f"
  done
  psql -U postgres -v ON_ERROR_STOP=1 -f /tests/storage_audit.sql
' 2>&1 | tee -a "$LOG"
STATUS=${PIPESTATUS[0]}
set -e

# Extract the JSON inventory between the markers into its own artifact.
awk '/STORAGE_AUDIT_JSON_BEGIN/{flag=1; next} /STORAGE_AUDIT_JSON_END/{flag=0} flag' "$LOG" \
  | grep -v '^$' > "$OUT_DIR/storage_inventory.json"

if [ "$STATUS" -ne 0 ]; then
  echo "FAIL: storage audit exited $STATUS (see $LOG)" | tee -a "$LOG"
  exit "$STATUS"
fi
if ! python3 -c 'import json,sys; json.load(open(sys.argv[1]))' "$OUT_DIR/storage_inventory.json" 2>/dev/null; then
  echo "FAIL: inventory JSON missing or malformed at $OUT_DIR/storage_inventory.json" | tee -a "$LOG"
  exit 1
fi
echo "ok: storage audit passed → $OUT_DIR" | tee -a "$LOG"
