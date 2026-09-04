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
# The whole decision lives in ONE python program below, delivered as a quoted
# heredoc: the shell never interpolates or re-quotes it, so it can be
# extracted and byte-compiled verbatim (scripts/tests/test_select_simulator.sh
# does exactly that). Python talks to `xcrun simctl` itself; any failure of
# the picker — bad JSON, simctl error — exits non-zero instead of falling
# through to "create a new device".
#
# Usage: select-simulator.sh            # print UDID
#        select-simulator.sh --boot     # print UDID and make sure it is booted
set -euo pipefail

exec python3 - "$@" <<'PY'
import json
import re
import subprocess
import sys

CI_DEVICE_NAME = "PickleSensei-CI"


def log(message):
    print(message, file=sys.stderr)
    sys.stderr.flush()


def fail(message, code=1):
    log(message)
    sys.exit(code)


def simctl(*args, check=True):
    """Run `xcrun simctl <args>`; stdout is returned, stderr is forwarded."""
    proc = subprocess.run(
        ["xcrun", "simctl", *args],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    if proc.stderr:
        sys.stderr.write(proc.stderr)
        sys.stderr.flush()
    if check and proc.returncode != 0:
        fail(
            "xcrun simctl %s failed with exit code %d" % (" ".join(args), proc.returncode),
            proc.returncode or 1,
        )
    return proc


def simctl_json(*args):
    out = simctl(*args).stdout
    try:
        data = json.loads(out)
    except ValueError as exc:
        fail("xcrun simctl %s returned invalid JSON: %s" % (" ".join(args), exc))
    if not isinstance(data, dict):
        fail("xcrun simctl %s returned unexpected JSON (%s)" % (" ".join(args), type(data).__name__))
    return data


def version_tuple(text):
    """'26.4' / 'iOS-26-4' -> (26, 4); non-numeric parts sort lowest."""
    parts = re.split(r"[.\-]", text)
    return tuple(int(p) if p.isdigit() else -1 for p in parts)


def ios_runtime_version(runtime_id):
    """Runtime identifier -> version tuple, or None if it is not an iOS runtime."""
    marker = "SimRuntime.iOS-"
    if marker not in runtime_id:
        return None
    return version_tuple(runtime_id.rsplit(marker, 1)[1])


def is_iphone(dev):
    type_id = dev.get("deviceTypeIdentifier") or ""
    if type_id:
        return ".SimDeviceType.iPhone" in type_id
    return "iPhone" in (dev.get("name") or "")


def inventory():
    """One `simctl list devices available -j` call: [(runtime id, device), ...].

    Selection, stale-device cleanup and the boot-state check all read this
    single snapshot, so the picker depends on exactly one listing command.
    """
    devices = simctl_json("list", "devices", "available", "-j").get("devices", {})
    return [(runtime_id, dev) for runtime_id, devs in devices.items() for dev in devs]


def pick_existing(devices):
    """Newest-runtime, booted-first, Pro-first available iPhone, or None."""
    candidates = []
    for runtime_id, dev in devices:
        version = ios_runtime_version(runtime_id)
        if version is None:
            continue
        if not dev.get("isAvailable") or not is_iphone(dev):
            continue
        name = dev.get("name") or ""
        candidates.append(
            (
                version,
                1 if dev.get("state") == "Booted" else 0,
                1 if "Pro" in name else 0,
                name,
                dev["udid"],
            )
        )
    if not candidates:
        return None
    candidates.sort(reverse=True)
    version, _, _, name, udid = candidates[0]
    ios = ".".join(str(p) for p in version)
    log("selected simulator: %s (iOS %s) %s" % (name, ios, udid))
    return udid


def model_key(device_type):
    """Newest-first ordering for device types.

    Prefers the CoreSimulator modelIdentifier ("iPhone18,1" -> (18, 1)), which
    grows monotonically with the hardware generation and also covers names
    without a number (iPhone Air, iPhone SE); falls back to the number in the
    marketing name ("iPhone 16 Pro" -> (16, 0)).
    """
    model = device_type.get("modelIdentifier") or ""
    match = re.search(r"(\d+),(\d+)", model)
    if match:
        return (int(match.group(1)), int(match.group(2)))
    match = re.search(r"\d+", device_type.get("name") or "")
    return (int(match.group(0)) if match else 0, 0)


def is_iphone_type(device_type):
    family = device_type.get("productFamily")
    if family:
        return family == "iPhone"
    return ".SimDeviceType.iPhone" in (device_type.get("identifier") or "")


def choose_device_type(runtime):
    types = runtime.get("supportedDeviceTypes") or []
    if not types:
        types = simctl_json("list", "devicetypes", "-j").get("devicetypes", [])
    iphones = [t for t in types if is_iphone_type(t)]
    if not iphones:
        fail("::error::No iPhone device type is available for %s." % runtime["identifier"])
    pro = [t for t in iphones if "Pro" in t["name"] and "Max" not in t["name"]]
    pool = pro or iphones
    pool.sort(key=lambda t: (model_key(t), t["name"]), reverse=True)
    return pool[0]["identifier"]


def create_device():
    log("no available iPhone simulator found; trying to create one")
    runtimes = [
        r
        for r in simctl_json("list", "runtimes", "-j").get("runtimes", [])
        if r.get("isAvailable") and r.get("platform") == "iOS"
    ]
    if not runtimes:
        developer_dir = subprocess.run(
            ["xcode-select", "-p"], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, text=True
        ).stdout.strip()
        log("::error::No iOS simulator runtime is installed in %s." % developer_dir)
        fail("Install one on the Mac with: xcodebuild -downloadPlatform iOS   (then re-run)")
    runtimes.sort(key=lambda r: version_tuple(r.get("version") or ""), reverse=True)
    runtime = runtimes[0]
    device_type = choose_device_type(runtime)
    log("creating simulator %s (%s on %s)" % (CI_DEVICE_NAME, device_type, runtime["identifier"]))
    udid = simctl("create", CI_DEVICE_NAME, device_type, runtime["identifier"]).stdout.strip()
    if not udid:
        fail("xcrun simctl create printed no UDID")
    return udid


def delete_stale_ci_devices(devices, keep_udid):
    """Remove CI-created devices left behind by earlier runs (never the one in use).

    Housekeeping only: a device that refuses to go away is reported as a
    warning with simctl's own message and does not fail the selection.
    """
    for _, dev in devices:
        if dev.get("name") != CI_DEVICE_NAME or dev.get("udid") == keep_udid:
            continue
        stale = dev["udid"]
        log("deleting stale simulator %s %s" % (CI_DEVICE_NAME, stale))
        if dev.get("state") == "Booted":
            simctl("shutdown", stale, check=False)
        result = simctl("delete", stale, check=False)
        if result.returncode != 0:
            log(
                "::warning::could not delete stale simulator %s (exit %d)"
                % (stale, result.returncode)
            )


def ensure_booted(udid, state):
    if state != "Booted":
        log("booting simulator %s" % udid)
        boot = simctl("boot", udid)
        if boot.stdout:
            sys.stderr.write(boot.stdout)
    status = simctl("bootstatus", udid, "-b")
    if status.stdout:
        sys.stderr.write(status.stdout)
        sys.stderr.flush()


def main(argv):
    boot = False
    for arg in argv:
        if arg == "--boot":
            boot = True
        else:
            fail("unknown argument: %s" % arg, 2)

    devices = inventory()
    udid = pick_existing(devices)
    if udid is None:
        udid = create_device()  # a freshly created device starts out Shutdown
    delete_stale_ci_devices(devices, udid)
    if boot:
        state = next((d.get("state") for _, d in devices if d.get("udid") == udid), "Shutdown")
        ensure_booted(udid, state)
    print(udid)


main(sys.argv[1:])
PY
