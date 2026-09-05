#!/usr/bin/env bash
# Full boundary/i18n/a11y campaign for DrillLibraryScreen: the whole
# locale × font-scale × width matrix in UTC, then the default seed range in
# each of the 8 timezones. Writes one seed → outcome JSON table plus one
# rendered-tree evidence file per run under $STRESS_OUT (default
# apps/mobile/artifacts/stress, git-ignored).
#
#   cd apps/mobile && __tests__/stress/run-drillLibrary-boundary-campaign.sh
#
# Replay one seed:
#   TZ=<zone> STRESS_ONLY=<seed> npx jest --ci __tests__/stress/drillLibraryScreen
set -u
cd "$(dirname "$0")/../.."
OUT=${STRESS_OUT:-$PWD/artifacts/stress}
MATRIX_ITER=${STRESS_MATRIX_ITER:-216}
ZONE_ITER=${STRESS_ZONE_ITER:-40}
mkdir -p "$OUT"
: >"$OUT/exit-codes.txt"
status=0

run() { # zone iter
  local zone=$1 iter=$2 label
  label=$(echo "$zone" | tr '/+' '_p')
  TZ=$zone STRESS_ITER=$iter STRESS_OUT=$OUT npx jest --ci \
    __tests__/stress/drillLibraryScreen.boundaryI18nA11y.stress.test.tsx \
    >"$OUT/jest-$label.log" 2>&1
  local code=$?
  echo "TZ=$zone STRESS_ITER=$iter npx jest --ci __tests__/stress/drillLibraryScreen.boundaryI18nA11y.stress.test.tsx → exit $code" |
    tee -a "$OUT/exit-codes.txt"
  if [ "$code" -ne 0 ]; then status=1; fi
}

run Etc/UTC "$MATRIX_ITER"
for zone in Etc/GMT-14 Etc/GMT+12 Pacific/Kiritimati America/New_York \
  Europe/Berlin Australia/Lord_Howe Pacific/Chatham Asia/Kolkata; do
  run "$zone" "$ZONE_ITER"
done
exit $status
