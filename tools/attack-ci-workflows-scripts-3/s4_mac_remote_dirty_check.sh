#!/usr/bin/env bash
# S4 — scripts/mac-full-verify.sh --remote from a tree with an UNTRACKED file.
#
# The remote path refuses to push when `git diff --quiet HEAD` is dirty, then
# pushes HEAD to a ci/mac-* trigger branch. `git diff HEAD` only sees tracked
# paths: a brand-new Swift file / Podfile / helper script that was never
# `git add`ed is invisible, so the Mac builds a commit that does not contain
# what the developer is looking at.
#
# SAFETY: this never contacts GitHub and never wakes the M4 runner.
#   * the script runs inside a throwaway `git clone` whose `origin` is a LOCAL
#     bare repository (so even an un-shimmed push could only land there);
#   * PATH is prefixed with shims/ where `git push` is logged and skipped and
#     `gh` answers canned data (a successful fake run), so the script runs to
#     completion and we can observe exactly what it would have done.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/attack-s4.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
BARE="$WORK/origin.git"
CLONE="$WORK/clone"
git init -q --bare "$BARE"
git clone -q --local --no-hardlinks "$REPO_ROOT" "$CLONE"
git -C "$CLONE" remote set-url origin "$BARE"
git -C "$CLONE" checkout -q -B attack/s4-dirty-tree "$(git -C "$REPO_ROOT" rev-parse HEAD)"
git -C "$CLONE" -c user.name=attack -c user.email=attack@example.invalid commit -q --allow-empty -m "s4 base"
git -C "$CLONE" push -q "$BARE" HEAD:refs/heads/attack/s4-dirty-tree
BASE_SHA="$(git -C "$CLONE" rev-parse HEAD)"

export SHIM_LOG="$OUT/shim_calls.log"
REAL_GIT="$(command -v git)"; export REAL_GIT
: >"$SHIM_LOG"
SHIMMED_PATH="$(shim_path):$PATH"

run_remote() { # <logfile>
  (cd "$CLONE" && PATH="$SHIMMED_PATH" MAC_ARTIFACTS="$OUT/mac-artifacts" scripts/mac-full-verify.sh --remote)
}

# --- 0. control: a clean tree pushes (proves the shims let the script finish) --
rc=$(run_capture "$OUT/clean_tree.log" run_remote)
if [ "$rc" = 0 ] && grep -q "git push .*HEAD:refs/heads/ci/mac-attack-s4-dirty-tree" "$SHIM_LOG"; then
  record HELD s4.control_clean "$rc" "$OUT/clean_tree.log" "clean tree → push to ci/mac-attack-s4-dirty-tree (intercepted by shim), exit 0"
else
  record BROKEN s4.control_clean "$rc" "$OUT/clean_tree.log" "control run did not behave (shim log: $(tr '\n' ';' <"$SHIM_LOG"))"
  verdict
fi
if ! git -C "$BARE" show-ref | grep -q "ci/mac-"; then
  record HELD s4.no_real_push 0 "$SHIM_LOG" "no ci/mac-* ref reached the (local) origin — push was intercepted"
else
  record BROKEN s4.no_real_push 1 "$SHIM_LOG" "a ci/mac-* ref reached origin — shim did not intercept"
fi

# --- 1. tracked file modified → must refuse (exit 2) ---------------------------
: >"$SHIM_LOG"
TRACKED_SWIFT="$(git -C "$CLONE" ls-files 'native/*.swift' | head -1)"
echo "// attack" >>"$CLONE/$TRACKED_SWIFT"
rc=$(run_capture "$OUT/modified_tracked.log" run_remote)
git -C "$CLONE" checkout -q -- "$TRACKED_SWIFT"
if [ "$rc" = 2 ] && ! grep -q "git push" "$SHIM_LOG"; then
  record HELD s4.modified_tracked "$rc" "$OUT/modified_tracked.log" "modified tracked file → refused, no push"
else
  record BROKEN s4.modified_tracked "$rc" "$OUT/modified_tracked.log" "modified tracked file: exit $rc, push=$(grep -c 'git push' "$SHIM_LOG")"
fi

