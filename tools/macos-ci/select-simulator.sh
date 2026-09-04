#!/usr/bin/env bash
# Pick (or create) an iPhone simulator on the self-hosted Mac and print its
# UDID on stdout. Everything else goes to stderr so callers can capture the
# UDID with $(...).
#
# Selection order: an available iPhone on the NEWEST installed iOS runtime,
# preferring an already-booted device, then "Pro" models, then by name. Devices
# are recognised by their device type (so a PickleSensei-CI simulator created
# by an earlier run is reused rather than duplicated); any other
# PickleSensei-CI simulators left behind are deleted. Only when no iPhone
# exists at all is one created: the newest non-Max "Pro" iPhone supported by
# the newest iOS runtime. If no iOS runtime is installed at all, the script
# fails with the exact command needed to install one — it does NOT silently
# download ~8 GB onto the Mac.
#
# A failure of `simctl list` or of the picker itself fails the step: the python
# programs live in quoted heredocs (never inline shell strings, whose bodies
# the shell would re-quote) and no failure is swallowed.
# Control-flow tests: scripts/tests/test_select_simulator.sh (fake xcrun).
#
# Usage: select-simulator.sh            # print UDID
#        select-simulator.sh --boot     # print UDID and make sure it is booted
set -euo pipefail

BOOT=0
CI_DEVICE_NAME="PickleSensei-CI"
for arg in "$@"; do
  case "$arg" in
    --boot) BOOT=1 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

WORK="$(mktemp -d "${TMPDIR:-/tmp}/select-simulator.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

xcrun simctl list devices available -j >"$WORK/available.json"
UDID="$(python3 - "$WORK/available.json" <<'PY'
import json
import re
import sys

with open(sys.argv[1], encoding="utf-8") as fh:
    try:
        data = json.load(fh)["devices"]
    except (ValueError, KeyError, TypeError) as exc:
        sys.exit(f"select-simulator: unusable `simctl list devices` output: {exc}")


def ios_version(runtime_id):
    # com.apple.CoreSimulator.SimRuntime.iOS-26-4 -> (26, 4)
    match = re.search(r"SimRuntime\.iOS-(\d+(?:-\d+)*)$", runtime_id)
    return tuple(int(p) for p in match.group(1).split("-")) if match else None


candidates = []
for runtime, devices in data.items():
    version = ios_version(runtime)
    if version is None:
        continue
    for dev in devices:
        if not dev.get("isAvailable"):
            continue
        name = dev.get("name", "")
        type_id = dev.get("deviceTypeIdentifier", "")
        # "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro" -> "iPhone 17 Pro";
        # fall back to the device name for simctl versions without the field.
        model = type_id.rsplit(".", 1)[-1].replace("-", " ") if type_id else name
        if not model.startswith("iPhone"):
            continue
        candidates.append((
            version,
            1 if dev.get("state") == "Booted" else 0,
            1 if "Pro" in model else 0,
            name,
            dev["udid"],
        ))
candidates.sort(reverse=True)
if candidates:
    version, _, _, name, udid = candidates[0]
    ios = ".".join(str(p) for p in version)
    print(udid)
    print(f"selected simulator: {name} (iOS {ios}) {udid}", file=sys.stderr)
PY
)"

if [ -z "$UDID" ]; then
  echo "no available iPhone simulator found; trying to create one" >&2
  xcrun simctl list runtimes -j >"$WORK/runtimes.json"
  RUNTIME="$(python3 - "$WORK/runtimes.json" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as fh:
    runtimes = json.load(fh)["runtimes"]
ios = [r for r in runtimes if r.get("isAvailable") and r.get("platform") == "iOS"]
ios.sort(key=lambda r: tuple(int(p) for p in r["version"].split(".")), reverse=True)
if ios:
    print(ios[0]["identifier"])
