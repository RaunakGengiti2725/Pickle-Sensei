#!/usr/bin/env bash
# Replays every minimized finding seed from the boundary-malformed campaign
# and prints the recorded outcome row for each. Run from apps/mobile:
#   bash testing/stress/replay-minimized.sh [repeat]
# `repeat` (default 1) re-runs every seed N times to measure flake rate.
set -euo pipefail
cd "$(dirname "$0")/../.."
REPEAT="${1:-1}"
ART="../../artifacts/stress/mod-capture-boundary-malformed"

# campaign:seed:suite
SEEDS=(
  "envelopeLive:3397397111:captureEnvelopeBoundaryMalformed"
  "envelopeLive:3980861522:captureEnvelopeBoundaryMalformed"
  "envelopeLive:3284391795:captureEnvelopeBoundaryMalformed"
  "envelopeAttempt:2108351565:captureEnvelopeBoundaryMalformed"
  "envelopeAttempt:1199210966:captureEnvelopeBoundaryMalformed"
  "envelopeSession:169038368:captureEnvelopeBoundaryMalformed"
  "envelopeSession:3789117386:captureEnvelopeBoundaryMalformed"
  "orphanSeed:638589395:captureClipBoundaryMalformed"
  "orphanSeed:1060787521:captureClipBoundaryMalformed"
  "orphanSeed:2161017543:captureClipBoundaryMalformed"
  "clip:945149200:captureClipBoundaryMalformed"
  "clip:3021218621:captureClipBoundaryMalformed"
  "clip:2507596628:captureClipBoundaryMalformed"
  "clip:1985732946:captureClipBoundaryMalformed"
  "poseExtraction:1848548318:captureClipBoundaryMalformed"
  "poseExtraction:3010379069:captureClipBoundaryMalformed"
  "benchValidate:3559511147:deviceBenchBoundaryMalformed"
  "benchValidate:1714550429:deviceBenchBoundaryMalformed"
  "benchValidate:1631368251:deviceBenchBoundaryMalformed"
  "benchValidate:2066906137:deviceBenchBoundaryMalformed"
  "benchValidate:60679134:deviceBenchBoundaryMalformed"
  "benchValidate:4068035069:deviceBenchBoundaryMalformed"
  "benchValidate:1953900821:deviceBenchBoundaryMalformed"
  "benchRecorder:3281080642:deviceBenchBoundaryMalformed"
  "benchRecorder:1740214663:deviceBenchBoundaryMalformed"
)

for entry in "${SEEDS[@]}"; do
  IFS=: read -r campaign seed suite <<<"$entry"
  for ((i = 1; i <= REPEAT; i++)); do
    run_id="replay-${campaign}-${seed}-${i}"
    if STRESS_REPLAY="${campaign}:${seed}" STRESS_RUN_ID="$run_id" \
      npx jest --ci --silent "__tests__/stress/${suite}" >/dev/null 2>&1; then
      status=pass
    else
      status=FAIL
    fi
    node -e '
      const d = require(process.argv[1]);
      const r = d.rows[0];
      console.log(process.argv[2], process.argv[3], "jest=" + process.argv[4],
        "|", r.strategy, "|", r.input.slice(0, 110), "=>", r.outcome,
        r.detail ? "| " + r.detail.slice(0, 90) : "");
    ' "${ART}/${run_id}/${campaign}.json" "$campaign" "$seed" "$status"
  done
done
