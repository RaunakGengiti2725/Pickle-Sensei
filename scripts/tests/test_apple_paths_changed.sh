#!/usr/bin/env bash
# Regression tests for tools/macos-ci/apple-paths-changed.sh and the `changes`
# job of .github/workflows/mac-full-verify.yml that consumes it.
#
#   scripts/tests/test_apple_paths_changed.sh
#
# Builds a throwaway git repository (with the helper committed at the same
# relative path as in a real checkout), then exercises
#   * the helper directly: docs-only -> false, Apple paths -> true, unknown
#     BEFORE -> true, deletions/renames OUT of native/ -> true, non-ASCII file
#     names inside native/ -> true, and a diff failure never yields an empty
#     answer with a zero exit;
#   * the workflow's `decide` step, extracted verbatim from the YAML and run
#     the way GitHub runs an unspecified-shell step (`bash -e <file>`): the
#     resulting $GITHUB_OUTPUT must contain run=true / run=false, never `run=`,
#     and a helper failure must fail the step or fail open to run=true;
#   * the workflow keeps `permissions: contents: read` and has no
#     `pull_request:` trigger (public repo, personal Mac runner).
# Exits non-zero if any assertion fails. No network, no Docker.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HELPER_REL="tools/macos-ci/apple-paths-changed.sh"
HELPER="$REPO_ROOT/$HELPER_REL"
WORKFLOW="$REPO_ROOT/.github/workflows/mac-full-verify.yml"

[ -f "$HELPER" ] || { echo "missing $HELPER" >&2; exit 2; }
[ -f "$WORKFLOW" ] || { echo "missing $WORKFLOW" >&2; exit 2; }

# Deterministic commits without touching any git config.
export GIT_AUTHOR_NAME=test GIT_AUTHOR_EMAIL=test@example.invalid
export GIT_COMMITTER_NAME=test GIT_COMMITTER_EMAIL=test@example.invalid
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null
export LC_ALL=C.UTF-8

WORK="$(mktemp -d "${TMPDIR:-/tmp}/apple-paths-changed.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

