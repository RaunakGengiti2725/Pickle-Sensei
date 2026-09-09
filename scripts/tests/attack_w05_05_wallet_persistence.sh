#!/usr/bin/env bash
# Adversarial host tests for tools/macos-ci/wallet-persistence-check.sh (W05-05,
# candidate 9ef411a3). Same fake-tool technique as the candidate's own
# scripts/tests/test_wallet_persistence_check.sh (fake xcrun/codesign/PlistBuddy/
# sleep, a fixture "keychain" file that survives SIGKILL, virtualised app pids),
# but every case sits on a failure boundary the candidate's suite does not
# visit. No Apple runtime behaviour is claimed from Linux: the helper is copied
# byte-for-byte and executed under the calling Bash.
#
# Every attack asserts the helper's own contract ("every failure mode exits
# non-zero and never reports ok; wallet-summary.txt carries the verdict on
# every exit path"). A case that FAILS here is a confirmed break of that
# contract; the script exits non-zero when any attack broke the candidate and
# prints a final tally either way.
#
# Attacks (category in brackets):
#   sigterm-while-waiting      [process death of the harness] SIGTERM (CI cancel)
#                              while waiting for the store result
#   crash-after-store          [crash between steps] app dies after the store
#                              result, before the host SIGKILL
#   survive-sigkill            [process death] SIGKILL does not take effect
#   log-dies-after-kill        [evidence channel failure at a step] unified log
#                              stream dies between the kill and the restore
#   restore-other-owner        [interleaved account switch / owner isolation]
#   restore-replay-previous-run [replay] restore returns a previous run's wallet
#   restore-cleared-envelope-leak [corrupt state -> fabricated empty history]
#   store-revision-zero        [boundary] revision 0 reported after a replace
#   store-revision-bool        [boundary] boolean revision
#   store-result-not-json      [corrupt/partial persisted state]
#   restore-result-not-json    [corrupt/partial persisted state]
#   stale-evidence             [replay of stale artifacts] previous run's ok=1
#                              summary/results already in the artifact dir
#   missing-app-bundle         [boundary] verdict file on the earliest exit path
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
[ -f "${@: -1}" ] || { echo "codesign: no such file: ${@: -1}" >&2; exit 1; }
SH_CODESIGN
# Bash's kill builtin bypasses PATH: virtualise only the impossible app pids the
# fake simctl hands out. `immortal` models a SIGKILL that does not take effect.
cat >"$WORK/bash-env" <<'SH_ENV'
kill() {
  local signal="$1" pid="${2:-}"
  if [ -n "$pid" ] && [ "$pid" -ge 987654320 ] 2>/dev/null; then
    case "$signal" in
      -0) [ -f "$WALLET_FIXTURE_DIR/alive-$pid" ] ;;
      -KILL|-9)
        [ -f "$WALLET_FIXTURE_DIR/alive-$pid" ] || return 1
        echo "$signal" >"$WALLET_FIXTURE_DIR/killed-$pid"
        if [ -f "$WALLET_FIXTURE_DIR/immortal" ]; then return 0; fi
        rm -f "$WALLET_FIXTURE_DIR/alive-$pid"
        if [ -f "$WALLET_FIXTURE_DIR/running" ] && [ "$(cat "$WALLET_FIXTURE_DIR/running")" = "$pid" ]; then
          rm -f "$WALLET_FIXTURE_DIR/running"
        fi
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
import json, os, pathlib, signal, sys, time
root = pathlib.Path(os.environ['WALLET_FIXTURE_DIR'])
case = os.environ['WALLET_FIXTURE_CASE']
args = sys.argv[1:]
with (root / 'commands.jsonl').open('a') as f:
    f.write(json.dumps(args) + '\n')

OTHER_OWNER = '9d9d9d9d-9d9d-4d9d-8d9d-9d9d9d9d9d9d'

def keychain():
    path = root / 'keychain.json'
    return json.loads(path.read_text()) if path.exists() else None

def write_keychain(state):
    (root / 'keychain.json').write_text(json.dumps(state))

def write_result(path, payload):
    tmp = pathlib.Path(path + '.tmp')
    tmp.write_text(json.dumps(payload, indent=2, sort_keys=True))
    tmp.rename(path)

