#!/usr/bin/env bash
# Standalone, artifact-producing run of the seeded randomized outbox state
# machine (seeds 2000-2099). Writes raw JSON tables, matrices, heap numbers,
# observations and a full jest log under the artifact directory, and exits
# with jest's exit code (a failing invariant fails the run — nothing is hidden).
#
#   harness/outbox/run.sh [artifact-dir]            # 2000 memory + 400 sqlite sequences
#   OUTBOX_FUZZ_SEQUENCES=50 harness/outbox/run.sh  # 5000 memory sequences
#   OUTBOX_FUZZ_REPLAY=2079:5 harness/outbox/run.sh # one sequence, full trace dump
#
# Requires Node >= 22.5 (node:sqlite; the flag below is a no-op once the
# module is stable). Run from apps/mobile with npm/npx — never pnpm here.
set -euo pipefail

cd "$(dirname "$0")/../.."
ARTIFACTS="${1:-${OUTBOX_FUZZ_ARTIFACTS:-artifacts/outbox-fuzz/$(date -u +%Y%m%dT%H%M%SZ)}}"
mkdir -p "$ARTIFACTS"
ARTIFACTS="$(cd "$ARTIFACTS" && pwd)"

{
  echo "commit: $(git rev-parse HEAD 2>/dev/null || echo unknown)"
  echo "node: $(node --version)"
  echo "seeds: 2000-2099"
  echo "OUTBOX_FUZZ_SEQUENCES=${OUTBOX_FUZZ_SEQUENCES:-20} (per seed, memory)"
  echo "OUTBOX_FUZZ_SQLITE_SEQUENCES=${OUTBOX_FUZZ_SQLITE_SEQUENCES:-4} (per seed, real sqlite differential)"
  echo "OUTBOX_FUZZ_REPLAY=${OUTBOX_FUZZ_REPLAY:-}"
  echo "started: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
} | tee "$ARTIFACTS/run.env.txt"

set +e
OUTBOX_FUZZ_ARTIFACTS="$ARTIFACTS" \
  NODE_OPTIONS="${NODE_OPTIONS:-} --experimental-sqlite" \
  npx jest --ci __tests__/outboxRandomizedStateMachine.test.ts 2>&1 | tee "$ARTIFACTS/jest.log"
status=${PIPESTATUS[0]}
set -e

echo "finished: $(date -u +%Y-%m-%dT%H:%M:%SZ)" | tee -a "$ARTIFACTS/run.env.txt"
echo "exit: $status" | tee -a "$ARTIFACTS/run.env.txt"
echo "artifacts: $ARTIFACTS"
ls -la "$ARTIFACTS"
exit "$status"
