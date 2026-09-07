#!/usr/bin/env bash
# Regression test: scripts/security-scan.sh must judge the commit under test,
# not whatever else happens to sit in the clone.
#   history: HEAD's ancestry — gitleaks' `git` mode defaults to
#            `--full-history --all`, which made the verdict depend on unrelated
#            remote branches (a secret on a stale audit branch failed main's
#            CI, and a secret on the branch under test could hide in that noise).
#   tree:    tracked + untracked-unignored files — `gitleaks dir` also reads
#            gitignored paths (downloaded CI artifacts, local logs), which
#            fail the gate for content that can never reach the repository.
# Detection itself must not weaken: secrets in HEAD's ancestry, in tracked
# files and in about-to-be-added files still fail.
#
# Runs against a throwaway repo so it never touches this checkout's history.
#   scripts/tests/security-scan-scope.sh
# Exit 0 = all assertions hold; 1 = regression; 2 = setup failure.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCAN="$REPO_ROOT/scripts/security-scan.sh"
CONFIG="$REPO_ROOT/.gitleaks.toml"

log() { printf '[security-scan-scope] %s\n' "$*" >&2; }
die() {
  log "SETUP ERROR: $*"
  exit 2
}

[ -x "$SCAN" ] || die "missing $SCAN"
[ -f "$CONFIG" ] || die "missing $CONFIG"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

fixture() {
  # $1 = repo dir. Builds:
  #   main:   clean-a ─ clean-b          (HEAD)
  #   stale:  clean-a ─ SECRET           (non-ancestor of HEAD)
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
    echo "clean" >README.md
    git add -A
    git commit -qm "clean-a"
    git checkout -qb stale
    write_secret leaked.ts
    git add leaked.ts
    git commit -qm "leaked secret on a stale branch"
    git checkout -q main
    echo "still clean" >>README.md
    git add README.md
    git commit -qm "clean-b"
  )
}

run_scan() {
  # $1 = repo dir, $2 = --history|--tree; echoes the exit code, never fails
  # the caller.
  local dir="$1" mode="$2" rc=0
  rm -rf "$WORK/report"
  (
    cd "$dir"
    scripts/security-scan.sh "$mode" --report-dir "$WORK/report" >"$WORK/scan.log" 2>&1
  ) || rc=$?
  echo "$rc"
}
run_history_scan() { run_scan "$1" --history; }
run_tree_scan() { run_scan "$1" --tree; }

write_secret() {
  # A Stripe live-key shape gitleaks' default ruleset flags. Assembled from
  # parts so this test file itself never contains the pattern.
  printf 'const apiKey = "sk_%s_%s";\n' live 51H8xK2eZvKYlo2C0aBcDeFgHiJkLmNoPq >"$1"
}

fail=0

# 1. A secret on a NON-ancestor branch must not fail the gate for HEAD.
fixture "$WORK/scope"
rc="$(run_history_scan "$WORK/scope")"
if [ "$rc" = 0 ]; then
  log "PASS: secret on a non-ancestor branch does not fail HEAD's history scan"
elif [ "$rc" = 2 ]; then
  cat "$WORK/scan.log" >&2
  die "scanner setup failed (exit 2) — cannot evaluate scope"
else
  log "FAIL: history scan exited $rc although HEAD's ancestry is clean (scanned unrelated refs)"
  grep -E 'leaks found|Commit:|Fingerprint:' "$WORK/scan.log" >&2 || true
  fail=1
fi

# 2. The same secret IN HEAD's ancestry must still fail — the fix narrows the
#    scope to the commit under test, it must not weaken detection.
(
  cd "$WORK/scope"
  git merge -q --no-ff --no-edit stale
)
rc="$(run_history_scan "$WORK/scope")"
if [ "$rc" = 1 ]; then
  log "PASS: secret in HEAD's ancestry still fails the history scan"
else
  log "FAIL: history scan exited $rc although HEAD's ancestry contains a secret"
  cat "$WORK/scan.log" >&2
  fail=1
fi

# 3. The tree scan judges what git would commit: a secret in a GITIGNORED file
#    (downloaded CI artifacts, local logs) must not fail the gate…
fixture "$WORK/tree"
(
  cd "$WORK/tree"
  printf 'artifacts/\n' >.gitignore
  git add .gitignore
  git commit -qm "ignore artifacts"
  mkdir -p artifacts/run
  write_secret artifacts/run/log.json
)
rc="$(run_tree_scan "$WORK/tree")"
if [ "$rc" = 0 ]; then
  log "PASS: secret in a gitignored file does not fail the tree scan"
elif [ "$rc" = 2 ]; then
  cat "$WORK/scan.log" >&2
  die "scanner setup failed (exit 2) — cannot evaluate tree scope"
else
  log "FAIL: tree scan exited $rc although the only secret is gitignored"
  grep -E 'leaks found' "$WORK/scan.log" >&2 || true
  cat "$WORK/report/gitleaks-tree.json" >&2 2>/dev/null || true
  fail=1
fi

# 4. …while the same secret in an UNTRACKED, unignored file (about to be
#    `git add`ed) and in a TRACKED file must each still fail it.
write_secret "$WORK/tree/src_untracked.ts"
rc="$(run_tree_scan "$WORK/tree")"
if [ "$rc" = 1 ] && grep -q 'src_untracked.ts' "$WORK/report/gitleaks-tree.json"; then
  log "PASS: secret in an untracked, unignored file still fails the tree scan"
else
  log "FAIL: tree scan exited $rc without flagging the untracked secret"
  cat "$WORK/scan.log" >&2
  fail=1
fi
rm -f "$WORK/tree/src_untracked.ts"
(
  cd "$WORK/tree"
  write_secret src_tracked.ts
  git add src_tracked.ts
)
rc="$(run_tree_scan "$WORK/tree")"
if [ "$rc" = 1 ] && grep -q 'src_tracked.ts' "$WORK/report/gitleaks-tree.json"; then
  log "PASS: secret in a tracked file still fails the tree scan"
else
  log "FAIL: tree scan exited $rc without flagging the tracked secret"
  cat "$WORK/scan.log" >&2
  fail=1
fi

if [ "$fail" = 0 ]; then
  log "PASS: scan scope is HEAD's ancestry + what git would commit"
else
  log "FAIL: scan scope regression"
fi
exit "$fail"