def write_raw(path, text):
    tmp = pathlib.Path(path + '.tmp')
    tmp.write_text(text)
    tmp.rename(path)

if args[:3] == ['--sdk', 'iphonesimulator', '--show-sdk-path']:
    print(str(root / 'iPhoneSimulator.sdk'))
elif args[:3] == ['--sdk', 'iphonesimulator', 'clang']:
    flags = args[3:]
    pathlib.Path(flags[flags.index('-o') + 1]).write_bytes(b'fixture dylib')
elif args[:2] == ['lipo', '-archs']:
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
        (root / 'immortal').unlink(missing_ok=True)
    elif args[0] == 'spawn':
        assert args[2:4] == ['log', 'stream'], args
        (root / 'log.pid').write_text(str(os.getpid()))
        print('FixtureApp: PickleWalletProbe fixture line', flush=True)
        (root / 'log-ready').touch()
        signal.signal(signal.SIGTERM, lambda signum, frame: sys.exit(0))
        while True:
            # The stream "dies on its own" once the store instance was killed.
            if case == 'log-dies-after-kill' and (root / 'killed-987654321').exists():
                print('fixture log stream lost its connection', file=sys.stderr, flush=True)
                sys.exit(5)
            time.sleep(0.01)
    elif args[0] == 'launch':
        assert args[1:] == ['fixture-owned-iphone', 'com.fixture.launch'], args
        assert not (root / 'running').exists(), 'launched while a previous instance was still running'
        env = {k[len('SIMCTL_CHILD_'):]: v for k, v in os.environ.items() if k.startswith('SIMCTL_CHILD_')}
        with (root / 'launch-env.jsonl').open('a') as f:
            f.write(json.dumps(env, sort_keys=True) + '\n')
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
        if case in ('sigterm-while-waiting', 'stale-evidence'):
            sys.exit(0)  # probe never reports
        if case == 'log-dies-after-kill' and phase == 'restore':
            sys.exit(0)  # restore probe still working when the stream dies
        if case == 'store-result-not-json' and phase == 'store':
            write_raw(result_path, '{"phase": "store", "ok": true, "stored": {"revision": 1')
            sys.exit(0)
        if case == 'restore-result-not-json' and phase == 'restore':
            write_raw(result_path, '')
            sys.exit(0)
        stored = keychain()
        result = {'phase': phase, 'ownerId': owner, 'pid': pid, 'bundleId': 'com.fixture.launch'}
        if phase == 'store':
            contents = json.loads(pathlib.Path(env['PICKLE_WALLET_PROBE_INPUT']).read_text())
            result['loaded'] = {'resolved': stored}
            revision = (stored['revision'] if stored else 0) + 1
            if case == 'store-revision-zero':
                revision = 0
            if case == 'store-revision-bool':
                revision = True
            snapshot = {'ownerId': owner, 'revision': revision, 'grants': contents['grants'], 'receipts': contents['receipts']}
            if case == 'restore-replay-previous-run':
                (root / 'previous-run.json').write_text(json.dumps(stored))
            write_keychain(snapshot)
            result['replaced'] = {'resolved': snapshot}
            result['stored'] = snapshot
            result['ok'] = True
            write_result(result_path, result)
            if case == 'crash-after-store':
                (root / f'alive-{pid}').unlink()
                (root / 'running').unlink()
            if case == 'survive-sigkill':
                (root / 'immortal').touch()
        else:
            assert phase == 'restore', phase
            if case == 'restore-replay-previous-run':
                stored = json.loads((root / 'previous-run.json').read_text())
            if case == 'restore-other-owner' and stored is not None:
                stored = dict(stored, ownerId=OTHER_OWNER)
            result['loaded'] = {'resolved': stored}
            if stored is not None:
                result['restored'] = stored
                write_keychain(None)
                result['cleared'] = {'resolved': None}
                after = keychain()
                if case == 'restore-cleared-envelope-leak':
                    after = {'ownerId': owner, 'revision': stored['revision'], 'grants': [], 'receipts': []}
                result['afterClear'] = {'resolved': after}
                result['ok'] = True
            else:
                result['failure'] = 'no wallet stored'
                result['ok'] = False
            write_result(result_path, result)
    elif args[0] == 'io':
        assert args[2] == 'screenshot', args
        pathlib.Path(args[3]).write_bytes(b'fixture screenshot')
    else:
        raise AssertionError(args)
