#!/usr/bin/env bash
# Control-flow regression tests for tools/macos-ci/select-simulator.sh.
#
# Runs on Linux (and macOS) against a fake `xcrun` that serves fixture JSON
# for `simctl list …` and records every other simctl call, so the picker's
# selection order, its failure propagation and the create/cleanup fallbacks can
# be asserted without a Mac. Apple runtime truth still comes from the M4 runner.
#
#   scripts/tests/test_select_simulator.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="$REPO_ROOT/tools/macos-ci/select-simulator.sh"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
FAKE="$WORK/fake"
mkdir -p "$FAKE/bin"

cat >"$FAKE/bin/xcrun" <<'EOF'
#!/usr/bin/env bash
# Fake xcrun: `simctl list <kind> … -j` prints $FAKE_SIMCTL_DIR/<kind>.json
# (exit 1 when <kind>.fail exists); every other simctl call is appended to
# $FAKE_SIMCTL_DIR/calls.log. `simctl create` prints a fixed UDID.
set -euo pipefail
dir="${FAKE_SIMCTL_DIR:?}"
[ "${1:-}" = "simctl" ] || { echo "fake xcrun: unexpected tool ${1:-}" >&2; exit 97; }
shift
case "${1:-}" in
  list)
    kind="${2:-}"
    [ -e "$dir/$kind.fail" ] && { echo "fake simctl: list $kind failed" >&2; exit 1; }
    [ -f "$dir/$kind.json" ] || { echo "fake simctl: no fixture for list $kind" >&2; exit 98; }
    cat "$dir/$kind.json"
    ;;
  create)
    echo "simctl $*" >>"$dir/calls.log"
    echo "CREATED-UDID-0000"
    ;;
  boot|bootstatus|shutdown|delete)
    echo "simctl $*" >>"$dir/calls.log"
    ;;
  *)
    echo "fake simctl: unhandled $*" >&2
    exit 99
    ;;
esac
EOF
cat >"$FAKE/bin/xcode-select" <<'EOF'
#!/usr/bin/env bash
echo "/Applications/Xcode.app/Contents/Developer"
EOF
chmod +x "$FAKE/bin/xcrun" "$FAKE/bin/xcode-select"

FAILURES=0
PASSES=0
CASE=""

fail() {
  echo "FAIL [$CASE] $*" >&2
  FAILURES=$((FAILURES + 1))
}

pass() {
  echo "ok   [$CASE] $*"
  PASSES=$((PASSES + 1))
}

