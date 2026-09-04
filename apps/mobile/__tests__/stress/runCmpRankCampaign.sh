#!/usr/bin/env bash
# Full cmp-rank boundary/i18n/a11y campaign: the same seeded suite once per
# timezone. TZ must be set per PROCESS — jest's environment reads the zone
# when the process starts, so mutating process.env.TZ mid-run changes
# nothing (verified: Date output stays on the launch zone).
#
#   apps/mobile$ __tests__/stress/runCmpRankCampaign.sh /tmp/rank-campaign 40
#
# Every iteration is replayable from its seed:
#   STRESS_SEED=<seed> STRESS_ITER=1 npx jest --ci cmpRankBoundaryI18nA11y
set -euo pipefail

OUT_DIR="${1:-/tmp/rank-campaign}"
ITER="${2:-40}"
mkdir -p "$OUT_DIR"

# UTC+14 / UTC-12 extremes plus northern, southern and southern-hemisphere
# DST edges, a 45-minute offset and a zone with no DST at all.
ZONES=(
  UTC
  Pacific/Kiritimati   # UTC+14
  Etc/GMT+12           # UTC-12
  America/New_York     # spring-forward / fall-back
  Europe/Berlin        # EU DST edge
  Australia/Lord_Howe  # 30-minute DST shift
  Pacific/Chatham      # UTC+12:45 / +13:45
  Asia/Kolkata         # UTC+05:30, no DST
)

status=0
for tz in "${ZONES[@]}"; do
  slug="${tz//\//_}"
  echo "=== TZ=$tz STRESS_ITER=$ITER ==="
  if ! TZ="$tz" STRESS_ITER="$ITER" STRESS_OUT="$OUT_DIR" \
    npx jest --ci --runTestsByPath __tests__/stress/cmpRankBoundaryI18nA11y.stress.test.tsx \
    >"$OUT_DIR/jest-$slug.log" 2>&1; then
    status=1
    echo "FAILED: see $OUT_DIR/jest-$slug.log"
  fi
done

echo "artifacts: $OUT_DIR"
exit "$status"