# --- 2. UNTRACKED Apple-relevant file → should refuse; does it? ----------------
: >"$SHIM_LOG"
mkdir -p "$CLONE/native/Sources/Attack"
cat >"$CLONE/native/Sources/Attack/Untracked.swift" <<'SWIFT'
// This file exists only in the working tree. The Mac will build a commit without it.
import Foundation
public enum Attack { public static let present = true }
SWIFT
git -C "$CLONE" status --porcelain >"$OUT/untracked_status.txt"
rc=$(run_capture "$OUT/untracked_file.log" run_remote)
pushed_sha="$(git -C "$CLONE" rev-parse HEAD)"
if [ "$rc" = 2 ] && ! grep -q "git push" "$SHIM_LOG"; then
  record HELD s4.untracked_file "$rc" "$OUT/untracked_file.log" "untracked file → refused"
else
  record BROKEN s4.untracked_file "$rc" "$OUT/untracked_file.log" \
    "untracked native/Sources/Attack/Untracked.swift ignored: exit $rc, pushed $pushed_sha (=$BASE_SHA, lacks the file); status: $(tr '\n' ';' <"$OUT/untracked_status.txt")"
fi
# the pushed commit really lacks the file
if git -C "$CLONE" cat-file -e "$pushed_sha:native/Sources/Attack/Untracked.swift" 2>/dev/null; then
  record HELD s4.pushed_commit_content 0 "$OUT/untracked_file.log" "pushed commit contains the new file"
else
  record BROKEN s4.pushed_commit_content 1 "$OUT/untracked_file.log" "pushed commit $pushed_sha does not contain native/Sources/Attack/Untracked.swift"
fi

# --- 3. staged-but-uncommitted new file → `git diff HEAD` DOES see index adds --
: >"$SHIM_LOG"
git -C "$CLONE" add native/Sources/Attack/Untracked.swift
rc=$(run_capture "$OUT/staged_new_file.log" run_remote)
git -C "$CLONE" rm -q --cached native/Sources/Attack/Untracked.swift
if [ "$rc" = 2 ] && ! grep -q "git push" "$SHIM_LOG"; then
  record HELD s4.staged_new_file "$rc" "$OUT/staged_new_file.log" 'staged new file → refused (so `git add -A` before --remote is the only safe habit)'
else
  record BROKEN s4.staged_new_file "$rc" "$OUT/staged_new_file.log" "staged new file: exit $rc, push=$(grep -c 'git push' "$SHIM_LOG")"
fi
rm -rf "$CLONE/native/Sources/Attack"

# --- 4. untracked file inside apps/mobile/ios (CocoaPods/Xcode project) --------
: >"$SHIM_LOG"
mkdir -p "$CLONE/apps/mobile/ios"
echo "attack" >"$CLONE/apps/mobile/ios/Attack.xcconfig"
rc=$(run_capture "$OUT/untracked_ios.log" run_remote)
rm -f "$CLONE/apps/mobile/ios/Attack.xcconfig"
if [ "$rc" = 2 ] && ! grep -q "git push" "$SHIM_LOG"; then
  record HELD s4.untracked_ios "$rc" "$OUT/untracked_ios.log" "untracked ios file → refused"
else
  record BROKEN s4.untracked_ios "$rc" "$OUT/untracked_ios.log" "untracked apps/mobile/ios/Attack.xcconfig ignored: exit $rc, push=$(grep -c 'git push' "$SHIM_LOG")"
fi

# --- 5. detached HEAD: trigger branch name becomes ci/mac-HEAD -----------------
: >"$SHIM_LOG"
git -C "$CLONE" checkout -q --detach
rc=$(run_capture "$OUT/detached_head.log" run_remote)
git -C "$CLONE" checkout -q attack/s4-dirty-tree
if grep -q "HEAD:refs/heads/ci/mac-HEAD" "$SHIM_LOG"; then
  record BROKEN s4.detached_head_trigger "$rc" "$OUT/detached_head.log" "detached HEAD → every agent shares trigger branch ci/mac-HEAD; the workflow's concurrency group is per ref with cancel-in-progress, so a second agent's push cancels the first agent's 1-2h Mac run"
else
  record HELD s4.detached_head_trigger "$rc" "$OUT/detached_head.log" "detached HEAD handled: $(grep 'git push' "$SHIM_LOG" || echo no-push)"
fi

verdict