begin_case() {
  CASE="$1"
  FIX="$WORK/$CASE"
  mkdir -p "$FIX"
  : >"$FIX/calls.log"
  export FAKE_SIMCTL_DIR="$FIX"
  # Defaults: one runtime, device types listed oldest-Pro-last (as on the real
  # Mac, where `(pro or types)[-1]` picked iPhone 11 Pro).
  cat >"$FIX/runtimes.json" <<'JSON'
{"runtimes":[
  {"identifier":"com.apple.CoreSimulator.SimRuntime.iOS-18-5","version":"18.5","platform":"iOS","isAvailable":true,
   "supportedDeviceTypes":[
     {"identifier":"com.apple.CoreSimulator.SimDeviceType.iPhone-16-Pro","name":"iPhone 16 Pro","productFamily":"iPhone"},
     {"identifier":"com.apple.CoreSimulator.SimDeviceType.iPhone-11-Pro","name":"iPhone 11 Pro","productFamily":"iPhone"}]},
  {"identifier":"com.apple.CoreSimulator.SimRuntime.iOS-26-4","version":"26.4","platform":"iOS","isAvailable":true,
   "supportedDeviceTypes":[
     {"identifier":"com.apple.CoreSimulator.SimDeviceType.iPhone-16-Pro","name":"iPhone 16 Pro","productFamily":"iPhone"},
     {"identifier":"com.apple.CoreSimulator.SimDeviceType.iPhone-17","name":"iPhone 17","productFamily":"iPhone"},
     {"identifier":"com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro","name":"iPhone 17 Pro","productFamily":"iPhone"},
     {"identifier":"com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro-Max","name":"iPhone 17 Pro Max","productFamily":"iPhone"},
     {"identifier":"com.apple.CoreSimulator.SimDeviceType.iPad-Pro-13-inch-M5","name":"iPad Pro 13-inch (M5)","productFamily":"iPad"},
     {"identifier":"com.apple.CoreSimulator.SimDeviceType.iPhone-11-Pro","name":"iPhone 11 Pro","productFamily":"iPhone"}]},
  {"identifier":"com.apple.CoreSimulator.SimRuntime.tvOS-26-4","version":"26.4","platform":"tvOS","isAvailable":true,"supportedDeviceTypes":[]}
]}
JSON
  cat >"$FIX/devicetypes.json" <<'JSON'
{"devicetypes":[
  {"identifier":"com.apple.CoreSimulator.SimDeviceType.iPhone-16-Pro","name":"iPhone 16 Pro","productFamily":"iPhone","minRuntimeVersionString":"18.0.0","maxRuntimeVersionString":"65535.255.255"},
  {"identifier":"com.apple.CoreSimulator.SimDeviceType.iPhone-17","name":"iPhone 17","productFamily":"iPhone","minRuntimeVersionString":"26.0.0","maxRuntimeVersionString":"65535.255.255"},
  {"identifier":"com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro","name":"iPhone 17 Pro","productFamily":"iPhone","minRuntimeVersionString":"26.0.0","maxRuntimeVersionString":"65535.255.255"},
  {"identifier":"com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro-Max","name":"iPhone 17 Pro Max","productFamily":"iPhone","minRuntimeVersionString":"26.0.0","maxRuntimeVersionString":"65535.255.255"},
  {"identifier":"com.apple.CoreSimulator.SimDeviceType.iPad-Pro-13-inch-M5","name":"iPad Pro 13-inch (M5)","productFamily":"iPad","minRuntimeVersionString":"26.0.0","maxRuntimeVersionString":"65535.255.255"},
  {"identifier":"com.apple.CoreSimulator.SimDeviceType.iPhone-11-Pro","name":"iPhone 11 Pro","productFamily":"iPhone","minRuntimeVersionString":"13.0.0","maxRuntimeVersionString":"65535.255.255"}
]}
JSON
}

# run_script [args…] → sets OUT, ERR, RC
run_script() {
  set +e
  OUT="$(PATH="$FAKE/bin:$PATH" "$SCRIPT" "$@" 2>"$FIX/stderr.txt")"
  RC=$?
  set -e
  ERR="$(cat "$FIX/stderr.txt")"
}

assert_eq() {
  local what="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then pass "$what = $(printf %q "$expected")"; else fail "$what: expected $(printf %q "$expected"), got $(printf %q "$actual")"; fi
}

assert_contains() {
  local what="$1" needle="$2" haystack="$3"
  if [[ "$haystack" == *"$needle"* ]]; then pass "$what contains $(printf %q "$needle")"; else fail "$what does not contain $(printf %q "$needle"):"$'\n'"$haystack"; fi
}

assert_not_contains() {
  local what="$1" needle="$2" haystack="$3"
  if [[ "$haystack" != *"$needle"* ]]; then pass "$what has no $(printf %q "$needle")"; else fail "$what unexpectedly contains $(printf %q "$needle"):"$'\n'"$haystack"; fi
}

calls() { cat "$FIX/calls.log"; }

