#!/usr/bin/env bash
# Structural audit (services-api-legacy-admin-web, pass 1) reproducer.
#
# playwright.config.ts sets reuseExistingServer = !CI, so a bare `pnpm e2e`
# attaches to whatever already listens on :3001. When that API was started
# with a DIFFERENT DEV_AUTH_SECRET than the one the suite mints with, the
# authenticated smoke test fails deep inside with a bare 401 from
# POST /v1/account/bootstrap instead of an up-front "secret mismatch /
# foreign server" error.
#
# Expected (if the config guarded against this): the run aborts before any
# test with a clear message about the foreign :3001 server.
# Observed on 4d812e1a: tests 1-2 pass, test 3 fails with
#   Error: POST /v1/account/bootstrap … Expected: < 300  Received: 401
#
# Usage (from the repo root, with `docker compose up -d postgres` and the dev
# database migrated + seeded; ports 3001/5173 must be free):
#   bash apps/admin-web/e2e/audit-structural1/stale-server-secret-mismatch.sh
# Exit code 0 = defect reproduced (e2e failed with 401), 1 = did not reproduce.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
DEV_DB="${PICKLE_E2E_DATABASE_URL:-postgres://pickle:pickle_dev_password@localhost:5432/pickle_dev}"
LOG="${AUDIT_LOG:-/tmp/audit-stale-server-e2e.log}"

cd "$REPO_ROOT"

if ss -ltn | grep -qE ':3001|:5173'; then
  echo "ports 3001/5173 busy — stop other servers first" >&2
  exit 2
fi

# setsid → own process group so the whole pnpm → tsx → node tree can be
# stopped on exit (killing only the pnpm wrapper leaves :3001 listening).
PICKLE_ENV=development PORT=3001 HOST=127.0.0.1 \
  DEV_AUTH_SECRET="stale-foreign-secret-0123456789" \
  DATABASE_URL="$DEV_DB" \
  setsid pnpm --filter @pickle/api start > /tmp/audit-stale-api.log 2>&1 &
API_PID=$!
trap 'kill -- "-$API_PID" 2>/dev/null || true' EXIT

for _ in $(seq 1 30); do
  curl -sf http://127.0.0.1:3001/v1/health > /dev/null && break
  sleep 1
done

# Bare local invocation: CI unset → reuseExistingServer=true → attaches to the
# foreign API above; the suite mints with the DEFAULT secret.
env -u CI -u DEV_AUTH_SECRET PICKLE_E2E_DATABASE_URL="$DEV_DB" \
  pnpm --filter @pickle/admin-web e2e > "$LOG" 2>&1
E2E_EXIT=$?

echo "e2e exit=$E2E_EXIT (log: $LOG)"
if [ "$E2E_EXIT" -ne 0 ] && grep -q "POST /v1/account/bootstrap" "$LOG" && grep -q "Received:   401" "$LOG"; then
  echo "REPRODUCED: authenticated smoke failed with a bare 401 against a foreign :3001 (secret mismatch not detected up front)"
  exit 0
fi
echo "not reproduced"
exit 1
