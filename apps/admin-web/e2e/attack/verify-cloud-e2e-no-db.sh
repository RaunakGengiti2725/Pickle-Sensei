#!/usr/bin/env bash
# Adversarial S6 — does verify-cloud's e2e stage report a partially-skipped
# Playwright run honestly?
#
# Setup: PICKLE_E2E_DATABASE_URL unset, the dev Postgres container STOPPED,
# then `scripts/verify-cloud.sh --only e2e`. smoke.e2e.ts skips its
# authenticated-panel test when no datastore is available. verify-cloud's own
# policy header says "a SKIPPED stage is never reported as passed".
#
# Asserted (HELD when all true, otherwise BROKEN with the failing check named):
#   1. Playwright reports the authenticated test as "skipped" in e2e.log
#   2. summary.json marks the e2e stage as something OTHER than a clean "passed"
#      (skipped / unavailable / failed, or a non-empty note mentioning the skip)
#   3. verify-cloud's exit code is non-zero (partial coverage != pass)
#
# Usage: apps/admin-web/e2e/attack/verify-cloud-e2e-no-db.sh [out-dir]
# Restarts the postgres container afterwards regardless of outcome.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
OUT="${1:-$REPO_ROOT/artifacts/attack3/s6-verify-cloud-no-db}"
mkdir -p "$OUT"
cd "$REPO_ROOT"

unset PICKLE_E2E_DATABASE_URL
unset CI

restore() { docker compose start postgres >/dev/null 2>&1 || docker compose up -d postgres >/dev/null 2>&1; }
trap restore EXIT

echo "==> stopping dev postgres (5432)"
docker compose stop postgres >"$OUT/docker-stop.log" 2>&1
sleep 1
if NODE_PATH="$REPO_ROOT/packages/database/node_modules" node -e '
const { Client } = require("pg");
const c = new Client({ connectionString: process.argv[1] });
c.connect().then(() => process.exit(0)).catch(() => process.exit(1));' \
  "${DATABASE_URL:-postgres://pickle:pickle_dev_password@localhost:5432/pickle_dev}"; then
  echo "dev DB still reachable — cannot run the attack" >&2
  exit 2
fi

echo "==> scripts/verify-cloud.sh --only e2e (no PICKLE_E2E_DATABASE_URL, DB down)"
run_log="$OUT/verify-cloud.stdout.log"
scripts/verify-cloud.sh --only e2e >"$run_log" 2>&1
rc=$?
echo "    verify-cloud exit=$rc"
summary=$(grep -Eo 'summary: .*summary.json' "$run_log" | awk '{print $2}')
[ -n "$summary" ] || { echo "no summary path in $run_log" >&2; exit 2; }
run_dir=$(dirname "$summary")
cp "$summary" "$OUT/summary.json"
cp "$run_dir/e2e.log" "$OUT/e2e.log" 2>/dev/null

pw_skipped=$(grep -Eo '[0-9]+ skipped' "$OUT/e2e.log" | head -1)
pw_passed=$(grep -Eo '[0-9]+ passed' "$OUT/e2e.log" | head -1)
stage_status=$(node -e 'const s=require(process.argv[1]);const e=s.stages.find(x=>x.name==="e2e");console.log(e.status)' "$OUT/summary.json")
stage_note=$(node -e 'const s=require(process.argv[1]);const e=s.stages.find(x=>x.name==="e2e");console.log(e.note)' "$OUT/summary.json")
ok_flag=$(node -e 'console.log(require(process.argv[1]).ok)' "$OUT/summary.json")

checks=()
[ -n "$pw_skipped" ] || checks+=("playwright-did-not-report-skip")
if [ "$stage_status" = "passed" ] && [ -z "$stage_note" ]; then checks+=("summary-stage-passed-with-empty-note"); fi
[ "$rc" -ne 0 ] || checks+=("verify-cloud-exit-0")
mentions_skip=$(grep -ci "skip" "$OUT/summary.json")

verdict="HELD"; [ ${#checks[@]} -eq 0 ] || verdict="BROKEN"
printf '{"verdict":"%s","failed_checks":%s,"verify_cloud_exit":%d,"summary_ok":%s,"e2e_stage_status":"%s","e2e_stage_note":"%s","summary_mentions_skip":%s,"playwright":"%s, %s","artifacts":"%s"}\n' \
  "$verdict" "$(printf '%s\n' "${checks[@]:-}" | node -e 'const l=require("fs").readFileSync(0,"utf8").split("\n").filter(Boolean);console.log(JSON.stringify(l))')" \
  "$rc" "$ok_flag" "$stage_status" "$stage_note" "$mentions_skip" "$pw_passed" "$pw_skipped" "$OUT" | tee "$OUT/result.json"

[ "$verdict" = "HELD" ]
