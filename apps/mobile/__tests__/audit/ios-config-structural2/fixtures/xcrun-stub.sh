#!/usr/bin/env bash
# Stand-in for `xcrun` so tools/macos-ci/select-simulator.sh can be exercised
# on Linux. Serves the fixture device list and records every `simctl create`
# so the probe can prove whether the picker fell through to creating a new
# device although an available iPhone exists.
set -euo pipefail
here="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
case "$*" in
  "simctl list devices available -j"|"simctl list devices -j")
    cat "$here/simctl-devices.json" ;;
  "simctl list runtimes -j")
    echo '{"runtimes":[{"identifier":"com.apple.CoreSimulator.SimRuntime.iOS-26-4","isAvailable":true,"platform":"iOS","version":"26.4"}]}' ;;
  "simctl list devicetypes -j")
    echo '{"devicetypes":[{"identifier":"com.apple.CoreSimulator.SimDeviceType.iPhone-11-Pro","name":"iPhone 11 Pro"},{"identifier":"com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro","name":"iPhone 17 Pro"}]}' ;;
  "simctl create "*)
    echo "$*" >> "${XCRUN_STUB_LOG:?}"
    echo "FIXTURE-NEWLY-CREATED-DEVICE" ;;
  *)
    echo "xcrun-stub: unexpected invocation: $*" >&2
    exit 97 ;;
esac
