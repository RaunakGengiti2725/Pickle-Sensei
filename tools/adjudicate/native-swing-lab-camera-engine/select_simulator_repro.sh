#!/usr/bin/env bash
# Linux self-test for tools/macos-ci/select-simulator.sh (adjudication repro for
# NSLC-04, kept as the permanent regression gate — verify-cloud.sh `tooling`).
#
# Original defect (4d812e1a): the python body inside pick() was a bash
# single-quoted string, and the f-string `{'.'.join(...)}` contained single
# quotes that terminated it, so python saw `{..join(...)}` and raised
# SyntaxError on EVERY invocation. `UDID="$(pick || true)"` masked that and the
# helper fell through to `simctl create`, so every Mac stage created a NEW
# "PickleSensei-CI" simulator on the M4 runner (never deleted).
#
# The helper is driven with a fake `xcrun` on PATH; every simctl invocation is
# appended to a call log so the cases below can assert what was (not) run.
#
# Cases:
#   1  one available booted iPhone           -> selected, no create
#      (prints "OK: existing simulator selected without creating a new one")
#   2  malformed JSON from simctl            -> non-zero exit, no create
#   3  realistic M4 inventory                -> booted iPhone on newest runtime
#   4  no iPhone at all                      -> exactly one create, newest
#                                              runtime, newest Pro (non-Max) type
#   5  only an available PickleSensei-CI     -> reused by name, no create
#   6  leftover PickleSensei-CI duplicates   -> stock iPhone selected, leftovers
#                                              shut down + deleted
#   7  --boot on a Shutdown device           -> simctl boot + bootstatus run
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
HELPER="$ROOT/tools/macos-ci/select-simulator.sh"
FAKE="$(mktemp -d)"
trap 'rm -rf "$FAKE"' EXIT

cat >"$FAKE/xcrun" <<'EOF'
#!/usr/bin/env bash
# Fake xcrun: serves canned JSON from $FAKE_DIR and logs every call.
echo "$*" >>"$FAKE_DIR/calls.log"
case "$*" in
  "simctl list devices available -j"|"simctl list devices -j") cat "$FAKE_DIR/devices.json" ;;
  "simctl list runtimes -j") cat "$FAKE_DIR/runtimes.json" ;;
  "simctl list devicetypes -j") cat "$FAKE_DIR/devicetypes.json" ;;
  simctl\ create\ *) echo "CREATED-NEW-UDID" ;;
  simctl\ shutdown\ *|simctl\ delete\ *|simctl\ boot\ *|simctl\ bootstatus\ *) ;;
  *) echo "fake xcrun: unhandled $*" >&2; exit 1 ;;
esac
EOF
chmod +x "$FAKE/xcrun"
export FAKE_DIR="$FAKE"

cat >"$FAKE/runtimes.json" <<'EOF'
{"runtimes":[
  {"isAvailable":true,"platform":"iOS","version":"18.5","identifier":"com.apple.CoreSimulator.SimRuntime.iOS-18-5"},
  {"isAvailable":true,"platform":"iOS","version":"26.4","identifier":"com.apple.CoreSimulator.SimRuntime.iOS-26-4"},
  {"isAvailable":true,"platform":"watchOS","version":"26.4","identifier":"com.apple.CoreSimulator.SimRuntime.watchOS-26-4"}
]}
EOF
# Deliberately NOT sorted by model so the chooser must rank, not take [-1].
cat >"$FAKE/devicetypes.json" <<'EOF'
{"devicetypes":[
  {"name":"iPhone 17 Pro Max","identifier":"com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro-Max"},
  {"name":"iPhone SE (3rd generation)","identifier":"com.apple.CoreSimulator.SimDeviceType.iPhone-SE-3rd-generation"},
  {"name":"iPad Pro 13-inch (M5)","identifier":"com.apple.CoreSimulator.SimDeviceType.iPad-Pro-13-inch-M5"},
  {"name":"iPhone 17 Pro","identifier":"com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro"},
  {"name":"iPhone 11 Pro","identifier":"com.apple.CoreSimulator.SimDeviceType.iPhone-11-Pro"}
]}
EOF

FAILURES=0
fail() { echo "FAIL: $*" >&2; FAILURES=$((FAILURES + 1)); }

# run_helper <case-name> [helper args...]; sets OUT, STATUS, ERR, CALLS.
run_helper() {
  local name="$1"; shift
  : >"$FAKE/calls.log"
  OUT="$(PATH="$FAKE:$PATH" bash "$HELPER" "$@" 2>"$FAKE/stderr")"
  STATUS=$?
  ERR="$(cat "$FAKE/stderr")"
  CALLS="$(cat "$FAKE/calls.log")"
  echo "--- case $name: stdout='$OUT' exit=$STATUS"
  sed 's/^/    stderr: /' "$FAKE/stderr"
}
created_count() { grep -c '^simctl create ' "$FAKE/calls.log"; }

