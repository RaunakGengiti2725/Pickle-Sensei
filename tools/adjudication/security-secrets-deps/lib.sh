#!/usr/bin/env bash
# Shared helpers for the security-secrets-deps adjudication reproductions.
# Every script: exit 0 when the gate HELD (defect fixed), 1 when BROKEN
# (defect reproduced), 2 on setup failure. Canaries are random per run and
# never printed; reports go OUTSIDE the repo so gitleaks never re-scans them.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
OUT="${ADJ_OUT:-${HOME}/adjudication-artifacts/security-secrets-deps}"
mkdir -p "$OUT"
export SECURITY_SCAN_CACHE="${SECURITY_SCAN_CACHE:-${HOME}/.cache/pickle-sensei-security-scan}"

BROKEN=0
verdict() { # verdict <HELD|BROKEN> <check> <detail>
  printf '%s|%s|%s\n' "$1" "$2" "$3" | tee -a "$OUT/verdicts.txt"
  [ "$1" = BROKEN ] && BROKEN=1 || true
}
die() { echo "setup failure: $*" >&2; exit 2; }
finish() { [ "$BROKEN" = 0 ] && exit 0 || exit 1; }

rand() { head -c 64 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c "$1"; }
canary_payload() { # matches supabase-secret-api-key, aws-access-token, generic-api-key
  printf '# canary\nSUPABASE_SERVICE_ROLE_KEY=sb_secret_%s\nAWS_ACCESS_KEY_ID=AKIA%s\napi_key = "%s"\n' \
    "$(rand 40)" "$(head -c 64 /dev/urandom | tr -dc 'A-Z0-9' | head -c 16)" "$(rand 40)"
}

# The gate under test is the checked-out tree's, not HEAD's: a clone only carries
# committed files, so the policy and the wrapper are overlaid from the working
# tree (this is what makes `git checkout <sha> -- .gitleaks.toml` revert checks
# and uncommitted fixes observable).
GATE_FILES=(.gitleaks.toml scripts/security-scan.sh)

throwaway_clone() { # throwaway_clone <dest> [extra git clone args...]
  local dest="$1" f; shift
  rm -rf "$dest"
  git clone -q "$@" "$REPO_ROOT" "$dest" || die "clone failed"
  for f in "${GATE_FILES[@]}"; do
    [ -f "$REPO_ROOT/$f" ] || die "$f missing from the working tree"
    cp -p "$REPO_ROOT/$f" "$dest/$f" || die "cannot overlay $f"
  done
  git -C "$dest" config user.email adjudicator@example.invalid
  git -C "$dest" config user.name adjudicator
}
