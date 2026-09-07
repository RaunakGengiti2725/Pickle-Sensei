#!/usr/bin/env bash
# Decide whether a push touched anything the Apple/M4 verification could care
# about. Used by .github/workflows/mac-full-verify.yml for pushes to main so the
# physical runner is not woken by docs-only or Linux-only commits.
#
# Usage: tools/macos-ci/apple-paths-changed.sh <before-sha> <after-sha>
# Prints "true" or "false" on stdout (always exit 0 unless misused):
#   true   Apple-relevant paths changed, or <before-sha> is unknown to this
#          clone (force-push / first push) — when in doubt, run.
#   false  nothing Apple-relevant changed.
# The list of changed paths goes to stderr for the job log.
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

changed="$(git diff --name-only "$before" "$after")"
printf '%s\n' "$changed" >&2
if printf '%s\n' "$changed" | grep -Eq "$APPLE_PATHS"; then
  echo true
else
  echo "no Apple-relevant paths changed; skipping the Mac" >&2
  echo false
fi
