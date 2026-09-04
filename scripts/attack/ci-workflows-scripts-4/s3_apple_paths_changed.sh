#!/usr/bin/env bash
# S3 — tools/macos-ci/apple-paths-changed.sh: docs-only, unreachable/zero
# BEFORE sha, plus adversarial diffs (rename out of native/, non-ASCII file
# names, JS-only mobile changes) and the workflow's `run=$(...)` capture.
# Everything happens in a throwaway worktree; no branch is pushed and no
# Mac run is triggered.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

OUT="$ATTACK_EVIDENCE/s3"
rm -rf "$OUT" && mkdir -p "$OUT"
export GIT_AUTHOR_NAME=attack GIT_AUTHOR_EMAIL=attack@example.invalid
export GIT_COMMITTER_NAME=attack GIT_COMMITTER_EMAIL=attack@example.invalid

WT="$(scratch_worktree s3)"
trap 'remove_worktree "$WT"' EXIT
cd "$WT" || exit 2
BASE="$(git rev-parse HEAD)"
SCRIPT=tools/macos-ci/apple-paths-changed.sh

decide() { # $1 before $2 after → prints stdout, logs stderr, returns script rc
  local rc=0
  "$SCRIPT" "$1" "$2" 2>>"$OUT/stderr.log" || rc=$?
  echo "rc=$rc" >>"$OUT/stderr.log"
  return $rc
}

# 1. docs-only commit (4bc0377 touches only docs/devin/OPERATING_SYSTEM.md).
DOCS_ONLY=4bc037770ca826fa2213c4e1ddf45e81fa403f24
if git cat-file -e "$DOCS_ONLY^{commit}" 2>/dev/null; then
  assert_eq "docs-only commit → false" false "$(decide "$DOCS_ONLY^" "$DOCS_ONLY")"
  assert_eq "docs-only sha → HEAD (no Apple paths) → false" false "$(decide "$DOCS_ONLY" HEAD)"
else
  verdict BROKEN "docs-only fixture commit reachable" "$DOCS_ONLY not in clone"
fi
# Positive control: a commit touching tools/macos-ci + mac-full-verify.yml.
APPLE=416c959b50a6bc97574cf78ac0e2dd471d973f22
git cat-file -e "$APPLE^{commit}" 2>/dev/null && assert_eq "Apple-touching commit → true" true "$(decide "$APPLE^" "$APPLE")"

# 2. zero / unreachable / empty BEFORE → true (fail open to running the Mac).
assert_eq "zero sha BEFORE → true" true "$(decide 0000000000000000000000000000000000000000 HEAD)"
assert_eq "unreachable BEFORE (force-push) → true" true "$(decide deadbeefdeadbeefdeadbeefdeadbeefdeadbeef HEAD)"
assert_eq "empty BEFORE → true" true "$(decide '' HEAD)"
rc=0; "$SCRIPT" HEAD >/dev/null 2>&1 || rc=$?
assert_eq "one argument → usage exit 2" 2 "$rc"

# 3. bogus AFTER: the script fails (rc 128, no stdout). The workflow captures it
#    as `echo "run=$(...)"` — echo's status is 0, run='' → Mac job skipped, green.
rc=0; out="$("$SCRIPT" HEAD deadbeefdeadbeefdeadbeefdeadbeefdeadbeef 2>/dev/null)" || rc=$?
assert_eq "bogus AFTER → script exits non-zero" 128 "$rc"
assert_eq "bogus AFTER → prints nothing on stdout" "" "$out"
step_rc=0
export GITHUB_OUTPUT="$OUT/github_output.txt"; : >"$GITHUB_OUTPUT"
bash -e -c 'echo "run=$(tools/macos-ci/apple-paths-changed.sh "$1" "$2")" >> "$GITHUB_OUTPUT"' _ HEAD deadbeefdeadbeefdeadbeefdeadbeefdeadbeef 2>/dev/null || step_rc=$?
# mirrors .github/workflows/mac-full-verify.yml:68 (default `bash -e {0}` shell)
if [ "$step_rc" = 0 ] && grep -qx 'run=' "$GITHUB_OUTPUT"; then
  verdict BROKEN "workflow step fails when path detection fails" "step rc=0, GITHUB_OUTPUT has 'run=' (empty) → mac-full-verify skipped silently"
else
  verdict HELD "workflow step fails when path detection fails" "step rc=$step_rc"
fi

# 4. rename OUT of native/ (deletes a Swift source): git's default rename
#    detection lists only the destination path.
git checkout -q --detach "$BASE"
src="$(git ls-files native | grep '\.swift$' | head -1)"
mkdir -p docs/moved && git mv "$src" docs/moved/ && git commit -qm "move $src out of native/"
assert_eq "rename of $src out of native/ → true" true "$(decide "$BASE" HEAD)"
git diff --name-only "$BASE" HEAD >"$OUT/rename-diff-names.txt"
git -c diff.renames=false diff --name-only "$BASE" HEAD >"$OUT/rename-diff-names-norenames.txt"

# 5. non-ASCII filename inside native/: core.quotePath wraps the line in quotes
#    so the anchored ^native/ regex misses it.
git checkout -q --detach "$BASE"
printf 'x\n' >"native/vision-core/ünïcode.swift"
git add -A native && git commit -qm "unicode filename"
assert_eq "non-ASCII filename under native/ → true" true "$(decide "$BASE" HEAD)"
git diff --name-only "$BASE" HEAD >"$OUT/unicode-diff-names.txt"

# 6. JS-only mobile change (bundled into the iOS Release app): not an Apple
#    path by design — recorded for the report, not asserted.
git checkout -q --detach "$BASE"
printf '\n' >>apps/mobile/App.tsx && printf '\n' >>apps/mobile/babel.config.js && git commit -qam "js only"
log "apps/mobile/App.tsx + babel.config.js only → $(decide "$BASE" HEAD) (design: Linux-only gate)"

# 7. rapid repeats — deterministic output.
git checkout -q --detach "$BASE"
for _ in 1 2 3 4 5; do decide "$APPLE^" "$APPLE"; done | sort -u >"$OUT/repeat.txt"
assert_eq "5 rapid repeats agree" 1 "$(wc -l <"$OUT/repeat.txt")"

finish