# ---------------------------------------------------------------------------
begin_case "booted_iphone_is_selected_not_created"
cat >"$FIX/devices.json" <<'JSON'
{"devices":{
  "com.apple.CoreSimulator.SimRuntime.iOS-26-4":[
    {"udid":"UDID-17PRO-SHUTDOWN","name":"iPhone 17 Pro","state":"Shutdown","isAvailable":true,"deviceTypeIdentifier":"com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro"},
    {"udid":"UDID-17PROMAX-BOOTED","name":"iPhone 17 Pro Max","state":"Booted","isAvailable":true,"deviceTypeIdentifier":"com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro-Max"},
    {"udid":"UDID-IPAD","name":"iPad Pro 13-inch (M5)","state":"Shutdown","isAvailable":true,"deviceTypeIdentifier":"com.apple.CoreSimulator.SimDeviceType.iPad-Pro-13-inch-M5"}
  ],
  "com.apple.CoreSimulator.SimRuntime.iOS-18-5":[
    {"udid":"UDID-16PRO-OLD","name":"iPhone 16 Pro","state":"Shutdown","isAvailable":true,"deviceTypeIdentifier":"com.apple.CoreSimulator.SimDeviceType.iPhone-16-Pro"}
  ],
  "com.apple.CoreSimulator.SimRuntime.tvOS-26-4":[
    {"udid":"UDID-TV","name":"Apple TV","state":"Booted","isAvailable":true,"deviceTypeIdentifier":"com.apple.CoreSimulator.SimDeviceType.Apple-TV-4K-3rd-generation-4K"}
  ]
}}
JSON
run_script
assert_eq "exit code" 0 "$RC"
assert_eq "stdout (UDID)" "UDID-17PROMAX-BOOTED" "$OUT"
assert_contains "stderr" "selected simulator: iPhone 17 Pro Max (iOS 26.4) UDID-17PROMAX-BOOTED" "$ERR"
assert_not_contains "stderr" "SyntaxError" "$ERR"
assert_not_contains "stderr" "Traceback" "$ERR"
assert_not_contains "stderr" "creating simulator" "$ERR"
assert_not_contains "stderr" "no available iPhone simulator" "$ERR"
assert_eq "simctl side effects" "" "$(calls)"

# ---------------------------------------------------------------------------
begin_case "newest_runtime_beats_booted_older_runtime_and_pro_beats_base"
cat >"$FIX/devices.json" <<'JSON'
{"devices":{
  "com.apple.CoreSimulator.SimRuntime.iOS-18-5":[
    {"udid":"UDID-OLD-BOOTED","name":"iPhone 16 Pro","state":"Booted","isAvailable":true,"deviceTypeIdentifier":"com.apple.CoreSimulator.SimDeviceType.iPhone-16-Pro"}
  ],
  "com.apple.CoreSimulator.SimRuntime.iOS-26-4":[
    {"udid":"UDID-17-BASE","name":"iPhone 17","state":"Shutdown","isAvailable":true,"deviceTypeIdentifier":"com.apple.CoreSimulator.SimDeviceType.iPhone-17"},
    {"udid":"UDID-17-PRO","name":"iPhone 17 Pro","state":"Shutdown","isAvailable":true,"deviceTypeIdentifier":"com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro"},
    {"udid":"UDID-UNAVAILABLE","name":"iPhone 17 Pro Max","state":"Shutdown","isAvailable":false,"deviceTypeIdentifier":"com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro-Max"}
  ]
}}
JSON
run_script
assert_eq "exit code" 0 "$RC"
assert_eq "stdout (UDID)" "UDID-17-PRO" "$OUT"
assert_contains "stderr" "selected simulator: iPhone 17 Pro (iOS 26.4) UDID-17-PRO" "$ERR"
assert_eq "simctl side effects" "" "$(calls)"

# ---------------------------------------------------------------------------
begin_case "invalid_json_fails_the_step"
printf 'this is not json\n' >"$FIX/devices.json"
run_script
if [ "$RC" -ne 0 ]; then pass "exit code is non-zero ($RC)"; else fail "exit code is 0 although simctl output was invalid JSON"; fi
assert_eq "stdout" "" "$OUT"
assert_not_contains "stderr" "creating simulator" "$ERR"
assert_not_contains "simctl side effects" "simctl create" "$(calls)"

# ---------------------------------------------------------------------------
begin_case "simctl_list_failure_fails_the_step"
: >"$FIX/devices.fail"
run_script
if [ "$RC" -ne 0 ]; then pass "exit code is non-zero ($RC)"; else fail "exit code is 0 although simctl list devices failed"; fi
assert_eq "stdout" "" "$OUT"
assert_not_contains "simctl side effects" "simctl create" "$(calls)"

