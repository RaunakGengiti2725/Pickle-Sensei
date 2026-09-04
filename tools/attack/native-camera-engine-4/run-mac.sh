#!/usr/bin/env bash
# Runs the adversarial camera-engine XCTest harness on an Apple host.
#
# This script is FOR THE COORDINATOR / a Mac operator. It is not wired into
# scripts/mac-full-verify.sh and never triggers the self-hosted runner; the
# adversarial tester that authored it ran only Linux static checks.
#
#   tools/attack/native-camera-engine-4/run-mac.sh sim            # deterministic [sim] subset + [device] skips
#   tools/attack/native-camera-engine-4/run-mac.sh device <udid>  # camera-backed scenarios on an attached iPhone
#
# Artifacts land in artifacts/attack/native-camera-engine-4/<plane>/:
#   xcodebuild.log, result.xcresult, summary.txt (Test Suite / Executed lines).
# Skips are printed as "skipped" and are NOT passes: a [device] test that
# skips on the simulator has produced no evidence.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
HARNESS="$ROOT/tools/attack/native-camera-engine-4/xctest"
PLANE="${1:-sim}"
UDID="${2:-}"
OUT="$ROOT/artifacts/attack/native-camera-engine-4/$PLANE"
rm -rf "$OUT"; mkdir -p "$OUT"

case "$PLANE" in
  sim)
    if [ -z "$UDID" ]; then
      UDID="$("$ROOT/tools/macos-ci/select-simulator.sh" --boot)"
    fi
    DESTINATION="platform=iOS Simulator,id=$UDID"
    EXTRA=(CODE_SIGNING_ALLOWED=NO)
    ;;
  device)
    [ -n "$UDID" ] || { echo "usage: run-mac.sh device <iphone-udid>  (xcrun devicectl list devices)"; exit 2; }
    DESTINATION="platform=iOS,id=$UDID"
    # A physical device needs a signed test host. Set PICKLE_DEVELOPMENT_TEAM
    # to the team id used for the app's development builds.
    : "${PICKLE_DEVELOPMENT_TEAM:?set PICKLE_DEVELOPMENT_TEAM=<team id> for on-device signing}"
    EXTRA=(-allowProvisioningUpdates "DEVELOPMENT_TEAM=$PICKLE_DEVELOPMENT_TEAM")
    ;;
  *)
    echo "unknown plane '$PLANE' (sim|device)"; exit 2 ;;
esac

cd "$HARNESS"
LIST="$(xcodebuild -list 2>&1)"; echo "$LIST" > "$OUT/xcodebuild-list.txt"
SCHEME="CameraEngineAttack-Package"; echo "$LIST" | grep -q "$SCHEME" || SCHEME="CameraEngineAttack"
echo "scheme: $SCHEME  destination: $DESTINATION  git: $(git -C "$ROOT" rev-parse HEAD)" | tee "$OUT/summary.txt"

set +e
xcodebuild test -scheme "$SCHEME" -destination "$DESTINATION" \
  -resultBundlePath "$OUT/result.xcresult" "${EXTRA[@]}" 2>&1 | tee "$OUT/xcodebuild.log" \
  | grep -E 'Test Case|Test Suite|Executed|error:|skipped|\*\* TEST' | tee -a "$OUT/summary.txt"
STATUS=${PIPESTATUS[0]}
set -e

if [ -x "$ROOT/tools/macos-ci/xcresult-summary.py" ]; then
  "$ROOT/tools/macos-ci/xcresult-summary.py" "$OUT/result.xcresult" > "$OUT/xcresult-summary.txt" 2>&1 || \
    echo "xcresult-summary.py failed (see $OUT/xcresult-summary.txt)"
fi
echo "xcodebuild exit: $STATUS" | tee -a "$OUT/summary.txt"
exit "$STATUS"
