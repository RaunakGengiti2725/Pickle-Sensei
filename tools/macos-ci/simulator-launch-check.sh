#!/usr/bin/env bash
# Install the built Pickle Sensei .app on an iOS simulator, launch it, and
# verify that it is still alive after a settle period. Collects screenshots,
# the app's unified log, and any crash reports into an artifact directory.
#
# Fails loudly when:
#   - the app cannot be installed or launched
#   - the process exits/crashes before the settle period ends
#   - a crash report for the app appears in ~/Library/Logs/DiagnosticReports
#   - the app log contains a fatal React Native error (RCTFatal /
#     "Unhandled JS Exception")
#   - secure storage is unusable because the simulator build lacks entitlements
#
# Usage: simulator-launch-check.sh <path/to/PickleSensei.app> <bundle id> <artifact dir> [settle seconds]
set -euo pipefail

APP_PATH="${1:?path to .app required}"
BUNDLE_ID="${2:?bundle id required}"
OUT_DIR="${3:?artifact dir required}"
SETTLE_SECONDS="${4:-25}"
# The default remains the real macOS tool; direct host tests provide a fake.
PLIST_BUDDY="${PICKLE_CI_PLIST_BUDDY:-/usr/libexec/PlistBuddy}"

HERE="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$OUT_DIR"
OUT_DIR="$(cd "$OUT_DIR" && pwd)"

if [ ! -d "$APP_PATH" ]; then
  echo "::error::app bundle not found at $APP_PATH"
  exit 1
fi

APP_NAME="$("$PLIST_BUDDY" -c 'Print :CFBundleExecutable' "$APP_PATH/Info.plist")"
APP_VERSION="$("$PLIST_BUDDY" -c 'Print :CFBundleShortVersionString' "$APP_PATH/Info.plist" 2>/dev/null || echo '?')"
APP_BUILD="$("$PLIST_BUDDY" -c 'Print :CFBundleVersion' "$APP_PATH/Info.plist" 2>/dev/null || echo '?')"
echo "app: $APP_NAME ($BUNDLE_ID) version $APP_VERSION ($APP_BUILD)"
if [ -f "$APP_PATH/main.jsbundle" ]; then
  echo "js bundle: $(du -h "$APP_PATH/main.jsbundle" | cut -f1) main.jsbundle present (release bundle embedded)"
else
  echo "js bundle: main.jsbundle NOT present (debug build expects Metro)"
fi

UDID="$("$HERE/select-simulator.sh" --boot)"
echo "simulator udid: $UDID"
xcrun simctl list devices | grep "$UDID" || true

# Marker for "crash reports newer than this run".
MARKER="$(mktemp)"
touch "$MARKER"

require_log_stream_alive() {
  if kill -0 "$LOG_PID" 2>/dev/null; then return 0; fi
  local status=0
  wait "$LOG_PID" 2>/dev/null || status=$?
  LOG_PID=""
  echo "::error::app log stream exited before requested termination (status $status); launch evidence is incomplete"
  return 1
}

stop_log_stream() {
  require_log_stream_alive || return 1
  if ! kill "$LOG_PID" 2>/dev/null; then
    echo "::error::app log stream vanished before requested termination"
    return 1
  fi
  local step forced=0
  # Bound both normal shutdown and EXIT cleanup: three seconds of grace, then
  # SIGKILL only this helper's recorded log child. Forced shutdown is failure.
  for step in $(seq 1 30); do
    if ! kill -0 "$LOG_PID" 2>/dev/null; then break; fi
    sleep 0.1
  done
  if kill -0 "$LOG_PID" 2>/dev/null; then
    forced=1
    echo "::error::app log stream did not stop within 3s; forced termination"
    kill -KILL "$LOG_PID" 2>/dev/null || return 1
  fi
  LOG_STOP_STATUS=0
  wait "$LOG_PID" 2>/dev/null || LOG_STOP_STATUS=$?
  LOG_PID=""
  if [ "$forced" = 1 ]; then return 1; fi
  if [ "$LOG_STOP_STATUS" != 0 ] && [ "$LOG_STOP_STATUS" != 143 ]; then
    echo "::error::app log stream failed during requested termination (status $LOG_STOP_STATUS)"
    return 1
  fi
}

cleanup() {
  set +e
  if [ -n "${LOG_PID:-}" ]; then
    stop_log_stream
  fi
  xcrun simctl terminate "$UDID" "$BUNDLE_ID" >/dev/null 2>&1
  rm -f "$MARKER"
}
trap cleanup EXIT

# Fresh install: remove any previous copy so we exercise first-launch paths too.
xcrun simctl terminate "$UDID" "$BUNDLE_ID" >/dev/null 2>&1 || true
xcrun simctl uninstall "$UDID" "$BUNDLE_ID" >/dev/null 2>&1 || true

echo "installing $APP_PATH"
xcrun simctl install "$UDID" "$APP_PATH"

# Stream the app's unified log for the duration of the check.
xcrun simctl spawn "$UDID" log stream --style compact --level debug \
  --predicate "process == \"$APP_NAME\"" >"$OUT_DIR/app-log-stream.txt" 2>&1 &
LOG_PID=$!
sleep 2
require_log_stream_alive

