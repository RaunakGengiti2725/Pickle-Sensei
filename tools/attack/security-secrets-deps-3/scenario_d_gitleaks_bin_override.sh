#!/usr/bin/env bash
# Scenario D — `GITLEAKS_BIN=/bin/true scripts/security-scan.sh --tree` with a
# planted key in the tree, then the same through `verify-cloud.sh --only security`.
#
# Expected: the gate refuses a binary that is not gitleaks v8.30.1 (at least
# when CI=true) — exit 2, and verify-cloud records `failed`.
# Reproduced: a warning is logged, /bin/true "scans" nothing, the script prints
# `PASS: no secrets detected` with exit 0, and verify-cloud marks the security
# stage `passed` (summary.json "ok": true).
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
cd "$REPO_ROOT"

probe="$REPO_ROOT/.attack-probe-d.txt"
track "$probe"
printf 'AWS_ACCESS_KEY_ID=%s\n' "$(fake_aws_key)" > "$probe"

fails=()
for ci in "" 1; do
  rc=0
  CI="$ci" GITLEAKS_BIN=/bin/true scan "d-bin-true-ci${ci:-0}" --tree || rc=$?
  if [ "$rc" = 0 ]; then
    fails+=("CI=${ci:-unset}: GITLEAKS_BIN=/bin/true accepted → PASS, exit 0 with a planted key present")
  fi
done

vc="$ATTACK_OUT/d-verify-cloud"
rm -rf "$vc"
rc=0
VERIFY_ARTIFACTS="$vc" GITLEAKS_BIN=/bin/true "$REPO_ROOT/scripts/verify-cloud.sh" --only security > "$ATTACK_OUT/d-verify-cloud.log" 2>&1 || rc=$?
log "verify-cloud --only security → exit $rc ($vc/summary.json)"
status="$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(next(s["status"] for s in d["stages"] if s["name"]=="security"))' "$vc/summary.json" 2>/dev/null || echo unknown)"
[ "$status" = failed ] || fails+=("verify-cloud --only security recorded '$status' (exit $rc) with a non-gitleaks GITLEAKS_BIN")

rm -f "$probe"
assert_clean_tree
if [ "${#fails[@]}" = 0 ]; then
  held "non-8.30.1 GITLEAKS_BIN refused; verify-cloud recorded failed"
fi
printf '%s\n' "${fails[@]}"
broken "GITLEAKS_BIN is trusted without version enforcement"
