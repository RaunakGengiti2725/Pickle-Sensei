#!/usr/bin/env bash
# Adjudication repro: tools/macos-ci/select-simulator.sh never selects an
# existing simulator. The python body inside pick() is a bash single-quoted
# string, and the f-string `{'.'.join(...)}` contains single quotes that
# terminate it, so python sees `{..join(...)}` and raises SyntaxError. The
# caller masks that with `UDID="$(pick || true)"` and falls through to
# `simctl create`, so every stage that calls the helper creates a NEW
# "PickleSensei-CI" simulator on the runner (never deleted).
#
# Runs on Linux with a fake `xcrun` that exposes ONE available, booted iPhone.
# Expected (fixed): prints FAKE-UDID-1 and never invokes `simctl create`.
# Observed (4d812e1a): SyntaxError, then `simctl create` is invoked.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
FAKE="$(mktemp -d)"
trap 'rm -rf "$FAKE"' EXIT
cat >"$FAKE/xcrun" <<'EOF'
#!/usr/bin/env bash
case "$*" in
  "simctl list devices available -j"|"simctl list devices -j")
    echo '{"devices":{"com.apple.CoreSimulator.SimRuntime.iOS-26-0":[{"isAvailable":true,"name":"iPhone 17 Pro","state":"Booted","udid":"FAKE-UDID-1"}]}}' ;;
  "simctl list runtimes -j")
    echo '{"runtimes":[{"isAvailable":true,"platform":"iOS","version":"26.0","identifier":"com.apple.CoreSimulator.SimRuntime.iOS-26-0"}]}' ;;
  "simctl list devicetypes -j")
    echo '{"devicetypes":[{"name":"iPhone 17 Pro","identifier":"com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro"}]}' ;;
  simctl\ create*) echo "CREATED-NEW-UDID"; echo "FAKE: simctl create invoked: $*" >&2 ;;
  *) echo "fake xcrun: unhandled $*" >&2; exit 1 ;;
esac
EOF
chmod +x "$FAKE/xcrun"

OUT="$(PATH="$FAKE:$PATH" bash "$ROOT/tools/macos-ci/select-simulator.sh" 2>"$FAKE/stderr")"
STATUS=$?
cat "$FAKE/stderr" >&2
echo "select-simulator.sh printed: '$OUT' (exit $STATUS)"
if grep -q "SyntaxError" "$FAKE/stderr" || grep -q "simctl create invoked" "$FAKE/stderr" || [ "$OUT" != "FAKE-UDID-1" ]; then
  echo "REPRODUCED: helper failed to select the existing booted iPhone and fell through to simctl create" >&2
  exit 1
fi
echo "OK: existing simulator selected without creating a new one"