PY_XCRUN
cat >"$WORK/bin/sleep" <<'PY_SLEEP'
#!/usr/bin/env python3
# Synchronous fixture: only wait for the log worker's readiness, except for the
# signal case, which needs a real (short) window while the helper is waiting.
import os, pathlib, sys, time
root = pathlib.Path(os.environ['WALLET_FIXTURE_DIR'])
if os.environ['WALLET_FIXTURE_CASE'] == 'sigterm-while-waiting':
    time.sleep(0.05)
if (root / 'log.pid').exists():
    deadline = time.monotonic() + 3
    while not (root / 'log-ready').exists():
        if time.monotonic() > deadline:
            raise SystemExit('fixture log worker synchronization timed out')
        time.sleep(0.005)
PY_SLEEP
chmod +x "$WORK/bin/"*

ATTACKS=0
BREAKS=0
BROKEN_CASES=""

# run_helper <case> <app path> -> helper exit status in $STATUS; runs bounded.
run_helper() {
  local case_name="$1" app_path="$2" dir="$WORK/cases/$1"
  STATUS=0
  (
    cd "$dir"
    BASH_ENV="$WORK/bash-env" WALLET_FIXTURE_DIR="$dir" WALLET_FIXTURE_CASE="$case_name" \
      PICKLE_CI_PLIST_BUDDY="$WORK/bin/PlistBuddy" PATH="$WORK/bin:$PATH" \
      python3 - "$case_name" "$dir" "$BASH" "$WORK/helper/wallet-persistence-check.sh" \
      fixture-owned-iphone com.fixture.launch "$app_path" 'relative wallet dir' 987654320 <<'PY_BOUNDED_RUN'
import os, pathlib, signal, subprocess, sys, time
case, root = sys.argv[1], pathlib.Path(sys.argv[2])
child = subprocess.Popen(sys.argv[3:], start_new_session=True)
if case == 'sigterm-while-waiting':
    # CI cancellation: the helper is inside wait_for_result for the store phase.
    deadline = time.monotonic() + 10
    while not (root / 'launch-env.jsonl').exists():
        if child.poll() is not None or time.monotonic() > deadline:
            print('fixture: helper never reached the store launch', file=sys.stderr)
            sys.exit(97)
        time.sleep(0.01)
    time.sleep(0.3)
    os.kill(child.pid, signal.SIGTERM)
try:
    status = child.wait(timeout=15)
except subprocess.TimeoutExpired:
    os.killpg(child.pid, signal.SIGKILL)
    child.wait(timeout=3)
    print('fixture helper exceeded bounded execution window', file=sys.stderr)
    sys.exit(98)
sys.exit(128 - status if status < 0 else status)
PY_BOUNDED_RUN
  ) >"$dir/run.log" 2>&1 || STATUS=$?
}

# attack <case> <description> <check function>
attack() {
  local case_name="$1" description="$2" check="$3" dir="$WORK/cases/$1"
  ATTACKS=$((ATTACKS + 1))
  mkdir -p "$dir"
  touch "$dir/alive-987654320"
  echo 987654320 >"$dir/running"
  OUT="$dir/relative wallet dir"
  SUMMARY="$OUT/wallet-summary.txt"
  RUN_LOG="$dir/run.log"
  DIR="$dir"
  local app_path="$WORK/Test App.app"
  if [ "$case_name" = missing-app-bundle ]; then app_path="$WORK/No Such App.app"; fi
  local verdict=PASS
  if ! "$check"; then verdict=BREAK; fi
  if [ -f "$dir/log.pid" ]; then
    if builtin kill -0 "$(cat "$dir/log.pid")" 2>/dev/null; then
      echo "  [leak] fixture log worker survived helper exit"
      verdict=BREAK
    fi
    rm -f "$dir/log.pid"
  fi
  if [ "$verdict" = BREAK ]; then
    BREAKS=$((BREAKS + 1))
    BROKEN_CASES="$BROKEN_CASES $case_name"
    echo "[attack_w05_05_wallet_persistence] BREAK: $case_name — $description"
    echo "  helper exit status: $STATUS"
    sed 's/^/  | /' "$RUN_LOG" | tail -15
    if [ -f "$SUMMARY" ]; then sed 's/^/  summary| /' "$SUMMARY"; else echo "  summary| (wallet-summary.txt absent)"; fi
  else
    echo "[attack_w05_05_wallet_persistence] PASS: $case_name — $description (helper exit $STATUS)"
  fi
}