echo "launching $BUNDLE_ID"
LAUNCH_OUTPUT="$(xcrun simctl launch "$UDID" "$BUNDLE_ID")"
echo "$LAUNCH_OUTPUT"
PID="$(echo "$LAUNCH_OUTPUT" | sed -n 's/.*: \([0-9][0-9]*\)$/\1/p')"
if [ -z "$PID" ]; then
  echo "::error::could not parse launched PID from simctl output"
  exit 1
fi

# Early screenshot (splash / first frame), then the settled screen.
sleep 5
xcrun simctl io "$UDID" screenshot "$OUT_DIR/launch-05s.png" >/dev/null
ALIVE=1
for _ in $(seq 1 "$((SETTLE_SECONDS - 5))"); do
  require_log_stream_alive
  if ! kill -0 "$PID" 2>/dev/null; then
    ALIVE=0
    break
  fi
  sleep 1
done
xcrun simctl io "$UDID" screenshot "$OUT_DIR/launch-settled.png" >/dev/null

# Give the log stream a moment to flush, then stop it.
sleep 2
require_log_stream_alive
stop_log_stream
# The last loop check preceded a sleep and both screenshot/flush work. Check
# again before claiming survival through the complete observation interval.
if ! kill -0 "$PID" 2>/dev/null; then ALIVE=0; fi

# Same install, same ad-hoc signature: store wallet contents through the
# shipping native bridge, SIGKILL the process, relaunch and read them back.
# Only a surviving launch is worth probing; a missing verdict is a failure.
WALLET_STATUS=0
WALLET_OK=0
if [ "$ALIVE" = "1" ]; then
  "$HERE/wallet-persistence-check.sh" "$UDID" "$BUNDLE_ID" "$APP_PATH" "$OUT_DIR/wallet" "$PID" || WALLET_STATUS=$?
  if [ -f "$OUT_DIR/wallet/wallet-summary.txt" ]; then
    WALLET_OK="$(sed -n 's/^wallet_persistence_ok=//p' "$OUT_DIR/wallet/wallet-summary.txt")"
  fi
fi

# Crash reports written during this check.
CRASHES=0
if [ -d "$HOME/Library/Logs/DiagnosticReports" ]; then
  while IFS= read -r report; do
    [ -n "$report" ] || continue
    CRASHES=$((CRASHES + 1))
    cp "$report" "$OUT_DIR/" || true
    echo "::error::crash report: $(basename "$report")"
  done < <(find "$HOME/Library/Logs/DiagnosticReports" -maxdepth 1 -newer "$MARKER" \( -name "${APP_NAME}*" -o -name "${BUNDLE_ID}*" \) 2>/dev/null)
fi

FATAL_LINES="$(grep -E 'RCTFatal|Unhandled JS Exception|Terminating app due to uncaught exception' "$OUT_DIR/app-log-stream.txt" || true)"
KEYCHAIN_LINES="$(grep -E 'Code=-34018|error:\[-34018\]|neither application-identifier nor keychain-access-groups' "$OUT_DIR/app-log-stream.txt" || true)"

{
  echo "bundle_id=$BUNDLE_ID"
  echo "app_name=$APP_NAME"
  echo "version=$APP_VERSION ($APP_BUILD)"
  echo "simulator_udid=$UDID"
  echo "pid=$PID"
  echo "alive_after_${SETTLE_SECONDS}s=$ALIVE"
  echo "crash_reports=$CRASHES"
  echo "log_stream_stop_status=$LOG_STOP_STATUS"
  echo "fatal_log_lines=$(printf '%s' "$FATAL_LINES" | grep -c . || true)"
  echo "keychain_entitlement_errors=$(printf '%s' "$KEYCHAIN_LINES" | grep -c . || true)"
  echo "wallet_persistence_ok=$WALLET_OK"
} | tee "$OUT_DIR/launch-summary.txt"

STATUS=0
if [ "$ALIVE" != "1" ]; then
  echo "::error::$APP_NAME exited before the ${SETTLE_SECONDS}s settle period ended"
  STATUS=1
fi
if [ "$CRASHES" != "0" ]; then
  STATUS=1
fi
if [ -n "$FATAL_LINES" ]; then
  echo "::error::fatal React Native error(s) in the app log:"
  echo "$FATAL_LINES" | head -20
  STATUS=1
fi
if [ -n "$KEYCHAIN_LINES" ]; then
  echo "::error::simulator secure storage is unavailable because signing entitlements are missing"
  STATUS=1
fi
if [ "$ALIVE" != "1" ]; then
  echo "::error::wallet persistence check not run: $APP_NAME did not survive the launch"
  STATUS=1
elif [ "$WALLET_STATUS" != "0" ]; then
  echo "::error::wallet persistence check failed (status $WALLET_STATUS)"
  STATUS=1
elif [ "$WALLET_OK" != "1" ]; then
  echo "::error::wallet persistence check produced no verdict (wallet_persistence_ok=$WALLET_OK)"
  STATUS=1
fi

if [ "$STATUS" = "0" ]; then
  echo "launch check passed: $APP_NAME stayed alive for ${SETTLE_SECONDS}s with no crash report or fatal JS error, and wallet contents survived force-quit"
fi
exit "$STATUS"
