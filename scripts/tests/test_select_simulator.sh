#!/usr/bin/env bash
# Regression test for tools/macos-ci/select-simulator.sh, runnable on Linux.
#
# A fake `xcrun` (and `xcode-select`) is placed first on PATH; every simctl
# call it receives is appended to a log so the assertions can check exactly
# which devices the script created, deleted or booted. The fixtures below
# model `simctl list … -j` output.
#
# Pinned behaviour:
#   1. one available Booted iPhone → its UDID on stdout, exit 0, stderr says
#      'selected simulator:', no SyntaxError, nothing created
#   2. invalid JSON from simctl → non-zero exit, nothing created (a picker
#      failure fails the step instead of falling through to `create`)
#   3. bash -n passes and every embedded python program (heredoc `<<'PY'`)
#      compiles with python3 -m py_compile
#   4. ordering: newest iOS runtime first, then Booted, then "Pro", then name
#   5. the create fallback runs only when no device exists and picks the
#      NEWEST Pro device type (not the last one simctl happens to list)
#   6. stale PickleSensei-CI devices from earlier runs are deleted, the
#      selected device is kept
#   7. --boot boots a Shutdown device and waits; a Booted one is not re-booted
#
#   scripts/tests/test_select_simulator.sh
# Exit 0 = all assertions hold; 1 = regression; 2 = setup failure.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="$REPO_ROOT/tools/macos-ci/select-simulator.sh"

log() { printf '[test_select_simulator] %s\n' "$*" >&2; }
die() {
  log "SETUP ERROR: $*"
  exit 2
}

[ -f "$SCRIPT" ] || die "missing $SCRIPT"
command -v python3 >/dev/null 2>&1 || die "python3 required"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
FAKE_BIN="$WORK/bin"
FIX="$WORK/fixtures"
mkdir -p "$FAKE_BIN" "$FIX"
export FAKE_SIMCTL_FIXTURES="$FIX"
export FAKE_SIMCTL_LOG="$WORK/simctl.log"

cat >"$FAKE_BIN/xcrun" <<'EOF'
#!/usr/bin/env bash
# Fake xcrun: answers `simctl list <kind> [available] -j` from fixture files
# and records every other simctl call. Unknown commands fail loudly.
set -uo pipefail
printf '%s\n' "$*" >>"$FAKE_SIMCTL_LOG"
[ "${1:-}" = "simctl" ] || { echo "fake xcrun: unsupported tool: $*" >&2; exit 97; }
shift
case "${1:-}" in
  list)
    shift
    kind="${1:-}"; shift
    avail=""
    [ "${1:-}" = "available" ] && { avail="-available"; shift; }
    [ "${1:-}" = "-j" ] || { echo "fake xcrun: expected -j: $*" >&2; exit 97; }
    f="$FAKE_SIMCTL_FIXTURES/$kind$avail.json"
    [ -f "$f" ] || f="$FAKE_SIMCTL_FIXTURES/$kind.json"
    [ -f "$f" ] || { echo "fake xcrun: no fixture for simctl list $kind" >&2; exit 98; }
    cat "$f"
    ;;
  create)
    # create <name> <device type> <runtime> → prints the new UDID
    echo "CREATED-${2//[^A-Za-z0-9]/-}"
    ;;
  delete|shutdown|boot|bootstatus)
    ;;
  *)
    echo "fake xcrun: unsupported simctl command: $*" >&2
    exit 97
    ;;
esac
EOF
cat >"$FAKE_BIN/xcode-select" <<'EOF'
#!/usr/bin/env bash
echo /Applications/Xcode.app/Contents/Developer
EOF
chmod +x "$FAKE_BIN/xcrun" "$FAKE_BIN/xcode-select"

# ---------------------------------------------------------------- fixtures --
RT26="com.apple.CoreSimulator.SimRuntime.iOS-26-4"
RT18="com.apple.CoreSimulator.SimRuntime.iOS-18-5"
RTTV="com.apple.CoreSimulator.SimRuntime.tvOS-26-0"

