#!/usr/bin/env bash
# Direct host behavior of the real helper; no app, simulator or native tools.
# The simulator picker, PlistBuddy and simctl are dependency fakes. The actual
# launch helper is copied byte-for-byte and executed under the calling Bash.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORK="$(mktemp -d)"
cleanup() {
  set +e
  # Only helper-created fixture log workers recorded beneath this owned root.
  for pid_file in "$WORK"/cases/*/log.pid; do
    [ -f "$pid_file" ] || continue
    pid="$(cat "$pid_file")"
    # The fixture includes workers that ignore SIGTERM. Even a failed assertion
    # must dispose of only the recorded fixture worker instead of leaking it.
    kill -KILL "$pid" 2>/dev/null
  done
  rm -rf "$WORK"
}
trap cleanup EXIT
mkdir -p "$WORK/helper" "$WORK/bin" "$WORK/cases" "$WORK/Test App.app"
cp "$REPO_ROOT/tools/macos-ci/simulator-launch-check.sh" "$WORK/helper/"
touch "$WORK/Test App.app/Info.plist" "$WORK/Test App.app/main.jsbundle"
cat >"$WORK/helper/select-simulator.sh" <<'SH_PICKER'
#!/usr/bin/env bash
printf 'fixture-owned-iphone\n'
SH_PICKER
# The wallet helper has its own direct host test; here it is a dependency
# fake that records how the launch helper drives it and returns a verdict.
cat >"$WORK/helper/wallet-persistence-check.sh" <<'SH_WALLET'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$@" >"$LAUNCH_FIXTURE_DIR/wallet-args.txt"
[ -f "$LAUNCH_FIXTURE_DIR/app-alive" ] || { echo 'fixture: wallet probe asked to run against a dead app' >&2; exit 90; }
[ -f "$LAUNCH_FIXTURE_DIR/log.pid" ] && builtin kill -0 "$(cat "$LAUNCH_FIXTURE_DIR/log.pid")" 2>/dev/null && { echo 'fixture: launch log stream still running during wallet probe' >&2; exit 91; }
mkdir -p "$4"
case "$LAUNCH_FIXTURE_CASE" in
  wallet-fail)
    echo 'wallet_persistence_ok=0' >"$4/wallet-summary.txt"
    echo '::error::fixture wallet restore mismatch'
    exit 1 ;;
  wallet-silent)
    exit 0 ;;
  *)
    echo 'wallet_persistence_ok=1' >"$4/wallet-summary.txt" ;;
esac
SH_WALLET
cat >"$WORK/bin/PlistBuddy" <<'SH_PLIST'
#!/usr/bin/env bash
case "$2" in
  'Print :CFBundleExecutable') echo FixtureApp ;;
  'Print :CFBundleShortVersionString') echo 1.0 ;;
  'Print :CFBundleVersion') echo 1 ;;
  *) exit 97 ;;
esac
SH_PLIST
# Bash's kill builtin otherwise bypasses PATH. Virtualize only the impossible
# app PID; all log-worker PID checks/signals use the real builtin.
cat >"$WORK/bash-env" <<'SH_ENV'
kill() {
  if [ "${2:-}" = 987654321 ]; then
    [ "${1:-}" = -0 ] && [ -f "$LAUNCH_FIXTURE_DIR/app-alive" ]
  else
    builtin kill "$@"
  fi
}
SH_ENV
cat >"$WORK/bin/xcrun" <<'PY_XCRUN'
#!/usr/bin/env python3
import json, os, pathlib, signal, sys, time
root = pathlib.Path(os.environ['LAUNCH_FIXTURE_DIR'])
case = os.environ['LAUNCH_FIXTURE_CASE']
args = sys.argv[1:]
with (root / 'commands.jsonl').open('a') as f:
    f.write(json.dumps(args) + '\n')
assert args[0] == 'simctl', args
args = args[1:]
if args == ['list', 'devices']:
    print('fixture-owned-iphone (Booted)')
elif args[0] in ('terminate', 'uninstall'):
    (root / 'app-alive').unlink(missing_ok=True)
elif args[0] == 'install':
    assert pathlib.Path(args[2]).is_dir(), args
elif args[0] == 'spawn':
    assert args[2:4] == ['log', 'stream'], args
    (root / 'log.pid').write_text(str(os.getpid()))
    if case == 'entitlements':
        print('FixtureApp: Code=-34018 Client has neither application-identifier nor keychain-access-groups entitlements', flush=True)
    elif case == 'fatal':
        print('FixtureApp: RCTFatal Unhandled JS Exception', flush=True)
    else:
        print('FixtureApp: ordinary local fixture log', flush=True)
    (root / 'log-ready').touch()
    if case.startswith('log-early'):
        (root / 'log-exited').touch()
        sys.exit(0 if case.endswith('zero') else 17)
    def forced_exit(signum, frame):
        (root / 'log-exited').touch()
        os._exit(19)
    signal.signal(signal.SIGUSR1, forced_exit)
    if case == 'normal-graceful':
        signal.signal(signal.SIGTERM, lambda signum, frame: sys.exit(0))
    elif case == 'log-abnormal-stop':
        signal.signal(signal.SIGTERM, lambda signum, frame: sys.exit(19))
    elif case in ('log-ignore-term', 'screenshot-early-ignore-term'):
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
    while True:
        signal.pause()
elif args[0] == 'launch':
    (root / 'app-alive').touch()
    print('com.fixture.launch: 987654321')
elif args[0] == 'io':
    assert args[2] == 'screenshot', args
    target = pathlib.Path(args[3])
    assert target.is_absolute(), args
    if ((case in ('screenshot-early', 'screenshot-early-ignore-term') and target.name == 'launch-05s.png') or
        (case == 'screenshot-settled' and target.name == 'launch-settled.png')):
        print('fixture screenshot failure', file=sys.stderr)
        sys.exit(23)
    target.write_bytes(b'fixture screenshot')
    if case == 'app-final-screenshot' and target.name == 'launch-settled.png':
        (root / 'app-alive').unlink()
else:
    raise AssertionError(args)
PY_XCRUN
cat >"$WORK/bin/sleep" <<'PY_SLEEP'
#!/usr/bin/env python3
# Accelerate observation without races: synchronize on the owned log worker's
# readiness/exit markers, then cause failures at exact helper sleep boundaries.
import os, pathlib, signal, subprocess, sys, time
root = pathlib.Path(os.environ['LAUNCH_FIXTURE_DIR'])
case = os.environ['LAUNCH_FIXTURE_CASE']
seconds = sys.argv[1]
def wait_for(name):
    deadline = time.monotonic() + 3
    while not (root / name).exists():
        if time.monotonic() > deadline:
            raise SystemExit('fixture worker synchronization timed out: ' + name)
        time.sleep(0.005)
def wait_for_worker_exit():
    pid = (root / 'log.pid').read_text()
    deadline = time.monotonic() + 3
    while True:
        state = subprocess.run(['/bin/ps', '-p', pid, '-o', 'stat='], capture_output=True, text=True).stdout.strip()
        if not state or state.startswith('Z'):
            return
        if time.monotonic() > deadline:
            raise SystemExit('fixture log worker did not exit')
        time.sleep(0.005)
wait_for('log-ready')
if seconds == '0.1':
    counter = root / 'stop-grace-ticks'
    counter.write_text(str(int(counter.read_text()) + 1 if counter.exists() else 1))
if case.startswith('log-early'):
    wait_for('log-exited')
    wait_for_worker_exit()
if case == 'log-during' and seconds == '5':
    os.kill(int((root / 'log.pid').read_text()), signal.SIGUSR1)
    wait_for('log-exited')
    wait_for_worker_exit()
if case == 'app-final-sleep' and seconds == '1':
    (root / 'app-alive').unlink()
PY_SLEEP
# Do not inspect unrelated host crash reports in deterministic unit fixtures.
cat >"$WORK/bin/find" <<'SH_FIND'
#!/usr/bin/env bash
exit 0
SH_FIND
chmod +x "$WORK/helper/select-simulator.sh" "$WORK/helper/wallet-persistence-check.sh" "$WORK/bin/"*

run_case() {
  local case_name="$1" expected="$2" reason="$3" status=0
  local dir="$WORK/cases/$case_name"
  mkdir -p "$dir"
  (
    cd "$dir"
    BASH_ENV="$WORK/bash-env" LAUNCH_FIXTURE_DIR="$dir" \
      LAUNCH_FIXTURE_CASE="$case_name" PICKLE_CI_PLIST_BUDDY="$WORK/bin/PlistBuddy" \
      PATH="$WORK/bin:$PATH" python3 - "$BASH" "$WORK/helper/simulator-launch-check.sh" \
      "$WORK/Test App.app" com.fixture.launch 'relative artifact dir' 6 <<'PY_BOUNDED_RUN'
import os, signal, subprocess, sys
# A broken helper must not hang this test or retain any fixture descendants.
# This process group is newly created for this one owned fake invocation.
child = subprocess.Popen(sys.argv[1:], start_new_session=True)
try:
    status = child.wait(timeout=10)
except subprocess.TimeoutExpired:
    os.killpg(child.pid, signal.SIGKILL)
    child.wait(timeout=3)
    print('fixture helper exceeded bounded execution window', file=sys.stderr)
    sys.exit(98)
sys.exit(status)
PY_BOUNDED_RUN
  ) >"$dir/run.log" 2>&1 || status=$?
  if [ "$expected" = pass ]; then
    test "$status" -eq 0 || { cat "$dir/run.log" >&2; return 1; }
    grep -F 'alive_after_6s=1' "$dir/relative artifact dir/launch-summary.txt" >/dev/null
    grep -F 'keychain_entitlement_errors=0' "$dir/relative artifact dir/launch-summary.txt" >/dev/null
    grep -Fx 'wallet_persistence_ok=1' "$dir/relative artifact dir/launch-summary.txt" >/dev/null || { echo "launch summary lacks the wallet verdict: $case_name" >&2; return 1; }
    grep -F 'wallet contents survived force-quit' "$dir/run.log" >/dev/null
    # The probe runs against the surviving launch pid, on the same install,
    # writing beneath the launch artifact dir.
    test -f "$dir/wallet-args.txt" || { echo "wallet persistence check never ran: $case_name" >&2; return 1; }
    printf '%s\n' fixture-owned-iphone com.fixture.launch "$WORK/Test App.app" \
      "$dir/relative artifact dir/wallet" 987654321 | diff -u - "$dir/wallet-args.txt"
    test -f "$dir/relative artifact dir/launch-05s.png"
    test -f "$dir/relative artifact dir/launch-settled.png"
    if [ "$case_name" = normal-graceful ]; then
      grep -F 'log_stream_stop_status=0' "$dir/relative artifact dir/launch-summary.txt" >/dev/null
    else
      grep -F 'log_stream_stop_status=143' "$dir/relative artifact dir/launch-summary.txt" >/dev/null
    fi
  else
    test "$status" -ne 0 || { echo "unexpected pass: $case_name" >&2; return 1; }
    grep -F "$reason" "$dir/run.log" >/dev/null || { cat "$dir/run.log" >&2; return 1; }
    if grep -q 'launch check passed:' "$dir/run.log"; then
      echo "failed case printed success: $case_name" >&2; return 1
    fi
    case "$case_name" in
      wallet-fail|wallet-silent|entitlements|fatal)
        test -f "$dir/wallet-args.txt" || { echo "wallet persistence check never ran: $case_name" >&2; return 1; } ;;
      *)
        # A launch that did not survive, or evidence that is already
        # incomplete, is never probed further.
        if [ -f "$dir/wallet-args.txt" ]; then
          echo "wallet persistence check ran without a surviving launch: $case_name" >&2; return 1
        fi
        case "$case_name" in
          app-final-*) grep -F 'wallet persistence check not run: FixtureApp did not survive the launch' "$dir/run.log" >/dev/null ;;
        esac ;;
    esac
    if [ "$case_name" = wallet-fail ] || [ "$case_name" = wallet-silent ]; then
      grep -Fx 'wallet_persistence_ok=0' "$dir/relative artifact dir/launch-summary.txt" >/dev/null
    fi
  fi
  if [ "$case_name" = log-early-zero ] || [ "$case_name" = log-early-error ]; then
    if grep -q '"launch"' "$dir/commands.jsonl"; then
      echo 'app launch happened without an available log stream' >&2; return 1
    fi
  fi
  if [ "$case_name" = log-ignore-term ] || [ "$case_name" = screenshot-early-ignore-term ]; then
    grep -F 'log stream did not stop within 3s; forced termination' "$dir/run.log" >/dev/null
    test "$(cat "$dir/stop-grace-ticks")" = 30
  fi
  if [ -f "$dir/log.pid" ]; then
    if builtin kill -0 "$(cat "$dir/log.pid")" 2>/dev/null; then
      echo "fixture log worker survived helper cleanup: $case_name" >&2; return 1
    fi
    rm -f "$dir/log.pid"
  fi
  echo "[test_simulator_launch_check] PASS: $case_name"
}
run_case normal-signal pass ''
run_case normal-graceful pass ''
run_case log-early-zero fail 'log stream exited before requested termination'
run_case log-early-error fail 'log stream exited before requested termination'
run_case log-during fail 'log stream exited before requested termination'
run_case log-abnormal-stop fail 'log stream failed during requested termination (status 19)'
run_case log-ignore-term fail 'log stream did not stop within 3s; forced termination'
run_case screenshot-early-ignore-term fail 'fixture screenshot failure'
run_case app-final-sleep fail 'exited before the 6s settle period ended'
run_case app-final-screenshot fail 'exited before the 6s settle period ended'
run_case screenshot-early fail 'fixture screenshot failure'
run_case screenshot-settled fail 'fixture screenshot failure'
run_case entitlements fail 'signing entitlements are missing'
run_case fatal fail 'fatal React Native error'
run_case wallet-fail fail 'wallet persistence check failed (status 1)'
run_case wallet-silent fail 'wallet persistence check produced no verdict (wallet_persistence_ok=0)'
