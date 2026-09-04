#!/usr/bin/env bash
# Execution audit harness: runs the @pickle/swing-lab and @pickle/model-registry
# suites twice, shuffled (two seeds), with Vitest's hanging-process reporter
# (the Vitest equivalent of `jest --detectOpenHandles`), plus both typechecks.
# Every command logs its exit code; nothing is masked.
# Usage: run_suites.sh <repo-root> <out-dir>
set -u
REPO=${1:?repo root}
OUT=${2:?out dir}
mkdir -p "$OUT"
cd "$REPO"
INDEX="$OUT/suites-index.log"
run() { # name, cmd...
  local name=$1; shift
  echo "### $name :: $*" | tee -a "$INDEX"
  "$@" > "$OUT/$name.log" 2>&1
  local ec=$?
  echo "exit=$ec" >> "$OUT/$name.log"
  echo "$name exit=$ec" | tee -a "$INDEX"
}
tmp_count() { ls -d /tmp/exp-bundle-* /tmp/coach-gates-* /tmp/exp-import-* /tmp/coach-agreement-* \
  /tmp/swing-lab-export-* /tmp/health-review-* /tmp/label-queue-fixture-* 2>/dev/null | wc -l; }

before=$(tmp_count)
run swing-lab-test-run1 pnpm --filter @pickle/swing-lab test
run swing-lab-test-run2-verbose pnpm --filter @pickle/swing-lab exec vitest run --reporter=verbose
run swing-lab-test-shuffle-seed1 pnpm --filter @pickle/swing-lab exec vitest run --sequence.shuffle --sequence.seed=1
run swing-lab-test-shuffle-seed2 pnpm --filter @pickle/swing-lab exec vitest run --sequence.shuffle --sequence.seed=20260904
run swing-lab-test-hanging-process pnpm --filter @pickle/swing-lab exec vitest run --reporter=default --reporter=hanging-process
run swing-lab-crossfade-isolated pnpm --filter @pickle/swing-lab exec vitest run test/oodGateRedTeam.test.ts -t crossfading
run model-registry-test-run1 pnpm --filter @pickle/model-registry test
run model-registry-test-run2-verbose pnpm --filter @pickle/model-registry exec vitest run --reporter=verbose
run model-registry-test-shuffle pnpm --filter @pickle/model-registry exec vitest run --sequence.shuffle --sequence.seed=1
run model-registry-test-hanging-process pnpm --filter @pickle/model-registry exec vitest run --reporter=default --reporter=hanging-process
run swing-lab-typecheck pnpm --filter @pickle/swing-lab typecheck
run model-registry-typecheck pnpm --filter @pickle/model-registry typecheck
after=$(tmp_count)
echo "tmpdir-leak: swing-lab test temp dirs under /tmp before=$before after=$after" | tee -a "$INDEX"
