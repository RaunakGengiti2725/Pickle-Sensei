#!/usr/bin/env bash
# Scenario 3 (Linux harness) — tools/macos-ci/simulator-launch-check.sh with
# the app ALREADY installed on a booted simulator.
#
# Apple truth is UNKNOWN from Linux; what runs here is the real bash script
# against a shim `xcrun` that records every simctl call (order matters), a
# shim /usr/libexec/PlistBuddy (bind-mounted via an unprivileged user
# namespace — nothing on the host is modified), and a real background process
# standing in for the launched app PID so `kill -0` behaves like on macOS.
#
# Variants
#   preinstalled   app marker present before the run → expect terminate →
#                  uninstall → install ordering, both PNGs, launch-summary.txt,
#                  exit 0
#   shot-fail      `simctl io … screenshot` exits 1 → does the check still pass
#                  with NO screenshots (evidence silently missing)?
#   dies-early     launched PID exits after 3 s → expect exit 1 + '::error::'
#   fatal-js       log stream carries 'Unhandled JS Exception' → expect exit 1
#   no-pid         launch output without a PID → expect exit 1
# shellcheck source=tests/attack/ci-workflows-scripts-2/lib.sh
source "$(dirname "$0")/lib.sh"
cd "$ATTACK_REPO_ROOT" || exit 2

command -v unshare >/dev/null || { alog "unshare(1) missing — cannot shim /usr/libexec/PlistBuddy"; exit 2; }
if ! unshare -Urm --propagation unchanged true 2>/dev/null; then
  alog "unprivileged user namespaces unavailable — cannot shim /usr/libexec/PlistBuddy"; exit 2
fi

overall=0
SHIM="$ATTACK_OUT/s3-shim-bin"; LIBEXEC="$ATTACK_OUT/s3-libexec"; APP="$ATTACK_OUT/s3-PickleSensei.app"
mkdir -p "$SHIM" "$LIBEXEC" "$APP"
register_cleanup "$SHIM" "$LIBEXEC" "$APP"
: >"$APP/Info.plist"; : >"$APP/main.jsbundle"

cat >"$LIBEXEC/PlistBuddy" <<'SH'
#!/usr/bin/env bash
case "$2" in
  *CFBundleExecutable) echo PickleSensei ;;
  *CFBundleShortVersionString) echo 1.0.0 ;;
  *CFBundleVersion) echo 42 ;;
  *) exit 1 ;;
esac
SH
cat >"$SHIM/xcrun" <<'SH'
#!/usr/bin/env bash
# state dir: $SHIM_STATE/installed marks the app as present on the simulator
[ "${1:-}" = simctl ] || { echo "xcrun shim: unsupported $*" >&2; exit 1; }
shift
echo "simctl $*" >>"$SHIM_STATE/simctl-calls.txt"
case "${1:-} ${2:-}" in
  'list devices')
    if [ "${3:-}" = -j ] || [ "${3:-}" = available ]; then
      echo '{"devices": {"com.apple.CoreSimulator.SimRuntime.iOS-26-0": [{"udid": "SHIM-UDID-0000", "name": "iPhone 17 Pro", "state": "Booted", "isAvailable": true}]}}'
    else
      echo "    iPhone 17 Pro (SHIM-UDID-0000) (Booted)"
    fi ;;
  'list runtimes') echo '{"runtimes": [{"identifier": "com.apple.CoreSimulator.SimRuntime.iOS-26-0", "version": "26.0", "platform": "iOS", "isAvailable": true}]}' ;;
  'list devicetypes') echo '{"devicetypes": [{"name": "iPhone 17 Pro", "identifier": "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro"}]}' ;;
  'create '*) echo "SHIM-UDID-0000" ;;
  'boot '*|'bootstatus '*) ;;
  'terminate '*) rm -f "$SHIM_STATE/running" ;;
  'uninstall '*) rm -f "$SHIM_STATE/installed" ;;
  'install '*) touch "$SHIM_STATE/installed" ;;
  'spawn '*)
    # log stream: emit a few lines then idle until killed
    echo "$(date +%T) PickleSensei: RN bridge up (shim)"
    [ "${SHIM_FATAL_JS:-0}" = 1 ] && echo "$(date +%T) PickleSensei: Unhandled JS Exception: TypeError (shim)"
    exec sleep 600 ;;
  'launch '*)
    [ -f "$SHIM_STATE/installed" ] || { echo "An error was encountered processing the command (domain=FBSOpenApplicationServiceErrorDomain, code=1): app not installed (shim)" >&2; exit 1; }
    if [ "${SHIM_NO_PID:-0}" = 1 ]; then echo "$3"; exit 0; fi
    ( exec -a PickleSensei-shim sleep "${SHIM_APP_LIFETIME:-600}" ) >/dev/null 2>&1 </dev/null &
    echo "$3: $!"
    disown ;;
  'io '*)
    # io UDID screenshot PATH
    [ "${SHIM_SCREENSHOT_FAIL:-0}" = 1 ] && { echo "screenshot failed (shim)" >&2; exit 1; }
    printf '\x89PNG\r\n\x1a\n' >"$4" ;;
  *) echo "simctl shim: unsupported $*" >&2; exit 1 ;;
