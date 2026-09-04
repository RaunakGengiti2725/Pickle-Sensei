#!/usr/bin/env bash
# Pick (or create) an iPhone simulator on the self-hosted Mac and print its
# UDID on stdout. Everything else goes to stderr so callers can capture the
# UDID with $(...).
#
# Selection order: an available iPhone on the NEWEST installed iOS runtime,
# preferring an already-booted device, then "Pro" models, then by name. If no
# iOS runtime is installed at all, the script fails with the exact command
# needed to install one — it does NOT silently download ~8 GB onto the Mac.
# A device is created (named PickleSensei-CI, newest Pro iPhone type) only
# when no iPhone exists; PickleSensei-CI devices left by earlier runs are
# deleted so they never accumulate. Any simctl/python failure fails the step.
#
# The python programs are quoted heredocs fed to `python3 -`, never
# `python3 -c '…'`: a quote inside the program would end the shell string early.
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

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

pick() {
  xcrun simctl list devices available -j >"$TMP/devices-available.json"
  python3 - "$TMP/devices-available.json" <<'PY'
import json, sys

with open(sys.argv[1], encoding="utf-8") as fh:
    data = json.load(fh)["devices"]
candidates = []
for runtime, devices in data.items():
    if "SimRuntime.iOS-" not in runtime:
        continue
    version = tuple(int(p) for p in runtime.rsplit("iOS-", 1)[1].split("-"))
    for dev in devices:
        # The model comes from the device type, not the user-chosen name
        # (a device created as "PickleSensei-CI" is still an iPhone).
        model = dev.get("deviceTypeIdentifier", "").rsplit(".", 1)[-1].replace("-", " ") or dev.get("name", "")
        if not dev.get("isAvailable") or "iPhone" not in model:
            continue
        candidates.append((
            version,
            1 if dev.get("state") == "Booted" else 0,
            1 if "Pro" in model else 0,
            model,
            dev["name"],
            dev["udid"],
        ))
candidates.sort(reverse=True)
if candidates:
    v, _, _, model, name, udid = candidates[0]
    ios = ".".join(str(p) for p in v)
    label = name if name == model else f"{name} [{model}]"
    print(udid)
    print(f"selected simulator: {label} (iOS {ios}) {udid}", file=sys.stderr)
PY
}

UDID="$(pick)"

if [ -z "$UDID" ]; then
  echo "no available iPhone simulator found; trying to create one" >&2
  xcrun simctl list runtimes -j >"$TMP/runtimes.json"
  RUNTIME="$(python3 - "$TMP/runtimes.json" <<'PY'
import json, sys

with open(sys.argv[1], encoding="utf-8") as fh:
    rts = [r for r in json.load(fh)["runtimes"] if r.get("isAvailable") and r.get("platform") == "iOS"]
rts.sort(key=lambda r: tuple(int(p) for p in r["version"].split(".")), reverse=True)
print(rts[0]["identifier"] if rts else "")
PY
)"
  if [ -z "$RUNTIME" ]; then
    echo "::error::No iOS simulator runtime is installed in $(xcode-select -p)." >&2
    echo "Install one on the Mac with: xcodebuild -downloadPlatform iOS   (then re-run)" >&2
    exit 1
  fi
  xcrun simctl list devicetypes -j >"$TMP/devicetypes.json"
  DEVICE_TYPE="$(python3 - "$TMP/devicetypes.json" <<'PY'
import json, re, sys

with open(sys.argv[1], encoding="utf-8") as fh:
    types = [t for t in json.load(fh)["devicetypes"] if t["name"].startswith("iPhone")]
if not types:
    sys.exit("no iPhone device type available")

def rank(t):
    # simctl lists device types in no useful order; rank by the model
    # generation in the name so the NEWEST Pro (non-Max) wins.
    name = t["name"]
    m = re.search(r"iPhone\s+(\d+)", name)
    generation = int(m.group(1)) if m else -1
    return ("Pro" in name, generation, "Max" not in name, name)

print(max(types, key=rank)["identifier"])
PY
)"
  echo "creating simulator $CI_DEVICE_NAME ($DEVICE_TYPE on $RUNTIME)" >&2
  UDID="$(xcrun simctl create "$CI_DEVICE_NAME" "$DEVICE_TYPE" "$RUNTIME")"
fi

# Remove every other CI-created device so repeated runs never accumulate them.
xcrun simctl list devices -j >"$TMP/devices-all.json"
python3 - "$TMP/devices-all.json" "$UDID" "$CI_DEVICE_NAME" <<'PY' >"$TMP/stale.txt"
import json, sys

path, keep, name = sys.argv[1:4]
with open(path, encoding="utf-8") as fh:
    for devs in json.load(fh)["devices"].values():
        for d in devs:
            if d["name"] == name and d["udid"] != keep:
                print(d["udid"], d.get("state", ""))
PY
while read -r stale state; do
  [ -n "$stale" ] || continue
  echo "deleting stale simulator $CI_DEVICE_NAME $stale ($state)" >&2
  if [ "$state" = "Booted" ]; then
    xcrun simctl shutdown "$stale" >&2
  fi
  xcrun simctl delete "$stale" >&2
done <"$TMP/stale.txt"

if [ "$BOOT" = "1" ]; then
  xcrun simctl list devices -j >"$TMP/devices-boot.json"
  STATE="$(python3 - "$TMP/devices-boot.json" "$UDID" <<'PY'
import json, sys

path, udid = sys.argv[1:3]
with open(path, encoding="utf-8") as fh:
    for devs in json.load(fh)["devices"].values():
        for d in devs:
            if d["udid"] == udid:
                print(d["state"])
PY
)"
  if [ "$STATE" != "Booted" ]; then
    echo "booting simulator $UDID" >&2
    xcrun simctl boot "$UDID" >&2
  fi
  xcrun simctl bootstatus "$UDID" -b >&2
fi

echo "$UDID"
