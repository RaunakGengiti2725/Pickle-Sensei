#!/usr/bin/env bash
# H14 Wave-H cascade-certification Linux-proxy replay (re-run of the f16
# regression baseline harness at the release-candidate head).
#
# NOT-CANONICAL / NOT-MAC: this replays only the cascade stages that run on
# Linux from COMMITTED artifacts (committed windowed pose, gold labels,
# motion candidates). It is NOT the canonical Mac strict cascade
# (pnpm lab:cascade over datasets/paddle-bench/runs/, which is Mac-only —
# see wave-e e06 BLOCKED_EXTERNAL forensics).
#
# Run from the repo root with pnpm installed (Node 20):
#   bash datasets/experiments/wave-h/h14-replay-all.sh
set -euo pipefail
cd "$(dirname "$0")/../../.."

WAVE_H=datasets/experiments/wave-h

# EVENT — proposal recall on DEV gold (e01 harness; writes a timestamped file
# into wave-e, moved into wave-h by this runner).
pnpm --filter @pickle/swing-lab exec tsx src/eventRecallBench.ts
latest=$(ls -t datasets/experiments/wave-e/event-recall-*.json | head -1)
mv "$latest" "$WAVE_H/h14-event-recall-linux-proxy.json"

# OWNERSHIP — dual-frame ownership bench (D02 harness), committed labels only.
pnpm --filter @pickle/swing-lab exec tsx src/ownershipBench.ts \
  --out "$WAVE_H/h14-ownership-eval-linux-proxy.json"
pnpm --filter @pickle/swing-lab exec tsx src/ownershipBench.ts --apply-corrections \
  --out "$WAVE_H/h14-ownership-eval-corrected-linux-proxy.json"

# BALL — real tracker over committed Linux-regenerated motion candidates,
# scored on the D2-06 hard-slice gold (e12 harness).
pnpm --filter @pickle/swing-lab exec tsx src/ballHardSliceEval.ts \
  "../../$WAVE_H/h14-ball-hardslice-linux-proxy.json"

# CONTACT — e02 contact-gold replay (committed pose, ORACLE ball, no paddle
# track) via the assertion-free wave-h wrapper.
(cd packages/swing-lab && pnpm exec tsx ../../$WAVE_H/h14-contact-replay-run.ts)

# PHASE — anchored + anchor-free coverage on committed wave-a gold (D3-05
# measure script, unmodified).
(cd packages/swing-lab && pnpm exec tsx ../../datasets/experiments/wave-d3/d3-05-measure-gold.ts) \
  > "$WAVE_H/h14-phase-gold-linux-proxy.txt"

# STROKE — L1/L2 heuristic bench on committed stroke gold (e03 harness) via
# the wave-h wrapper that persists the full report.
(cd packages/swing-lab && pnpm exec tsx ../../$WAVE_H/h14-stroke-bench-run.ts)

echo "h14 Linux-proxy replay complete — artifacts in $WAVE_H/"
