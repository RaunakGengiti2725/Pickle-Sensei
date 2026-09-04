#!/usr/bin/env bash
# Scenario B — SECURITY_SCAN_CACHE pointed at a READ-ONLY directory with an
# empty cache, plus two corrupt-state variants.
#
#   B1 read-only cache, online   → download succeeds but cannot be installed;
#                                  must exit 2 (setup failure), never scan.
#   B2 corrupt (random bytes) cached binary, offline → must exit 2.
#   B3 TAMPERED cached binary (prints "8.30.1", never scans) offline
#                                → accepted: reports_version() is the only
#                                  trust check on the cache (BROKEN).
# B1 needs network access to github.com; it is skipped (INCONCLUSIVE) when
# ATTACK_OFFLINE=1.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
cd "$REPO_ROOT"

fails=()

# --- B1 -------------------------------------------------------------------
if [ "${ATTACK_OFFLINE:-0}" = 1 ]; then
  log "B1 skipped (ATTACK_OFFLINE=1)"
else
  ro="$(mktemp -d)"
  track "$ro"
  chmod 0555 "$ro"
  rc=0
  SECURITY_SCAN_CACHE="$ro" scan b1-readonly-cache --tree || rc=$?
  chmod 0755 "$ro"
  if [ "$rc" = 2 ] && ! grep -q 'scanning tree' "$ATTACK_OUT/b1-readonly-cache.log"; then
    log "B1 held: exit 2 before any scan"
  else
    fails+=("B1 read-only cache: exit $rc (expected 2 with no scan)")
  fi
fi

# --- B2 -------------------------------------------------------------------
c2="$(mktemp -d)"
track "$c2"
mkdir -p "$c2/gitleaks-8.30.1"
head -c 65536 /dev/urandom > "$c2/gitleaks-8.30.1/gitleaks"
chmod 0755 "$c2/gitleaks-8.30.1/gitleaks"
rc=0
SECURITY_SCAN_OFFLINE=1 SECURITY_SCAN_CACHE="$c2" scan b2-corrupt-cache --tree || rc=$?
if [ "$rc" = 2 ]; then
  log "B2 held: corrupt cached binary rejected, exit 2"
else
  fails+=("B2 corrupt cache: exit $rc (expected 2)")
fi

# --- B3 -------------------------------------------------------------------
c3="$(mktemp -d)"
track "$c3"
mkdir -p "$c3/gitleaks-8.30.1"
cat > "$c3/gitleaks-8.30.1/gitleaks" <<'EOF'
#!/bin/sh
# Impostor: answers the version probe, scans nothing, always "clean".
[ "$1" = version ] && { echo 8.30.1; exit 0; }
exit 0
EOF
chmod 0755 "$c3/gitleaks-8.30.1/gitleaks"
probe="$REPO_ROOT/.attack-probe-b3.txt"
track "$probe"
printf 'AWS_ACCESS_KEY_ID=%s\n' "$(fake_aws_key)" > "$probe"
rc=0
SECURITY_SCAN_OFFLINE=1 SECURITY_SCAN_CACHE="$c3" scan b3-tampered-cache --tree || rc=$?
rm -f "$probe"
if [ "$rc" = 0 ]; then
  fails+=("B3 tampered cache: impostor binary trusted on version string alone — PASS with a planted key (exit 0)")
else
  log "B3 held: tampered cache rejected (exit $rc)"
fi

assert_clean_tree
if [ "${#fails[@]}" = 0 ]; then
  held "read-only and corrupt caches fail closed with exit 2; tampered cache rejected"
fi
printf '%s\n' "${fails[@]}"
broken "${#fails[@]} cache-trust failure(s)"