PASS=0
FAIL=0
pass() { PASS=$((PASS + 1)); echo "ok   - $1"; }
fail() { FAIL=$((FAIL + 1)); echo "FAIL - $1"; [ $# -gt 1 ] && printf '       %s\n' "${@:2}"; }

assert_eq() { # <name> <expected> <actual>
  if [ "$2" = "$3" ]; then pass "$1"; else fail "$1" "expected: $2" "actual:   $3"; fi
}

# ---------------------------------------------------------------- fixture repo
SCRATCH="$WORK/repo"
mkdir -p "$SCRATCH"
git -C "$SCRATCH" init -q -b main
mkdir -p "$SCRATCH/native/camera-engine/Sources" "$SCRATCH/apps/mobile/ios/PickleSensei" \
  "$SCRATCH/apps/mobile/src" "$SCRATCH/docs" "$SCRATCH/packages/shared-types/src" \
  "$SCRATCH/$(dirname "$HELPER_REL")"
cp "$HELPER" "$SCRATCH/$HELPER_REL"
chmod +x "$SCRATCH/$HELPER_REL"
echo 'import Foundation' > "$SCRATCH/native/camera-engine/Sources/CameraEngine.swift"
echo 'import Foundation' > "$SCRATCH/native/camera-engine/Sources/Übersicht.swift"
echo 'plist' > "$SCRATCH/apps/mobile/ios/PickleSensei/Info.plist"
echo '{"name":"mobile"}' > "$SCRATCH/apps/mobile/package.json"
echo 'export {};' > "$SCRATCH/apps/mobile/src/index.ts"
echo 'export {};' > "$SCRATCH/packages/shared-types/src/index.ts"
echo '# docs' > "$SCRATCH/docs/README.md"
git -C "$SCRATCH" add -A
git -C "$SCRATCH" commit -q -m base
BASE="$(git -C "$SCRATCH" rev-parse HEAD)"

# commit_change <branch> <shell snippet run inside the scratch repo> -> prints new sha
commit_change() {
  local branch="$1" snippet="$2"
  git -C "$SCRATCH" checkout -q "$BASE"
  git -C "$SCRATCH" checkout -q -b "$branch"
  (cd "$SCRATCH" && eval "$snippet")
  git -C "$SCRATCH" add -A
  git -C "$SCRATCH" commit -q -m "$branch"
  git -C "$SCRATCH" rev-parse HEAD
}

DOCS_ONLY="$(commit_change docs-only 'echo more >> docs/README.md; echo more >> packages/shared-types/src/index.ts; echo more >> apps/mobile/src/index.ts')"
NATIVE_EDIT="$(commit_change native-edit 'echo "// edit" >> native/camera-engine/Sources/CameraEngine.swift')"
IOS_EDIT="$(commit_change ios-edit 'echo edit >> apps/mobile/ios/PickleSensei/Info.plist')"
PKG_EDIT="$(commit_change pkg-edit 'echo "{}" > apps/mobile/package.json')"
NATIVE_DELETE="$(commit_change native-delete 'git rm -q native/camera-engine/Sources/CameraEngine.swift')"
RENAME_OUT="$(commit_change rename-out 'git mv native/camera-engine/Sources/CameraEngine.swift docs/CameraEngine.swift')"
RENAME_IN="$(commit_change rename-in 'git mv docs/README.md native/camera-engine/Sources/README.md')"
NON_ASCII_EDIT="$(commit_change non-ascii-edit 'echo "// edit" >> "native/camera-engine/Sources/Übersicht.swift"')"
NON_ASCII_ADD="$(commit_change non-ascii-add 'echo x > "native/camera-engine/Sources/Ärmel.swift"')"
git -C "$SCRATCH" checkout -q main
ZERO_SHA=0000000000000000000000000000000000000000

# run_helper <args...> -> sets HELPER_OUT (stdout) and HELPER_RC
run_helper() {
  HELPER_OUT="$(cd "$SCRATCH" && "./$HELPER_REL" "$@" 2>"$WORK/helper.stderr")"
  HELPER_RC=$?
}

assert_helper() { # <name> <before> <after> <expected stdout>
  run_helper "$2" "$3"
  assert_eq "$1" "$4" "$HELPER_OUT"
  assert_eq "$1 (exit 0)" 0 "$HELPER_RC"
}

# ---------------------------------------------------------------- helper: existing behaviour
assert_helper "helper: docs-only diff -> false" "$BASE" "$DOCS_ONLY" false
assert_helper "helper: native/ edit -> true" "$BASE" "$NATIVE_EDIT" true
assert_helper "helper: apps/mobile/ios/ edit -> true" "$BASE" "$IOS_EDIT" true
assert_helper "helper: apps/mobile/package.json edit -> true" "$BASE" "$PKG_EDIT" true
assert_helper "helper: unknown BEFORE (all zeros) -> true" "$ZERO_SHA" "$DOCS_ONLY" true
assert_helper "helper: identical shas -> false" "$BASE" "$BASE" false
run_helper "$BASE"
assert_eq "helper: wrong arity exits 2" 2 "$HELPER_RC"

# ---------------------------------------------------------------- helper: CI-10 (renames, quoted paths)
assert_helper "helper: deletion inside native/ -> true" "$BASE" "$NATIVE_DELETE" true
assert_helper "helper: rename OUT of native/ -> true" "$BASE" "$RENAME_OUT" true
assert_helper "helper: rename INTO native/ -> true" "$BASE" "$RENAME_IN" true
assert_helper "helper: edit of non-ASCII file name inside native/ -> true" "$BASE" "$NON_ASCII_EDIT" true
assert_helper "helper: added non-ASCII file name inside native/ -> true" "$BASE" "$NON_ASCII_ADD" true
# Whatever the runner's git config says about rename detection / path quoting.
out="$(cd "$SCRATCH" && GIT_CONFIG_COUNT=2 \
  GIT_CONFIG_KEY_0=diff.renames GIT_CONFIG_VALUE_0=true \
  GIT_CONFIG_KEY_1=core.quotePath GIT_CONFIG_VALUE_1=true \
  "./$HELPER_REL" "$BASE" "$RENAME_OUT" 2>/dev/null)"
assert_eq "helper: rename OUT of native/ -> true even with diff.renames=true" "true" "$out"
out="$(cd "$SCRATCH" && GIT_CONFIG_COUNT=1 \
  GIT_CONFIG_KEY_0=core.quotePath GIT_CONFIG_VALUE_0=true \
  "./$HELPER_REL" "$BASE" "$NON_ASCII_EDIT" 2>/dev/null)"
assert_eq "helper: non-ASCII edit -> true even with core.quotePath=true" "true" "$out"

# ---------------------------------------------------------------- helper: CI-09 (diff failure never yields an empty answer)
run_helper "$BASE" notasha
if [ "$HELPER_RC" -ne 0 ] || [ "$HELPER_OUT" = "true" ]; then
  pass "helper: bogus AFTER exits non-zero or fails open to true (rc=$HELPER_RC, out='$HELPER_OUT')"
else
  fail "helper: bogus AFTER exits non-zero or fails open to true" "rc=$HELPER_RC" "stdout='$HELPER_OUT'"
fi

# ---------------------------------------------------------------- workflow: extract the `decide` step verbatim
STEP_SCRIPT="$WORK/decide.sh"
awk '
  /^[[:space:]]*- id: decide[[:space:]]*$/ { in_step = 1; next }
  in_step && /^[[:space:]]*- / { exit }
  in_step && /^[[:space:]]*run: \|[[:space:]]*$/ { in_run = 1; next }
  in_run {
    if ($0 ~ /^[[:space:]]*$/) { print ""; next }
    match($0, /^[[:space:]]*/)
    if (block_indent == "") block_indent = RLENGTH
    if (RLENGTH < block_indent) exit
    print substr($0, block_indent + 1)
  }
' "$WORKFLOW" > "$STEP_SCRIPT"
if [ -s "$STEP_SCRIPT" ] && grep -q "$HELPER_REL" "$STEP_SCRIPT"; then
  pass "workflow: extracted the decide step's run block"
else
  fail "workflow: extracted the decide step's run block" "$(cat "$STEP_SCRIPT")"
fi

# run_step <before> <after> <on_demand> -> sets STEP_RC and STEP_OUTPUT (contents of $GITHUB_OUTPUT)
run_step() {
  local gh_out="$WORK/github_output"
  : > "$gh_out"
  (
    cd "$SCRATCH" &&
      BEFORE="$1" AFTER="$2" ON_DEMAND="$3" GITHUB_OUTPUT="$gh_out" \
        bash -e "$STEP_SCRIPT" >"$WORK/step.stdout" 2>"$WORK/step.stderr"
  )
  STEP_RC=$?
  STEP_OUTPUT="$(cat "$gh_out")"
}

assert_step_run() { # <name> <expected run= value>
  assert_eq "$1" "run=$2" "$STEP_OUTPUT"
  assert_eq "$1 (step exit 0)" 0 "$STEP_RC"
}

run_step "$BASE" "$DOCS_ONLY" false
assert_step_run "step: docs-only push writes run=false" false
run_step "$BASE" "$NATIVE_EDIT" false
assert_step_run "step: native/ push writes run=true" true
run_step "$BASE" "$RENAME_OUT" false
assert_step_run "step: rename out of native/ writes run=true" true
run_step "$ZERO_SHA" "$DOCS_ONLY" false
assert_step_run "step: BEFORE=0000000 (new branch) writes run=true" true
run_step "$BASE" "$DOCS_ONLY" true
assert_step_run "step: on-demand (ci/mac-** or dispatch) writes run=true" true

run_step "$BASE" notasha false
if [ "$STEP_RC" -ne 0 ] || [ "$STEP_OUTPUT" = "run=true" ]; then
  pass "step: bogus AFTER exits non-zero or writes run=true (rc=$STEP_RC, output='$STEP_OUTPUT')"
else
  fail "step: bogus AFTER exits non-zero or writes run=true" "rc=$STEP_RC" "GITHUB_OUTPUT='$STEP_OUTPUT'"
fi
if grep -qx 'run=' "$WORK/github_output"; then
  fail "step: bogus AFTER never writes an empty run=" "GITHUB_OUTPUT='$STEP_OUTPUT'"
else
  pass "step: bogus AFTER never writes an empty run="
fi

# A helper that cannot execute at all (rc 126/127) must not turn into run=.
chmod -x "$SCRATCH/$HELPER_REL"
run_step "$BASE" "$NATIVE_EDIT" false
chmod +x "$SCRATCH/$HELPER_REL"
if [ "$STEP_RC" -ne 0 ] || [ "$STEP_OUTPUT" = "run=true" ]; then
  pass "step: non-executable helper exits non-zero or writes run=true (rc=$STEP_RC, output='$STEP_OUTPUT')"
else
  fail "step: non-executable helper exits non-zero or writes run=true" "rc=$STEP_RC" "GITHUB_OUTPUT='$STEP_OUTPUT'"
fi

# ---------------------------------------------------------------- workflow: security invariants (REVIEW.md)
if grep -qE '^permissions:[[:space:]]*$' "$WORKFLOW" && grep -qE '^[[:space:]]+contents: read[[:space:]]*$' "$WORKFLOW"; then
  pass "workflow: permissions is contents: read"
else
  fail "workflow: permissions is contents: read"
fi
if grep -qE '^[[:space:]]*pull_request(_target)?:' "$WORKFLOW"; then
  fail "workflow: no pull_request trigger" "$(grep -nE '^[[:space:]]*pull_request' "$WORKFLOW")"
else
  pass "workflow: no pull_request trigger"
fi

echo
echo "apple-paths-changed: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
