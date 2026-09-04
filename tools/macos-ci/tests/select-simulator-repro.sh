#!/usr/bin/env bash
# Adjudication reproduction — area `mobile-ios-config`, finding IOSCFG-6.
#
# tools/macos-ci/select-simulator.sh embeds a python3 -c program in SINGLE
# quotes, and that program contains `'.'.join(...)` — the inner quotes end the
# shell string, python receives a truncated f-string and dies with
# "SyntaxError: f-string: expecting a valid expression after '{'". Because the
# caller does `UDID="$(pick || true)"`, the error is swallowed, the script
# decides "no available iPhone simulator found" and CREATES a new simulator on
# every run (observed in the same-SHA Mac artifact of run 33841813597).
#
# Linux-runnable: fakes `xcrun simctl` with a stub that advertises one booted
# iPhone. Expected behaviour: the script prints that UDID and never calls
# `simctl create`. Exits 1 at 4d812e1a.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
SCRIPT="${SELECT_SIMULATOR_SH:-$ROOT/tools/macos-ci/select-simulator.sh}"
STUB="$(mktemp -d "${TMPDIR:-/tmp}/simctl-stub.XXXXXX")"
trap 'rm -rf "$STUB"' EXIT
mkdir -p "$STUB/bin"
CALLS="$STUB/xcrun-calls.log"
: >"$CALLS"

cat >"$STUB/bin/xcrun" <<EOF
#!/usr/bin/env bash
echo "\$*" >>"$CALLS"
case "\$*" in
  "simctl list devices available -j")
    cat <<'JSON'
{"devices":{"com.apple.CoreSimulator.SimRuntime.iOS-18-2":[
  {"udid":"AAAA-BOOTED-IPHONE","name":"iPhone 16","state":"Booted","isAvailable":true,"deviceTypeIdentifier":"com.apple.CoreSimulator.SimDeviceType.iPhone-16"},
  {"udid":"BBBB-SHUTDOWN-IPHONE","name":"iPhone 16 Pro","state":"Shutdown","isAvailable":true,"deviceTypeIdentifier":"com.apple.CoreSimulator.SimDeviceType.iPhone-16-Pro"}]}}
JSON
    ;;
  "simctl list runtimes -j")
    echo '{"runtimes":[{"identifier":"com.apple.CoreSimulator.SimRuntime.iOS-18-2","isAvailable":true,"platform":"iOS","version":"18.2","name":"iOS 18.2"}]}' ;;
  "simctl list devicetypes -j")
    echo '{"devicetypes":[{"identifier":"com.apple.CoreSimulator.SimDeviceType.iPhone-16","name":"iPhone 16","productFamily":"iPhone"}]}' ;;
  "simctl list devices -j")
    echo '{"devices":{"com.apple.CoreSimulator.SimRuntime.iOS-18-2":[{"udid":"AAAA-BOOTED-IPHONE","state":"Booted"},{"udid":"CCCC-NEWLY-CREATED","state":"Booted"}]}}' ;;
  simctl\ create*) echo "CCCC-NEWLY-CREATED" ;;
  simctl\ boot*) ;;
  *) echo "stub xcrun: unexpected: \$*" >&2; exit 97 ;;
esac
EOF
chmod +x "$STUB/bin/xcrun"
printf '#!/usr/bin/env bash\necho /Applications/Xcode.app/Contents/Developer\n' >"$STUB/bin/xcode-select"
chmod +x "$STUB/bin/xcode-select"

OUT="$STUB/stdout"; ERR="$STUB/stderr"
PATH="$STUB/bin:$PATH" bash "$SCRIPT" >"$OUT" 2>"$ERR"
status=$?

echo "--- select-simulator.sh exit=$status"
echo "--- stdout"; cat "$OUT"
echo "--- stderr"; cat "$ERR"
echo "--- xcrun calls"; cat "$CALLS"

fail=0
if grep -q 'SyntaxError' "$ERR"; then echo "FAIL: embedded python did not parse"; fail=1; fi
if grep -q '^simctl create' "$CALLS"; then echo "FAIL: created a simulator although an available iPhone existed"; fail=1; fi
if [ "$(tail -n1 "$OUT")" != "AAAA-BOOTED-IPHONE" ]; then echo "FAIL: expected the booted iPhone UDID on stdout, got '$(tail -n1 "$OUT")'"; fail=1; fi
[ "$status" -eq 0 ] || { echo "FAIL: non-zero exit"; fail=1; }
[ "$fail" -eq 0 ] && echo "PASS: reused the available booted iPhone"
exit "$fail"
