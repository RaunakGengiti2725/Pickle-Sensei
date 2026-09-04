#!/usr/bin/env bash
# Regression tests for scripts/security-scan.sh — history scope.
#
# The gate's verdict must be a function of the commit under test: `--history`
# scans HEAD's ancestry only, so an unrelated branch in the same clone (CI
# fetches every remote branch) can neither fail nor pass a run. Everything
# runs in a throwaway repository built from the WORKING-TREE copies of
# scripts/security-scan.sh, scripts/verify-cloud.sh and .gitleaks.toml, with
# a synthetic sb_secret_ token generated at run time (no secret literal lives
# in this file). Needs git, node, jq and gitleaks (security-scan.sh resolves or
# downloads its pinned binary).
#
#   scripts/tests/test_security_scan.sh
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

FAILURES=0
pass() { printf 'ok   - %s\n' "$*"; }
fail() { printf 'FAIL - %s\n' "$*"; FAILURES=$((FAILURES + 1)); }
check() { # check <description> <command...>  (stdout of the command is discarded)
  local desc="$1"; shift
  if "$@" >/dev/null; then pass "$desc"; else fail "$desc"; fi
}

# Synthetic Supabase-style secret key: prefix + 40 random [A-Za-z0-9] chars,
# assembled here so the literal never appears in a committed file.
prefix='sb_secret_'
random_body="$(head -c 256 /dev/urandom | tr -dc 'A-Za-z0-9' | head -c 40)"
[ "${#random_body}" -eq 40 ] || { echo "could not generate a 40-char token body" >&2; exit 2; }
token="${prefix}${random_body}"

REPO="$WORK/repo"
mkdir -p "$REPO/scripts"
cp "$REPO_ROOT/.gitleaks.toml" "$REPO/.gitleaks.toml"
cp "$REPO_ROOT/scripts/security-scan.sh" "$REPO/scripts/security-scan.sh"
cp "$REPO_ROOT/scripts/verify-cloud.sh" "$REPO/scripts/verify-cloud.sh"
chmod +x "$REPO/scripts/"*.sh

g() { git -C "$REPO" -c user.name=test -c user.email=test@example.invalid -c commit.gpgsign=false "$@"; }
g init -q -b main
g add -A
g commit -q -m "base: scan policy + scripts"

# An unrelated branch whose single commit adds the token; never merged, not checked out.
g checkout -q -b planted
mkdir -p "$REPO/planted"
printf 'SUPABASE_SECRET_KEY=%s\n' "$token" >"$REPO/planted/creds.txt"
g add -A
g commit -q -m "planted: synthetic secret on an unrelated branch"
g checkout -q main
[ ! -e "$REPO/planted/creds.txt" ] || { echo "planted file leaked into main's tree" >&2; exit 2; }

echo "# --- unrelated branch must not influence a clean HEAD ---"
log="$WORK/history-clean.log"
(cd "$REPO" && scripts/security-scan.sh --history) >"$log" 2>&1
rc=$?
check "--history exits 0 on a clean HEAD while branch 'planted' holds a secret (exit $rc)" [ "$rc" -eq 0 ]
head_commits="$(g rev-list --count HEAD)"
check "--history log states the scanned range (HEAD ancestry, $head_commits commits)" \
  grep -Eq "history: HEAD ancestry .*\b${head_commits} commits?\b" "$log"
check "--history does not report findings from the unrelated branch" bash -c '! grep -q "FINDINGS" "$1"' _ "$log"

echo "# --- verify-cloud --only security in the same clone ---"
art="$WORK/vc-clean"
(cd "$REPO" && VERIFY_ARTIFACTS="$art" scripts/verify-cloud.sh --only security) >"$WORK/vc-clean.log" 2>&1
rc=$?
check "verify-cloud --only security exits 0 on the clean HEAD (exit $rc)" [ "$rc" -eq 0 ]
check "summary.json stages[security].status == passed" \
  jq -e '.stages[] | select(.name == "security") | .status == "passed"' "$art/summary.json"

echo "# --- repo-wide audit mode still sees the unrelated branch ---"
(cd "$REPO" && scripts/security-scan.sh --history --all-refs) >"$WORK/history-allrefs.log" 2>&1
rc=$?
check "--history --all-refs exits 1 because branch 'planted' holds a secret (exit $rc)" [ "$rc" -eq 1 ]
check "--history --all-refs log states the scanned range (all refs)" grep -Eq "history: all refs" "$WORK/history-allrefs.log"

echo "# --- a secret committed then removed IN HEAD's ancestry must still fail ---"
mkdir -p "$REPO/config"
printf 'export SUPABASE_SECRET_KEY=%s\n' "$token" >"$REPO/config/leaked.sh"
g add -A
g commit -q -m "oops: commit a secret"
g rm -q config/leaked.sh
g commit -q -m "remove the secret (still in history)"
[ ! -e "$REPO/config/leaked.sh" ] || { echo "leaked file still in tree" >&2; exit 2; }
(cd "$REPO" && scripts/security-scan.sh --history) >"$WORK/history-leaked.log" 2>&1
rc=$?
check "--history exits 1 when the secret is in HEAD's ancestry (exit $rc)" [ "$rc" -eq 1 ]
(cd "$REPO" && scripts/security-scan.sh --tree) >"$WORK/tree-after-removal.log" 2>&1
rc=$?
check "--tree exits 0 once the file is removed (history is the only trace) (exit $rc)" [ "$rc" -eq 0 ]

echo
if [ "$FAILURES" -ne 0 ]; then
  echo "test_security_scan: $FAILURES failure(s); logs under $WORK:"
  for f in "$WORK"/*.log; do echo "--- $f"; sed 's/^/    /' "$f" | tail -n 30; done
  trap - EXIT # keep the evidence
  exit 1
fi
echo "test_security_scan: all checks passed"
