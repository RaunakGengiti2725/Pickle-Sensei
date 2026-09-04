#!/usr/bin/env bash
# Pick (or create) an iPhone simulator on the self-hosted Mac and print its
# UDID on stdout. Everything else goes to stderr so callers can capture the
# UDID with $(...).
#
# Selection order: an available iPhone (by device type or name) on the NEWEST
# installed iOS runtime, preferring stock devices over the CI-created one, then
# an already-booted device, then "Pro" models, then by name. Only when
# no available iPhone exists at all is ONE simulator named PickleSensei-CI
# created (newest Pro non-Max iPhone type on the newest iOS runtime); it is an
# iPhone device type, so later runs select it again instead of creating more.
# Any other PickleSensei-CI simulator left behind (stale runtime, earlier
# tooling) is shut down and deleted so the runner never accumulates them.
# If no iOS runtime is installed at all, the script fails with the exact
# command needed to install one — it does NOT silently download ~8 GB onto the
# Mac. A failure to list or parse simulators aborts the script; it never falls
# through to creating a device.
#
# Usage: select-simulator.sh            # print UDID
#        select-simulator.sh --boot     # print UDID and make sure it is booted
set -euo pipefail

CI_DEVICE_NAME="PickleSensei-CI"

BOOT=0
for arg in "$@"; do
  case "$arg" in
    --boot) BOOT=1 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

# The python programs are quoted heredocs (never bash single-quoted strings, so
# they may contain any quoting) and read the simctl JSON on stdin.
PICK_PY=$(cat <<'PY'
import json, sys
ci_name = sys.argv[1]
try:
    data = json.load(sys.stdin)["devices"]
except (ValueError, KeyError) as exc:
    print(f"select-simulator: cannot parse `xcrun simctl list devices available -j` output: {exc}", file=sys.stderr)
    sys.exit(1)
candidates = []
for runtime, devices in data.items():
    if "SimRuntime.iOS-" not in runtime:
        continue
    version = tuple(int(p) for p in runtime.rsplit("iOS-", 1)[1].split("-"))
    for dev in devices:
        name = dev.get("name", "")
        is_iphone = "iPhone" in dev.get("deviceTypeIdentifier", "") or "iPhone" in name
        if not dev.get("isAvailable") or not is_iphone:
            continue
        candidates.append((
            version,
            0 if name == ci_name else 1,
            1 if dev.get("state") == "Booted" else 0,
            1 if "Pro" in name else 0,
            name,
            dev["udid"],
        ))
candidates.sort(reverse=True)
if candidates:
    v, _, _, _, name, udid = candidates[0]
    print(udid)
    print(f"selected simulator: {name} (iOS {'.'.join(map(str, v))}) {udid}", file=sys.stderr)
PY
)

RUNTIME_PY=$(cat <<'PY'
import json, sys
rts = [r for r in json.load(sys.stdin)["runtimes"] if r.get("isAvailable") and r.get("platform") == "iOS"]
rts.sort(key=lambda r: tuple(int(p) for p in r["version"].split(".")), reverse=True)
print(rts[0]["identifier"] if rts else "")
PY
)

# Newest iPhone model number wins; among equal models prefer "Pro" but not "Pro Max".
DEVICE_TYPE_PY=$(cat <<'PY'
import json, re, sys
types = [t for t in json.load(sys.stdin)["devicetypes"] if t["name"].startswith("iPhone")]
def rank(t):
    m = re.search(r"\d+", t["name"])
    model = int(m.group(0)) if m else 0
    pro = 1 if "Pro" in t["name"] and "Max" not in t["name"] else 0
    return (model, pro, t["name"])
types.sort(key=rank, reverse=True)
print(types[0]["identifier"] if types else "")
PY
)

# Prints "<udid> <state>" for every device named argv[1] except argv[2].
LEFTOVERS_PY=$(cat <<'PY'
import json, sys
name, keep = sys.argv[1], sys.argv[2]
for devs in json.load(sys.stdin)["devices"].values():
    for d in devs:
        if d.get("name") == name and d.get("udid") != keep:
            print(d["udid"], d.get("state", "unknown"))
PY
)

STATE_PY=$(cat <<'PY'
import json, sys
udid = sys.argv[1]
for devs in json.load(sys.stdin)["devices"].values():
    for d in devs:
        if d["udid"] == udid:
            print(d["state"])
PY
)

pick() {
  xcrun simctl list devices available -j | python3 -c "$PICK_PY" "$CI_DEVICE_NAME"
}

if ! UDID="$(pick)"; then
  echo "::error::select-simulator: could not enumerate simulators (xcrun simctl list devices available -j failed)" >&2
  exit 1
fi

if [ -z "$UDID" ]; then
  echo "no available iPhone simulator found; trying to create one" >&2
  RUNTIME="$(xcrun simctl list runtimes -j | python3 -c "$RUNTIME_PY")"
  if [ -z "$RUNTIME" ]; then
    echo "::error::No iOS simulator runtime is installed in $(xcode-select -p)." >&2
    echo "Install one on the Mac with: xcodebuild -downloadPlatform iOS   (then re-run)" >&2
    exit 1
  fi
  DEVICE_TYPE="$(xcrun simctl list devicetypes -j | python3 -c "$DEVICE_TYPE_PY")"
  if [ -z "$DEVICE_TYPE" ]; then
    echo "::error::No iPhone simulator device type is known to xcrun simctl." >&2
    exit 1
  fi
  echo "creating simulator $CI_DEVICE_NAME ($DEVICE_TYPE on $RUNTIME)" >&2
  UDID="$(xcrun simctl create "$CI_DEVICE_NAME" "$DEVICE_TYPE" "$RUNTIME")"
fi

# Housekeeping: at most one PickleSensei-CI simulator may exist on the runner.
LEFTOVERS="$(xcrun simctl list devices -j | python3 -c "$LEFTOVERS_PY" "$CI_DEVICE_NAME" "$UDID")"
while read -r leftover_udid leftover_state; do
  [ -n "$leftover_udid" ] || continue
  echo "removing leftover $CI_DEVICE_NAME simulator $leftover_udid ($leftover_state)" >&2
  if [ "$leftover_state" = "Booted" ] && ! xcrun simctl shutdown "$leftover_udid" >&2; then
    echo "::warning::could not shut down leftover simulator $leftover_udid" >&2
  fi
  if ! xcrun simctl delete "$leftover_udid" >&2; then
    echo "::warning::could not delete leftover simulator $leftover_udid" >&2
  fi
done <<<"$LEFTOVERS"

if [ "$BOOT" = "1" ]; then
  STATE="$(xcrun simctl list devices -j | python3 -c "$STATE_PY" "$UDID")"
  if [ "$STATE" != "Booted" ]; then
    echo "booting simulator $UDID" >&2
    xcrun simctl boot "$UDID" >&2
  fi
  xcrun simctl bootstatus "$UDID" -b >&2
fi

echo "$UDID"
