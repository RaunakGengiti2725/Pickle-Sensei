#!/usr/bin/env bash
# Adversarial pass 3 — run observability_views_poison.sql against a THROWAWAY
# postgres:16 container and write the JSON verdict table to $1.
set -euo pipefail
OUT="${1:-/tmp/attack3-observability-views.json}"
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
CONTAINER="attack3-obs-pg-$$"

cleanup() { docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; }
trap cleanup EXIT

docker run -d --name "$CONTAINER" -e POSTGRES_PASSWORD=pg postgres:16-alpine >/dev/null
for _ in $(seq 1 60); do
  if docker exec "$CONTAINER" pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1; then break; fi
  sleep 1
done
docker exec "$CONTAINER" pg_isready -h 127.0.0.1 -U postgres >/dev/null

docker cp "$ROOT/infra/observability/views.sql" "$CONTAINER":/views.sql
docker cp "$ROOT/infra/postgres/attack3/observability_views_poison.sql" "$CONTAINER":/poison.sql
docker exec "$CONTAINER" psql -U postgres -v ON_ERROR_STOP=1 -q -f /poison.sql > "$OUT"
echo "wrote $OUT" >&2
cat "$OUT"
