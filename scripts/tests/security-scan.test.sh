#!/usr/bin/env bash
# Regression tests for scripts/security-scan.sh (the gitleaks gate).
#
#   scripts/tests/security-scan.test.sh            # exit 0 = every case passed
#
# Builds throwaway git repositories under a temp dir (a bare "origin" with a
# clean main branch plus an unrelated branch holding a synthetic secret) and
# asserts the gate's history-scan semantics:
#   - the default history scan is bounded to the ancestry of HEAD, so a leak on
#     an unrelated fetched ref neither fails nor passes the commit under test;
#   - a leak committed on the current branch is still found and reported;
#   - explicit --log-opts are honored verbatim;
#   - the header documents the same default scope the code implements;
#   - invalid or empty ranges and shallow clones fail closed instead of PASS;
#   - `--log-opts HEAD` on a full clone is still clean.
# The synthetic secret is assembled at runtime so this file never contains a
# detectable value itself. Needs git + the pinned gitleaks (downloaded/cached by
# security-scan.sh; GITLEAKS_BIN / SECURITY_SCAN_CACHE are honored).
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

# A value the custom `supabase-secret-api-key` rule matches (sb_secret_ + 20..).
# Concatenated so the literal never appears in this test file.
synthetic_secret() {
  printf 'sb_%s_%s' secret "$(head -c 48 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 40)"
}

# fixture_repo <dir>: fresh work tree with the gate + policy committed on main.
fixture_repo() {
  local dir="$1"
  git init -q -b main "$dir"
  mkdir -p "$dir/scripts"
  cp "$SCAN" "$dir/scripts/security-scan.sh"
  cp "$CONFIG" "$dir/.gitleaks.toml"
  printf 'fixture\n' >"$dir/README.md"
  git -C "$dir" add -A
  git -C "$dir" commit -q -m "fixture: gate + policy"
  printf 'second\n' >>"$dir/README.md"
  git -C "$dir" commit -q -am "fixture: clean follow-up"
}

# ---------------------------------------------------------------- fixtures --
ORIGIN="$WORK/origin.git"
SEED="$WORK/seed"
fixture_repo "$SEED"
git -C "$SEED" checkout -q -b leaky-branch
printf 'SUPABASE_KEY=%s\n' "$(synthetic_secret)" >"$SEED/leak.env.example"
git -C "$SEED" add leak.env.example
git -C "$SEED" commit -q -m "unrelated branch: fixture leak"
git -C "$SEED" checkout -q main
git init -q --bare -b main "$ORIGIN"
git -C "$SEED" remote add origin "$ORIGIN"
git -C "$SEED" push -q origin main leaky-branch

CLONE="$WORK/clone"
git clone -q "$ORIGIN" "$CLONE" # full clone: origin/main + origin/leaky-branch fetched, HEAD = main
git -C "$CLONE" rev-parse --verify -q origin/leaky-branch >/dev/null || {
  echo "fixture error: origin/leaky-branch not fetched" >&2
  exit 2
}
if git -C "$CLONE" merge-base --is-ancestor origin/leaky-branch HEAD; then
  echo "fixture error: leaky-branch must not be an ancestor of HEAD" >&2
  exit 2
fi

run_gate() {
  # run_gate <repo> <logfile> [args...] -> exit code in $RC
  local repo="$1" log="$2"
  shift 2
  RC=0
  (cd "$repo" && scripts/security-scan.sh "$@") >"$log" 2>&1 || RC=$?
}

# ------------------------------------------------------------------- cases --
# 1. Leak on an unrelated fetched ref must not fail the commit under test.
run_gate "$CLONE" "$WORK/01.log" --history
if [ "$RC" -eq 0 ]; then
  pass "default --history ignores a leak on a non-ancestor remote ref (exit 0)"
else
  fail "default --history ignores a leak on a non-ancestor remote ref" "exit=$RC"
  show "$WORK/01.log"
fi

