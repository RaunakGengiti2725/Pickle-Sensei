#!/usr/bin/env bash
# Linux-runnable harness for tools/macos-ci/select-simulator.sh.
#
# Stubs `xcrun simctl` with a Mac-shaped JSON payload that contains ONE
# available, already-booted iPhone and asserts that select-simulator.sh
# returns that device's UDID without calling `simctl create`.
#
# Usage: tools/macos-ci/tests/select-simulator-repro.sh   # exit 0 = pass
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$HERE/../select-simulator.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/bin"

cat > "$WORK/bin/xcrun" <<'EOF'
#!/usr/bin/env bash
echo "xcrun $*" >> "$(dirname "$0")/../xcrun-calls.log"
case "$*" in
  "simctl list devices available -j"|"simctl list devices -j")
    echo '{"devices":{"com.apple.CoreSimulator.SimRuntime.iOS-26-4":[{"isAvailable":true,"name":"iPhone 17 Pro","udid":"EXISTING-BOOTED-UDID","state":"Booted"}]}}' ;;
  "simctl list runtimes -j")
    echo '{"runtimes":[{"isAvailable":true,"platform":"iOS","version":"26.4","identifier":"com.apple.CoreSimulator.SimRuntime.iOS-26-4"}]}' ;;
  "simctl list devicetypes -j")
    echo '{"devicetypes":[{"name":"iPhone 11 Pro","identifier":"com.apple.CoreSimulator.SimDeviceType.iPhone-11-Pro"}]}' ;;
  simctl\ create*)
    echo "NEWLY-CREATED-UDID" ;;
  *) exit 0 ;;
esac
EOF
chmod +x "$WORK/bin/xcrun"

UDID="$(PATH="$WORK/bin:$PATH" bash "$SCRIPT" 2> "$WORK/stderr.txt")"
status=$?

echo "--- select-simulator.sh stderr:"
cat "$WORK/stderr.txt"
echo "--- xcrun calls:"
cat "$WORK/xcrun-calls.log" 2>/dev/null || true
echo "--- returned UDID: ${UDID:-<empty>} (exit $status)"

fail=0
if grep -q "SyntaxError" "$WORK/stderr.txt"; then
  echo "FAIL: embedded python raised SyntaxError (quoting bug in pick())"
  fail=1
fi
if [ "$UDID" != "EXISTING-BOOTED-UDID" ]; then
  echo "FAIL: expected the existing booted iPhone to be selected, got '${UDID:-<empty>}'"
  fail=1
fi
if grep -q "simctl create" "$WORK/xcrun-calls.log" 2>/dev/null; then
  echo "FAIL: a new simulator was created although one was available"
  fail=1
fi
if [ "$fail" = "0" ]; then
  echo "PASS: existing simulator selected, no SyntaxError, no simctl create"
fi
exit "$fail"