PY
)"
  if [ -z "$RUNTIME" ]; then
    echo "::error::No iOS simulator runtime is installed in $(xcode-select -p)." >&2
    echo "Install one on the Mac with: xcodebuild -downloadPlatform iOS   (then re-run)" >&2
    exit 1
  fi
  xcrun simctl list devicetypes -j >"$WORK/devicetypes.json"
  DEVICE_TYPE="$(python3 - "$WORK/runtimes.json" "$WORK/devicetypes.json" "$RUNTIME" <<'PY'
import json
import re
import sys

runtimes_path, devicetypes_path, runtime_id = sys.argv[1:4]
with open(runtimes_path, encoding="utf-8") as fh:
    runtime = next(r for r in json.load(fh)["runtimes"] if r["identifier"] == runtime_id)
with open(devicetypes_path, encoding="utf-8") as fh:
    devicetypes = json.load(fh)["devicetypes"]


def version_tuple(text):
    return tuple(int(p) for p in text.split("."))


def is_iphone(dt):
    return dt.get("productFamily") == "iPhone" or dt["name"].startswith("iPhone")


def supported(dt):
    supported_types = runtime.get("supportedDeviceTypes")
    if supported_types is not None:
        return any(s["identifier"] == dt["identifier"] for s in supported_types)
    rt_version = version_tuple(runtime["version"])
    low = version_tuple(dt.get("minRuntimeVersionString", "0.0.0"))
    high = version_tuple(dt.get("maxRuntimeVersionString", "65535.255.255"))
    return low <= rt_version <= high


def generation(dt):
    match = re.search(r"iPhone (\d+)", dt["name"])
    return int(match.group(1)) if match else 0


iphones = [dt for dt in devicetypes if is_iphone(dt) and supported(dt)]
if not iphones:
    sys.exit(f"select-simulator: no iPhone device type is supported by {runtime_id}")
iphones.sort(
    key=lambda dt: (
        1 if "Pro" in dt["name"] and "Max" not in dt["name"] else 0,
        generation(dt),
        dt["name"],
    ),
    reverse=True,
)
print(iphones[0]["identifier"])
PY
)"
  echo "creating simulator $CI_DEVICE_NAME ($DEVICE_TYPE on $RUNTIME)" >&2
  UDID="$(xcrun simctl create "$CI_DEVICE_NAME" "$DEVICE_TYPE" "$RUNTIME")"
fi

# Delete every other CI-created simulator so repeated runs never accumulate them.
xcrun simctl list devices -j >"$WORK/all.json"
python3 - "$WORK/all.json" "$UDID" "$CI_DEVICE_NAME" <<'PY' >"$WORK/stale.txt"
import json
import sys

path, keep, ci_name = sys.argv[1:4]
with open(path, encoding="utf-8") as fh:
    devices = json.load(fh)["devices"]
for group in devices.values():
    for dev in group:
        if dev.get("name") == ci_name and dev["udid"] != keep:
            print(dev["udid"], dev.get("state", "Shutdown"))
PY
while read -r stale state; do
  echo "deleting stale simulator $CI_DEVICE_NAME $stale ($state)" >&2
  if [ "$state" = "Booted" ]; then
    xcrun simctl shutdown "$stale" >&2
  fi
  if ! xcrun simctl delete "$stale" >&2; then
    echo "::warning::could not delete stale simulator $CI_DEVICE_NAME $stale" >&2
  fi
done <"$WORK/stale.txt"

if [ "$BOOT" = "1" ]; then
  xcrun simctl list devices -j >"$WORK/all.json"
  STATE="$(python3 - "$WORK/all.json" "$UDID" <<'PY'
import json
import sys

path, udid = sys.argv[1:3]
with open(path, encoding="utf-8") as fh:
    devices = json.load(fh)["devices"]
for group in devices.values():
    for dev in group:
        if dev["udid"] == udid:
            print(dev["state"])
PY
)"
  if [ "$STATE" != "Booted" ]; then
    echo "booting simulator $UDID" >&2
    xcrun simctl boot "$UDID" >&2
  fi
  xcrun simctl bootstatus "$UDID" -b >&2
fi

echo "$UDID"
