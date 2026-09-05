#!/usr/bin/env bash
# Regression test: scripts/security-scan.sh must only run a gitleaks binary it
# has verified against the pinned digest for GITLEAKS_VERSION — whether it comes
# from GITLEAKS_BIN, from SECURITY_SCAN_CACHE, or from PATH. An executable that
# merely prints the pinned version string (or nothing at all) must be a SETUP
# FAILURE (exit 2), never a green gate (exit 0) over a tree that holds a secret.
#
# Runs against a throwaway repo with one committed canary so the three
# impostor paths are judged with the same input the real scanner fails on.
#   scripts/tests/security-scan-binary-trust.sh
# Exit 0 = all assertions hold; 1 = regression; 2 = setup failure.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCAN="$REPO_ROOT/scripts/security-scan.sh"
CONFIG="$REPO_ROOT/.gitleaks.toml"

log() { printf '[security-scan-binary-trust] %s\n' "$*" >&2; }
die() {
  log "SETUP ERROR: $*"
  exit 2
}

[ -x "$SCAN" ] || die "missing $SCAN"
[ -f "$CONFIG" ] || die "missing $CONFIG"

PINNED_VERSION="$(sed -n 's/^GITLEAKS_VERSION="\([^"]*\)"$/\1/p' "$SCAN")"
[ -n "$PINNED_VERSION" ] || die "could not read GITLEAKS_VERSION from $SCAN"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

write_secret() {
  # A Stripe live-key shape gitleaks' default ruleset flags. Assembled from
  # parts so this test file itself never contains the pattern.
  printf 'const apiKey = "sk_%s_%s";\n' live 51H8xK2eZvKYlo2C0aBcDeFgHiJkLmNoPq >"$1"
}

fixture() {
  # $1 = repo dir: one commit, one committed canary.
  local dir="$1"
  mkdir -p "$dir/scripts"
  git -c init.defaultBranch=main init -q "$dir"
  cp "$CONFIG" "$dir/.gitleaks.toml"
  cp "$SCAN" "$dir/scripts/security-scan.sh"
  chmod +x "$dir/scripts/security-scan.sh"
  (
    cd "$dir"
    git config user.email test@example.invalid
    git config user.name test
    git config commit.gpgsign false
    write_secret leaked.ts
    git add -A
    git commit -qm "canary"
  )
}

# An impostor that answers `version` with the pinned string and "scans" clean.
make_impostor() {
  local path="$1"
  mkdir -p "$(dirname "$path")"
  printf '#!/bin/sh\n[ "$1" = version ] && echo %s\nexit 0\n' "$PINNED_VERSION" >"$path"
  chmod +x "$path"
}

run_tree_scan() {
  # $1 = label, remaining = env assignments; echoes the exit code.
  local label="$1" rc=0
  shift
  (
    cd "$WORK/repo"
    env "$@" scripts/security-scan.sh --tree >"$WORK/$label.log" 2>&1
  ) || rc=$?
  echo "$rc"
}

fixture "$WORK/repo"
fail=0

# 0. Control: the real pinned scanner (fresh cache → self-download + tarball
#    checksum) reports the canary. Without this the impostor checks prove
#    nothing, so a failure here is a setup error, not a verdict.
REAL_CACHE="$WORK/real-cache"
rc="$(run_tree_scan control SECURITY_SCAN_CACHE="$REAL_CACHE")"
if [ "$rc" = 1 ]; then
  log "PASS: control — pinned gitleaks v${PINNED_VERSION} reports the canary (exit 1)"
else
  cat "$WORK/control.log" >&2
  die "control scan exited $rc (expected 1: canary reported by the real scanner)"
fi

# 1. GITLEAKS_BIN pointing at an executable that is not the pinned scanner.
rc="$(run_tree_scan bin-true GITLEAKS_BIN=/bin/true SECURITY_SCAN_CACHE="$REAL_CACHE")"
if [ "$rc" = 2 ]; then
  log "PASS: GITLEAKS_BIN=/bin/true is a setup failure (exit 2)"
else
  log "FAIL: GITLEAKS_BIN=/bin/true exited $rc over a tree with a secret (expected 2)"
  cat "$WORK/bin-true.log" >&2
  fail=1
fi

# 2. A same-version impostor already sitting in SECURITY_SCAN_CACHE.
POISONED="$WORK/poisoned-cache"
make_impostor "$POISONED/gitleaks-${PINNED_VERSION}/gitleaks"
rc="$(run_tree_scan poisoned-cache SECURITY_SCAN_CACHE="$POISONED")"
if [ "$rc" = 2 ]; then
  log "PASS: same-version impostor in SECURITY_SCAN_CACHE is a setup failure (exit 2)"
else
  log "FAIL: cache impostor exited $rc over a tree with a secret (expected 2)"
  cat "$WORK/poisoned-cache.log" >&2
  fail=1
fi

# 3. A same-version impostor first on PATH, with an empty cache.
IMP="$WORK/path-impostor"
make_impostor "$IMP/gitleaks"
rc="$(run_tree_scan path-impostor SECURITY_SCAN_CACHE="$WORK/empty-cache" PATH="$IMP:$PATH")"
if [ "$rc" = 2 ]; then
  log "PASS: same-version impostor on PATH is a setup failure (exit 2)"
else
  log "FAIL: PATH impostor exited $rc over a tree with a secret (expected 2)"
  cat "$WORK/path-impostor.log" >&2
  fail=1
fi

# 4. The verified binary is still accepted from every source the wrapper
#    consults: the cache it filled itself, GITLEAKS_BIN, and PATH.
REAL_BIN="$REAL_CACHE/gitleaks-${PINNED_VERSION}/gitleaks"
[ -x "$REAL_BIN" ] || die "control run left no binary at $REAL_BIN"
rc="$(run_tree_scan real-bin GITLEAKS_BIN="$REAL_BIN" SECURITY_SCAN_CACHE="$WORK/empty-cache")"
if [ "$rc" = 1 ]; then
  log "PASS: verified binary via GITLEAKS_BIN still scans (canary reported, exit 1)"
else
  log "FAIL: verified GITLEAKS_BIN exited $rc (expected 1: canary reported)"
  cat "$WORK/real-bin.log" >&2
  fail=1
fi
rc="$(run_tree_scan real-path SECURITY_SCAN_CACHE="$WORK/empty-cache" PATH="$(dirname "$REAL_BIN"):$PATH")"
if [ "$rc" = 1 ]; then
  log "PASS: verified binary on PATH still scans (canary reported, exit 1)"
else
  log "FAIL: verified PATH binary exited $rc (expected 1: canary reported)"
  cat "$WORK/real-path.log" >&2
  fail=1
fi

if [ "$fail" = 0 ]; then
  log "PASS: only the digest-verified pinned gitleaks can run the gate"
else
  log "FAIL: an unverified gitleaks binary can pass the security gate"
fi
exit "$fail"
