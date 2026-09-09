#!/usr/bin/env bash
# W05-05 adversarial audit of a REAL Mac run's launch artifacts (the `launch/`
# directory inside the mac-full-verify-* GitHub Actions artifact). Runs on Linux
# against downloaded files only: it makes no Apple runtime claim of its own, it
# checks that the evidence the run produced is internally consistent and that
# each artifact carries distinct information.
#
#   usage: scripts/tests/attack_w05_05_artifact_audit.sh <path/to/launch>
#
#   verdict-consistency      wallet-summary.txt ok=1 agrees with launch-summary.txt
#                            and with both probe result files (ok=true, phases,
#                            distinct pids, SIGKILL recorded)
#   restore-matches-store    restore `loaded` == store `stored`, contents == input,
#                            owner == wallet-summary.txt owner
#   probe-log-both-pids      PickleWalletProbe lines from the store AND restore pid
#   screenshots-distinct     wallet-store.png and wallet-restore.png must not be the
#                            same bytes: identical captures carry no phase-specific
#                            evidence (the objective asks for screenshots as proof)
set -euo pipefail
LAUNCH="${1:?launch artifact directory}"
W="$LAUNCH/wallet"
ATTACKS=0
BREAKS=0
BROKEN=""
verdict() {
  local name="$1" ok="$2" detail="$3"
  ATTACKS=$((ATTACKS + 1))
  if [ "$ok" = 0 ]; then
    echo "[attack_w05_05_artifact_audit] PASS: $name — $detail"
  else
    BREAKS=$((BREAKS + 1))
    BROKEN="$BROKEN $name"
    echo "[attack_w05_05_artifact_audit] BREAK: $name — $detail"
  fi
}
for f in "$W/wallet-summary.txt" "$LAUNCH/launch-summary.txt" "$W/wallet-store-result.json" \
  "$W/wallet-restore-result.json" "$W/wallet-probe-input.json" "$W/wallet-log-stream.txt" \
  "$W/wallet-store.png" "$W/wallet-restore.png"; do
  [ -f "$f" ] || { echo "::error::missing artifact $f"; exit 2; }
done

ok=0
detail="$(python3 - "$W" "$LAUNCH" <<'PY'
import json, sys
w, launch = sys.argv[1], sys.argv[2]
def kv(path):
    return dict(line.rstrip('\n').split('=', 1) for line in open(path) if '=' in line)
ws, ls = kv(f'{w}/wallet-summary.txt'), kv(f'{launch}/launch-summary.txt')
store = json.load(open(f'{w}/wallet-store-result.json'))
restore = json.load(open(f'{w}/wallet-restore-result.json'))
problems = []
if ws.get('wallet_persistence_ok') != '1': problems.append('wallet ok!=1')
if ls.get('wallet_persistence_ok') != ws.get('wallet_persistence_ok'): problems.append('launch summary disagrees')
if store.get('ok') is not True or store.get('phase') != 'store': problems.append('store result not ok/store')
if restore.get('ok') is not True or restore.get('phase') != 'restore': problems.append('restore result not ok/restore')
if str(store.get('pid')) != ws.get('wallet_store_pid'): problems.append('store pid mismatch')
if str(restore.get('pid')) != ws.get('wallet_restore_pid'): problems.append('restore pid mismatch')
if store.get('pid') == restore.get('pid'): problems.append('same pid for both phases')
if ws.get('wallet_force_quit') != 'SIGKILL': problems.append('force_quit != SIGKILL')
if ws.get('wallet_keychain_entitlement_errors') != '0': problems.append('entitlement errors')
rev = store['stored']['revision']
if not (isinstance(rev, int) and not isinstance(rev, bool) and rev >= 1): problems.append(f'store revision {rev!r} not a positive integer')
print(f"store pid {store.get('pid')} rev {rev} -> restore pid {restore.get('pid')}; " + ('; '.join(problems) or 'consistent'))
sys.exit(1 if problems else 0)
PY
)" || ok=1
verdict verdict-consistency "$ok" "$detail"

ok=0
detail="$(python3 - "$W" <<'PY'
import json, sys
w = sys.argv[1]
store = json.load(open(f'{w}/wallet-store-result.json'))
restore = json.load(open(f'{w}/wallet-restore-result.json'))
inp = json.load(open(f'{w}/wallet-probe-input.json'))
owner = dict(line.rstrip('\n').split('=', 1) for line in open(f'{w}/wallet-summary.txt') if '=' in line)['wallet_owner']
problems = []
stored = store['stored']; loaded = restore['loaded']['resolved']
if loaded != stored: problems.append('restore loaded != store stored')
if not (stored['ownerId'] == store.get('ownerId') == restore.get('ownerId') == owner): problems.append('owner mismatch vs summary')
if stored['grants'] != inp['grants'] or stored['receipts'] != inp['receipts']: problems.append('grants/receipts differ from input')
if restore['cleared']['resolved'] is not None or restore['afterClear']['resolved'] is not None: problems.append('slot not empty after clear')
print('; '.join(problems) or f"owner {owner} rev {stored['revision']} identical across kill, cleared, empty")
sys.exit(1 if problems else 0)
PY
)" || ok=1
verdict restore-matches-store "$ok" "$detail"

store_pid="$(sed -n 's/^wallet_store_pid=//p' "$W/wallet-summary.txt")"
restore_pid="$(sed -n 's/^wallet_restore_pid=//p' "$W/wallet-summary.txt")"
s_lines="$(grep -c "\[$store_pid:.*PickleWalletProbe" "$W/wallet-log-stream.txt" || true)"
r_lines="$(grep -c "\[$restore_pid:.*PickleWalletProbe" "$W/wallet-log-stream.txt" || true)"
ok=0
[ "${s_lines:-0}" -ge 1 ] && [ "${r_lines:-0}" -ge 1 ] || ok=1
verdict probe-log-both-pids "$ok" "PickleWalletProbe log lines: store pid $store_pid=$s_lines, restore pid $restore_pid=$r_lines"

ok=0
if cmp -s "$W/wallet-store.png" "$W/wallet-restore.png"; then ok=1; fi
verdict screenshots-distinct "$ok" "wallet-store.png vs wallet-restore.png: $(cmp -s "$W/wallet-store.png" "$W/wallet-restore.png" && echo "byte-identical ($(wc -c <"$W/wallet-store.png") bytes)" || echo differ)"

echo "[attack_w05_05_artifact_audit] attacks=$ATTACKS breaks=$BREAKS broken=[${BROKEN# }]"
[ "$BREAKS" -eq 0 ]