esac
exit 0
SH
chmod +x "$SHIM/xcrun" "$LIBEXEC/PlistBuddy"

run_check() { # $1 label, $2 preinstalled(0/1), rest = env assignments
  local label="$1" pre="$2"; shift 2
  local state="$ATTACK_OUT/s3-state-$label" out="$ATTACK_OUT/s3-out-$label" log="$ATTACK_OUT/s3-$label.log" rc=0
  rm -rf "$state" "$out"; mkdir -p "$state"
  [ "$pre" = 1 ] && touch "$state/installed" "$state/running"
  (
    export PATH="$SHIM:$PATH" SHIM_STATE="$state" HOME="$ATTACK_OUT/s3-home"
    for kv in "$@"; do export "${kv?}"; done
    # shellcheck disable=SC2016  # the $1/$2/$3 are for the inner bash -c
    exec unshare -Urm --propagation unchanged bash -c \
      'mount --bind "$1" /usr/libexec && exec timeout 120 tools/macos-ci/simulator-launch-check.sh "$2" com.picklesensei "$3" 8' _ "$LIBEXEC" "$APP" "$out"
  ) >"$log" 2>&1 || rc=$?
  echo "exit=$rc" >>"$log"
  CHECK_RC=$rc CHECK_OUT=$out CHECK_LOG=$log CHECK_CALLS="$state/simctl-calls.txt"
}
call_order() { grep -nE '^simctl (terminate|uninstall|install|launch) ' "$1" | awk '{print $2}' | tr '\n' ' '; }

# ---- preinstalled app on a booted simulator
run_check preinstalled 1
order="$(call_order "$CHECK_CALLS")"
if [ "$CHECK_RC" = 0 ] && [ "$order" = "terminate uninstall install launch terminate " ] \
   && [ -s "$CHECK_OUT/launch-05s.png" ] && [ -s "$CHECK_OUT/launch-settled.png" ] \
   && grep -q '^alive_after_8s=1' "$CHECK_OUT/launch-summary.txt" && grep -q 'launch check passed' "$CHECK_LOG"; then
  record_verdict s3-preinstalled HELD "app already installed → simctl order: $order(final terminate = EXIT trap); launch-05s.png + launch-settled.png + launch-summary.txt written; exit 0" \
    "uninstall before install, both screenshots" "$CHECK_LOG" "$CHECK_CALLS" "$CHECK_OUT/launch-summary.txt"
else
  record_verdict s3-preinstalled BROKEN "exit $CHECK_RC, simctl order: $order, files: $(find "$CHECK_OUT" -maxdepth 1 -type f -printf '%f ' 2>/dev/null)" \
    "terminate→uninstall→install→launch, both PNGs, exit 0" "$CHECK_LOG" "$CHECK_CALLS"; overall=1