# Shared contract: non-zero exit, no success line, verdict file present with ok=0.
expect_failed_closed() {
  local ok=0
  if [ "$STATUS" -eq 0 ]; then echo "  [break] helper exited 0"; ok=1; fi
  if grep -q 'wallet persistence check passed:' "$RUN_LOG"; then echo "  [break] success line printed"; ok=1; fi
  if [ ! -f "$SUMMARY" ]; then
    echo "  [break] wallet-summary.txt absent (no machine-readable verdict)"; ok=1
  elif ! grep -Fxq 'wallet_persistence_ok=0' "$SUMMARY"; then
    echo "  [break] wallet_persistence_ok=0 missing from summary"; ok=1
  fi
  return $ok
}
expect_reason() {
  grep -Fq "$1" "$RUN_LOG" || { echo "  [break] expected reason not reported: $1"; return 1; }
}
expect_no_instance_left() {
  if [ -f "$DIR/running" ]; then echo "  [break] app instance left running (pid $(cat "$DIR/running"))"; return 1; fi
}
expect_launches() {
  local n=0
  [ -f "$DIR/launches" ] && n="$(cat "$DIR/launches")"
  [ "$n" = "$1" ] || { echo "  [break] expected $1 launch(es), saw $n"; return 1; }
}

check_sigterm() {
  run_helper sigterm-while-waiting "$WORK/Test App.app"
  local ok=0
  expect_failed_closed || ok=1
  expect_no_instance_left || ok=1
  expect_launches 1 || ok=1
  return $ok
}
check_crash_after_store() {
  run_helper crash-after-store "$WORK/Test App.app"
  local ok=0
  expect_failed_closed || ok=1
  expect_launches 1 || ok=1
  # The verdict must not claim a force-quit that never happened.
  if grep -Fxq 'wallet_force_quit=SIGKILL' "$SUMMARY" 2>/dev/null; then echo "  [break] summary claims force_quit=SIGKILL"; ok=1; fi
  return $ok
}
check_survive_sigkill() {
  run_helper survive-sigkill "$WORK/Test App.app"
  local ok=0
  expect_failed_closed || ok=1
  expect_reason 'survived SIGKILL' || ok=1
  expect_launches 1 || ok=1
  expect_no_instance_left || ok=1
  return $ok
}
check_log_dies() {
  run_helper log-dies-after-kill "$WORK/Test App.app"
  local ok=0
  expect_failed_closed || ok=1
  expect_reason 'app log stream exited before requested termination' || ok=1
  expect_no_instance_left || ok=1
  return $ok
}
check_other_owner() {
  run_helper restore-other-owner "$WORK/Test App.app"
  local ok=0
  expect_failed_closed || ok=1
  expect_reason 'owner differs from the probe owner' || ok=1
  grep -Fxq 'wallet_restored_match=0' "$SUMMARY" 2>/dev/null || { echo "  [break] restored_match not 0"; ok=1; }
  return $ok
}
check_replay() {
  # An earlier, interrupted run left its wallet (old nonce) at revision 5.
  python3 - "$DIR/keychain.json" <<'PY_SEED'
import json, sys
nonce = 'deadbeef00000001'
json.dump({
    'ownerId': '0c1c0c1c-0c1c-4c1c-8c1c-0c1c0c1c0c1c', 'revision': 5,
    'grants': [{'grantId': f'ci-grant-{nonce}', 'compactJws': 'eyJhbGciOiJFUzI1NiIsInR5cCI6IkpXVCJ9.e30.' + 'A' * 86}],
    'receipts': [{'receiptId': f'ci-receipt-{nonce}', 'kind': 'result', 'payloadJson': json.dumps({'nonce': nonce})}],
}, open(sys.argv[1], 'w'))
PY_SEED
  run_helper restore-replay-previous-run "$WORK/Test App.app"
  local ok=0
  expect_failed_closed || ok=1
  expect_reason 'wallet did not survive force-quit' || ok=1
  expect_reason 'revision differs after relaunch' || ok=1
  expect_reason 'grants differ from the stored input' || ok=1
  return $ok
}
check_cleared_leak() {
  run_helper restore-cleared-envelope-leak "$WORK/Test App.app"
  local ok=0
  expect_failed_closed || ok=1
  expect_reason 'wallet clear after restore failed' || ok=1
  grep -Fxq 'wallet_after_clear_empty=0' "$SUMMARY" 2>/dev/null || { echo "  [break] after_clear_empty not 0"; ok=1; }
  return $ok
}
check_revision_zero() {
  run_helper store-revision-zero "$WORK/Test App.app"
  # The product's replace() always yields revision >= 1 (nextRevision = max(stored, fence) + 1);
  # a store snapshot at revision 0 can only be a product or probe defect and must not be certified.
  expect_failed_closed
}
check_revision_bool() {
  run_helper store-revision-bool "$WORK/Test App.app"
  expect_failed_closed
}
check_store_not_json() {
  run_helper store-result-not-json "$WORK/Test App.app"
  local ok=0
  expect_failed_closed || ok=1
  expect_launches 1 || ok=1
  expect_no_instance_left || ok=1
  return $ok
}
check_restore_not_json() {
  run_helper restore-result-not-json "$WORK/Test App.app"
  local ok=0
  expect_failed_closed || ok=1
  expect_no_instance_left || ok=1
  return $ok
}
check_stale_evidence() {
  mkdir -p "$OUT"
  printf 'wallet_persistence_ok=1\nwallet_restored_match=1\nwallet_cleared=1\nwallet_after_clear_empty=1\n' >"$SUMMARY"
  printf '{"ok": true, "stored": {"revision": 1}}\n' >"$OUT/wallet-store-result.json"
  printf '{"ok": true, "restored": {"revision": 1}, "cleared": {"resolved": null}, "afterClear": {"resolved": null}}\n' >"$OUT/wallet-restore-result.json"
  printf 'restore_revision=1\nrestored_match=1\ncleared=1\nafter_clear_empty=1\ndetail=ok\n' >"$OUT/wallet-compare.txt"
  run_helper stale-evidence "$WORK/Test App.app"
  local ok=0
  expect_failed_closed || ok=1
  expect_reason 'wallet probe produced no result within' || ok=1
  if grep -Fxq 'wallet_restored_match=1' "$SUMMARY" 2>/dev/null; then echo "  [break] stale restored_match=1 survived"; ok=1; fi
  if [ -f "$OUT/wallet-store-result.json" ]; then echo "  [break] stale store result survived the run"; ok=1; fi
  return $ok
}
check_missing_app() {
  run_helper missing-app-bundle "$WORK/No Such App.app"
  local ok=0
  expect_failed_closed || ok=1
  expect_reason 'app bundle not found' || ok=1
  return $ok
}