# 4. Documented scope == implemented scope: the header names the default log
#    range and the scan reports scanning exactly HEAD's ancestry.
DEFAULT_FROM_CODE="$(sed -n 's/^DEFAULT_LOG_OPTS="\(.*\)"$/\1/p' "$SCAN" | head -n 1)"
HEAD_COUNT="$(git -C "$CLONE" rev-list --count HEAD)"
if [ -z "$DEFAULT_FROM_CODE" ]; then
  fail "header and code agree on the default history scope" "no DEFAULT_LOG_OPTS=\"...\" assignment in scripts/security-scan.sh"
elif ! sed -n '2,/^set -euo/p' "$SCAN" | grep -Fq -- "--log-opts \"$DEFAULT_FROM_CODE\""; then
  fail "header and code agree on the default history scope" "header does not mention --log-opts \"$DEFAULT_FROM_CODE\""
elif ! grep -Eq "history:.*\b${HEAD_COUNT} commits?\b" "$WORK/01.log"; then
  fail "header and code agree on the default history scope" "expected the scan to report ${HEAD_COUNT} commits (git rev-list --count HEAD)"
  show "$WORK/01.log"
else
  pass "header and code agree on the default history scope (--log-opts \"$DEFAULT_FROM_CODE\", $HEAD_COUNT commits)"
fi

# 2. A leak committed on the current branch is detected and the report names the commit.
printf 'SUPABASE_KEY=%s\n' "$(synthetic_secret)" >"$CLONE/config.env.example"
git -C "$CLONE" add config.env.example
git -C "$CLONE" commit -q -m "branch: fixture leak"
LEAK_SHA="$(git -C "$CLONE" rev-parse HEAD)"
mkdir -p "$WORK/report"
run_gate "$CLONE" "$WORK/02.log" --history --report-dir "$WORK/report"
if [ "$RC" -eq 1 ] && grep -Fq "\"Commit\": \"$LEAK_SHA\"" "$WORK/report/gitleaks-history.json"; then
  pass "leak on the current branch: exit 1 and the JSON report names commit ${LEAK_SHA:0:12}"
else
  fail "leak on the current branch is detected" "exit=$RC (want 1); report names commit: $(grep -Fc "\"Commit\": \"$LEAK_SHA\"" "$WORK/report/gitleaks-history.json" 2>/dev/null || echo 0)"
  show "$WORK/02.log"
fi

# 3. Explicit --log-opts is honored verbatim: origin/main..HEAD covers exactly the leak commit.
run_gate "$CLONE" "$WORK/03.log" --history --log-opts "origin/main..HEAD"
if [ "$RC" -eq 1 ] && grep -Fq 'log-opts "origin/main..HEAD"' "$WORK/03.log" && grep -Eq 'history:.*\b1 commits?\b' "$WORK/03.log"; then
  pass "--log-opts \"origin/main..HEAD\" is passed verbatim (1 commit, exit 1)"
else
  fail "--log-opts \"origin/main..HEAD\" is passed verbatim" "exit=$RC (want 1)"
  show "$WORK/03.log"
fi

# 5. Invalid range fails closed and names the range.
run_gate "$CLONE" "$WORK/05.log" --history --log-opts "no-such-ref..HEAD"
if [ "$RC" -ne 0 ] && grep -Fq "no-such-ref..HEAD" "$WORK/05.log"; then
  pass "--log-opts \"no-such-ref..HEAD\" exits $RC and names the range"
else
  fail "--log-opts \"no-such-ref..HEAD\" fails closed" "exit=$RC (want non-zero); range named: $(grep -Fc 'no-such-ref..HEAD' "$WORK/05.log")"
  show "$WORK/05.log"
fi

# 6. A range selecting zero commits is never a PASS.
run_gate "$CLONE" "$WORK/06.log" --history --log-opts "--since=2099-01-01"
if [ "$RC" -ne 0 ] && grep -Fiq "no commits" "$WORK/06.log"; then
  pass "--log-opts \"--since=2099-01-01\" (0 commits) exits $RC with a no-commits message"
else
  fail "--log-opts \"--since=2099-01-01\" (0 commits) fails closed" "exit=$RC (want non-zero)"
  show "$WORK/06.log"
fi