# ---------------------------------------------------------------------------
begin_case "existing_ci_device_is_reused_and_stale_ci_devices_deleted"
cat >"$FIX/devices.json" <<'JSON'
{"devices":{
  "com.apple.CoreSimulator.SimRuntime.iOS-26-4":[
    {"udid":"UDID-CI-STALE-1","name":"PickleSensei-CI","state":"Shutdown","isAvailable":true,"deviceTypeIdentifier":"com.apple.CoreSimulator.SimDeviceType.iPhone-11-Pro"},
    {"udid":"UDID-CI-BOOTED","name":"PickleSensei-CI","state":"Booted","isAvailable":true,"deviceTypeIdentifier":"com.apple.CoreSimulator.SimDeviceType.iPhone-11-Pro"},
    {"udid":"UDID-CI-STALE-2","name":"PickleSensei-CI","state":"Booted","isAvailable":true,"deviceTypeIdentifier":"com.apple.CoreSimulator.SimDeviceType.iPhone-11-Pro"},
    {"udid":"UDID-IPAD","name":"iPad Pro 13-inch (M5)","state":"Shutdown","isAvailable":true,"deviceTypeIdentifier":"com.apple.CoreSimulator.SimDeviceType.iPad-Pro-13-inch-M5"}
  ]
}}
JSON
run_script
assert_eq "exit code" 0 "$RC"
assert_eq "stdout (UDID)" "UDID-CI-BOOTED" "$OUT"
assert_contains "stderr" "selected simulator: PickleSensei-CI (iOS 26.4) UDID-CI-BOOTED" "$ERR"
assert_not_contains "stderr" "creating simulator" "$ERR"
assert_contains "simctl side effects" "simctl delete UDID-CI-STALE-1" "$(calls)"
assert_contains "simctl side effects" "simctl shutdown UDID-CI-STALE-2" "$(calls)"
assert_contains "simctl side effects" "simctl delete UDID-CI-STALE-2" "$(calls)"
assert_not_contains "simctl side effects" "delete UDID-CI-BOOTED" "$(calls)"
assert_not_contains "simctl side effects" "shutdown UDID-CI-BOOTED" "$(calls)"
assert_not_contains "simctl side effects" "shutdown UDID-CI-STALE-1" "$(calls)"
assert_not_contains "simctl side effects" "simctl create" "$(calls)"

# ---------------------------------------------------------------------------
begin_case "create_fallback_only_when_no_iphone_and_picks_newest_pro"
cat >"$FIX/devices.json" <<'JSON'
{"devices":{
  "com.apple.CoreSimulator.SimRuntime.iOS-26-4":[
    {"udid":"UDID-IPAD","name":"iPad Pro 13-inch (M5)","state":"Shutdown","isAvailable":true,"deviceTypeIdentifier":"com.apple.CoreSimulator.SimDeviceType.iPad-Pro-13-inch-M5"}
  ]
}}
JSON
run_script
assert_eq "exit code" 0 "$RC"
assert_eq "stdout (UDID)" "CREATED-UDID-0000" "$OUT"
assert_contains "stderr" "no available iPhone simulator found" "$ERR"
assert_contains "stderr" "creating simulator PickleSensei-CI (com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro on com.apple.CoreSimulator.SimRuntime.iOS-26-4)" "$ERR"
assert_not_contains "stderr" "iPhone-11-Pro" "$ERR"
assert_contains "simctl side effects" "simctl create PickleSensei-CI com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro com.apple.CoreSimulator.SimRuntime.iOS-26-4" "$(calls)"

# ---------------------------------------------------------------------------
begin_case "create_fallback_without_supportedDeviceTypes_uses_runtime_version_bounds"
cat >"$FIX/devices.json" <<'JSON'
{"devices":{}}
JSON
cat >"$FIX/runtimes.json" <<'JSON'
{"runtimes":[
  {"identifier":"com.apple.CoreSimulator.SimRuntime.iOS-18-5","version":"18.5","platform":"iOS","isAvailable":true}
]}
JSON
run_script
assert_eq "exit code" 0 "$RC"
assert_eq "stdout (UDID)" "CREATED-UDID-0000" "$OUT"
assert_contains "stderr" "creating simulator PickleSensei-CI (com.apple.CoreSimulator.SimDeviceType.iPhone-16-Pro on com.apple.CoreSimulator.SimRuntime.iOS-18-5)" "$ERR"