attack sigterm-while-waiting 'SIGTERM (CI cancellation) while waiting for the store result: fail closed, stop the app and the log stream' check_sigterm
attack crash-after-store 'app dies after the store result and before the host SIGKILL' check_crash_after_store
attack survive-sigkill 'SIGKILL does not take effect: no restore launch, fail closed' check_survive_sigkill
attack log-dies-after-kill 'unified log stream dies between kill and restore' check_log_dies
attack restore-other-owner 'restored snapshot carries another owner id (cross-account isolation)' check_other_owner
attack restore-replay-previous-run 'restore returns a previous run'"'"'s wallet (replay / rollback)' check_replay
attack restore-cleared-envelope-leak 'load after clear resolves a cleared envelope as an empty wallet' check_cleared_leak
attack store-revision-zero 'store snapshot at revision 0 must not be certified' check_revision_zero
attack store-revision-bool 'store snapshot with boolean revision must not be certified' check_revision_bool
attack store-result-not-json 'store result file is truncated JSON' check_store_not_json
attack restore-result-not-json 'restore result file is empty' check_restore_not_json
attack stale-evidence 'previous run left an ok=1 summary and results in the artifact dir' check_stale_evidence
attack missing-app-bundle 'verdict file on the earliest exit path (app bundle missing)' check_missing_app

echo "[attack_w05_05_wallet_persistence] attacks=$ATTACKS breaks=$BREAKS broken=[${BROKEN_CASES# }]"
[ "$BREAKS" -eq 0 ]
