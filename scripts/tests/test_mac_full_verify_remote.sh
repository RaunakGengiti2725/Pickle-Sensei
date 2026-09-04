#!/usr/bin/env bash
# Regression tests for `scripts/mac-full-verify.sh --remote` (the Linux-side
# dispatcher). Everything runs against a synthetic git repo with a LOCAL bare
# origin and a fake `gh` on PATH — no network, no GitHub, no Mac runner.
#
# Pins:
#   CI-07  a failed `gh run download` / final `gh run view` makes the script
#          exit non-zero (no green claim without artifacts + run.json; run.json
#          is never a 0-byte file); a watch failure still exits 1.
#   CI-08  the dirty-tree guard also refuses untracked, non-ignored files
#          (nothing is pushed), ignores artifacts/, and a detached HEAD pushes
#          to ci/mac-<sha12>, never ci/mac-HEAD.
#
# Usage: scripts/tests/test_mac_full_verify_remote.sh        (exit 0 = all pass)
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="$REPO_ROOT/scripts/mac-full-verify.sh"
command -v jq >/dev/null || { echo "jq is required" >&2; exit 2; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
export HOME="$WORK/home"; mkdir -p "$HOME"
export GIT_AUTHOR_NAME=test GIT_AUTHOR_EMAIL=test@example.invalid
export GIT_COMMITTER_NAME=test GIT_COMMITTER_EMAIL=test@example.invalid
export GIT_CONFIG_GLOBAL="$WORK/gitconfig"; : >"$GIT_CONFIG_GLOBAL"
export GIT_CONFIG_NOSYSTEM=1

# ----------------------------------------------------------------- fake gh ----
# Behaviour is driven by FAKE_GH_WATCH_RC / FAKE_GH_DOWNLOAD_RC / FAKE_GH_VIEW_RC.
# Every invocation is appended to $FAKE_GH_LOG.
mkdir -p "$WORK/bin"
cat >"$WORK/bin/gh" <<'EOF'
#!/usr/bin/env bash
set -u
printf '%s\n' "gh $*" >>"$FAKE_GH_LOG"
case "$1 $2" in
  "run list")
    echo "424242" ;;
  "run view")
    if [[ " $* " == *" --jq .url "* ]]; then
      echo "https://example.invalid/actions/runs/424242"; exit 0
    fi
    if [ "${FAKE_GH_VIEW_RC:-0}" -ne 0 ]; then
      echo "HTTP 502: bad gateway" >&2; exit "${FAKE_GH_VIEW_RC}"
    fi
    echo '{"databaseId":424242,"status":"completed","conclusion":"success","url":"https://example.invalid/actions/runs/424242","headSha":"deadbeef"}' ;;
  "run watch")
    exit "${FAKE_GH_WATCH_RC:-0}" ;;
  "run download")
    if [ "${FAKE_GH_DOWNLOAD_RC:-0}" -ne 0 ]; then
      echo "no artifacts found" >&2; exit "${FAKE_GH_DOWNLOAD_RC}"
    fi
    dir=""
    while [ $# -gt 0 ]; do [ "$1" = "--dir" ] && dir="$2"; shift; done
    mkdir -p "$dir/mac-full-verify-1" && echo '{"ok":true}' >"$dir/mac-full-verify-1/summary.json" ;;
  *)
    echo "fake gh: unexpected args: $*" >&2; exit 99 ;;
esac
EOF
chmod +x "$WORK/bin/gh"
export PATH="$WORK/bin:$PATH"

# ----------------------------------------------------------- synthetic repo ----
ORIGIN="$WORK/origin.git"
git init -q --bare "$ORIGIN"
REPO="$WORK/repo"
git init -q -b main "$REPO"
mkdir -p "$REPO/scripts" "$REPO/native" "$REPO/tools/macos-ci"
cp "$SCRIPT" "$REPO/scripts/mac-full-verify.sh"
echo 'let a = 1' >"$REPO/native/A.swift"
echo 'hello' >"$REPO/tools/macos-ci/README"
git -C "$REPO" add -A
git -C "$REPO" commit -qm "synthetic"
git -C "$REPO" remote add origin "$ORIGIN"
git -C "$REPO" push -q origin main
UNDER_TEST="$REPO/scripts/mac-full-verify.sh"

PASS=0; FAIL=0
ok()   { PASS=$((PASS + 1)); echo "  ok   - $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL - $1"; }
check() { if eval "$2"; then ok "$1"; else fail "$1"; fi; }

reset_repo() {
  git -C "$REPO" checkout -q main
  git -C "$REPO" clean -qfd
  git -C "$REPO" checkout -q -- .
  for ref in $(git -C "$ORIGIN" for-each-ref --format='%(refname)' refs/heads/ci/); do
    git -C "$ORIGIN" update-ref -d "$ref"
  done
  git -C "$REPO" remote prune origin >/dev/null
}

