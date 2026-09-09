#!/usr/bin/env bash
# Prove, on the iOS simulator, that the shipping app's native offline wallet
# survives a force-quit: store through the product's own Keychain code path,
# SIGKILL the process from the host, relaunch, read the identical wallet back,
# then clear it. Runs after simulator-launch-check.sh has installed the app and
# watched the plain launch settle; the app is the Release build under the same
# certificate-free ad-hoc signature scripts/mac-full-verify.sh ships to the
# simulator, so a missing Keychain entitlement fails here, not on a device.
#
# How: tools/macos-ci/wallet-probe.m is compiled against the iPhoneSimulator
# SDK for the app binary's own architecture and minimum OS, ad-hoc signed and
# injected into the installed app with SIMCTL_CHILD_DYLD_INSERT_LIBRARIES on
# each launch. Inside the process it drives the real `PickleOfflineWallet`
# React Native module (load / replace / clear / discardCorrupt) and writes one
# JSON result per phase; this helper waits for each result, screenshots the
# simulator, and compares the restored snapshot with the stored one.
#
# Fails loudly when:
#   - the probe does not compile or sign
#   - the running instance does not stop, or a launch cannot be parsed
#   - a phase reports no result within the wait, or the app exits meanwhile
#   - the store phase is rejected (e.g. wallet.storage_denied)
#   - the restored wallet is missing, or differs in revision/grants/receipts
#   - clearing fails or the slot still holds a wallet afterwards
#   - the app log shows the Keychain entitlement error (-34018)
#   - the unified log stream stops on its own
#
# Artifacts (<artifact dir>): PickleWalletProbe.dylib, probe-compile.log,
# wallet-probe-input.json, wallet-store-result.json, wallet-store.png,
# wallet-restore-result.json, wallet-restore.png, wallet-log-stream.txt,
# wallet-summary.txt (machine-readable verdict, wallet_persistence_ok=0|1).
#
# Usage: wallet-persistence-check.sh <simulator udid> <bundle id> <path/to/PickleSensei.app> <artifact dir> [running app pid]
set -euo pipefail

UDID="${1:?simulator udid required}"
BUNDLE_ID="${2:?bundle id required}"
APP_PATH="${3:?path to .app required}"
OUT_DIR="${4:?artifact dir required}"
RUNNING_PID="${5:-}"
# The default remains the real macOS tool; direct host tests provide a fake.
PLIST_BUDDY="${PICKLE_CI_PLIST_BUDDY:-/usr/libexec/PlistBuddy}"
PROBE_WAIT_SECONDS=30
# Synthetic CI owner: canonical lowercase UUID shape the wallet requires,
# never an account that exists anywhere.
OWNER="0c1c0c1c-0c1c-4c1c-8c1c-0c1c0c1c0c1c"

HERE="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$OUT_DIR"
OUT_DIR="$(cd "$OUT_DIR" && pwd)"
PROBE="$OUT_DIR/PickleWalletProbe.dylib"
INPUT="$OUT_DIR/wallet-probe-input.json"
STORE_RESULT="$OUT_DIR/wallet-store-result.json"
RESTORE_RESULT="$OUT_DIR/wallet-restore-result.json"
LOG_FILE="$OUT_DIR/wallet-log-stream.txt"

LOG_PID=""
LIVE_PID=""
LAUNCHED_PID=""
STORE_PID=""
STORE_REVISION=""
FORCE_QUIT=""
RESTORE_PID=""
RESTORE_REVISION=""
RESTORED_MATCH=0
CLEARED=0
AFTER_CLEAR_EMPTY=0
RESTORE_DETAIL=""
KEYCHAIN_LINES=""
KEYCHAIN_ERRORS=0
PROBE_LOG_LINES=""
LOG_STOP_STATUS=""
OK=0
SUMMARY_WRITTEN=0

if [ ! -d "$APP_PATH" ]; then
  echo "::error::app bundle not found at $APP_PATH"
  exit 1
fi

