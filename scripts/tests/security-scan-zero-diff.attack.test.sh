#!/usr/bin/env bash
# Adversarial regression tests for scripts/security-scan.sh (candidate 1529bf9b
# vs baseline 4d812e1a): valid, NON-empty history ranges must never be reported
# as a scanner error.
#
#   scripts/tests/security-scan-zero-diff.attack.test.sh   # exit 0 = every case passed
#
# The candidate pre-flights the range with `git log` (>= 1 commit => valid) and
# then ALSO treats gitleaks' "0 commits scanned" as "the requested range
# evaluated nothing" (exit 2). gitleaks only counts commits that carry a textual
# diff, so a range that git resolved to real commits which happen to have no
# text hunks — a sync merge from main, an --allow-empty "retrigger CI" commit, a
# pure rename, a mode change — now FAILS with "scanner error" although nothing
# was invalid and nothing was skipped. The baseline exits 0 on every one of these
# (verified: /home/ubuntu/attack-evidence/22-zero-diff-results.log). The
# documented invocation `--log-opts "origin/main..HEAD"` hits this on any PR
# whose only commits are of that kind.
#
# A tracked file literally named `HEAD` in the repository root makes the new
# default range ambiguous (`git log HEAD` => fatal: ambiguous argument) and the
# default `--history` scan exits 2; the baseline (`--all`) exits 0.
#
# Each case has a control: the same range shape with a real leak still exits 1,
# so a fix must not restore the vacuous PASS the candidate set out to remove.
set -uo pipefail

TESTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$TESTS_DIR/../.." && pwd)"
SCAN="$REPO_ROOT/scripts/security-scan.sh"
CONFIG="$REPO_ROOT/.gitleaks.toml"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
export GIT_AUTHOR_NAME=test GIT_AUTHOR_EMAIL=test@example.invalid
export GIT_COMMITTER_NAME=test GIT_COMMITTER_EMAIL=test@example.invalid
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1

PASS=0
FAIL=0
pass() {
  PASS=$((PASS + 1))
  printf 'ok   - %s\n' "$1"
}
fail() {
  FAIL=$((FAIL + 1))
  printf 'FAIL - %s\n' "$1"
  shift
  [ $# -eq 0 ] || printf '       %s\n' "$@"
}
show() { sed 's/^/       | /' "$1" | tail -n 12; }

synthetic_secret() {
  printf 'sb_%s_%s' secret "$(head -c 48 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 40)"
}

# fixture_repo <dir>: main = one clean commit holding the gate + policy; a
# `feature` branch checked out at the same commit.
fixture_repo() {
  local dir="$1"
  git init -q -b main "$dir"
  mkdir -p "$dir/scripts"
  cp "$SCAN" "$dir/scripts/security-scan.sh"
  cp "$CONFIG" "$dir/.gitleaks.toml"
  printf 'fixture\n' >"$dir/README.md"
  git -C "$dir" add -A
  git -C "$dir" commit -q -m "fixture: gate + policy"
  git -C "$dir" checkout -q -b feature
}

run_gate() {
  # run_gate <repo> <logfile> [args...] -> exit code in $RC
  local repo="$1" log="$2"
  shift 2
  RC=0
  (cd "$repo" && scripts/security-scan.sh "$@") >"$log" 2>&1 || RC=$?
}

# expect_clean_range <name> <repo> <range>: git selects >= 1 commit in <range>,
# none of them contains a secret => the gate must exit 0 and must not call it a
# scanner error / NO COMMITS SCANNED.
expect_clean_range() {
  local name="$1" repo="$2" range="$3" log="$WORK/$1.log" n
  n="$(git -C "$repo" rev-list --count "$range")"
  if [ "$n" -lt 1 ]; then
    fail "$name" "fixture error: git selects $n commits in '$range'"
    return
  fi
  run_gate "$repo" "$log" --history --log-opts "$range"
  if [ "$RC" -eq 0 ] && ! grep -Fq "NO COMMITS SCANNED" "$log"; then
    pass "$name: $n commit(s) in '$range', no text diff, exit 0"
  else
    fail "$name: valid non-empty range '$range' ($n commit(s) per git log) is not a scanner error" \
      "exit=$RC (want 0); NO COMMITS SCANNED lines: $(grep -Fc 'NO COMMITS SCANNED' "$log")"
    show "$log"
  fi
}

# ------------------------------------------------------------------- cases --
# A. PR branch whose only commit in main..HEAD is a sync merge from main.
R="$WORK/merge-only"
fixture_repo "$R"
git -C "$R" checkout -q main
printf 'main moved on\n' >>"$R/README.md"
git -C "$R" commit -q -am "main: follow-up"
git -C "$R" checkout -q feature
git -C "$R" merge -q --no-ff main -m "sync main into feature"
expect_clean_range "merge-only range" "$R" "main..HEAD"

# B. PR branch whose only commit is an --allow-empty "retrigger CI" commit.
R="$WORK/empty-commit"
fixture_repo "$R"
git -C "$R" commit -q --allow-empty -m "retrigger ci"
expect_clean_range "empty-commit range" "$R" "main..HEAD"

# C. Pure rename (100% similarity) as the only commit in range.
R="$WORK/rename-only"
fixture_repo "$R"
git -C "$R" mv README.md README.txt
git -C "$R" commit -q -m "rename README"
expect_clean_range "rename-only range" "$R" "main..HEAD"

# D. File mode change as the only commit in range.
R="$WORK/mode-only"
fixture_repo "$R"
chmod +x "$R/README.md"
git -C "$R" commit -q -am "make README executable"
expect_clean_range "mode-only range" "$R" "main..HEAD"

# E. Control: the same range shape with a leaked value must still exit 1 —
#    a fix for A–D must not reintroduce a vacuous PASS.
R="$WORK/leak-control"
fixture_repo "$R"
git -C "$R" commit -q --allow-empty -m "retrigger ci"
printf 'SUPABASE_KEY=%s\n' "$(synthetic_secret)" >"$R/config.env.example"
git -C "$R" add config.env.example
git -C "$R" commit -q -m "feature: fixture leak"
run_gate "$R" "$WORK/leak-control.log" --history --log-opts "main..HEAD"
if [ "$RC" -eq 1 ]; then
  pass "control: empty commit + leak commit in main..HEAD still exits 1"
else
  fail "control: empty commit + leak commit in main..HEAD exits 1" "exit=$RC"
  show "$WORK/leak-control.log"
fi

# F. Control: a genuinely empty range is still rejected.
run_gate "$R" "$WORK/empty-range.log" --history --log-opts "HEAD..HEAD"
if [ "$RC" -ne 0 ] && grep -Fiq "no commits" "$WORK/empty-range.log"; then
  pass "control: 'HEAD..HEAD' (0 commits) still fails closed (exit $RC)"
else
  fail "control: 'HEAD..HEAD' (0 commits) fails closed" "exit=$RC (want non-zero)"
  show "$WORK/empty-range.log"
fi

# G. A tracked file named HEAD in the repo root must not break the default scan.
R="$WORK/file-named-HEAD"
fixture_repo "$R"
printf 'not a ref\n' >"$R/HEAD"
git -C "$R" add HEAD
git -C "$R" commit -q -m "add a file called HEAD"
run_gate "$R" "$WORK/file-named-HEAD.log" --history
if [ "$RC" -eq 0 ]; then
  pass "default --history with a tracked file named HEAD exits 0"
else
  fail "default --history with a tracked file named HEAD exits 0" "exit=$RC"
  show "$WORK/file-named-HEAD.log"
fi

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
