#!/usr/bin/env bash
# Linux-plane stress harness for the native swing-lab / camera-engine unit.
# Runs from the swing-domain workspace so the canonical parser resolves.
#   STRESS_ITER=<n> STRESS_SEED=<seed> STRESS_RESULTS_DIR=<dir> native/stress/linux-harness/run.sh
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
export STRESS_RESULTS_DIR="${STRESS_RESULTS_DIR:-$repo/artifacts/stress/linux-harness}"
mkdir -p "$STRESS_RESULTS_DIR"
cd "$repo/packages/swing-lab"
npx vitest run --dir "$here" "$@" 2>&1 | tee "$STRESS_RESULTS_DIR/vitest.log"
