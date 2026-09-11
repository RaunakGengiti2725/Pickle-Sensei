#!/usr/bin/env bash
# Direct host behavior of tools/macos-ci/wallet-persistence-check.sh (W05-05);
# no app, simulator, clang or Keychain. Every Apple tool the helper drives is a
# dependency fake: `xcrun` (SDK path, clang, lipo, simctl), `codesign`,
# PlistBuddy and `sleep`. The fake `simctl launch` plays the in-process probe
# the real dylib provides: it reads the SIMCTL_CHILD_ environment the helper
# must pass, keeps a fixture "keychain" file across launches, and writes the
# phase result the helper waits for. The real helper is copied byte-for-byte
# and executed under the calling Bash.
#
# Pinned behaviour:
#   1. the probe is compiled from tools/macos-ci/wallet-probe.m for the app's
#      own architecture and MinimumOSVersion, ad-hoc signed, and injected into
#      the shipping app through SIMCTL_CHILD_DYLD_INSERT_LIBRARIES — never a
#      separate process
#   2. the sequence is: terminate the running instance, launch (store), wait
#      for the store result, screenshot, SIGKILL the app from the host, launch
#      again (restore), wait for the restore result, screenshot
#   3. the restored wallet must carry the stored revision and identical
#      grants/receipts; the probe then clears it and reads back "no wallet"
#   4. a store rejection, a wallet lost across the kill, a stale wallet, a
#      silent probe, a failed compile and a Keychain entitlement error in the
#      app log each fail the helper with the reason on stdout
#   5. wallet-summary.txt carries the machine-readable verdict
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORK="$(mktemp -d)"
cleanup() {
  set +e
  for pid_file in "$WORK"/cases/*/log.pid; do
    [ -f "$pid_file" ] || continue
    kill -KILL "$(cat "$pid_file")" 2>/dev/null
  done
  rm -rf "$WORK"
}
trap cleanup EXIT
mkdir -p "$WORK/helper" "$WORK/bin" "$WORK/cases" "$WORK/Test App.app"
cp "$REPO_ROOT/tools/macos-ci/wallet-persistence-check.sh" "$WORK/helper/"
cp "$REPO_ROOT/tools/macos-ci/wallet-probe.m" "$WORK/helper/"
touch "$WORK/Test App.app/Info.plist" "$WORK/Test App.app/FixtureApp"
cat >"$WORK/bin/PlistBuddy" <<'SH_PLIST'
#!/usr/bin/env bash
case "$2" in
  'Print :CFBundleExecutable') echo FixtureApp ;;
  'Print :MinimumOSVersion') echo 15.1 ;;
  *) exit 97 ;;
esac
SH_PLIST
cat >"$WORK/bin/codesign" <<'SH_CODESIGN'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$WALLET_FIXTURE_DIR/codesign.log"
[ -f "${@: -1}" ] || { echo "codesign: no such file: ${@: -1}" >&2; exit 1; }
SH_CODESIGN
# Bash's kill builtin otherwise bypasses PATH. Virtualize only the impossible
# app PIDs the fake simctl hands out; everything else uses the real builtin.
cat >"$WORK/bash-env" <<'SH_ENV'
kill() {
  local signal="$1" pid="${2:-}"
  if [ -n "$pid" ] && [ "$pid" -ge 987654320 ] 2>/dev/null; then
    case "$signal" in
      -0) [ -f "$WALLET_FIXTURE_DIR/alive-$pid" ] ;;
      -KILL|-9)
        [ -f "$WALLET_FIXTURE_DIR/alive-$pid" ] || return 1
        rm -f "$WALLET_FIXTURE_DIR/alive-$pid"
        echo "$signal" >"$WALLET_FIXTURE_DIR/killed-$pid"
        if [ -f "$WALLET_FIXTURE_DIR/running" ] && [ "$(cat "$WALLET_FIXTURE_DIR/running")" = "$pid" ]; then
          rm -f "$WALLET_FIXTURE_DIR/running"
        fi
        if [ -f "$WALLET_FIXTURE_DIR/lose-on-kill" ]; then rm -f "$WALLET_FIXTURE_DIR/keychain.json"; fi
        ;;
      *) echo "fixture: unexpected signal $signal for app pid $pid" >&2; return 1 ;;
    esac
  else
    builtin kill "$@"
  fi
}
SH_ENV
cat >"$WORK/bin/xcrun" <<'PY_XCRUN'
#!/usr/bin/env python3
import json, os, pathlib, signal, sys
root = pathlib.Path(os.environ['WALLET_FIXTURE_DIR'])
case = os.environ['WALLET_FIXTURE_CASE']
args = sys.argv[1:]
with (root / 'commands.jsonl').open('a') as f:
    f.write(json.dumps(args) + '\n')

def keychain():
    path = root / 'keychain.json'
    return json.loads(path.read_text()) if path.exists() else None

def write_keychain(state):
    (root / 'keychain.json').write_text(json.dumps(state))

def write_result(path, payload):
    tmp = pathlib.Path(path + '.tmp')
    tmp.write_text(json.dumps(payload, indent=2, sort_keys=True))
    tmp.rename(path)

if args[:3] == ['--sdk', 'iphonesimulator', '--show-sdk-path']:
    print(str(root / 'iPhoneSimulator.sdk'))
elif args[:3] == ['--sdk', 'iphonesimulator', 'clang']:
    flags = args[3:]
    assert '-arch' in flags and flags[flags.index('-arch') + 1] == 'arm64', flags
    assert '-mios-simulator-version-min=15.1' in flags, flags
    assert '-dynamiclib' in flags and '-fobjc-arc' in flags, flags
    assert '-isysroot' in flags and flags[flags.index('-isysroot') + 1] == str(root / 'iPhoneSimulator.sdk'), flags
    source = [f for f in flags if f.endswith('.m')]
    assert len(source) == 1 and pathlib.Path(source[0]).name == 'wallet-probe.m' and pathlib.Path(source[0]).is_file(), flags
    output = pathlib.Path(flags[flags.index('-o') + 1])
    if case == 'compile-fail':
        print('wallet-probe.m:1:1: error: fixture compile failure', file=sys.stderr)
        sys.exit(1)
    output.write_bytes(b'fixture dylib')
elif args[:2] == ['lipo', '-archs']:
    assert pathlib.Path(args[2]).is_file(), args
    print('arm64')
elif args[0] != 'simctl':
    raise AssertionError(args)
else:
    args = args[1:]
    if args[0] == 'terminate':
        running = root / 'running'
        if not running.exists():
            print('An error was encountered processing the command: found nothing to terminate', file=sys.stderr)
            sys.exit(3)
        pid = running.read_text().strip()
        (root / f'alive-{pid}').unlink(missing_ok=True)
        running.unlink()
    elif args[0] == 'spawn':
        assert args[2:4] == ['log', 'stream'], args
        assert 'process == "FixtureApp"' in args, args
        (root / 'log.pid').write_text(str(os.getpid()))
        if case == 'entitlements':
            print('FixtureApp: Code=-34018 Client has neither application-identifier nor keychain-access-groups entitlements', flush=True)
        else:
            print('FixtureApp: PickleWalletProbe fixture line', flush=True)
        (root / 'log-ready').touch()
        signal.signal(signal.SIGTERM, lambda signum, frame: sys.exit(0))
        while True:
            signal.pause()
    elif args[0] == 'launch':
        assert args[1:] == ['fixture-owned-iphone', 'com.fixture.launch'], args
        assert not (root / 'running').exists(), 'launched while a previous instance was still running'
        env = {k[len('SIMCTL_CHILD_'):]: v for k, v in os.environ.items() if k.startswith('SIMCTL_CHILD_')}
        with (root / 'launch-env.jsonl').open('a') as f:
            f.write(json.dumps(env, sort_keys=True) + '\n')
        dylib = pathlib.Path(env['DYLD_INSERT_LIBRARIES'])
        assert dylib.is_absolute() and dylib.is_file() and dylib.name == 'PickleWalletProbe.dylib', env
        counter = root / 'launches'
        launches = int(counter.read_text()) if counter.exists() else 0
        pid = 987654321 + launches
        counter.write_text(str(launches + 1))
        (root / f'alive-{pid}').touch()
        (root / 'running').write_text(str(pid))
        print(f'com.fixture.launch: {pid}')
        phase = env['PICKLE_WALLET_PROBE_PHASE']
        owner = env['PICKLE_WALLET_PROBE_OWNER']
        result_path = env['PICKLE_WALLET_PROBE_RESULT']
        assert pathlib.Path(result_path).is_absolute(), env
        if case == 'probe-silent':
            sys.exit(0)
        stored = keychain()
        if stored is not None:
            assert stored['ownerId'] == owner, (stored, owner)
        result = {'phase': phase, 'ownerId': owner, 'pid': pid, 'bundleId': 'com.fixture.launch'}
        if phase == 'store':
            contents = json.loads(pathlib.Path(env['PICKLE_WALLET_PROBE_INPUT']).read_text())
            result['loaded'] = {'resolved': stored}
            if case == 'store-denied':
                result['replaced'] = {'rejected': {'code': 'wallet.storage_denied', 'message': 'keychain write failed', 'status': -34018}}
                result['failure'] = 'wallet.storage_denied'
                result['ok'] = False
            else:
                revision = (stored['revision'] if stored else 0) + 1
                snapshot = {'ownerId': owner, 'revision': revision, 'grants': contents['grants'], 'receipts': contents['receipts']}
                write_keychain(snapshot)
                result['replaced'] = {'resolved': snapshot}
                result['stored'] = snapshot
                result['ok'] = True
                if case == 'restore-lost':
                    (root / 'lose-on-kill').touch()
                if case == 'restore-stale':
                    stale = dict(snapshot, receipts=[])
                    write_keychain(stale)
        else:
            assert phase == 'restore', phase
            result['loaded'] = {'resolved': stored}
            if stored is not None:
                result['restored'] = stored
                write_keychain(None)
                result['cleared'] = {'resolved': None}
                result['afterClear'] = {'resolved': keychain()}
                result['ok'] = True
            else:
                result['failure'] = 'no wallet stored'
                result['ok'] = False
        write_result(result_path, result)
    elif args[0] == 'io':
        assert args[2] == 'screenshot', args
        target = pathlib.Path(args[3])
        assert target.is_absolute(), args
        if case == 'screenshot-fail' and target.name == 'wallet-restore.png':
            print('fixture screenshot failure', file=sys.stderr)
            sys.exit(23)
        target.write_bytes(b'fixture screenshot')
    else:
        raise AssertionError(args)
PY_XCRUN
cat >"$WORK/bin/sleep" <<'PY_SLEEP'
#!/usr/bin/env python3
# The fixture is synchronous; only wait for the owned log worker's readiness.
import os, pathlib, time
root = pathlib.Path(os.environ['WALLET_FIXTURE_DIR'])
if (root / 'log.pid').exists():
    deadline = time.monotonic() + 3
    while not (root / 'log-ready').exists():
        if time.monotonic() > deadline:
            raise SystemExit('fixture log worker synchronization timed out')
        time.sleep(0.005)
PY_SLEEP
chmod +x "$WORK/bin/"*

run_case() {
  local case_name="$1" expected="$2" reason="$3" status=0
  local dir="$WORK/cases/$case_name"
  mkdir -p "$dir"
  touch "$dir/alive-987654320"
  echo 987654320 >"$dir/running"
  (
    cd "$dir"
    BASH_ENV="$WORK/bash-env" WALLET_FIXTURE_DIR="$dir" WALLET_FIXTURE_CASE="$case_name" \
      PICKLE_CI_PLIST_BUDDY="$WORK/bin/PlistBuddy" PATH="$WORK/bin:$PATH" \
      python3 - "$BASH" "$WORK/helper/wallet-persistence-check.sh" \
      fixture-owned-iphone com.fixture.launch "$WORK/Test App.app" 'relative wallet dir' 987654320 <<'PY_BOUNDED_RUN'
import os, signal, subprocess, sys
child = subprocess.Popen(sys.argv[1:], start_new_session=True)
try:
    status = child.wait(timeout=15)
except subprocess.TimeoutExpired:
    os.killpg(child.pid, signal.SIGKILL)
    child.wait(timeout=3)
    print('fixture helper exceeded bounded execution window', file=sys.stderr)
    sys.exit(98)
sys.exit(status)
PY_BOUNDED_RUN
  ) >"$dir/run.log" 2>&1 || status=$?
  local out="$dir/relative wallet dir"
  if [ "$expected" = pass ]; then
    test "$status" -eq 0 || { cat "$dir/run.log" >&2; return 1; }
    grep -F 'wallet persistence check passed:' "$dir/run.log" >/dev/null
    for line in wallet_persistence_ok=1 wallet_store_pid=987654321 wallet_store_revision=1 \
      wallet_force_quit=SIGKILL wallet_restore_pid=987654322 wallet_restore_revision=1 \
      wallet_restored_match=1 wallet_cleared=1 wallet_after_clear_empty=1 \
      wallet_keychain_entitlement_errors=0 wallet_probe_log_lines=1 wallet_log_stream_stop_status=0; do
      grep -Fx "$line" "$out/wallet-summary.txt" >/dev/null || { echo "missing $line" >&2; cat "$out/wallet-summary.txt" >&2; return 1; }
    done
    for artifact in PickleWalletProbe.dylib wallet-probe-input.json wallet-store-result.json \
      wallet-restore-result.json wallet-store.png wallet-restore.png wallet-log-stream.txt; do
      test -f "$out/$artifact" || { echo "missing artifact $artifact" >&2; return 1; }
    done
    # The plain instance was terminated before the store launch; the store
    # instance died by SIGKILL from the host, never by simctl terminate.
    test ! -f "$dir/alive-987654320"
    test "$(cat "$dir/killed-987654321")" = -KILL
    test "$(cat "$dir/launches")" = 2
    python3 - "$dir/launch-env.jsonl" "$out" <<'PY_ENV'
import json, sys
store, restore = [json.loads(line) for line in open(sys.argv[1], encoding='utf-8')]
out = sys.argv[2]
assert store['PICKLE_WALLET_PROBE_PHASE'] == 'store' and restore['PICKLE_WALLET_PROBE_PHASE'] == 'restore', (store, restore)
assert store['PICKLE_WALLET_PROBE_OWNER'] == restore['PICKLE_WALLET_PROBE_OWNER'], (store, restore)
assert store['DYLD_INSERT_LIBRARIES'] == restore['DYLD_INSERT_LIBRARIES'] == f'{out}/PickleWalletProbe.dylib', (store, restore)
assert store['PICKLE_WALLET_PROBE_INPUT'] == f'{out}/wallet-probe-input.json', store
assert store['PICKLE_WALLET_PROBE_RESULT'] == f'{out}/wallet-store-result.json', store
assert restore['PICKLE_WALLET_PROBE_RESULT'] == f'{out}/wallet-restore-result.json', restore
contents = json.load(open(f'{out}/wallet-probe-input.json', encoding='utf-8'))
stored = json.load(open(f'{out}/wallet-store-result.json', encoding='utf-8'))['stored']
restored = json.load(open(f'{out}/wallet-restore-result.json', encoding='utf-8'))['restored']
assert stored['grants'] == restored['grants'] == contents['grants'], (stored, restored, contents)
assert stored['receipts'] == restored['receipts'] == contents['receipts'], (stored, restored, contents)
assert len(contents['grants']) == 1 and len(contents['receipts']) == 1, contents
header, payload, signature = contents['grants'][0]['compactJws'].split('.')
assert len(signature) == 86 and signature[-1] in 'AQgw', signature
assert json.loads(contents['receipts'][0]['payloadJson']), contents
PY_ENV
    grep -F 'PickleWalletProbe.dylib' "$dir/codesign.log" >/dev/null
  else
    test "$status" -ne 0 || { echo "unexpected pass: $case_name" >&2; return 1; }
    grep -F "$reason" "$dir/run.log" >/dev/null || { cat "$dir/run.log" >&2; return 1; }
    if grep -q 'wallet persistence check passed:' "$dir/run.log"; then
      echo "failed case printed success: $case_name" >&2; return 1
    fi
    # The verdict file is written on every exit path, never left absent.
    grep -Fx 'wallet_persistence_ok=0' "$out/wallet-summary.txt" >/dev/null || { echo "missing wallet_persistence_ok=0" >&2; cat "$out/wallet-summary.txt" >&2; return 1; }
    if [ "$case_name" = entitlements ]; then
      grep -Fx 'wallet_keychain_entitlement_errors=1' "$out/wallet-summary.txt" >/dev/null
    fi
  fi
  if [ "$case_name" = compile-fail ]; then
    # Nothing was launched, so the caller's instance is left to the caller.
    test "$(cat "$dir/running")" = 987654320 || { echo "compile failure touched the running app: $case_name" >&2; return 1; }
  elif [ -f "$dir/running" ]; then
    echo "app instance left running after helper exit: $case_name" >&2; return 1
  fi
  if [ -f "$dir/log.pid" ]; then
    if builtin kill -0 "$(cat "$dir/log.pid")" 2>/dev/null; then
      echo "fixture log worker survived helper cleanup: $case_name" >&2; return 1
    fi
    rm -f "$dir/log.pid"
  fi
  echo "[test_wallet_persistence_check] PASS: $case_name"
}
run_case normal pass ''
run_case compile-fail fail 'wallet probe did not compile'
run_case store-denied fail 'wallet store phase failed: wallet.storage_denied'
run_case probe-silent fail 'wallet probe produced no result within'
run_case restore-lost fail 'wallet did not survive force-quit'
run_case restore-stale fail 'wallet did not survive force-quit'
run_case entitlements fail 'signing entitlements are missing'
run_case screenshot-fail fail 'fixture screenshot failure'
bash -n "$REPO_ROOT/tools/macos-ci/wallet-persistence-check.sh"
echo '[test_wallet_persistence_check] PASS: bash -n'