# ---------------------------------------------------------------- case 1 ----
cat >"$FAKE/devices.json" <<'EOF'
{"devices":{"com.apple.CoreSimulator.SimRuntime.iOS-26-0":[
  {"isAvailable":true,"name":"iPhone 17 Pro","state":"Booted","udid":"FAKE-UDID-1",
   "deviceTypeIdentifier":"com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro"}
]}}
EOF
run_helper "1 existing booted iPhone"
if grep -q "SyntaxError" <<<"$ERR"; then fail "case 1: python SyntaxError in pick()"; fi
if [ "$(created_count)" != "0" ]; then fail "case 1: simctl create invoked although an iPhone was available"; fi
if [ "$STATUS" != "0" ] || [ "$OUT" != "FAKE-UDID-1" ]; then fail "case 1: expected FAKE-UDID-1 exit 0"; fi
if ! grep -q "^selected simulator: iPhone 17 Pro (iOS 26.0) FAKE-UDID-1" <<<"$ERR"; then fail "case 1: missing 'selected simulator:' line on stderr"; fi
if [ "$FAILURES" = "0" ]; then
  echo "OK: existing simulator selected without creating a new one"
else
  echo "REPRODUCED: helper failed to select the existing booted iPhone and fell through to simctl create" >&2
fi

# ---------------------------------------------------------------- case 2 ----
printf '{"devices": {"com.apple.CoreSimulator.SimRuntime.iOS-26-0": [ {"isAvailable": true' >"$FAKE/devices.json"
run_helper "2 malformed simctl JSON"
if [ "$STATUS" = "0" ]; then fail "case 2: malformed JSON must make the helper exit non-zero (got 0, stdout '$OUT')"; fi
if [ "$(created_count)" != "0" ]; then fail "case 2: simctl create invoked after a parse failure"; fi
if grep -q "^CREATED-NEW-UDID$" <<<"$OUT"; then fail "case 2: a created UDID leaked to stdout"; fi

# ---------------------------------------------------------------- case 3 ----
cat >"$FAKE/devices.json" <<'EOF'
{"devices":{
 "com.apple.CoreSimulator.SimRuntime.iOS-18-5":[
  {"isAvailable":true,"name":"iPhone 16 Pro","state":"Shutdown","udid":"U-16PRO","deviceTypeIdentifier":"com.apple.CoreSimulator.SimDeviceType.iPhone-16-Pro"},
  {"isAvailable":true,"name":"Pickle Sensei Visual QA","state":"Booted","udid":"U-QA","deviceTypeIdentifier":"com.apple.CoreSimulator.SimDeviceType.iPhone-16"},
  {"isAvailable":true,"name":"iPad Pro 11-inch (M4)","state":"Shutdown","udid":"U-IPAD-18","deviceTypeIdentifier":"com.apple.CoreSimulator.SimDeviceType.iPad-Pro-11-inch-M4"}
 ],
 "com.apple.CoreSimulator.SimRuntime.iOS-26-4":[
  {"isAvailable":true,"name":"iPhone 17 Pro","state":"Shutdown","udid":"U-17PRO","deviceTypeIdentifier":"com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro"},
  {"isAvailable":true,"name":"iPhone 17 Pro Max","state":"Booted","udid":"U-17PROMAX","deviceTypeIdentifier":"com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro-Max"},
  {"isAvailable":true,"name":"iPhone 17","state":"Shutdown","udid":"U-17","deviceTypeIdentifier":"com.apple.CoreSimulator.SimDeviceType.iPhone-17"},
  {"isAvailable":false,"name":"iPhone 17e","state":"Shutdown","udid":"U-17E-UNAVAIL","deviceTypeIdentifier":"com.apple.CoreSimulator.SimDeviceType.iPhone-17e"},
  {"isAvailable":true,"name":"iPad (A16)","state":"Shutdown","udid":"U-IPAD-26","deviceTypeIdentifier":"com.apple.CoreSimulator.SimDeviceType.iPad-A16"}
 ],
 "com.apple.CoreSimulator.SimRuntime.watchOS-26-4":[
  {"isAvailable":true,"name":"Apple Watch Ultra 3 (49mm)","state":"Booted","udid":"U-WATCH","deviceTypeIdentifier":"com.apple.CoreSimulator.SimDeviceType.Apple-Watch-Ultra-3-49mm"}
 ]}}
EOF
run_helper "3 realistic M4 inventory"
if [ "$STATUS" != "0" ] || [ "$OUT" != "U-17PROMAX" ]; then fail "case 3: expected the booted iPhone on the newest runtime (U-17PROMAX)"; fi
if [ "$(created_count)" != "0" ]; then fail "case 3: simctl create invoked"; fi
if grep -q "simctl delete" <<<"$CALLS"; then fail "case 3: deleted a simulator that is not ours"; fi

# ---------------------------------------------------------------- case 4 ----
cat >"$FAKE/devices.json" <<'EOF'
{"devices":{
 "com.apple.CoreSimulator.SimRuntime.iOS-26-4":[
  {"isAvailable":true,"name":"iPad (A16)","state":"Shutdown","udid":"U-IPAD-26","deviceTypeIdentifier":"com.apple.CoreSimulator.SimDeviceType.iPad-A16"}
 ]}}
