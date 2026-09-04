#!/usr/bin/env bash
# Linux-runnable check for tools/macos-ci/select-simulator.sh's `pick` helper.
#
# Feeds `pick` a fake `xcrun simctl list devices available -j` that returns one
# available iPhone and asserts the helper prints that UDID. It does NOT need a
# Mac: `pick` only shells out to `xcrun … | python3 -c …`, so the embedded
# Python (and the bash quoting around it) is exercised faithfully.
#
# Exit 0  → `pick` selected the fake iPhone (helper healthy).
# Exit 1  → `pick` failed (e.g. SyntaxError in the embedded f-string), which is
#           what mac-full-verify.sh currently masks via `UDID="$(pick || true)"`
#           before falling back to creating a fresh simulator.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SELECTOR="${SELECTOR:-$REPO_ROOT/tools/macos-ci/select-simulator.sh}"
EXPECTED_UDID="9151426D-F8B4-4E8C-9ABA-E2CEF98E01F3"

FAKE_BIN="$(mktemp -d)"
trap 'rm -rf "$FAKE_BIN"' EXIT
cat >"$FAKE_BIN/xcrun" <<'XCRUN'
#!/usr/bin/env bash
cat <<'JSON'
{"devices":{"com.apple.CoreSimulator.SimRuntime.iOS-26-4":[{"isAvailable":true,"name":"iPhone 17 Pro","state":"Shutdown","udid":"9151426D-F8B4-4E8C-9ABA-E2CEF98E01F3"}]}}
JSON
XCRUN
chmod +x "$FAKE_BIN/xcrun"

# Extract only the `pick() { … }` function so the script's argument parsing,
# simulator creation and boot logic never run here.
PICK_FN="$(awk '/^pick\(\) \{/,/^\}/' "$SELECTOR")"
if [ -z "$PICK_FN" ]; then
  echo "could not locate pick() in $SELECTOR" >&2
  exit 2
fi

set +e
UDID="$(PATH="$FAKE_BIN:$PATH" bash -c "$PICK_FN"$'\n''pick' 2>"$FAKE_BIN/stderr")"
status=$?
set -e
cat "$FAKE_BIN/stderr" >&2

if [ "$status" -ne 0 ]; then
  echo "FAIL: pick exited $status (see stderr above)" >&2
  exit 1
fi
if [ "$UDID" != "$EXPECTED_UDID" ]; then
  echo "FAIL: pick printed '$UDID', expected $EXPECTED_UDID" >&2
  exit 1
fi
echo "OK: pick selected $UDID"
