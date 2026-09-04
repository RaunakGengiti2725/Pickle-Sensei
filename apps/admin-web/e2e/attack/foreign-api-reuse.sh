#!/usr/bin/env bash
# Adversarial S4 — reuseExistingServer hazard.
#
# A FOREIGN process already listens on 127.0.0.1:3001, answers GET /v1/health
# with 200, but was started with a DIFFERENT DEV_AUTH_SECRET than the one the
# Playwright suite mints tokens with. With CI unset the suite reuses that
# server instead of booting its own. Expectation: the authenticated smoke
# test must FAIL FAST with a 401 (not pass, not hang).
#
# Two foreign servers are tried:
#   real  — the actual @pickle/api with DEV_AUTH_SECRET=<other>
#   stub  — a 30-line node HTTP server: /v1/health → 200, everything else → 401
#
# Usage: apps/admin-web/e2e/attack/foreign-api-reuse.sh [out-dir]
# Exit 0 when BOTH variants fail fast with 401 (the invariant HELD); 1 otherwise.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
OUT="${1:-$REPO_ROOT/artifacts/attack3/s4-foreign-api}"
mkdir -p "$OUT"
DB_URL="${PICKLE_E2E_DATABASE_URL:-postgres://pickle:pickle_dev_password@localhost:5432/pickle_dev}"
SUITE_SECRET="pickle-e2e-dev-secret-0123456789"   # the config default
FOREIGN_SECRET="foreign-process-secret-9876543210"
MAX_SECONDS=240

cd "$REPO_ROOT"
unset CI

wait_health() {
  for _ in $(seq 1 60); do
    if curl -sS -m 2 -o /dev/null -w '%{http_code}' http://127.0.0.1:3001/v1/health 2>/dev/null | grep -q 200; then
      return 0
    fi
    sleep 1
  done
  return 1
}

port_busy() { curl -sS -m 2 -o /dev/null http://127.0.0.1:3001/ 2>/dev/null; }

if port_busy; then
  echo "port 3001 is already busy — stop whatever is listening before running this attack" >&2
  exit 2
fi

run_variant() {
  local name="$1"; shift
  local log="$OUT/$name.e2e.log"
  echo "==> [$name] starting foreign server"
  # own process group so pnpm → tsx → node all die together
  setsid "$@" >"$OUT/$name.server.log" 2>&1 &
  local pid=$!
  if ! wait_health; then
    echo "    [$name] foreign server never became healthy"; kill -- "-$pid" 2>/dev/null; wait "$pid" 2>/dev/null
    return 1
  fi
  echo "    [$name] /v1/health 200 from pid $pid; running the suite (CI unset, reuseExistingServer=true)"
  local start end secs rc
  start=$(date +%s)
  DEV_AUTH_SECRET="$SUITE_SECRET" PICKLE_E2E_DATABASE_URL="$DB_URL" \
    timeout "${MAX_SECONDS}s" pnpm --filter @pickle/admin-web e2e >"$log" 2>&1
  rc=$?
  end=$(date +%s); secs=$((end - start))
  kill -- "-$pid" 2>/dev/null; wait "$pid" 2>/dev/null
  for _ in $(seq 1 20); do port_busy || break; sleep 0.5; done
  # the vite server Playwright started is torn down by Playwright itself
  local verdict="HELD"
  if [ "$rc" -eq 124 ]; then verdict="BROKEN(hang: killed after ${MAX_SECONDS}s)"; fi
  if [ "$rc" -eq 0 ]; then verdict="BROKEN(suite passed against a foreign secret)"; fi
  if ! grep -q "POST /v1/account/bootstrap" "$log" || ! grep -Eq "Received: 401|→ HTTP 401|401" "$log"; then
    verdict="BROKEN(no 401 reported: rc=$rc)"
  fi
  # the two anonymous tests must still pass — only the authenticated one may fail
  local passed failed
  passed=$(grep -Eo '[0-9]+ passed' "$log" | head -1)
  failed=$(grep -Eo '[0-9]+ failed' "$log" | head -1)
  printf '{"variant":"%s","exit":%d,"seconds":%d,"passed":"%s","failed":"%s","verdict":"%s","log":"%s"}\n' \
    "$name" "$rc" "$secs" "$passed" "$failed" "$verdict" "$log" | tee -a "$OUT/results.jsonl"
  [ "$verdict" = "HELD" ]
}

overall=0

run_variant real env PICKLE_ENV=development PORT=3001 HOST=127.0.0.1 \
  DEV_AUTH_SECRET="$FOREIGN_SECRET" DATABASE_URL="$DB_URL" \
  pnpm --filter @pickle/api start || overall=1

sleep 1
if port_busy; then echo "port 3001 still busy after real variant" >&2; exit 2; fi

run_variant stub node "$REPO_ROOT/apps/admin-web/e2e/attack/stub-health-server.mjs" || overall=1

echo "results: $OUT/results.jsonl"
exit "$overall"
