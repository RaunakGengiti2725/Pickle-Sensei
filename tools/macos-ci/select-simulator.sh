#!/usr/bin/env bash
# Pick (or create) an iPhone simulator on the self-hosted Mac and print its
# UDID on stdout. Everything else goes to stderr so callers can capture the
# UDID with $(...).
#
# Selection order: an available iPhone on the NEWEST installed iOS runtime,
# preferring an already-booted device, then "Pro" models, then by name. If no
# iOS runtime is installed at all, the script fails with the exact command
# needed to install one — it does NOT silently download ~8 GB onto the Mac.
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

pick() {
  xcrun simctl list devices available -j | python3 -c '
import json, sys
data = json.load(sys.stdin)["devices"]
candidates = []
for runtime, devices in data.items():
    if "SimRuntime.iOS-" not in runtime:
        continue
    version = tuple(int(p) for p in runtime.rsplit("iOS-", 1)[1].split("-"))
    for dev in devices:
        if not dev.get("isAvailable") or "iPhone" not in dev.get("name", ""):
            continue
        candidates.append((
            version,
            1 if dev.get("state") == "Booted" else 0,
            1 if "Pro" in dev["name"] else 0,
            dev["name"],
            dev["udid"],
        ))
candidates.sort(reverse=True)
if candidates:
    v, _, _, name, udid = candidates[0]
    ios = ".".join(str(p) for p in v)
    print(udid)
    print(f"selected simulator: {name} (iOS {ios}) {udid}", file=sys.stderr)
'
}

UDID="$(pick)"

if [ -z "$UDID" ]; then
  echo "no available iPhone simulator found; trying to create one" >&2
  RUNTIME="$(xcrun simctl list runtimes -j | python3 -c '
import json, sys
rts = [r for r in json.load(sys.stdin)["runtimes"] if r.get("isAvailable") and r.get("platform") == "iOS"]
rts.sort(key=lambda r: tuple(int(p) for p in r["version"].split(".")), reverse=True)
print(rts[0]["identifier"] if rts else "")
')"
  if [ -z "$RUNTIME" ]; then
    echo "::error::No iOS simulator runtime is installed in $(xcode-select -p)." >&2
    echo "Install one on the Mac with: xcodebuild -downloadPlatform iOS   (then re-run)" >&2
    exit 1
  fi
  DEVICE_TYPE="$(xcrun simctl list devicetypes -j | python3 -c '
import json, sys
types = [t for t in json.load(sys.stdin)["devicetypes"] if t["name"].startswith("iPhone")]
pro = [t for t in types if "Pro" in t["name"] and "Max" not in t["name"]]
chosen = (pro or types)[-1]
print(chosen["identifier"])
')"
  echo "creating simulator $CI_DEVICE_NAME ($DEVICE_TYPE on $RUNTIME)" >&2
  UDID="$(xcrun simctl create "$CI_DEVICE_NAME" "$DEVICE_TYPE" "$RUNTIME")"
fi

# Remove any other CI-created devices so repeated runs never accumulate them.
xcrun simctl list devices -j | python3 -c '
import json, sys
keep, name = sys.argv[1], sys.argv[2]
for devs in json.load(sys.stdin)["devices"].values():
    for d in devs:
        if d["name"] == name and d["udid"] != keep:
            print(d["udid"])
' "$UDID" "$CI_DEVICE_NAME" | while IFS= read -r stale; do
  [ -n "$stale" ] || continue
  echo "deleting stale simulator $CI_DEVICE_NAME $stale" >&2
  xcrun simctl shutdown "$stale" >/dev/null 2>&1 || true
  xcrun simctl delete "$stale" >&2 || true
done

if [ "$BOOT" = "1" ]; then
  STATE="$(xcrun simctl list devices -j | python3 -c '
import json, sys
udid = sys.argv[1]
for devs in json.load(sys.stdin)["devices"].values():
    for d in devs:
        if d["udid"] == udid:
            print(d["state"])
' "$UDID")"
  if [ "$STATE" != "Booted" ]; then
    echo "booting simulator $UDID" >&2
    xcrun simctl boot "$UDID" >&2
  fi
  xcrun simctl bootstatus "$UDID" -b >&2
fi

echo "$UDID"
