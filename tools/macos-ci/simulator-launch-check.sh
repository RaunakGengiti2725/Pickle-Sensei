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
#
# Usage: simulator-launch-check.sh <path/to/PickleSensei.app> <bundle id> <artifact dir> [settle seconds]
set -euo pipefail

APP_PATH="${1:?path to .app required}"
BUNDLE_ID="${2:?bundle id required}"
OUT_DIR="${3:?artifact dir required}"
SETTLE_SECONDS="${4:-25}"

HERE="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$OUT_DIR"
# `simctl io screenshot` does not resolve paths against our cwd; use an absolute one.
OUT_DIR="$(cd "$OUT_DIR" && pwd)"

if [ ! -d "$APP_PATH" ]; then
  echo "::error::app bundle not found at $APP_PATH"
  exit 1
fi

APP_NAME="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$APP_PATH/Info.plist")"
APP_VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP_PATH/Info.plist" 2>/dev/null || echo '?')"
APP_BUILD="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$APP_PATH/Info.plist" 2>/dev/null || echo '?')"
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

cleanup() {
  set +e
  if [ -n "${LOG_PID:-}" ]; then
    kill "$LOG_PID" 2>/dev/null
    wait "$LOG_PID" 2>/dev/null
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

echo "launching $BUNDLE_ID"
LAUNCH_OUTPUT="$(xcrun simctl launch "$UDID" "$BUNDLE_ID")"
echo "$LAUNCH_OUTPUT"
PID="$(echo "$LAUNCH_OUTPUT" | sed -n 's/.*: \([0-9][0-9]*\)$/\1/p')"
if [ -z "$PID" ]; then
  echo "::error::could not parse launched PID from simctl output"
  exit 1
fi

# Early screenshot (splash / first frame), then the settled screen.
screenshot() {
  if ! xcrun simctl io "$UDID" screenshot "$OUT_DIR/$1" >/dev/null 2>"$OUT_DIR/$1.err"; then
    echo "::warning::screenshot $1 failed: $(tr '\n' ' ' < "$OUT_DIR/$1.err")"
  fi
  rm -f "$OUT_DIR/$1.err"
}

sleep 5
screenshot launch-05s.png
ALIVE=1
for _ in $(seq 1 "$((SETTLE_SECONDS - 5))"); do
  if ! kill -0 "$PID" 2>/dev/null; then
    ALIVE=0
    break
  fi
  sleep 1
done
screenshot launch-settled.png

# Give the log stream a moment to flush, then stop it.
sleep 2
kill "$LOG_PID" 2>/dev/null || true
wait "$LOG_PID" 2>/dev/null || true
LOG_PID=""

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

{
  echo "bundle_id=$BUNDLE_ID"
  echo "app_name=$APP_NAME"
  echo "version=$APP_VERSION ($APP_BUILD)"
  echo "simulator_udid=$UDID"
  echo "pid=$PID"
  echo "alive_after_${SETTLE_SECONDS}s=$ALIVE"
  echo "crash_reports=$CRASHES"
  echo "fatal_log_lines=$(printf '%s' "$FATAL_LINES" | grep -c . || true)"
  echo "screenshots=$(find "$OUT_DIR" -maxdepth 1 -name 'launch-*.png' | wc -l | tr -d ' ')"
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

if [ "$STATUS" = "0" ]; then
  echo "launch check passed: $APP_NAME stayed alive for ${SETTLE_SECONDS}s with no crash report or fatal JS error"
fi
exit "$STATUS"
