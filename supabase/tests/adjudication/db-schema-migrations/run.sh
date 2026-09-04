#!/usr/bin/env bash
# Adjudication reproduction runner for area db-schema-migrations.
# Boots a throwaway postgres:16, installs supabase/tests/shim_auth.sql + every
# migration once into a template DB, then runs each probe in a FRESH database
# cloned from that template. Probes print "DEFECT_REPRODUCED <id>: ..." or
# "HELD <id>" verdict rows; nothing here asserts — this is evidence collection,
# not a gate. Logs land in $OUT (default artifacts/adjudication/db-schema-migrations).
set -euo pipefail
cd "$(dirname "$0")/../../.."   # supabase/
HERE=tests/adjudication/db-schema-migrations
OUT=${OUT:-../artifacts/adjudication/db-schema-migrations}
mkdir -p "$OUT"
CONTAINER=${CONTAINER:-pickle-adj-pg}
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
docker run -d --name "$CONTAINER" -e POSTGRES_PASSWORD=pg postgres:16 >/dev/null
for _ in $(seq 1 60); do
  docker exec "$CONTAINER" pg_isready -U postgres >/dev/null 2>&1 && break
  sleep 1
done
docker cp tests "$CONTAINER":/tests
docker cp migrations "$CONTAINER":/migrations
docker exec "$CONTAINER" bash -c '
  set -euo pipefail
  psql -U postgres -v ON_ERROR_STOP=1 -q -c "create database template_adj"
  psql -U postgres -d template_adj -v ON_ERROR_STOP=1 -q -f /tests/shim_auth.sql
  for f in /migrations/*.sql; do
    psql -U postgres -d template_adj -v ON_ERROR_STOP=1 -q -f "$f"
  done
' | tee "$OUT/00_migrate.log"

for probe in "$HERE"/[0-9][0-9]_*.sql; do
  name=$(basename "$probe" .sql)
  [ "$name" = "00_seed" ] && continue
  db="adj_${name%%_*}"
  docker exec "$CONTAINER" psql -U postgres -q -c "drop database if exists $db" -c "create database $db template template_adj" >/dev/null
  echo "### $name"
  docker exec -i "$CONTAINER" psql -U postgres -d "$db" -v ON_ERROR_STOP=0 -v N="${N:-2000}" \
    -f /tests/adjudication/db-schema-migrations/00_seed.sql \
    -f "/tests/adjudication/db-schema-migrations/$name.sql" 2>&1 | tee "$OUT/$name.log"
  echo "exit=${PIPESTATUS[0]}" | tee -a "$OUT/$name.log"
done
echo "logs: $OUT"
