#!/usr/bin/env bash
# Regression tests for tools/macos-ci/select-simulator.sh.
#
# The script under test only talks to the world through `xcrun` (simctl) and
# `xcode-select`, so these tests put a fake `xcrun` first on PATH that serves
# JSON fixtures and records every invocation. That exercises the real
# control flow (pick → create fallback → stale cleanup → boot) on Linux; it
# does not prove anything about CoreSimulator itself — the Mac run does.
#
# Usage: scripts/tests/test_select_simulator.sh        (exit 0 = all passed)
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
SUT="$ROOT/tools/macos-ci/select-simulator.sh"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
FAKE_BIN="$WORK/bin"
FIXTURES="$WORK/fixtures"
mkdir -p "$FAKE_BIN" "$FIXTURES"

PASS=0
FAIL=0
CURRENT=""

fail() {
  FAIL=$((FAIL + 1))
  echo "FAIL [$CURRENT] $*" >&2
}

pass() {
  PASS=$((PASS + 1))
  echo "ok   [$CURRENT] $*"
}

check() { # check <description> <shell test expression...>
  local desc="$1"
  shift
  if "$@"; then pass "$desc"; else fail "$desc"; fi
}

assert_contains() { # assert_contains <desc> <needle> <file>
  if grep -qF -- "$2" "$3"; then pass "$1"; else
    fail "$1 — expected '$2' in $(basename "$3"):"
    sed 's/^/      | /' "$3" >&2
  fi
}

assert_not_contains() { # assert_not_contains <desc> <needle> <file>
  if grep -qF -- "$2" "$3"; then
    fail "$1 — did not expect '$2' in $(basename "$3"):"
    sed 's/^/      | /' "$3" >&2
  else pass "$1"; fi
}

assert_eq() { # assert_eq <desc> <expected> <actual>
  if [ "$2" = "$3" ]; then pass "$1"; else fail "$1 — expected '$2', got '$3'"; fi
}

# --- fake toolchain --------------------------------------------------------
# Fixture files (all under $FIXTURES):
#   devices-available.json  → xcrun simctl list devices available -j
#   devices-all.json        → xcrun simctl list devices -j
#   runtimes.json           → xcrun simctl list runtimes -j
#   devicetypes.json        → xcrun simctl list devicetypes -j
#   list-available.exit     → (optional) exit code for `list devices available`
#   create.udid             → UDID printed by `simctl create`
# Every invocation is appended to $FAKE_LOG as one line of arguments.
cat >"$FAKE_BIN/xcrun" <<'FAKE'
#!/usr/bin/env bash
set -u
echo "$*" >>"$FAKE_LOG"
if [ "${1:-}" != "simctl" ]; then
  echo "fake xcrun: unsupported tool ${1:-}" >&2
  exit 70
fi
shift
case "$1 ${2:-} ${3:-} ${4:-}" in
  "list devices available -j")
    [ -f "$FIXTURES/list-available.exit" ] && exit "$(cat "$FIXTURES/list-available.exit")"
    cat "$FIXTURES/devices-available.json" ;;
  "list devices -j ")
    cat "$FIXTURES/devices-all.json" ;;
  "list runtimes -j ")
    cat "$FIXTURES/runtimes.json" ;;
  "list devicetypes -j ")
    cat "$FIXTURES/devicetypes.json" ;;
  create*)
    cat "$FIXTURES/create.udid" ;;
  shutdown*|delete*|boot*|bootstatus*)
    echo "fake simctl: $*" >&2 ;;
  *)
    echo "fake simctl: unexpected invocation: $*" >&2
    exit 71 ;;
esac
FAKE
chmod +x "$FAKE_BIN/xcrun"
cat >"$FAKE_BIN/xcode-select" <<'FAKE'
#!/usr/bin/env bash
echo "$*" >>"$FAKE_LOG"
echo /Applications/Xcode.app/Contents/Developer
FAKE
chmod +x "$FAKE_BIN/xcode-select"

