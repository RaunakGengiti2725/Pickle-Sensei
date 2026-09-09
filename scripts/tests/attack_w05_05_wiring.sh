#!/usr/bin/env bash
# W05-05 adversarial wiring checks (candidate 9ef411a3): does the shipping path
# actually carry the new evidence and its regression suite, or does the helper
# only exist next to the path? Static, Linux-safe, no Apple runtime claim.
#
#   verify-cloud-runs-wallet-suite   the candidate's own regression test
#                                    scripts/tests/test_wallet_persistence_check.sh
#                                    must be executed by the Linux gate
#                                    (scripts/verify-cloud.sh stage_scripts), like
#                                    its sibling test_simulator_launch_check.sh
#   mac-full-verify-preflights-helper  scripts/mac-full-verify.sh's missing-helper
#                                    preflight must cover the new helper + probe
#                                    source, so a broken checkout fails in
#                                    seconds instead of after the Xcode build
#   helper-modes-tracked             the helper is executable in git (the Mac
#                                    runner checks out fresh)
#   summary-carries-wallet-keys      simulator-launch-check.sh only forwards the
#                                    verdict; the pids/revisions/force-quit
#                                    fields stay in wallet-summary.txt (documented
#                                    expectation, not a break)
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"
ATTACKS=0
BREAKS=0
BROKEN=""
verdict() {
  local name="$1" ok="$2" detail="$3"
  ATTACKS=$((ATTACKS + 1))
  if [ "$ok" = 0 ]; then
    echo "[attack_w05_05_wiring] PASS: $name — $detail"
  else
    BREAKS=$((BREAKS + 1))
    BROKEN="$BROKEN $name"
    echo "[attack_w05_05_wiring] BREAK: $name — $detail"
  fi
}

# 1. The regression suite the implementer cites as red-on-base/green-on-candidate
#    must be part of a CI stage; a test nothing runs is not a gate.
stage="$(sed -n '/^stage_scripts() {/,/^}/p' scripts/verify-cloud.sh)"
ok=0
echo "$stage" | grep -Fq 'scripts/tests/test_simulator_launch_check.sh' || ok=1
echo "$stage" | grep -Fq 'scripts/tests/test_wallet_persistence_check.sh' || ok=1
verdict verify-cloud-runs-wallet-suite "$ok" \
  "stage_scripts lists test_simulator_launch_check.sh AND test_wallet_persistence_check.sh (listed: $(echo "$stage" | grep -c 'scripts/tests/'), wallet suite: $(echo "$stage" | grep -Fc 'test_wallet_persistence_check.sh'))"

# 2. Preflight in the Mac entry point.
preflight="$(sed -n '/^for h in select-simulator.sh/,/^done/p' scripts/mac-full-verify.sh)"
ok=0
echo "$preflight" | grep -Fq 'simulator-launch-check.sh' || ok=1
echo "$preflight" | grep -Fq 'wallet-persistence-check.sh' || ok=1
echo "$preflight" | grep -Fq 'wallet-probe.m' || ok=1
verdict mac-full-verify-preflights-helper "$ok" \
  "missing-helper preflight names wallet-persistence-check.sh and wallet-probe.m ($(echo "$preflight" | tr -s ' \n' ' ' | sed 's/^ //'))"

# 3. Executable bits as committed.
ok=0
mode="$(git ls-files -s tools/macos-ci/wallet-persistence-check.sh | cut -d' ' -f1)"
[ "$mode" = 100755 ] || ok=1
verdict helper-modes-tracked "$ok" "tools/macos-ci/wallet-persistence-check.sh git mode $mode"

# 4. What the top-level launch summary carries about the wallet.
ok=0
grep -Fq 'wallet_persistence_ok=' tools/macos-ci/simulator-launch-check.sh || ok=1
keys="$(grep -o 'wallet_[a-z_]*=' tools/macos-ci/simulator-launch-check.sh | sort -u | tr '\n' ' ')"
verdict summary-carries-wallet-keys "$ok" "launch-summary.txt wallet keys written by simulator-launch-check.sh: ${keys:-none}"

echo "[attack_w05_05_wiring] attacks=$ATTACKS breaks=$BREAKS broken=[${BROKEN# }]"
[ "$BREAKS" -eq 0 ]
