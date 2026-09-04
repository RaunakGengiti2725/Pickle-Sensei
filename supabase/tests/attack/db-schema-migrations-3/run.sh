#!/usr/bin/env bash
# Adversarial pass #3 — db-schema-migrations.
#
#   ./supabase/tests/attack/db-schema-migrations-3/run.sh            # all scenarios
#   ./supabase/tests/attack/db-schema-migrations-3/run.sh s3 s7      # subset
#
# Boots a throwaway postgres:16 container, installs supabase/tests/shim_auth.sql
# + every supabase/migrations/*.sql (lexical order, ON_ERROR_STOP) + helpers.sql
# into a TEMPLATE database, then runs each s*.sh (assigned scenarios) and
# x*.sh (own attacks) against its own clone.
# Never touches production (no Supabase CLI, no network beyond docker pull).
# Artifacts: artifacts/attack-db-schema-migrations-3/latest/*.log + results.json
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

if [ "${ATTACK_SKIP_BOOT:-0}" != "1" ]; then
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  docker run -d --name "$CONTAINER" -e POSTGRES_PASSWORD=pg postgres:16 >/dev/null
  ready=0
  for _ in $(seq 1 60); do
    if docker exec "$CONTAINER" pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1; then
      ready=1; break
    fi
    sleep 1
  done
  [ "$ready" -eq 1 ] || { echo "postgres:16 did not become ready" >&2; exit 2; }

  docker cp "$SUPABASE_DIR/tests" "$CONTAINER":/tests
  docker cp "$SUPABASE_DIR/migrations" "$CONTAINER":/migrations
  docker cp "$ATTACK_DIR/helpers.sql" "$CONTAINER":/attack_helpers.sql

  dq postgres "drop database if exists $TEMPLATE_DB" >/dev/null
  dq postgres "create database $TEMPLATE_DB" >/dev/null
  docker exec "$CONTAINER" bash -c "
    set -euo pipefail
    psql -X -U postgres -d $TEMPLATE_DB -v ON_ERROR_STOP=1 -q -f /tests/shim_auth.sql
    for f in /migrations/*.sql; do
      echo \"applying \$f\"
      psql -X -U postgres -d $TEMPLATE_DB -v ON_ERROR_STOP=1 -q -f \"\$f\"
    done
    psql -X -U postgres -d $TEMPLATE_DB -v ON_ERROR_STOP=1 -q -f /attack_helpers.sql
  " 2>&1 | tee "$OUT_DIR/00_boot.log" | grep -v '^NOTICE'
  echo "migrations applied: $(ls "$SUPABASE_DIR"/migrations/*.sql | wc -l)" | tee -a "$OUT_DIR/00_boot.log"
fi

if [ $# -gt 0 ]; then
  scenarios=("$@")
else
  scenarios=()
  for f in "$ATTACK_DIR"/s*.sh "$ATTACK_DIR"/x*.sh; do scenarios+=("$(basename "$f" .sh)"); done
fi

results=()
overall=0
for s in "${scenarios[@]}"; do
  log="$OUT_DIR/$s.log"
  set +e
  bash "$ATTACK_DIR/$s.sh" >"$log" 2>&1
  rc=$?
  set -e
  verdict=$(grep -E '^SCENARIO (HELD|BROKEN)' "$log" | tail -1 || true)
  echo "$s rc=$rc | $verdict"
  results+=("{\"scenario\":\"$s\",\"exit\":$rc,\"verdict\":\"${verdict//\"/\\\"}\",\"log\":\"$log\"}")
  [ "$rc" -eq 0 ] || overall=1
done

printf '[%s]\n' "$(IFS=,; echo "${results[*]}")" > "$OUT_DIR/results.json"
echo "results: $OUT_DIR/results.json"
exit $overall
