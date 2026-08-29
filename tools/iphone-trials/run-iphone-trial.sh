#!/usr/bin/env bash
# One-command physical-iPhone E2E trial runner (everything except the device).
#
# HONESTY: this script has NEVER been executed with a device attached — no
# physical iPhone exists in this program (GATE B external blocker). Every
# precondition below fails fast with a precise message so that the day
# hardware appears, this is ONE command. It never fabricates a trial file:
# the only artifacts it writes are the ones the operator + device produce.
#
# Usage: tools/iphone-trials/run-iphone-trial.sh --device-id <matrix-deviceId> \
#          [--trials-dir tools/iphone-trials/trials]
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
TRIALS_DIR="$HERE/trials"
DEVICE_ID=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --device-id) DEVICE_ID="${2:?--device-id needs a value}"; shift 2 ;;
    --trials-dir) TRIALS_DIR="${2:?--trials-dir needs a value}"; shift 2 ;;
    *) echo "FATAL: unknown flag: $1" >&2; exit 2 ;;
  esac
done

fail() { echo "FATAL: $1" >&2; exit 1; }

# ---- Preconditions (fail fast, precise) ------------------------------------
[[ "$(uname -s)" == "Darwin" ]] \
  || fail "physical-iPhone trials require macOS + Xcode; this host is $(uname -s). \
On Linux you can only validate schemas and generate reports: \
pnpm --filter @pickle/iphone-trials test / report."

[[ -n "$DEVICE_ID" ]] || fail "--device-id <matrix-deviceId> is required (see device-matrix.json)."

command -v node >/dev/null || fail "node not found (need Node 20)."
command -v pnpm >/dev/null || fail "pnpm not found."
command -v xcrun >/dev/null || fail "xcrun not found (install Xcode command line tools)."
xcrun devicectl --version >/dev/null 2>&1 \
  || fail "xcrun devicectl unavailable (need Xcode 15+)."

node -e "
  const m = require('$HERE/device-matrix.json');
  const d = m.devices.find((x) => x.deviceId === '$DEVICE_ID');
  if (!d) { console.error('FATAL: deviceId $DEVICE_ID not in device-matrix.json'); process.exit(1); }
" || exit 1

DEVICE_LIST="$(xcrun devicectl list devices 2>/dev/null || true)"
echo "$DEVICE_LIST" | grep -qi "iphone" \
  || fail "no physical iPhone is connected/paired (xcrun devicectl list devices). \
This is the GATE B external blocker — do NOT proceed without real hardware."

# ---- Procedure (executes only with a real device attached) ------------------
echo "== iphone-trial runner: device present, matrix id $DEVICE_ID =="
echo "1/5 Building app (Release) onto the device via xcodebuild…"
echo "    (Release only — Debug throttles differently and is not valid trial evidence.)"
cd "$REPO_ROOT/apps/mobile"
[[ -d ios ]] || fail "apps/mobile/ios missing — run the native prebuild on this Mac first."
npm ci
npx tsc --noEmit

echo "2/5 Operator checklist (script pauses; confirm each):"
echo "    - device charged >50%, unplugged, Low Power Mode OFF"
echo "    - thermal state nominal (idle until it is)"
echo "    - fixed screen brightness; storage free space recorded"
echo "    - synchronized reference camera recording STARTED (for human frame-marking)"
read -r -p "    all confirmed? [y/N] " CONFIRM
[[ "$CONFIRM" == "y" ]] || fail "operator did not confirm the checklist."

echo "3/5 Run the scripted real-user session on the device (launch -> permissions ->"
echo "    camera -> target lock -> real strokes -> Result -> Try Again). The app's"
echo "    device-bench recorder (pickle.device-bench.v1) captures thermal/fps/memory."

echo "4/5 After the session: pull the device-bench export and fill ONE"
echo "    pickle.iphone-trial.v1 JSON into $TRIALS_DIR."
echo "    TRUE-MOVEMENT-COMPLETION must be frame-marked by a human on the"
echo "    reference recording — never taken from the app's completion detector."

echo "5/5 Validate + report:"
echo "    pnpm --filter @pickle/iphone-trials report -- --trials $TRIALS_DIR"
echo "Done. The report generator rejects invalid or unmanifested-device trials."
