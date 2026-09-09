#!/usr/bin/env bash
# W08-06 adversary: a REAL PostgREST (the hosted API layer the Edge worker's
# owner-namespace sweep talks to) in front of the disposable Postgres started
# by ./xc_pg_up.sh. Lets attack_w0806_r2_e2e.test.ts drive the shipping Edge
# handler through genuine PostgREST query parsing, JWT role switching, RLS and
# max_rows clamping instead of the in-process stand-in.
#
#   XC_PG_URL=postgres://postgres:pg@127.0.0.1:55433/postgres ./attack_w0806_r2_pgrst_up.sh
#   # prints the XC_PGRST_URL / XC_PGRST_JWT_SECRET exports for the test run
set -euo pipefail

: "${XC_PG_URL:?set XC_PG_URL to the disposable Postgres (see xc_pg_up.sh)}"
PGRST_PORT="${XC_PGRST_PORT:-3011}"
PGRST_NAME="${XC_PGRST_NAME:-pickle-xc-postgrest}"
PGRST_IMAGE="${XC_PGRST_IMAGE:-postgrest/postgrest:v12.2.3}"
JWT_SECRET="${XC_PGRST_JWT_SECRET:-w0806-attack-jwt-secret-at-least-32-bytes-long}"

docker rm -f "$PGRST_NAME" >/dev/null 2>&1 || true
docker run -d --name "$PGRST_NAME" --network host \
  -e PGRST_DB_URI="$XC_PG_URL" \
  -e PGRST_DB_SCHEMAS=public \
  -e PGRST_DB_ANON_ROLE=anon \
  -e PGRST_JWT_SECRET="$JWT_SECRET" \
  -e PGRST_SERVER_PORT="$PGRST_PORT" \
  -e PGRST_DB_MAX_ROWS=1000 \
  -e PGRST_LOG_LEVEL=info \
  "$PGRST_IMAGE" >/dev/null

for _ in $(seq 1 40); do
  if curl -fsS -o /dev/null "http://127.0.0.1:${PGRST_PORT}/"; then
    echo "export XC_PGRST_URL=http://127.0.0.1:${PGRST_PORT}"
    echo "export XC_PGRST_JWT_SECRET=${JWT_SECRET}"
    exit 0
  fi
  sleep 0.5
done
echo "PostgREST did not become ready" >&2
docker logs "$PGRST_NAME" >&2 || true
exit 1