fi

# ---- screenshots fail → does the check still pass?
run_check shot-fail 1 SHIM_SCREENSHOT_FAIL=1
if [ "$CHECK_RC" = 0 ] && [ ! -e "$CHECK_OUT/launch-05s.png" ] && [ ! -e "$CHECK_OUT/launch-settled.png" ] && grep -q 'launch check passed' "$CHECK_LOG"; then
  record_verdict s3-shot-fail BROKEN "both 'simctl io … screenshot' calls fail (exit 1) yet the check prints 'launch check passed' and exits 0 with NO screenshot in the artifact dir (the '|| true' on both screenshot lines + no post-check)" \
    "missing launch screenshots should at least emit ::warning:: / be listed in launch-summary.txt; the workflow's step summary advertises them as evidence" \
    "$CHECK_LOG" "tools/macos-ci/simulator-launch-check.sh:78" "tools/macos-ci/simulator-launch-check.sh:87"
  overall=1
else
  record_verdict s3-shot-fail HELD "screenshot failure: exit $CHECK_RC" "n/a" "$CHECK_LOG"
fi

# ---- app dies after 3 s
run_check dies-early 1 SHIM_APP_LIFETIME=3
if [ "$CHECK_RC" = 1 ] && grep -q '::error::PickleSensei exited before the 8s settle period ended' "$CHECK_LOG" && grep -q '^alive_after_8s=0' "$CHECK_OUT/launch-summary.txt"; then
  record_verdict s3-dies-early HELD "launched PID exits after 3 s → alive_after_8s=0, ::error:: emitted, exit 1; launch-summary.txt still written" "exit 1" "$CHECK_LOG" "$CHECK_OUT/launch-summary.txt"
else
  record_verdict s3-dies-early BROKEN "early exit not detected: exit $CHECK_RC" "exit 1" "$CHECK_LOG"; overall=1
fi

# ---- fatal JS line in the unified log
run_check fatal-js 1 SHIM_FATAL_JS=1
if [ "$CHECK_RC" = 1 ] && grep -q '::error::fatal React Native error' "$CHECK_LOG" && grep -q '^fatal_log_lines=1' "$CHECK_OUT/launch-summary.txt"; then
  record_verdict s3-fatal-js HELD "'Unhandled JS Exception' in the log stream → fatal_log_lines=1, exit 1 even though the process stayed alive" "exit 1" "$CHECK_LOG"
else
  record_verdict s3-fatal-js BROKEN "fatal JS line not fatal: exit $CHECK_RC" "exit 1" "$CHECK_LOG"; overall=1
fi

# ---- launch output without a PID
run_check no-pid 1 SHIM_NO_PID=1
if [ "$CHECK_RC" = 1 ] && grep -q '::error::could not parse launched PID' "$CHECK_LOG"; then
  record_verdict s3-no-pid HELD "unparseable simctl launch output → exit 1" "exit 1" "$CHECK_LOG"
else
  record_verdict s3-no-pid BROKEN "no-PID launch: exit $CHECK_RC" "exit 1" "$CHECK_LOG"; overall=1
fi

# ---- nothing installed (fresh simulator) → same ordering, terminate/uninstall tolerate the absence
run_check fresh 0
order="$(call_order "$CHECK_CALLS")"
if [ "$CHECK_RC" = 0 ] && [ "$order" = "terminate uninstall install launch terminate " ]; then
  record_verdict s3-fresh HELD "nothing installed → same order (terminate/uninstall are '|| true' so a missing app does not abort), exit 0" "same order" "$CHECK_LOG" "$CHECK_CALLS"
else
  record_verdict s3-fresh BROKEN "fresh path: exit $CHECK_RC, order: $order" "exit 0" "$CHECK_LOG"; overall=1
fi

pkill -f 'PickleSensei-shim' 2>/dev/null || true
exit $overall
