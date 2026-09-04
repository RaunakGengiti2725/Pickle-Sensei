#!/usr/bin/env bash
# Create (or refresh) a disposable scratch clone of this repository for the
# fail-injection harness.
#
#   tools/ci-audit/make-scratch.sh --dest DIR [--sha SHA] [--source REPO]
#
# The scratch clone is a `git clone --local` of --source at --sha (default:
# HEAD of the source repo). Installed dependency trees (node_modules) are
# copied so that the canonical scripts run in the scratch exactly as they do in
# the source checkout without touching the network. A marker file
# (.git/ci-audit-scratch) is written so lib.sh refuses destructive git
# operations anywhere else.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$HERE/lib.sh"

SOURCE="$(cd "$HERE/../.." && pwd)"
DEST=""
SHA=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dest) DEST="$2"; shift 2 ;;
    --sha) SHA="$2"; shift 2 ;;
    --source) SOURCE="$2"; shift 2 ;;
    *) ca_die "unknown argument: $1" ;;
  esac
done
[ -n "$DEST" ] || ca_die "--dest is required"
[ -n "$SHA" ] || SHA="$(git -C "$SOURCE" rev-parse HEAD)"
export CI_AUDIT_SOURCE_REPO="$SOURCE"

if [ -e "$DEST" ]; then
  ca_assert_scratch "$DEST"
  echo "refreshing existing scratch $DEST -> $SHA"
  git -C "$DEST" fetch -q "$SOURCE" "$SHA"
  ca_reset_scratch "$DEST" "$SHA"
else
  echo "cloning $SOURCE -> $DEST @ $SHA"
  git clone -q --local --no-checkout "$SOURCE" "$DEST"
  git -C "$DEST" checkout -q "$SHA"
  : >"$DEST/$CI_AUDIT_MARKER"
fi

# Copy dependency trees (ignored paths, so git reset/clean leave them alone).
copy_tree() {
  local rel=$1
  [ -d "$SOURCE/$rel" ] || return 0
  [ -d "$DEST/$rel" ] && return 0
  mkdir -p "$(dirname "$DEST/$rel")"
  cp -a "$SOURCE/$rel" "$DEST/$rel"
  echo "  copied $rel"
}
copy_tree node_modules
copy_tree apps/mobile/node_modules
while IFS= read -r nm; do
  copy_tree "${nm#"$SOURCE"/}"
done < <(find "$SOURCE/apps" "$SOURCE/packages" "$SOURCE/services" "$SOURCE/tools" \
  -mindepth 2 -maxdepth 3 -type d -name node_modules -not -path '*/node_modules/*' 2>/dev/null)

echo "scratch ready: $DEST @ $(git -C "$DEST" rev-parse HEAD) (dirty=$(git -C "$DEST" status --porcelain | grep -q . && echo true || echo false))"