origin_ci_refs() { git -C "$ORIGIN" for-each-ref --format='%(refname:short)' refs/heads/ci/; }

# run_remote <out-dir> [ENV=VAL ...] ; sets RC, LOG
run_remote() {
  local out="$1"; shift
  export FAKE_GH_LOG="$WORK/gh.log"; : >"$FAKE_GH_LOG"
  LOG="$WORK/script.log"
  (cd "$REPO" && env MAC_ARTIFACTS="$out" "$@" bash "$UNDER_TEST" --remote) >"$LOG" 2>&1
  RC=$?
}

# ======================================================================= CI-07
echo "# CI-07: evidence (artifacts + run.json) is part of the verdict"

echo "## A. gh run download fails (watch ok, view ok)"
reset_repo; OUT="$WORK/outA"
run_remote "$OUT" FAKE_GH_DOWNLOAD_RC=1
check "exits non-zero (rc=$RC)" '[ "$RC" -ne 0 ]'
check "prints a line naming the failed download" 'grep -Eiq "download.*(fail|error)|(fail|error).*download" "$LOG"'
check "does not claim artifacts downloaded" '! grep -q "artifacts downloaded to" "$LOG"'

echo "## B. final gh run view fails (watch ok, download ok)"
reset_repo; OUT="$WORK/outB"
run_remote "$OUT" FAKE_GH_VIEW_RC=1
check "exits non-zero (rc=$RC)" '[ "$RC" -ne 0 ]'
check "run.json is absent or non-empty valid JSON" '[ ! -e "$OUT/run.json" ] || { [ -s "$OUT/run.json" ] && jq -e . "$OUT/run.json" >/dev/null; }'
check "message says the run itself was green but evidence is missing" 'grep -Eiq "evidence" "$LOG"'

echo "## C. everything succeeds"
reset_repo; OUT="$WORK/outC"
run_remote "$OUT"
check "exits 0 (rc=$RC)" '[ "$RC" -eq 0 ]'
check "run.json parses with jq" 'jq -e .databaseId "$OUT/run.json" >/dev/null'
check "artifacts downloaded" '[ -f "$OUT/mac-full-verify-1/summary.json" ]'

echo "## D. gh run watch --exit-status rc=1 (download + view ok)"
reset_repo; OUT="$WORK/outD"
run_remote "$OUT" FAKE_GH_WATCH_RC=1
check "exits 1 (rc=$RC)" '[ "$RC" -eq 1 ]'

# ======================================================================= CI-08
echo "# CI-08: dirty-tree guard and detached-HEAD trigger slug"

echo "## E. untracked, non-ignored file under native/"
reset_repo; OUT="$WORK/outE"
echo 'let b = 2' >"$REPO/native/Untracked.swift"
run_remote "$OUT"
check "exits 2 (rc=$RC)" '[ "$RC" -eq 2 ]'
check "fake origin received no ci/ ref" '[ -z "$(origin_ci_refs)" ]'
check "no gh call was made" '[ ! -s "$FAKE_GH_LOG" ]'

echo "## F. modified tracked file (control)"
reset_repo; OUT="$WORK/outF"
echo 'let a = 2' >"$REPO/native/A.swift"
run_remote "$OUT"
check "exits 2 (rc=$RC)" '[ "$RC" -eq 2 ]'
check "fake origin received no ci/ ref" '[ -z "$(origin_ci_refs)" ]'

echo "## G. only untracked files under artifacts/"
reset_repo; OUT="$WORK/outG"
mkdir -p "$REPO/artifacts/verify-cloud/x" && echo '{}' >"$REPO/artifacts/verify-cloud/x/summary.json"
run_remote "$OUT"
check "push proceeds and exits 0 (rc=$RC)" '[ "$RC" -eq 0 ]'
check "fake origin received ci/mac-main" '[ "$(origin_ci_refs)" = "ci/mac-main" ]'

echo "## H. detached HEAD"
reset_repo; OUT="$WORK/outH"
git -C "$REPO" checkout -q --detach
SHORT="$(git -C "$REPO" rev-parse --short=12 HEAD)"
run_remote "$OUT"
check "exits 0 (rc=$RC)" '[ "$RC" -eq 0 ]'
check "trigger branch is not ci/mac-HEAD" '! grep -q "trigger branch ci/mac-HEAD" "$LOG" && [ "$(origin_ci_refs)" != "ci/mac-HEAD" ]'
check "trigger branch contains the short SHA ($SHORT)" '[[ "$(origin_ci_refs)" == *"$SHORT"* ]]'

echo
echo "test_mac_full_verify_remote: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
