#!/usr/bin/env bash
# Regression tests for scripts/security-scan.sh — the history scan must be a
# function of the commit under test (HEAD's ancestry), never of whatever other
# refs happen to exist in the clone.
#
#   scripts/tests/test_security_scan.sh
#
# Builds a throwaway git repository that carries the WORKING-TREE copies of
# scripts/security-scan.sh, scripts/verify-cloud.sh and .gitleaks.toml, plants a
# synthetic sb_secret_ on an unmerged branch, and asserts on exit codes and the
# summary.json verify-cloud writes. Needs gitleaks v8.30.1 (the script's pinned
# download/cache; set GITLEAKS_BIN or SECURITY_SCAN_CACHE to reuse a binary).
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

PASS=0
FAIL=0
ok() { PASS=$((PASS + 1)); echo "ok   - $*"; }
bad() { FAIL=$((FAIL + 1)); echo "FAIL - $*"; }
check() {
  # check <description> <command...>: passes when the command exits 0
  local desc="$1"
  shift
  if "$@"; then ok "$desc"; else bad "$desc"; fi
}

export GIT_AUTHOR_NAME=test GIT_AUTHOR_EMAIL=test@example.invalid
export GIT_COMMITTER_NAME=test GIT_COMMITTER_EMAIL=test@example.invalid
# A synthetic secret in the format .gitleaks.toml's supabase-secret-api-key rule
# matches (never a real credential; assembled at runtime so this test file does
# not itself trip the gate, and high-entropy so gitleaks' default stopword /
# sequential-character allowlists do not discard it).
PLANTED="sb_secret_$(printf '%s%s' Zq8xLmN2pQr7sT4v Wy1aBc3dEf5gHj6k)"

REPO="$TMP/repo"
git -c init.defaultBranch=main init -q "$REPO"
mkdir -p "$REPO/scripts"
cp "$REPO_ROOT/scripts/security-scan.sh" "$REPO_ROOT/scripts/verify-cloud.sh" "$REPO/scripts/"
cp "$REPO_ROOT/.gitleaks.toml" "$REPO/"
echo "hello" >"$REPO/README.md"
git -C "$REPO" add -A
git -C "$REPO" commit -q -m "base"

# An unmerged, never-checked-out-again branch whose single commit adds the secret.
git -C "$REPO" checkout -q -b planted
printf 'SUPABASE_SECRET=%s\n' "$PLANTED" >"$REPO/leak.env"
git -C "$REPO" add leak.env
git -C "$REPO" commit -q -m "planted (synthetic fixture)"
git -C "$REPO" checkout -q main
echo "more" >>"$REPO/README.md"
git -C "$REPO" add README.md
git -C "$REPO" commit -q -m "clean follow-up"

echo "# clean HEAD, planted branch present ($(git -C "$REPO" rev-list --all --count) commits in clone, $(git -C "$REPO" rev-list HEAD --count) on HEAD)"

LOG="$TMP/history-clean.log"
"$REPO/scripts/security-scan.sh" --history >"$LOG" 2>&1
rc=$?
check "--history exits 0 on a clean HEAD even though another branch carries a secret (got $rc)" [ "$rc" -eq 0 ]
check "--history log states the scanned range (HEAD ancestry + commit count)" \
  grep -Eq 'history: HEAD ancestry.*2 commits' "$LOG"
[ "$rc" -eq 0 ] || sed 's/^/    /' "$LOG"

LOG="$TMP/history-explicit.log"
"$REPO/scripts/security-scan.sh" --history --log-opts "planted" >"$LOG" 2>&1
rc=$?
check "--log-opts is still honoured verbatim (scanning the planted ref finds the secret; got $rc)" [ "$rc" -eq 1 ]

VC_OUT="$TMP/verify-cloud-security"
LOG="$TMP/verify-cloud-security.log"
(cd "$REPO" && VERIFY_ARTIFACTS="$VC_OUT" scripts/verify-cloud.sh --only security) >"$LOG" 2>&1
rc=$?
check "verify-cloud.sh --only security exits 0 on the clean HEAD (got $rc)" [ "$rc" -eq 0 ]
check "summary.json stages[security].status == passed" \
  jq -e '.stages[] | select(.name == "security") | .status == "passed"' "$VC_OUT/summary.json" >/dev/null
[ "$rc" -eq 0 ] || sed 's/^/    /' "$LOG"

# The secret enters HEAD's own ancestry and is removed again: history must fail.
printf 'SUPABASE_SECRET=%s\n' "$PLANTED" >"$REPO/oops.env"
git -C "$REPO" add oops.env
git -C "$REPO" commit -q -m "oops (synthetic fixture committed on main)"
git -C "$REPO" rm -q oops.env
git -C "$REPO" commit -q -m "remove oops"

LOG="$TMP/history-ancestry.log"
"$REPO/scripts/security-scan.sh" --history >"$LOG" 2>&1
rc=$?
check "--history exits 1 when the secret was committed-then-removed in HEAD's ancestry (got $rc)" [ "$rc" -eq 1 ]
check "--history log states the scanned range after the extra commits" \
  grep -Eq 'history: HEAD ancestry.*4 commits' "$LOG"
"$REPO/scripts/security-scan.sh" --tree >"$TMP/tree.log" 2>&1
rc=$?
check "--tree stays clean (the working tree no longer holds the secret; got $rc)" [ "$rc" -eq 0 ]

echo
echo "test_security_scan: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
