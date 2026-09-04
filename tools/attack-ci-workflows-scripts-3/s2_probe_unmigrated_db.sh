#!/usr/bin/env bash
# S2 — tools/diagnostics/local_api_probe.mjs --start --with-account against an
# UN-MIGRATED database.
#
# Attack: point the probe (and therefore the Fastify API it spawns) at a fresh
# empty database. Every account route hits a missing table. Questions:
#   a) does the probe report that as a mismatch (FAIL, exit 1) — never as
#      "unavailable" / never as a pass?
#   b) how does services/api classify the missing schema — 503
#      api.datastore_unavailable (retryable) or 500 api.internal_error
#      (permanent)? (the scenario text expects the former to be the mismatch)
#   c) does /v1/health/slo (the "DB probe") still say 200 while every account
#      route is broken?
#
# Needs the docker `postgres` service (docker compose up -d postgres). Creates
# and drops a throwaway database on it; never touches pickle_dev's contents.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
cd "$REPO_ROOT" || exit 1

ADMIN_URL="${ATTACK_PG_ADMIN_URL:-postgres://pickle:pickle_dev_password@localhost:5432/postgres}"
DB="attack_unmigrated_$$"
APP_URL="${ADMIN_URL%/*}/$DB"
PORT="${ATTACK_PORT:-3101}"

if ! node "$HARNESS_DIR/pgctl.mjs" create-db "$ADMIN_URL" "$DB" >"$OUT/create_db.log" 2>&1; then
  log "cannot reach local postgres at ${ADMIN_URL%%@*}@…: $(tail -1 "$OUT/create_db.log")"
  record BROKEN s2.precondition 2 "$OUT/create_db.log" "docker postgres not reachable — scenario NOT executed"
  verdict
fi
trap 'node "$HARNESS_DIR/pgctl.mjs" drop-db "$ADMIN_URL" "$DB" >/dev/null 2>&1 || true' EXIT

node "$HARNESS_DIR/pgctl.mjs" sql "$APP_URL" "select count(*)::int as tables from information_schema.tables where table_schema='public'" \
  >"$OUT/table_count.json" 2>&1
if grep -q '"tables":0' "$OUT/table_count.json"; then
  record HELD s2.precondition 0 "$OUT/table_count.json" "fresh database has 0 public tables (un-migrated)"
else
  record BROKEN s2.precondition 1 "$OUT/table_count.json" "throwaway database is not empty: $(cat "$OUT/table_count.json")"
  verdict
fi

rc=$(run_split "$OUT/probe.json" "$OUT/probe.stderr" env DATABASE_URL="$APP_URL" API_BASE_URL="http://127.0.0.1:$PORT" \
  node tools/diagnostics/local_api_probe.mjs --start --with-account --json)
printf 'exit=%s\n' "$rc" >"$OUT/probe.rc"

# --- a) verdict must be FAIL / exit 1 (mismatch), not UNAVAILABLE / PASS -------
verdict_str=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("verdict"))' "$OUT/probe.json" 2>/dev/null || echo unparsable)
if [ "$rc" = 1 ] && [ "$verdict_str" = FAIL ]; then
  record HELD s2.mismatch_is_fail "$rc" "$OUT/probe.json" "un-migrated DB surfaces as verdict FAIL exit 1 (not unavailable, not pass)"
else
  record BROKEN s2.mismatch_is_fail "$rc" "$OUT/probe.json" "verdict=$verdict_str exit=$rc for an un-migrated DB"
fi

# --- b) how did the API classify the missing schema? --------------------------
python3 - "$OUT/probe.json" >"$OUT/classification.txt" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
for r in d["records"]:
    if r.get("outcome") != "pass":
        e = r.get("error") or {}
        print(f'{r["name"]}\t{r.get("outcome")}\tstatus={r.get("status")}\tkind={e.get("kind")}\tcode={e.get("code")}\tretryable={e.get("retryable")}')
PY
if grep -q "account bootstrap (WRITE)" "$OUT/classification.txt"; then
  boot_line=$(grep "account bootstrap (WRITE)" "$OUT/classification.txt")
  case "$boot_line" in
    *"status=503"*"api.datastore_unavailable"*)
      record HELD s2.bootstrap_classification "$rc" "$OUT/classification.txt" "bootstrap → 503 api.datastore_unavailable (retryable), reported as mismatch" ;;
    *"status=500"*"api.internal_error"*)
      record BROKEN s2.bootstrap_classification "$rc" "$OUT/classification.txt" \
        "bootstrap on an un-migrated DB → 500 api.internal_error kind=permanent (client gives up on queued work); 42P01 is not in isDatastoreUnavailable()" ;;
    *)
      record BROKEN s2.bootstrap_classification "$rc" "$OUT/classification.txt" "unexpected bootstrap outcome: $boot_line" ;;
  esac
else
  record BROKEN s2.bootstrap_classification "$rc" "$OUT/classification.txt" "bootstrap probe did not run/mismatch: $(cat "$OUT/classification.txt")"
fi

# --- c) health/slo must not report healthy while the schema is missing ---------
slo=$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); r=[x for x in d["records"] if x["name"]=="health/slo"][0]; print(r.get("outcome"), r.get("status"))' "$OUT/probe.json")
if [ "$slo" = "pass 200" ]; then
  record BROKEN s2.health_slo_blind "$rc" "$OUT/probe.json" "GET /v1/health/slo → 200 (SELECT 1 only) while every account route is 5xx on the missing schema"
else
  record HELD s2.health_slo_blind "$rc" "$OUT/probe.json" "health/slo reflected the broken datastore ($slo)"
fi

# --- d) rapid repeat: run again immediately (port reuse / leftover child) ------
rc2=$(run_split "$OUT/probe_repeat.json" "$OUT/probe_repeat.stderr" env DATABASE_URL="$APP_URL" API_BASE_URL="http://127.0.0.1:$PORT" \
  node tools/diagnostics/local_api_probe.mjs --start --with-account --json)
if [ "$rc2" = "$rc" ]; then
  record HELD s2.repeat_deterministic "$rc2" "$OUT/probe_repeat.json" "immediate re-run reproduces exit $rc"
else
  record BROKEN s2.repeat_deterministic "$rc2" "$OUT/probe_repeat.json" "immediate re-run gave exit $rc2 (first run $rc)"
fi

verdict