write_summary() {
  {
    echo "wallet_persistence_ok=$OK"
    echo "wallet_owner=$OWNER"
    echo "wallet_store_pid=$STORE_PID"
    echo "wallet_store_revision=$STORE_REVISION"
    echo "wallet_force_quit=$FORCE_QUIT"
    echo "wallet_restore_pid=$RESTORE_PID"
    echo "wallet_restore_revision=$RESTORE_REVISION"
    echo "wallet_restored_match=$RESTORED_MATCH"
    echo "wallet_cleared=$CLEARED"
    echo "wallet_after_clear_empty=$AFTER_CLEAR_EMPTY"
    echo "wallet_keychain_entitlement_errors=$KEYCHAIN_ERRORS"
    echo "wallet_probe_log_lines=$PROBE_LOG_LINES"
    echo "wallet_log_stream_stop_status=$LOG_STOP_STATUS"
  } | tee "$OUT_DIR/wallet-summary.txt"
  SUMMARY_WRITTEN=1
}

require_log_stream_alive() {
  if kill -0 "$LOG_PID" 2>/dev/null; then return 0; fi
  local status=0
  wait "$LOG_PID" 2>/dev/null || status=$?
  LOG_PID=""
  echo "::error::app log stream exited before requested termination (status $status); wallet evidence is incomplete"
  return 1
}

stop_log_stream() {
  require_log_stream_alive || return 1
  if ! kill "$LOG_PID" 2>/dev/null; then
    echo "::error::app log stream vanished before requested termination"
    return 1
  fi
  local step forced=0
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
  if [ -n "$LOG_PID" ]; then
    stop_log_stream
  fi
  if [ -n "$LIVE_PID" ] && kill -0 "$LIVE_PID" 2>/dev/null; then
    xcrun simctl terminate "$UDID" "$BUNDLE_ID" >/dev/null 2>&1
  fi
  if [ "$SUMMARY_WRITTEN" = 0 ]; then
    write_summary
  fi
}
trap cleanup EXIT

# Waits up to 10s for a host pid to disappear.
wait_for_exit() {
  local pid="$1" step
  for step in $(seq 1 100); do
    if ! kill -0 "$pid" 2>/dev/null; then return 0; fi
    sleep 0.1
  done
  return 1
}

APP_NAME="$("$PLIST_BUDDY" -c 'Print :CFBundleExecutable' "$APP_PATH/Info.plist")"
MIN_OS="$("$PLIST_BUDDY" -c 'Print :MinimumOSVersion' "$APP_PATH/Info.plist")"
ARCHS="$(xcrun lipo -archs "$APP_PATH/$APP_NAME")"
SDK_PATH="$(xcrun --sdk iphonesimulator --show-sdk-path)"
ARCH_FLAGS=()
for arch in $ARCHS; do
  ARCH_FLAGS+=(-arch "$arch")
done
echo "compiling wallet probe for $ARCHS (iOS $MIN_OS simulator)"
if ! xcrun --sdk iphonesimulator clang ${ARCH_FLAGS[@]+"${ARCH_FLAGS[@]}"} \
  -mios-simulator-version-min="$MIN_OS" -isysroot "$SDK_PATH" \
  -fobjc-arc -Wall -dynamiclib -framework Foundation \
  -o "$PROBE" "$HERE/wallet-probe.m" >"$OUT_DIR/probe-compile.log" 2>&1; then
  cat "$OUT_DIR/probe-compile.log"
  echo "::error::wallet probe did not compile"
  exit 1
fi
codesign --force --sign - "$PROBE"

if [ -n "$RUNNING_PID" ] && kill -0 "$RUNNING_PID" 2>/dev/null; then
  echo "terminating running $APP_NAME (pid $RUNNING_PID) before the store launch"
  xcrun simctl terminate "$UDID" "$BUNDLE_ID"
  if ! wait_for_exit "$RUNNING_PID"; then
    echo "::error::$APP_NAME (pid $RUNNING_PID) did not exit after simctl terminate"
    exit 1
  fi
fi

xcrun simctl spawn "$UDID" log stream --style compact --level debug \
  --predicate "process == \"$APP_NAME\"" >"$LOG_FILE" 2>&1 &
LOG_PID=$!
sleep 2
require_log_stream_alive

