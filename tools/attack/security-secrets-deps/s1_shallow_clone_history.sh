#!/usr/bin/env bash
# Adversarial scenario S1 — does `scripts/security-scan.sh --history` notice a
# shallow clone, or does it silently scan the single reachable commit?
#
# Builds a throwaway source repo (full clone of this checkout + one commit that
# ADDS a synthetic secret + one commit that REMOVES it), then `git clone --depth 1`
# it and runs the gate's --history mode inside the shallow clone.
#
#   tools/attack/security-secrets-deps/s1_shallow_clone_history.sh [out-dir]
#
# Exit 0 = HELD (the gate refuses / warns loudly on a shallow clone AND/OR still
#          finds the secret), exit 1 = BROKEN (shallow clone passes silently
#          while the full-history scan of the same commit graph fails).
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
OUT="${1:-$REPO_ROOT/artifacts/attack/s1}"
mkdir -p "$OUT"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

git clone -q "$REPO_ROOT" "$WORK/source"
(
  cd "$WORK/source"
  git config user.email attack@example.test
  git config user.name attack
  # Synthetic, non-functional value: the RevenueCat secret-key SHAPE only
  # (fixed high-entropy tail so the `entropy = 3` rule threshold is met).
  printf 'REVENUECAT_SECRET_API_KEY=sk_Qx7Lm2Vp9Rt4Wk8Zn3Hy6Bd1Fg5Jc0NsUe\n' > planted.env.txt
  git add planted.env.txt
  git commit -q -m "attack: plant synthetic secret"
  git rm -q planted.env.txt
  git commit -q -m "attack: remove synthetic secret"
)

git clone -q --depth 1 "file://$WORK/source" "$WORK/shallow"
echo "shallow clone is-shallow=$(git -C "$WORK/shallow" rev-parse --is-shallow-repository) commits=$(git -C "$WORK/shallow" rev-list --count HEAD)" | tee "$OUT/shallow.txt"

rc_full=0
(cd "$WORK/source" && scripts/security-scan.sh --history) >"$OUT/full-history.log" 2>&1 || rc_full=$?
rc_shallow=0
(cd "$WORK/shallow" && scripts/security-scan.sh --history) >"$OUT/shallow-history.log" 2>&1 || rc_shallow=$?

echo "full-clone  --history exit=$rc_full" | tee -a "$OUT/shallow.txt"
echo "shallow(depth1) --history exit=$rc_shallow" | tee -a "$OUT/shallow.txt"
if grep -qi shallow "$OUT/shallow-history.log"; then
  echo "gate mentions 'shallow' in its output" | tee -a "$OUT/shallow.txt"
  mentions=1
else
  echo "gate output never mentions the shallow clone" | tee -a "$OUT/shallow.txt"
  mentions=0
fi

if [ "$rc_full" = 1 ] && [ "$rc_shallow" = 0 ] && [ "$mentions" = 0 ]; then
  echo "BROKEN: secret in unreachable history passes silently on a shallow clone" | tee -a "$OUT/shallow.txt"
  exit 1
fi
echo "HELD" | tee -a "$OUT/shallow.txt"