# ---------------------------------------------------------------------------
begin_case "no_ios_runtime_fails_with_install_hint"
cat >"$FIX/devices.json" <<'JSON'
{"devices":{}}
JSON
cat >"$FIX/runtimes.json" <<'JSON'
{"runtimes":[{"identifier":"com.apple.CoreSimulator.SimRuntime.tvOS-26-4","version":"26.4","platform":"tvOS","isAvailable":true}]}
JSON
run_script
assert_eq "exit code" 1 "$RC"
assert_eq "stdout" "" "$OUT"
assert_contains "stderr" "No iOS simulator runtime is installed" "$ERR"
assert_contains "stderr" "xcodebuild -downloadPlatform iOS" "$ERR"
assert_not_contains "simctl side effects" "simctl create" "$(calls)"

# ---------------------------------------------------------------------------
begin_case "boot_flag_boots_a_shutdown_device_and_waits"
cat >"$FIX/devices.json" <<'JSON'
{"devices":{
  "com.apple.CoreSimulator.SimRuntime.iOS-26-4":[
    {"udid":"UDID-17PRO","name":"iPhone 17 Pro","state":"Shutdown","isAvailable":true,"deviceTypeIdentifier":"com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro"}
  ]
}}
JSON
run_script --boot
assert_eq "exit code" 0 "$RC"
assert_eq "stdout (UDID)" "UDID-17PRO" "$OUT"
assert_contains "stderr" "booting simulator UDID-17PRO" "$ERR"
assert_eq "simctl side effects" $'simctl boot UDID-17PRO\nsimctl bootstatus UDID-17PRO -b' "$(calls)"

# ---------------------------------------------------------------------------
begin_case "boot_flag_does_not_reboot_a_booted_device"
cat >"$FIX/devices.json" <<'JSON'
{"devices":{
  "com.apple.CoreSimulator.SimRuntime.iOS-26-4":[
    {"udid":"UDID-17PRO","name":"iPhone 17 Pro","state":"Booted","isAvailable":true,"deviceTypeIdentifier":"com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro"}
  ]
}}
JSON
run_script --boot
assert_eq "exit code" 0 "$RC"
assert_eq "stdout (UDID)" "UDID-17PRO" "$OUT"
assert_not_contains "stderr" "booting simulator" "$ERR"
assert_eq "simctl side effects" "simctl bootstatus UDID-17PRO -b" "$(calls)"

# ---------------------------------------------------------------------------
begin_case "unknown_argument_is_rejected"
cat >"$FIX/devices.json" <<'JSON'
{"devices":{}}
JSON
run_script --bogus
assert_eq "exit code" 2 "$RC"
assert_contains "stderr" "unknown argument: --bogus" "$ERR"
assert_eq "simctl side effects" "" "$(calls)"

# ---------------------------------------------------------------------------
begin_case "shell_syntax_and_embedded_python_compile"
if bash -n "$SCRIPT"; then pass "bash -n"; else fail "bash -n failed"; fi
# Every python program must be a quoted heredoc (python3 - <<'PY' … PY) so
# shell quoting can never rewrite it; each body must compile on its own.
if grep -nE "python3 -c '" "$SCRIPT" >"$FIX/inline.txt"; then
  fail "inline python3 -c '…' programs remain (shell quoting hazard):"$'\n'"$(cat "$FIX/inline.txt")"
else
  pass "no inline python3 -c '…' programs"
fi
set +e
PY_REPORT="$(python3 - "$SCRIPT" <<'PY'
import sys

path = sys.argv[1]
lines = open(path, encoding="utf-8").read().split("\n")
programs = []
i = 0
while i < len(lines):
    if lines[i].rstrip().endswith("<<'PY'"):
        start = i + 1
        j = start
        while j < len(lines) and lines[j] != "PY":
            j += 1
        if j >= len(lines):
            sys.exit(f"unterminated heredoc starting at line {start}")
        programs.append((start + 1, "\n".join(lines[start:j])))
        i = j
    i += 1
if not programs:
    sys.exit("no python3 - <<'PY' heredocs found")
for lineno, src in programs:
    compile(src, f"{path}:{lineno}", "exec")
print(f"compiled {len(programs)} embedded python programs")
PY
)"
PY_RC=$?
set -e
if [ "$PY_RC" -eq 0 ]; then pass "$PY_REPORT"; else fail "embedded python check: $PY_REPORT"; fi

# ---------------------------------------------------------------------------
echo
echo "select-simulator tests: $PASSES passed, $FAILURES failed"
[ "$FAILURES" -eq 0 ]