# Non-secret payload in the exact shape the wallet validates: one grant in
# compact JWS form (unsigned placeholder signature of ES256 length) and one
# result receipt, each tagged with a fresh nonce so the read-back cannot be
# satisfied by an earlier run's contents.
python3 - "$INPUT" <<'PY'
import base64, json, secrets, sys

def b64url(raw):
    return base64.urlsafe_b64encode(raw).rstrip(b'=').decode('ascii')

nonce = secrets.token_hex(8)
header = b64url(json.dumps({'alg': 'ES256', 'typ': 'JWT'}, separators=(',', ':')).encode())
payload = b64url(json.dumps({'ci': 'wallet-persistence-check', 'nonce': nonce}, separators=(',', ':')).encode())
signature = 'A' * 86
contents = {
    'grants': [{'grantId': f'ci-grant-{nonce}', 'compactJws': f'{header}.{payload}.{signature}'}],
    'receipts': [{'receiptId': f'ci-receipt-{nonce}', 'kind': 'result', 'payloadJson': json.dumps({'ci': 'wallet-persistence-check', 'nonce': nonce})}],
}
with open(sys.argv[1], 'w', encoding='utf-8') as f:
    json.dump(contents, f, indent=2, sort_keys=True)
    f.write('\n')
PY

launch_phase() {
  local phase="$1" result="$2" output
  rm -f "$result"
  echo "launching $BUNDLE_ID with the wallet probe ($phase phase)"
  output="$(
    SIMCTL_CHILD_DYLD_INSERT_LIBRARIES="$PROBE" \
      SIMCTL_CHILD_PICKLE_WALLET_PROBE_PHASE="$phase" \
      SIMCTL_CHILD_PICKLE_WALLET_PROBE_OWNER="$OWNER" \
      SIMCTL_CHILD_PICKLE_WALLET_PROBE_INPUT="$INPUT" \
      SIMCTL_CHILD_PICKLE_WALLET_PROBE_RESULT="$result" \
      xcrun simctl launch "$UDID" "$BUNDLE_ID"
  )"
  echo "$output"
  LAUNCHED_PID="$(echo "$output" | sed -n 's/.*: \([0-9][0-9]*\)$/\1/p')"
  if [ -z "$LAUNCHED_PID" ]; then
    echo "::error::could not parse launched PID from simctl output ($phase phase)"
    return 1
  fi
  LIVE_PID="$LAUNCHED_PID"
}

wait_for_result() {
  local phase="$1" result="$2" pid="$3" step
  for step in $(seq 1 $((PROBE_WAIT_SECONDS * 2))); do
    if [ -f "$result" ]; then return 0; fi
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "::error::$APP_NAME (pid $pid) exited during the wallet $phase phase before the probe reported"
      return 1
    fi
    require_log_stream_alive || return 1
    sleep 0.5
  done
  echo "::error::wallet probe produced no result within ${PROBE_WAIT_SECONDS}s ($phase phase)"
  return 1
}

launch_phase store "$STORE_RESULT"
STORE_PID="$LAUNCHED_PID"
wait_for_result store "$STORE_RESULT" "$STORE_PID"
xcrun simctl io "$UDID" screenshot "$OUT_DIR/wallet-store.png" >/dev/null
STORE_VERDICT="$(python3 - "$STORE_RESULT" <<'PY'
import json, sys
result = json.load(open(sys.argv[1], encoding='utf-8'))
stored = result.get('stored')
if result.get('ok') is True and isinstance(stored, dict) and isinstance(stored.get('revision'), int):
    print(f"ok {stored['revision']}")
else:
    print(f"failed {result.get('failure') or 'no snapshot in store result'}")
PY
)"
case "$STORE_VERDICT" in
  ok\ *) STORE_REVISION="${STORE_VERDICT#ok }" ;;
  *)
    echo "::error::wallet store phase failed: ${STORE_VERDICT#failed }"
    exit 1
    ;;
esac
echo "wallet revision $STORE_REVISION stored by pid $STORE_PID"

echo "force-quitting $APP_NAME (pid $STORE_PID) with SIGKILL"
kill -KILL "$STORE_PID"
if ! wait_for_exit "$STORE_PID"; then
  echo "::error::$APP_NAME (pid $STORE_PID) survived SIGKILL"
  exit 1
