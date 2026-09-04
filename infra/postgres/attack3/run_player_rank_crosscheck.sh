#!/usr/bin/env bash
# Adversarial pass 3 — spin a THROWAWAY postgres:16 container, apply the auth
# shim + every supabase migration, run player_rank_crosscheck.sql and write
# its JSON to $1 (default: /tmp/attack3-player-rank-pg.json).
#
# Never points at a real Supabase project; the container is removed on exit.
set -euo pipefail
OUT="${1:-/tmp/attack3-player-rank-pg.json}"
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
CONTAINER="attack3-pg-$$"

cleanup() { docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; }
trap cleanup EXIT

docker run -d --name "$CONTAINER" -e POSTGRES_PASSWORD=pg postgres:16-alpine >/dev/null
for _ in $(seq 1 60); do
  if docker exec "$CONTAINER" pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1; then break; fi
  sleep 1
done
docker exec "$CONTAINER" pg_isready -h 127.0.0.1 -U postgres >/dev/null

docker cp "$ROOT/supabase/tests/shim_auth.sql" "$CONTAINER":/shim_auth.sql
docker cp "$ROOT/supabase/migrations" "$CONTAINER":/migrations
docker cp "$ROOT/infra/postgres/attack3/player_rank_crosscheck.sql" "$CONTAINER":/crosscheck.sql

docker exec "$CONTAINER" bash -c '
  set -euo pipefail
  psql -U postgres -v ON_ERROR_STOP=1 -q -f /shim_auth.sql
  for f in /migrations/*.sql; do
    psql -U postgres -v ON_ERROR_STOP=1 -q -f "$f" >/dev/null
  done
' >&2

docker exec "$CONTAINER" psql -U postgres -v ON_ERROR_STOP=1 -q -f /crosscheck.sql > "$OUT"
echo "wrote $OUT" >&2
cat "$OUT"