reset_fixtures() {
  rm -f "$FIXTURES"/*
  echo NEW-CREATED-UDID >"$FIXTURES/create.udid"
  echo '{"devices":{}}' >"$FIXTURES/devices-all.json"
  echo '{"runtimes":[]}' >"$FIXTURES/runtimes.json"
  echo '{"devicetypes":[]}' >"$FIXTURES/devicetypes.json"
}

# run_sut <args...>: runs the script under test with the fake PATH.
# Sets OUT (stdout), ERR (stderr file), LOG (invocation log), RC.
run_sut() {
  export FAKE_LOG="$WORK/$CURRENT.log" FIXTURES
  : >"$FAKE_LOG"
  LOG="$FAKE_LOG"
  ERR="$WORK/$CURRENT.err"
  RC=0
  OUT="$(PATH="$FAKE_BIN:$PATH" "$SUT" "$@" 2>"$ERR")" || RC=$?
}

dev() { # dev <runtime-suffix|-> <name> <udid> <state> <available true|false> [device type id]
  local type="${6:-}"
  [ -n "$type" ] || type="com.apple.CoreSimulator.SimDeviceType.$(echo "$2" | tr ' ' '-')"
  printf '{"udid":"%s","name":"%s","state":"%s","isAvailable":%s,"deviceTypeIdentifier":"%s"}' \
    "$3" "$2" "$4" "$5" "$type"
}

# Mirrors the self-hosted M4 inventory captured by Mac run 33841813597
# (environment.txt): iOS 18.5 + iOS 26.4 runtimes, iPhone 17 Pro Max booted.
write_mac_like_devices() { # write_mac_like_devices <state of iPhone 17 Pro Max>
  local max_state="$1"
  cat >"$FIXTURES/devices-available.json" <<JSON
{"devices":{
  "com.apple.CoreSimulator.SimRuntime.iOS-18-5":[
    $(dev - "iPhone 16 Pro" UDID-16PRO Shutdown true),
    $(dev - "iPhone 16 Pro Max" UDID-16PROMAX Shutdown true),
    $(dev - "Pickle Sensei Visual QA" UDID-VISUALQA Booted true com.apple.CoreSimulator.SimDeviceType.iPhone-16-Pro),
    $(dev - "iPad Pro 11-inch (M4)" UDID-IPAD-18 Shutdown true com.apple.CoreSimulator.SimDeviceType.iPad-Pro-11-inch-M4)
  ],
  "com.apple.CoreSimulator.SimRuntime.iOS-26-4":[
    $(dev - "iPhone 17 Pro" UDID-17PRO Shutdown true),
    $(dev - "iPhone 17 Pro Max" UDID-17PROMAX "$max_state" true),
    $(dev - "iPhone 17e" UDID-17E Shutdown true),
    $(dev - "iPhone Air" UDID-AIR Shutdown true),
    $(dev - "iPhone 17" UDID-17 Shutdown true),
    $(dev - "iPad Pro 13-inch (M5)" UDID-IPAD-26 Booted true com.apple.CoreSimulator.SimDeviceType.iPad-Pro-13-inch-M5)
  ],
  "com.apple.CoreSimulator.SimRuntime.watchOS-26-4":[
    $(dev - "Apple Watch Ultra 3 (49mm)" UDID-WATCH Booted true com.apple.CoreSimulator.SimDeviceType.Apple-Watch-Ultra-3-49mm)
  ]
}}
JSON
  cp "$FIXTURES/devices-available.json" "$FIXTURES/devices-all.json"
}

write_runtimes() { # write_runtimes <with supportedDeviceTypes: yes|no>
  local sdt=""
  if [ "$1" = "yes" ]; then
    sdt=',"supportedDeviceTypes":[
      {"name":"iPhone 17","identifier":"com.apple.CoreSimulator.SimDeviceType.iPhone-17","productFamily":"iPhone"},
      {"name":"iPhone 17 Pro Max","identifier":"com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro-Max","productFamily":"iPhone"},
      {"name":"iPhone 17 Pro","identifier":"com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro","productFamily":"iPhone"},
      {"name":"iPhone Air","identifier":"com.apple.CoreSimulator.SimDeviceType.iPhone-Air","productFamily":"iPhone"},
      {"name":"iPad Pro 13-inch (M5)","identifier":"com.apple.CoreSimulator.SimDeviceType.iPad-Pro-13-inch-M5","productFamily":"iPad"},
      {"name":"iPhone 11 Pro","identifier":"com.apple.CoreSimulator.SimDeviceType.iPhone-11-Pro","productFamily":"iPhone"}
    ]'
  fi
  cat >"$FIXTURES/runtimes.json" <<JSON
{"runtimes":[
  {"identifier":"com.apple.CoreSimulator.SimRuntime.iOS-18-5","platform":"iOS","version":"18.5","isAvailable":true,"name":"iOS 18.5"},
  {"identifier":"com.apple.CoreSimulator.SimRuntime.iOS-27-0","platform":"iOS","version":"27.0","isAvailable":false,"name":"iOS 27.0"},
  {"identifier":"com.apple.CoreSimulator.SimRuntime.watchOS-26-4","platform":"watchOS","version":"26.4","isAvailable":true,"name":"watchOS 26.4"},
  {"identifier":"com.apple.CoreSimulator.SimRuntime.iOS-26-4","platform":"iOS","version":"26.4","isAvailable":true,"name":"iOS 26.4"$sdt}
]}
JSON
}

# Device-type order chosen so that `(pro or types)[-1]` — the old selection —
# yields iPhone 11 Pro, exactly what the real Mac created.
write_devicetypes() {
  cat >"$FIXTURES/devicetypes.json" <<'JSON'
{"devicetypes":[
  {"name":"iPhone 17 Pro","identifier":"com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro","productFamily":"iPhone","modelIdentifier":"iPhone18,1"},
  {"name":"iPhone 17 Pro Max","identifier":"com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro-Max","productFamily":"iPhone","modelIdentifier":"iPhone18,2"},
  {"name":"iPhone 17","identifier":"com.apple.CoreSimulator.SimDeviceType.iPhone-17","productFamily":"iPhone","modelIdentifier":"iPhone18,3"},
  {"name":"iPhone 16 Pro","identifier":"com.apple.CoreSimulator.SimDeviceType.iPhone-16-Pro","productFamily":"iPhone","modelIdentifier":"iPhone17,1"},
  {"name":"iPad Pro 13-inch (M5)","identifier":"com.apple.CoreSimulator.SimDeviceType.iPad-Pro-13-inch-M5","productFamily":"iPad","modelIdentifier":"iPad17,1"},
  {"name":"iPhone 11 Pro","identifier":"com.apple.CoreSimulator.SimDeviceType.iPhone-11-Pro","productFamily":"iPhone","modelIdentifier":"iPhone12,3"}
]}
JSON
}

# ---------------------------------------------------------------------------
CURRENT="static"
check "bash -n parses the script" bash -n "$SUT"
# Every embedded python program must be a heredoc (`python3 - <<'PY'`), so it
# can be extracted verbatim and byte-compiled: shell quoting can never
# corrupt it again.
PYCOUNT=0
PYOK=1
while IFS= read -r prog; do
  PYCOUNT=$((PYCOUNT + 1))
  if ! python3 -m py_compile "$prog" 2>"$WORK/py_compile.err"; then
    PYOK=0
    fail "embedded python program $PYCOUNT does not compile:"
    sed 's/^/      | /' "$WORK/py_compile.err" >&2
  fi
done < <(
  python3 - "$SUT" "$WORK" <<'PY'
import re, sys
src = open(sys.argv[1]).read()
n = 0
for m in re.finditer(r"python3 - [^\n]*<<'PY'\n(.*?)\nPY\n", src, re.S):
    n += 1
    path = f"{sys.argv[2]}/embedded-{n}.py"
    open(path, "w").write(m.group(1) + "\n")
    print(path)
PY
)
check "embedded python programs are heredocs (found $PYCOUNT)" [ "$PYCOUNT" -ge 1 ]
check "all embedded python programs byte-compile" [ "$PYOK" = 1 ]
check "no 'python3 -c' inline programs remain" bash -c "! grep -q \"python3 -c\" '$SUT'"
check "no '|| true' anywhere in the script" bash -c "! grep -q '|| true' '$SUT'"

# ---------------------------------------------------------------------------
CURRENT="single-booted-iphone"
reset_fixtures
cat >"$FIXTURES/devices-available.json" <<JSON
{"devices":{"com.apple.CoreSimulator.SimRuntime.iOS-26-4":[$(dev - "iPhone 16 Pro" UDID-BOOTED-16PRO Booted true)]}}
JSON
cp "$FIXTURES/devices-available.json" "$FIXTURES/devices-all.json"
write_runtimes yes
write_devicetypes
run_sut
assert_eq "exit 0" 0 "$RC"
assert_eq "stdout is exactly the booted UDID" UDID-BOOTED-16PRO "$OUT"
assert_contains "stderr announces the selection" "selected simulator: iPhone 16 Pro (iOS 26.4) UDID-BOOTED-16PRO" "$ERR"
assert_not_contains "stderr has no SyntaxError" "SyntaxError" "$ERR"
assert_not_contains "stderr has no create fallback" "creating simulator" "$ERR"
assert_not_contains "simctl create was not invoked" "simctl create" "$LOG"
assert_not_contains "simctl boot was not invoked without --boot" "simctl boot" "$LOG"

# ---------------------------------------------------------------------------
CURRENT="invalid-json-fails"
reset_fixtures
echo '{"devices": {' >"$FIXTURES/devices-available.json"
write_runtimes yes
write_devicetypes
run_sut
check "exit code is non-zero" [ "$RC" -ne 0 ]
assert_eq "nothing on stdout" "" "$OUT"
assert_not_contains "picker failure is not masked by the create fallback" "simctl create" "$LOG"
assert_contains "stderr names the failing command" "simctl list devices available -j" "$ERR"

CURRENT="picker-command-failure-fails"
reset_fixtures
echo 3 >"$FIXTURES/list-available.exit"
echo '{"devices":{}}' >"$FIXTURES/devices-available.json"
write_runtimes yes
write_devicetypes
run_sut
check "exit code is non-zero when simctl list fails" [ "$RC" -ne 0 ]
assert_eq "nothing on stdout" "" "$OUT"
assert_not_contains "no create fallback after a failed list" "simctl create" "$LOG"

# ---------------------------------------------------------------------------
CURRENT="ranking-mac-inventory-booted"
reset_fixtures
write_mac_like_devices Booted
write_runtimes yes
write_devicetypes
run_sut
assert_eq "exit 0" 0 "$RC"
assert_eq "booted iPhone on the newest runtime wins over shutdown Pro models" UDID-17PROMAX "$OUT"
assert_contains "selection is announced with the runtime version" "selected simulator: iPhone 17 Pro Max (iOS 26.4) UDID-17PROMAX" "$ERR"
assert_not_contains "no create fallback" "creating simulator" "$ERR"

CURRENT="ranking-mac-inventory-nothing-booted"
reset_fixtures
write_mac_like_devices Shutdown
write_runtimes yes
write_devicetypes
run_sut
assert_eq "exit 0" 0 "$RC"
case "$OUT" in
  UDID-17PRO|UDID-17PROMAX) pass "a Pro iPhone on iOS 26.4 is chosen ($OUT), not the booted 18.5 device, iPad or watch" ;;
  *) fail "expected a Pro iPhone on iOS 26.4, got '$OUT'" ;;
esac

CURRENT="ranking-newest-runtime-beats-booted-older"
reset_fixtures
cat >"$FIXTURES/devices-available.json" <<JSON
{"devices":{
  "com.apple.CoreSimulator.SimRuntime.iOS-18-5":[$(dev - "iPhone 16 Pro" UDID-OLD-BOOTED Booted true)],
  "com.apple.CoreSimulator.SimRuntime.iOS-26-4":[$(dev - "iPhone 17" UDID-NEW-SHUTDOWN Shutdown true)],
  "com.apple.CoreSimulator.SimRuntime.iOS-26-10":[$(dev - "iPhone 17 Pro" UDID-UNAVAILABLE Shutdown false)]
}}
JSON
cp "$FIXTURES/devices-available.json" "$FIXTURES/devices-all.json"
write_runtimes yes
write_devicetypes
run_sut
assert_eq "exit 0" 0 "$RC"
assert_eq "newest runtime is preferred over an older booted device; unavailable devices are ignored" UDID-NEW-SHUTDOWN "$OUT"
assert_contains "runtime version 26.4 (not lexicographic 26.10) is reported" "(iOS 26.4)" "$ERR"

# ---------------------------------------------------------------------------
CURRENT="create-fallback-uses-newest-pro-from-runtime"
reset_fixtures
echo '{"devices":{"com.apple.CoreSimulator.SimRuntime.iOS-26-4":[]}}' >"$FIXTURES/devices-available.json"
write_runtimes yes
write_devicetypes
run_sut
assert_eq "exit 0" 0 "$RC"
assert_eq "stdout is the created UDID" NEW-CREATED-UDID "$OUT"
assert_contains "stderr explains why it creates" "no available iPhone simulator found" "$ERR"
assert_contains "stderr announces the creation" "creating simulator PickleSensei-CI" "$ERR"
assert_contains "created on the newest available iOS runtime with the newest supported Pro (not iPhone 11 Pro)" \
  "simctl create PickleSensei-CI com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro com.apple.CoreSimulator.SimRuntime.iOS-26-4" "$LOG"

CURRENT="create-fallback-uses-newest-pro-from-devicetypes"
reset_fixtures
echo '{"devices":{}}' >"$FIXTURES/devices-available.json"
write_runtimes no
write_devicetypes
run_sut
assert_eq "exit 0" 0 "$RC"
assert_eq "stdout is the created UDID" NEW-CREATED-UDID "$OUT"
assert_contains "without supportedDeviceTypes the newest Pro from 'list devicetypes' is used (not [-1] = iPhone 11 Pro)" \
  "simctl create PickleSensei-CI com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro com.apple.CoreSimulator.SimRuntime.iOS-26-4" "$LOG"

CURRENT="create-fallback-no-runtime"
reset_fixtures
echo '{"devices":{}}' >"$FIXTURES/devices-available.json"
echo '{"runtimes":[{"identifier":"com.apple.CoreSimulator.SimRuntime.watchOS-26-4","platform":"watchOS","version":"26.4","isAvailable":true}]}' >"$FIXTURES/runtimes.json"
write_devicetypes
run_sut
check "exit code is non-zero" [ "$RC" -ne 0 ]
assert_eq "nothing on stdout" "" "$OUT"
assert_contains "stderr gives the install command" "xcodebuild -downloadPlatform iOS" "$ERR"
assert_not_contains "nothing is created" "simctl create" "$LOG"

# ---------------------------------------------------------------------------
CURRENT="stale-ci-devices-are-deleted"
reset_fixtures
cat >"$FIXTURES/devices-available.json" <<JSON
{"devices":{"com.apple.CoreSimulator.SimRuntime.iOS-26-4":[$(dev - "iPhone 17 Pro Max" UDID-17PROMAX Booted true)]}}
JSON
cat >"$FIXTURES/devices-all.json" <<JSON
{"devices":{
  "com.apple.CoreSimulator.SimRuntime.iOS-26-4":[
    $(dev - "iPhone 17 Pro Max" UDID-17PROMAX Booted true),
    $(dev - "PickleSensei-CI" UDID-STALE-1 Booted true com.apple.CoreSimulator.SimDeviceType.iPhone-11-Pro),
    $(dev - "PickleSensei-CI" UDID-STALE-2 Shutdown false com.apple.CoreSimulator.SimDeviceType.iPhone-11-Pro),
    $(dev - "PickleSensei-CI-keepsake" UDID-OTHER Shutdown true)
  ]
}}
JSON
write_runtimes yes
write_devicetypes
run_sut
assert_eq "exit 0" 0 "$RC"
assert_eq "stdout is the selected UDID" UDID-17PROMAX "$OUT"
assert_contains "stale device 1 deleted" "simctl delete UDID-STALE-1" "$LOG"
assert_contains "stale device 2 deleted" "simctl delete UDID-STALE-2" "$LOG"
assert_not_contains "differently named devices are left alone" "UDID-OTHER" "$LOG"
assert_not_contains "the selected device is never deleted" "simctl delete UDID-17PROMAX" "$LOG"
assert_contains "deletion is logged" "deleting stale simulator PickleSensei-CI UDID-STALE-1" "$ERR"

CURRENT="selected-ci-device-is-kept"
reset_fixtures
cat >"$FIXTURES/devices-available.json" <<JSON
{"devices":{"com.apple.CoreSimulator.SimRuntime.iOS-26-4":[$(dev - "PickleSensei-CI" UDID-CI-KEEP Shutdown true com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro)]}}
JSON
cat >"$FIXTURES/devices-all.json" <<JSON
{"devices":{"com.apple.CoreSimulator.SimRuntime.iOS-26-4":[
  $(dev - "PickleSensei-CI" UDID-CI-KEEP Shutdown true com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro),
  $(dev - "PickleSensei-CI" UDID-CI-STALE Shutdown true com.apple.CoreSimulator.SimDeviceType.iPhone-11-Pro)
]}}
JSON
write_runtimes yes
write_devicetypes
run_sut
assert_eq "exit 0" 0 "$RC"
assert_eq "an existing CI device is reused instead of creating another" UDID-CI-KEEP "$OUT"
assert_not_contains "no new device is created" "simctl create" "$LOG"
assert_not_contains "the reused CI device is not deleted" "simctl delete UDID-CI-KEEP" "$LOG"
assert_contains "the other CI device is deleted" "simctl delete UDID-CI-STALE" "$LOG"

# ---------------------------------------------------------------------------
CURRENT="boot-flag-boots-shutdown-device"
reset_fixtures
cat >"$FIXTURES/devices-available.json" <<JSON
{"devices":{"com.apple.CoreSimulator.SimRuntime.iOS-26-4":[$(dev - "iPhone 17 Pro" UDID-17PRO Shutdown true)]}}
JSON
cp "$FIXTURES/devices-available.json" "$FIXTURES/devices-all.json"
write_runtimes yes
write_devicetypes
run_sut --boot
assert_eq "exit 0" 0 "$RC"
assert_eq "stdout is only the UDID" UDID-17PRO "$OUT"
assert_contains "device is booted" "simctl boot UDID-17PRO" "$LOG"
assert_contains "boot is awaited" "simctl bootstatus UDID-17PRO -b" "$LOG"
assert_contains "boot is announced" "booting simulator UDID-17PRO" "$ERR"

CURRENT="boot-flag-skips-boot-when-booted"
reset_fixtures
cat >"$FIXTURES/devices-available.json" <<JSON
{"devices":{"com.apple.CoreSimulator.SimRuntime.iOS-26-4":[$(dev - "iPhone 17 Pro" UDID-17PRO Booted true)]}}
JSON
cp "$FIXTURES/devices-available.json" "$FIXTURES/devices-all.json"
write_runtimes yes
write_devicetypes
run_sut --boot
assert_eq "exit 0" 0 "$RC"
assert_eq "stdout is only the UDID" UDID-17PRO "$OUT"
assert_not_contains "an already booted device is not booted again" "simctl boot UDID-17PRO" "$LOG"
assert_contains "boot status is still awaited" "simctl bootstatus UDID-17PRO -b" "$LOG"

CURRENT="unknown-argument"
reset_fixtures
run_sut --bogus
assert_eq "exit 2" 2 "$RC"
assert_eq "nothing on stdout" "" "$OUT"
assert_contains "unknown argument reported" "unknown argument: --bogus" "$ERR"
check "no simctl call happened" [ ! -s "$LOG" ]

# ---------------------------------------------------------------------------
echo
echo "select-simulator tests: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