fi
FORCE_QUIT=SIGKILL
LIVE_PID=""

launch_phase restore "$RESTORE_RESULT"
RESTORE_PID="$LAUNCHED_PID"
wait_for_result restore "$RESTORE_RESULT" "$RESTORE_PID"
xcrun simctl io "$UDID" screenshot "$OUT_DIR/wallet-restore.png" >/dev/null
python3 - "$INPUT" "$STORE_RESULT" "$RESTORE_RESULT" "$OWNER" >"$OUT_DIR/wallet-compare.txt" <<'PY'
import json, sys

def load(path):
    return json.load(open(path, encoding='utf-8'))

contents, store, restore, owner = load(sys.argv[1]), load(sys.argv[2]), load(sys.argv[3]), sys.argv[4]
stored = store.get('stored') or {}
restored = restore.get('restored')
problems = []
if not isinstance(restored, dict):
    problems.append(restore.get('failure') or 'no wallet restored')
    restored = {}
else:
    for key in ('ownerId', 'revision', 'grants', 'receipts'):
        if restored.get(key) != stored.get(key):
            problems.append(f'{key} differs after relaunch')
    if restored.get('ownerId') != owner:
        problems.append('owner differs from the probe owner')
    for key in ('grants', 'receipts'):
        if restored.get(key) != contents.get(key):
            problems.append(f'{key} differ from the stored input')
cleared = restore.get('cleared')
after = restore.get('afterClear')
cleared_ok = isinstance(cleared, dict) and 'resolved' in cleared and cleared['resolved'] is None
after_ok = isinstance(after, dict) and 'resolved' in after and after['resolved'] is None
print(f"restore_revision={restored.get('revision', '')}")
print(f"restored_match={0 if problems else 1}")
print(f"cleared={1 if cleared_ok else 0}")
print(f"after_clear_empty={1 if after_ok else 0}")
print(f"detail={'; '.join(problems) if problems else 'ok'}")
PY
while IFS='=' read -r key value; do
  case "$key" in
    restore_revision) RESTORE_REVISION="$value" ;;
    restored_match) RESTORED_MATCH="$value" ;;
    cleared) CLEARED="$value" ;;
    after_clear_empty) AFTER_CLEAR_EMPTY="$value" ;;
    detail) RESTORE_DETAIL="$value" ;;
  esac
done <"$OUT_DIR/wallet-compare.txt"

sleep 2
require_log_stream_alive
stop_log_stream

KEYCHAIN_LINES="$(grep -E 'Code=-34018|-34018|neither application-identifier nor keychain-access-groups entitlements' "$LOG_FILE")" || [ $? -eq 1 ]
if [ -n "$KEYCHAIN_LINES" ]; then
  KEYCHAIN_ERRORS="$(printf '%s\n' "$KEYCHAIN_LINES" | wc -l | tr -d ' ')"
fi
PROBE_LOG_LINES="$(grep -c 'PickleWalletProbe' "$LOG_FILE")" || [ $? -eq 1 ]

STATUS=0
if [ -n "$KEYCHAIN_LINES" ]; then
  echo "::error::simulator secure storage is unavailable because signing entitlements are missing"
  echo "$KEYCHAIN_LINES" | head -20
  STATUS=1
fi
if [ "$RESTORED_MATCH" != 1 ]; then
  echo "::error::wallet did not survive force-quit: $RESTORE_DETAIL"
  STATUS=1
fi
if [ "$CLEARED" != 1 ] || [ "$AFTER_CLEAR_EMPTY" != 1 ]; then
  echo "::error::wallet clear after restore failed: ${RESTORE_DETAIL} (see $RESTORE_RESULT)"
  STATUS=1
fi
if [ "$STATUS" = 0 ]; then
  OK=1
fi
write_summary
if [ "$STATUS" != 0 ]; then
  exit "$STATUS"
fi
echo "wallet persistence check passed: revision $STORE_REVISION stored by pid $STORE_PID, force-quit with SIGKILL, revision $RESTORE_REVISION restored by pid $RESTORE_PID with identical contents, then cleared"
