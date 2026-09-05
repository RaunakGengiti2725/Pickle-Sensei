#!/usr/bin/env bash
# Full cross-platform verification: Linux gates + real Apple verification.
#
#   scripts/verify-all.sh                  # verify-cloud.sh, then mac-full-verify.sh
#   scripts/verify-all.sh --cloud-args "--tier pr" --mac-args "--skip-launch"   # (--mac-args apply on macOS only)
#   scripts/verify-all.sh --no-mac         # Linux only (same as verify-cloud.sh)
#
# On Linux the Mac half runs on the self-hosted M4 runner through GitHub
# Actions (scripts/mac-full-verify.sh --remote pushes HEAD to a ci/mac-*
# trigger branch), so HEAD must be committed; on macOS it runs locally. Both
# halves must pass for a zero exit code; neither is ever silently skipped —
# use --no-mac explicitly.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

CLOUD_ARGS=""
MAC_ARGS=""
RUN_MAC=1
while [ $# -gt 0 ]; do
  case "$1" in
    --cloud-args) CLOUD_ARGS="$2"; shift 2 ;;
    --mac-args) MAC_ARGS="$2"; shift 2 ;;
    --no-mac) RUN_MAC=0; shift ;;
    -h|--help) sed -n "2,13p" "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

STATUS=0
echo "########## 1/2 Linux gates (scripts/verify-cloud.sh $CLOUD_ARGS)"
# shellcheck disable=SC2086
scripts/verify-cloud.sh $CLOUD_ARGS || STATUS=1

if [ "$RUN_MAC" = 1 ]; then
  echo "########## 2/2 Apple verification (scripts/mac-full-verify.sh $MAC_ARGS)"
  if [ "$(uname -s)" = "Darwin" ]; then
    # shellcheck disable=SC2086
    scripts/mac-full-verify.sh $MAC_ARGS || STATUS=1
  else
    # shellcheck disable=SC2086
    scripts/mac-full-verify.sh --remote $MAC_ARGS || STATUS=1
  fi
else
  echo "########## 2/2 Apple verification SKIPPED (--no-mac) — Apple-specific claims are unverified"
fi

if [ $STATUS -ne 0 ]; then echo "verify-all: FAILED"; exit 1; fi
echo "verify-all: OK"
