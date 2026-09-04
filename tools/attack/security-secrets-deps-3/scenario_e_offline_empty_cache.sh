#!/usr/bin/env bash
# Scenario E — `SECURITY_SCAN_OFFLINE=1 SECURITY_SCAN_CACHE=$(mktemp -d)
# scripts/security-scan.sh` must exit 2, and `verify-cloud.sh --only security`
# must record the stage as `failed` (not `unavailable`, not `passed`).
#
# PATH is scrubbed of any gitleaks so the offline fallback (line 147 of
# security-scan.sh) cannot rescue the run. Two extra variants:
#   E2 a PATH gitleaks reporting the WRONG version → still exit 2 (HELD)
#   E3 a PATH impostor reporting "8.30.1" that never scans → trusted (BROKEN,
#      same class as scenario B3: version string is the only trust check)
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
cd "$REPO_ROOT"

clean_path="$(mktemp -d)"
track "$clean_path"
for tool in bash sh env git python3 mktemp mkdir rm cat tr head awk sed date printf uname tar curl chmod mv grep cut dirname basename; do
  p="$(command -v "$tool" 2>/dev/null || true)"
  [ -n "$p" ] && ln -sf "$p" "$clean_path/$tool"
done
[ -x "$clean_path/git" ] || inconclusive "git missing from scrubbed PATH"

fails=()

# --- E1 -------------------------------------------------------------------
cache="$(mktemp -d)"
track "$cache"
rc=0
PATH="$clean_path" SECURITY_SCAN_OFFLINE=1 SECURITY_SCAN_CACHE="$cache" scan e1-offline-empty || rc=$?
[ "$rc" = 2 ] || fails+=("E1: exit $rc (expected 2)")

vc="$ATTACK_OUT/e-verify-cloud"
rm -rf "$vc"
rc=0
PATH="$clean_path" VERIFY_ARTIFACTS="$vc" SECURITY_SCAN_OFFLINE=1 SECURITY_SCAN_CACHE="$cache" \
  "$REPO_ROOT/scripts/verify-cloud.sh" --only security > "$ATTACK_OUT/e-verify-cloud.log" 2>&1 || rc=$?
log "verify-cloud --only security → exit $rc ($vc/summary.json)"
status="$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(next(s["status"] for s in d["stages"] if s["name"]=="security"))' "$vc/summary.json" 2>/dev/null || echo unknown)"
[ "$status" = failed ] && [ "$rc" != 0 ] || fails+=("E1 verify-cloud recorded '$status' exit $rc (expected failed, nonzero)")

# --- E2 -------------------------------------------------------------------
fake="$(mktemp -d)"
track "$fake"
printf '#!/bin/sh\n[ "$1" = version ] && { echo 8.29.0; exit 0; }\nexit 0\n' > "$fake/gitleaks"
chmod 0755 "$fake/gitleaks"
rc=0
PATH="$fake:$clean_path" SECURITY_SCAN_OFFLINE=1 SECURITY_SCAN_CACHE="$cache" scan e2-path-wrong-version --tree || rc=$?
[ "$rc" = 2 ] || fails+=("E2: PATH gitleaks reporting 8.29.0 → exit $rc (expected 2)")

# --- E3 -------------------------------------------------------------------
printf '#!/bin/sh\n[ "$1" = version ] && { echo 8.30.1; exit 0; }\nexit 0\n' > "$fake/gitleaks"
probe="$REPO_ROOT/.attack-probe-e.txt"
track "$probe"
printf 'AWS_ACCESS_KEY_ID=%s\n' "$(fake_aws_key)" > "$probe"
rc=0
PATH="$fake:$clean_path" SECURITY_SCAN_OFFLINE=1 SECURITY_SCAN_CACHE="$cache" scan e3-path-impostor --tree || rc=$?
rm -f "$probe"
[ "$rc" = 0 ] && fails+=("E3: PATH impostor reporting 8.30.1 trusted → PASS exit 0 with a planted key")

assert_clean_tree
if [ "${#fails[@]}" = 0 ]; then
  held "offline empty cache exits 2 and verify-cloud records failed; impostors rejected"
fi
printf '%s\n' "${fails[@]}"
# E1/E2 are the assigned expectations; E3 is the extra trust-boundary probe.
broken "${#fails[@]} failure(s) — see list above"
