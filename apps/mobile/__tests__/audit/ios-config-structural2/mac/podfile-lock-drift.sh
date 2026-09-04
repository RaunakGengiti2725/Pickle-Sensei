#!/usr/bin/env bash
# AUDIT HARNESS (mobile-ios-config / auditor #2) — Mac only, NOT run on Linux.
#
# Suspected defect: the committed apps/mobile/ios/Podfile.lock is rewritten by
# `bundle exec pod install` on the Mac runner with the SAME CocoaPods 1.15.2
# (Mac Full Verify run 33841813597 on 4d812e1a, pod-install.log:580-581 and
# ios-app.log:30-31 print " M Podfile.lock"). tools/macos-ci/pod-install.sh
# only prints `git status --short Podfile.lock || true`, so the build that is
# verified uses a lockfile that differs from the one in git and the drift is
# never surfaced as a failure. This harness makes the drift a hard failure and
# prints the diff so the content can be triaged.
#
# Usage (on the Mac, from the repo root, after `bundle install` in apps/mobile):
#   apps/mobile/__tests__/audit/ios-config-structural2/mac/podfile-lock-drift.sh
# Exit 0  = Podfile.lock is reproducible from the Podfile with the pinned pods.
# Exit 1  = pod install rewrote Podfile.lock (diff printed).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../../../.." && pwd)"
IOS_DIR="$REPO_ROOT/apps/mobile/ios"
OUT_DIR="${AUDIT_OUT_DIR:-$REPO_ROOT/artifacts/audit-ios-config-structural2}"
mkdir -p "$OUT_DIR"

if ! git -C "$IOS_DIR" diff --quiet -- Podfile.lock; then
  echo "::error::Podfile.lock already dirty before pod install; commit or restore it first" >&2
  exit 2
fi

cp "$IOS_DIR/Podfile.lock" "$OUT_DIR/Podfile.lock.before"
(cd "$REPO_ROOT/apps/mobile" && bundle exec pod --version | tee "$OUT_DIR/cocoapods-version.txt")
(cd "$IOS_DIR" && bundle exec pod install 2>&1 | tee "$OUT_DIR/pod-install.log")
cp "$IOS_DIR/Podfile.lock" "$OUT_DIR/Podfile.lock.after"

if git -C "$IOS_DIR" diff --exit-code -- Podfile.lock > "$OUT_DIR/Podfile.lock.diff"; then
  echo "Podfile.lock reproducible: pod install left the committed lock unchanged"
  exit 0
fi

echo "::error::pod install rewrote the committed Podfile.lock (diff: $OUT_DIR/Podfile.lock.diff)" >&2
cat "$OUT_DIR/Podfile.lock.diff" >&2
# Also try the strict mode CocoaPods offers for CI so the coordinator can see
# whether --deployment would have refused the stale lock outright.
cp "$OUT_DIR/Podfile.lock.before" "$IOS_DIR/Podfile.lock"
if (cd "$IOS_DIR" && bundle exec pod install --deployment > "$OUT_DIR/pod-install-deployment.log" 2>&1); then
  echo "note: pod install --deployment accepted the committed lock" >&2
else
  echo "note: pod install --deployment REJECTED the committed lock (see $OUT_DIR/pod-install-deployment.log)" >&2
fi
exit 1