# 7. Shallow clone: history coverage is incomplete — fail closed (or warn loudly).
SHALLOW="$WORK/shallow"
git clone -q --depth 1 "file://$ORIGIN" "$SHALLOW"
[ "$(git -C "$SHALLOW" rev-parse --is-shallow-repository)" = true ] || {
  echo "fixture error: clone is not shallow" >&2
  exit 2
}
run_gate "$SHALLOW" "$WORK/07.log" --history
RC_DEFAULT=$RC
if grep -Fq "shallow repository" "$WORK/07.log" && grep -Fq "history coverage incomplete" "$WORK/07.log" && [ "$RC_DEFAULT" -ne 0 ]; then
  pass "shallow clone --history exits $RC_DEFAULT with a 'shallow repository — history coverage incomplete' message"
else
  fail "shallow clone --history fails closed with a shallow warning" "exit=$RC_DEFAULT; shallow mentioned: $(grep -Fc 'shallow repository' "$WORK/07.log")"
  show "$WORK/07.log"
fi
SECURITY_SCAN_ALLOW_SHALLOW=1 run_gate "$SHALLOW" "$WORK/07c.log" --history
if [ "$RC" -eq 0 ] && grep -Fq "history coverage incomplete" "$WORK/07c.log" && [ "$RC_DEFAULT" -ne 0 ]; then
  pass "SECURITY_SCAN_ALLOW_SHALLOW=1 downgrades the shallow failure to a loud warning (exit 0)"
else
  fail "SECURITY_SCAN_ALLOW_SHALLOW=1 downgrades the shallow failure to a warning" "exit=$RC (want 0), default exit=$RC_DEFAULT (want non-zero)"
  show "$WORK/07c.log"
fi

# 8. Explicit --log-opts HEAD on a clean full clone is still clean.
CLEAN="$WORK/clean"
git clone -q "$ORIGIN" "$CLEAN"
run_gate "$CLEAN" "$WORK/08.log" --history --log-opts HEAD
if [ "$RC" -eq 0 ]; then
  pass "--log-opts HEAD on a clean full clone exits 0"
else
  fail "--log-opts HEAD on a clean full clone exits 0" "exit=$RC"
  show "$WORK/08.log"
fi

# 9. A pathspec that selects nothing is also an empty range (git exits 0 silently).
run_gate "$CLEAN" "$WORK/09.log" --history --log-opts "HEAD -- no/such/path"
if [ "$RC" -ne 0 ] && grep -Fiq "no commits" "$WORK/09.log"; then
  pass "--log-opts \"HEAD -- no/such/path\" (0 commits via pathspec) exits $RC"
else
  fail "--log-opts \"HEAD -- no/such/path\" (0 commits via pathspec) fails closed" "exit=$RC (want non-zero)"
  show "$WORK/09.log"
fi

# 10. gitleaks' own error stream is never swallowed: a scanner that logs ERR /
#     "0 commits scanned" yet exits 0 (the observed gitleaks behaviour on a git
#     failure) must not produce a PASS even when the pre-flight found commits.
FAKE_BIN="$WORK/fake-gitleaks"
cat >"$FAKE_BIN" <<'SH'
#!/usr/bin/env bash
[ "${1:-}" = version ] && { echo 8.30.1; exit 0; }
echo '8:08PM ERR [git] fatal: simulated git failure' >&2
echo '8:08PM ERR error="stderr is not empty"' >&2
echo '8:08PM INF 0 commits scanned.' >&2
echo '8:08PM INF no leaks found' >&2
exit 0
SH
chmod +x "$FAKE_BIN"
GITLEAKS_BIN="$FAKE_BIN" run_gate "$CLEAN" "$WORK/10.log" --history --log-opts HEAD
if [ "$RC" -ne 0 ] && ! grep -Fq "PASS:" "$WORK/10.log"; then
  pass "gitleaks ERR + '0 commits scanned' with exit 0 is reported as a scanner error (exit $RC)"
else
  fail "gitleaks ERR + '0 commits scanned' with exit 0 is not a PASS" "exit=$RC (want non-zero)"
  show "$WORK/10.log"
fi

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
