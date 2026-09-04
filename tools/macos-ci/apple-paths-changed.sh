#!/usr/bin/env bash
# Decide whether a push touched anything the Apple/M4 verification could care
# about. Used by .github/workflows/mac-full-verify.yml for pushes to main so the
# physical runner is not woken by docs-only or Linux-only commits.
#
# Usage: tools/macos-ci/apple-paths-changed.sh <before-sha> <after-sha>
# Prints "true" or "false" on stdout (always exit 0 unless misused):
#   true   Apple-relevant paths changed, or <before-sha> is unknown to this
#          clone (force-push / first push), or git could not compute the diff
#          — when in doubt, run.
#   false  nothing Apple-relevant changed.
# The list of changed paths goes to stderr for the job log.
#
# Paths are compared NUL-separated (-z) so git never quotes/escapes them (a
# non-ASCII Swift file name must still match ^native/), and with --no-renames
# so a rename out of an Apple path is seen as the deletion it is.
set -euo pipefail

if [ $# -ne 2 ]; then
  echo "usage: $0 <before-sha> <after-sha>" >&2
  exit 2
fi
before="$1"
after="$2"

APPLE_PATHS='^(native/|apps/mobile/ios/|apps/mobile/package(-lock)?\.json$|apps/mobile/Gemfile|scripts/mac-full-verify\.sh$|tools/macos-ci/|\.github/workflows/mac-full-verify\.yml$)'

if ! git cat-file -e "${before}^{commit}" 2>/dev/null; then
  echo "no base commit ($before); running" >&2
  echo true
  exit 0
fi

# NUL-separated output cannot live in a shell variable (bash drops NUL bytes).
changed="$(mktemp)"
trap 'rm -f "$changed"' EXIT
if ! git diff --name-only --no-renames -z "$before" "$after" >"$changed"; then
  echo "git diff $before $after failed; running" >&2
  echo true
  exit 0
fi

tr '\0' '\n' <"$changed" >&2
if grep -Ezq "$APPLE_PATHS" "$changed"; then
  echo true
else
  echo "no Apple-relevant paths changed; skipping the Mac" >&2
  echo false
fi