dev() {
  # dev <name> <udid> <state> [isAvailable] [device type name]
  # A CI-created device is named PickleSensei-CI but its device type is still
  # an iPhone — the picker must recognise it by type, not by name.
  local type="${5:-$1}"
  [ "$1" = "PickleSensei-CI" ] && type="${5:-iPhone 16 Pro}"
  printf '{"name": "%s", "udid": "%s", "state": "%s", "isAvailable": %s, "deviceTypeIdentifier": "com.apple.CoreSimulator.SimDeviceType.%s"}' \
    "$1" "$2" "$3" "${4:-true}" "${type// /-}"
}

write_devices() {
  # write_devices <json body of "devices"> → both the `available` and the full listing
  printf '{"devices": {%s}}\n' "$1" >"$FIX/devices-available.json"
  cp "$FIX/devices-available.json" "$FIX/devices.json"
}

RUNTIMES='{"runtimes": [
  {"identifier": "'"$RT18"'", "platform": "iOS", "version": "18.5", "isAvailable": true},
  {"identifier": "'"$RT26"'", "platform": "iOS", "version": "26.4", "isAvailable": true},
  {"identifier": "'"$RTTV"'", "platform": "tvOS", "version": "26.0", "isAvailable": true}
]}'
# Deliberately NOT in chronological order: the real Mac listed iPhone 11 Pro
# last among the Pro models, which is what `(pro or types)[-1]` returned.
DEVICETYPES='{"devicetypes": [
  {"name": "iPhone 16", "identifier": "com.apple.CoreSimulator.SimDeviceType.iPhone-16", "productFamily": "iPhone"},
  {"name": "iPhone 17", "identifier": "com.apple.CoreSimulator.SimDeviceType.iPhone-17", "productFamily": "iPhone"},
  {"name": "iPhone 16 Pro Max", "identifier": "com.apple.CoreSimulator.SimDeviceType.iPhone-16-Pro-Max", "productFamily": "iPhone"},
  {"name": "iPhone 16 Pro", "identifier": "com.apple.CoreSimulator.SimDeviceType.iPhone-16-Pro", "productFamily": "iPhone"},
  {"name": "iPad Pro 13-inch (M4)", "identifier": "com.apple.CoreSimulator.SimDeviceType.iPad-Pro-13-inch-M4", "productFamily": "iPad"},
  {"name": "iPhone 8", "identifier": "com.apple.CoreSimulator.SimDeviceType.iPhone-8", "productFamily": "iPhone"},
  {"name": "iPhone 11 Pro", "identifier": "com.apple.CoreSimulator.SimDeviceType.iPhone-11-Pro", "productFamily": "iPhone"}
]}'

# ------------------------------------------------------------------ harness --
fail=0
RC=0
OUT=""
ERR=""

run_script() {
  # run_script [args…] → RC, OUT (stdout), ERR (stderr); resets the simctl log
  : >"$FAKE_SIMCTL_LOG"
  RC=0
  PATH="$FAKE_BIN:$PATH" "$SCRIPT" "$@" >"$WORK/out" 2>"$WORK/err" || RC=$?
  OUT="$(cat "$WORK/out")"
  ERR="$(cat "$WORK/err")"
}

pass() { log "PASS: $*"; }
flunk() {
  log "FAIL: $*"
  log "  exit=$RC stdout=[$OUT]"
  sed 's/^/  stderr: /' "$WORK/err" >&2
  sed 's/^/  simctl: /' "$FAKE_SIMCTL_LOG" >&2
  fail=1
}
simctl_called() { grep -qE "$1" "$FAKE_SIMCTL_LOG"; }

# 1. One available Booted iPhone → selected, nothing created.
write_devices "\"$RT26\": [$(dev 'iPhone 16 Pro' AAAA-1111 Booted)]"
printf '%s\n' "$RUNTIMES" >"$FIX/runtimes.json"
printf '%s\n' "$DEVICETYPES" >"$FIX/devicetypes.json"
run_script
if [ "$RC" = 0 ] && [ "$OUT" = "AAAA-1111" ] \
  && grep -q 'selected simulator: iPhone 16 Pro (iOS 26.4) AAAA-1111' "$WORK/err" \
  && ! grep -q 'SyntaxError' "$WORK/err" && ! grep -q 'creating simulator' "$WORK/err" \
  && ! simctl_called '^simctl create '; then
  pass "single booted iPhone is selected without creating anything"
else
  flunk "single booted iPhone: expected UDID AAAA-1111, exit 0, 'selected simulator:' on stderr"
fi