EOF
run_helper "4 no iPhone available"
if [ "$STATUS" != "0" ] || [ "$OUT" != "CREATED-NEW-UDID" ]; then fail "case 4: expected the created UDID, exit 0"; fi
if [ "$(created_count)" != "1" ]; then fail "case 4: expected exactly one simctl create, got $(created_count)"; fi
if ! grep -qx "simctl create PickleSensei-CI com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro com.apple.CoreSimulator.SimRuntime.iOS-26-4" <<<"$CALLS"; then
  fail "case 4: create must use the newest Pro (non-Max) iPhone type on the newest iOS runtime; calls were: $CALLS"
fi
if ! grep -q "^no available iPhone simulator found" <<<"$ERR"; then fail "case 4: missing the 'no available iPhone simulator found' notice"; fi

# ---------------------------------------------------------------- case 5 ----
cat >"$FAKE/devices.json" <<'EOF'
{"devices":{
 "com.apple.CoreSimulator.SimRuntime.iOS-26-4":[
  {"isAvailable":true,"name":"PickleSensei-CI","state":"Shutdown","udid":"U-CI-1","deviceTypeIdentifier":"com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro"},
  {"isAvailable":true,"name":"iPad (A16)","state":"Shutdown","udid":"U-IPAD-26","deviceTypeIdentifier":"com.apple.CoreSimulator.SimDeviceType.iPad-A16"}
 ]}}
EOF
run_helper "5 reuse existing PickleSensei-CI"
if [ "$STATUS" != "0" ] || [ "$OUT" != "U-CI-1" ]; then fail "case 5: expected the existing PickleSensei-CI (U-CI-1) to be reused"; fi
if [ "$(created_count)" != "0" ]; then fail "case 5: simctl create invoked although PickleSensei-CI exists"; fi
if grep -q "simctl delete" <<<"$CALLS"; then fail "case 5: deleted the only PickleSensei-CI"; fi

# ---------------------------------------------------------------- case 6 ----
cat >"$FAKE/devices.json" <<'EOF'
{"devices":{
 "com.apple.CoreSimulator.SimRuntime.iOS-26-4":[
  {"isAvailable":true,"name":"PickleSensei-CI","state":"Booted","udid":"U-CI-A","deviceTypeIdentifier":"com.apple.CoreSimulator.SimDeviceType.iPhone-11-Pro"},
  {"isAvailable":true,"name":"PickleSensei-CI","state":"Shutdown","udid":"U-CI-B","deviceTypeIdentifier":"com.apple.CoreSimulator.SimDeviceType.iPhone-11-Pro"},
  {"isAvailable":true,"name":"iPhone 17 Pro","state":"Shutdown","udid":"U-17PRO","deviceTypeIdentifier":"com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro"}
 ]}}
EOF
run_helper "6 prune leftover PickleSensei-CI duplicates"
if [ "$STATUS" != "0" ] || [ "$OUT" != "U-17PRO" ]; then fail "case 6: expected the stock iPhone 17 Pro over CI-created devices"; fi
if [ "$(created_count)" != "0" ]; then fail "case 6: simctl create invoked"; fi
if ! grep -qx "simctl shutdown U-CI-A" <<<"$CALLS"; then fail "case 6: booted leftover U-CI-A must be shut down before deletion"; fi
if ! grep -qx "simctl delete U-CI-A" <<<"$CALLS" || ! grep -qx "simctl delete U-CI-B" <<<"$CALLS"; then fail "case 6: leftover PickleSensei-CI devices must be deleted; calls were: $CALLS"; fi
if grep -q "simctl delete U-17PRO" <<<"$CALLS" || grep -q "simctl shutdown U-CI-B" <<<"$CALLS"; then fail "case 6: touched a device it must not (stock iPhone, or shutdown of an already-Shutdown device)"; fi

# ---------------------------------------------------------------- case 7 ----
cat >"$FAKE/devices.json" <<'EOF'
{"devices":{
 "com.apple.CoreSimulator.SimRuntime.iOS-26-4":[
  {"isAvailable":true,"name":"iPhone 17 Pro","state":"Shutdown","udid":"U-17PRO","deviceTypeIdentifier":"com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro"}
 ]}}
EOF
run_helper "7 --boot on a Shutdown device" --boot
if [ "$STATUS" != "0" ] || [ "$OUT" != "U-17PRO" ]; then fail "case 7: expected U-17PRO exit 0"; fi
if ! grep -qx "simctl boot U-17PRO" <<<"$CALLS" || ! grep -qx "simctl bootstatus U-17PRO -b" <<<"$CALLS"; then fail "case 7: --boot must boot and wait for the selected device; calls were: $CALLS"; fi

if [ "$FAILURES" != "0" ]; then
  echo "select-simulator.sh self-test: $FAILURES failing check(s)" >&2
  exit 1
fi
echo "OK: select-simulator.sh Linux self-test passed (7 cases)"