# 2. Invalid JSON from simctl → the picker failure fails the step.
printf 'not json\n' >"$FIX/devices-available.json"
run_script
if [ "$RC" != 0 ] && [ -z "$OUT" ] && ! simctl_called '^simctl create '; then
  pass "invalid simctl JSON exits non-zero (exit $RC) without creating a device"
else
  flunk "invalid simctl JSON must exit non-zero and never reach the create fallback"
fi

# 3. Syntax: bash -n and every embedded python heredoc compiles.
if bash -n "$SCRIPT"; then
  pass "bash -n"
else
  RC=$?; flunk "bash -n failed"
fi
heredocs=0
i=0
while IFS= read -r body_file; do
  heredocs=$((heredocs + 1))
  i=$((i + 1))
  if python3 -m py_compile "$body_file" 2>"$WORK/pyc.err"; then
    pass "embedded python program #$i compiles"
  else
    RC=1; cat "$WORK/pyc.err" >&2; flunk "embedded python program #$i does not compile ($body_file)"
  fi
done < <(awk -v dir="$WORK" '
  inblock && /^PY$/ { inblock = 0; close(f); print f; next }
  inblock { print > f; next }
  !/^[[:space:]]*#/ && /<<'\''PY'\''/ { n++; f = dir "/embedded-" n ".py"; inblock = 1 }
  END { if (inblock) { print "unterminated PY heredoc" > "/dev/stderr"; exit 1 } }
' "$SCRIPT")
if [ "$heredocs" -ge 3 ]; then
  pass "python programs live in <<'PY' heredocs ($heredocs found)"
else
  RC=1; flunk "expected the python programs as <<'PY' heredocs (found $heredocs) — python3 -c '…' quoting is what broke the picker"
fi
if grep -q '|| true' "$SCRIPT"; then
  RC=1; flunk "select-simulator.sh must not mask failures with '|| true'"
else
  pass "no '|| true' in select-simulator.sh"
fi

# 4. Ordering: newest runtime, then Booted, then Pro, then name.
write_devices "\"$RT18\": [$(dev 'iPhone 15 Pro' OLD-BOOTED Booted)],
  \"$RT26\": [$(dev 'iPhone 16 Pro Max' NEW-PROMAX Shutdown), $(dev 'iPhone 16' NEW-PLAIN Booted), $(dev 'iPhone 16 Pro' NEW-PRO Shutdown), $(dev 'iPhone 16e' NEW-UNAVAIL Shutdown false)],
  \"$RTTV\": [$(dev 'Apple TV' TV-1 Booted)]"
run_script
if [ "$RC" = 0 ] && [ "$OUT" = "NEW-PLAIN" ]; then
  pass "newest runtime wins over an older booted device; booted wins within the runtime"
else
  flunk "ordering: expected NEW-PLAIN (booted iPhone 16 on iOS 26.4)"
fi
write_devices "\"$RT26\": [$(dev 'iPhone 16 Pro Max' NEW-PROMAX Shutdown), $(dev 'iPhone 16' NEW-PLAIN Shutdown), $(dev 'iPhone 16 Pro' NEW-PRO Shutdown)]"
run_script
if [ "$RC" = 0 ] && [ "$OUT" = "NEW-PROMAX" ]; then
  pass "with nothing booted a Pro model is preferred (then by name)"
else
  flunk "ordering: expected NEW-PROMAX"
fi

# 5. Create fallback only when there is no device, choosing the newest Pro type.
write_devices "\"$RT26\": [], \"$RTTV\": [$(dev 'Apple TV' TV-1 Booted)]"
run_script
if [ "$RC" = 0 ] && [ "$OUT" = "CREATED-PickleSensei-CI" ] \
  && simctl_called "^simctl create PickleSensei-CI com.apple.CoreSimulator.SimDeviceType.iPhone-16-Pro $RT26$" \
  && grep -q 'creating simulator PickleSensei-CI' "$WORK/err"; then
  pass "no iPhone → creates PickleSensei-CI as the newest Pro type on the newest iOS runtime"
else
  flunk "create fallback: expected 'simctl create PickleSensei-CI …iPhone-16-Pro $RT26'"
fi
printf '{"runtimes": []}\n' >"$FIX/runtimes.json"
run_script
if [ "$RC" != 0 ] && grep -q 'xcodebuild -downloadPlatform iOS' "$WORK/err" && ! simctl_called '^simctl create '; then
  pass "no iOS runtime → fails with the install instruction instead of creating"
else
  flunk "no iOS runtime must fail with the downloadPlatform hint"
fi
printf '%s\n' "$RUNTIMES" >"$FIX/runtimes.json"

# 6. Stale PickleSensei-CI devices are deleted, the selected one is kept.
write_devices "\"$RT26\": [$(dev 'iPhone 16 Pro' KEEP-1 Booted)],
  \"$RT18\": [$(dev 'PickleSensei-CI' STALE-A Shutdown), $(dev 'PickleSensei-CI' STALE-B Booted)]"
printf '{"devices": {"%s": [%s], "%s": [%s, %s, %s]}}\n' \
  "$RT26" "$(dev 'iPhone 16 Pro' KEEP-1 Booted)" \
  "$RT18" "$(dev 'PickleSensei-CI' STALE-A Shutdown)" "$(dev 'PickleSensei-CI' STALE-B Booted)" \
  "$(dev 'PickleSensei-CI' STALE-C Shutdown false)" >"$FIX/devices.json"
run_script
if [ "$RC" = 0 ] && [ "$OUT" = "KEEP-1" ] \
  && simctl_called '^simctl delete STALE-A$' && simctl_called '^simctl delete STALE-B$' && simctl_called '^simctl delete STALE-C$' \
  && simctl_called '^simctl shutdown STALE-B$' && ! simctl_called '^simctl shutdown STALE-A$' \
  && ! simctl_called '^simctl delete KEEP-1$' && ! simctl_called '^simctl shutdown KEEP-1$'; then
  pass "stale PickleSensei-CI devices (incl. unavailable) are shut down if booted and deleted; selection kept"
else
  flunk "stale cleanup: expected delete STALE-A/B/C, shutdown STALE-B only, KEEP-1 untouched"
fi
# …and a PickleSensei-CI device that IS the selection survives.
write_devices "\"$RT26\": [$(dev 'PickleSensei-CI' CI-KEEP Booted), $(dev 'PickleSensei-CI' CI-STALE Shutdown)]"
run_script
if [ "$RC" = 0 ] && [ "$OUT" = "CI-KEEP" ] && simctl_called '^simctl delete CI-STALE$' && ! simctl_called '^simctl delete CI-KEEP$' \
  && ! simctl_called '^simctl create ' && grep -q 'selected simulator: PickleSensei-CI \[iPhone 16 Pro\] (iOS 26.4) CI-KEEP' "$WORK/err"; then
  pass "a PickleSensei-CI device (an iPhone by type) is picked, not re-created; its duplicates are deleted"
else
  flunk "stale cleanup: expected CI-KEEP picked (no create) and CI-STALE deleted"
fi

# 7. --boot
write_devices "\"$RT26\": [$(dev 'iPhone 16 Pro' SHUT-1 Shutdown)]"
run_script --boot
if [ "$RC" = 0 ] && [ "$OUT" = "SHUT-1" ] && simctl_called '^simctl boot SHUT-1$' && simctl_called '^simctl bootstatus SHUT-1 -b$'; then
  pass "--boot boots a Shutdown device and waits for bootstatus"
else
  flunk "--boot: expected 'simctl boot SHUT-1' then 'simctl bootstatus SHUT-1 -b'"
fi
write_devices "\"$RT26\": [$(dev 'iPhone 16 Pro' BOOTED-1 Booted)]"
run_script --boot
if [ "$RC" = 0 ] && [ "$OUT" = "BOOTED-1" ] && ! simctl_called '^simctl boot ' && simctl_called '^simctl bootstatus BOOTED-1 -b$'; then
  pass "--boot leaves an already Booted device alone"
else
  flunk "--boot: a Booted device must not be booted again"
fi
run_script --bogus
if [ "$RC" = 2 ] && grep -q 'unknown argument' "$WORK/err"; then
  pass "unknown argument exits 2"
else
  flunk "unknown argument must exit 2"
fi

if [ "$fail" = 0 ]; then
  log "PASS: select-simulator.sh picks, creates, cleans up and boots as specified"
else
  log "FAIL: select-simulator.sh regression"
fi
exit "$fail"
