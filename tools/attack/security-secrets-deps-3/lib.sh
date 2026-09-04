#!/usr/bin/env bash
# Shared helpers for the security-secrets-deps adversarial harness (pass 3).
#
# Every scenario script sources this file, plants ONLY synthetic, randomly
# generated credential-shaped strings (never real secrets), never prints them,
# removes them on exit, and finishes with one of:
#   RESULT: HELD          (exit 0)  the control behaved as the gate promises
#   RESULT: BROKEN        (exit 1)  reproduced gap — see the scenario header
#   RESULT: INCONCLUSIVE  (exit 3)  the probe could not establish either
# Seeded randomness: ATTACK_SEED (default 20260904) drives bash's RANDOM so a
# rerun plants byte-identical probe values.
set -euo pipefail

ATTACK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$ATTACK_DIR/../../.." && pwd)"
ATTACK_SEED="${ATTACK_SEED:-20260904}"
ATTACK_OUT="${ATTACK_OUT:-$REPO_ROOT/artifacts/attack-security-secrets-deps-3}"
mkdir -p "$ATTACK_OUT"
RANDOM=$ATTACK_SEED

CLEANUP_PATHS=()
cleanup() {
  # Runs from the EXIT trap: must not let errexit rewrite the scenario's
  # exit status, so it never fails.
  set +e
  local p
  for p in "${CLEANUP_PATHS[@]}"; do
    rm -rf -- "$p"
  done
  return 0
}
trap cleanup EXIT

log() { printf '[attack] %s\n' "$*" >&2; }

# Register a path for removal on exit (probe files, temp dirs).
track() { CLEANUP_PATHS+=("$1"); }

# Deterministic pseudo-random string from ALPHABET of length N (uses $RANDOM).
rand_chars() {
  local alphabet="$1" n="$2" out="" i
  for ((i = 0; i < n; i++)); do
    out+="${alphabet:$((RANDOM % ${#alphabet})):1}"
  done
  printf '%s' "$out"
}

# AWS-access-key-shaped token: AKIA + 16 chars of [A-Z2-7] (gitleaks
# `aws-access-token` rule shape). Purely synthetic.
fake_aws_key() { printf 'AKIA%s' "$(rand_chars ABCDEFGHIJKLMNOPQRSTUVWXYZ234567 16)"; }

# JWT-shaped token: header.payload.signature with base64url-looking segments.
fake_jwt() {
  local a='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  printf 'eyJ%s.eyJ%s.%s' "$(rand_chars "$a" 33)" "$(rand_chars "$a" 60)" "$(rand_chars "${a}_-" 43)"
}

# Run scripts/security-scan.sh with the given args, capturing rc without
# aborting the harness. Output goes to $ATTACK_OUT/<label>.log.
scan() {
  local label="$1"
  shift
  local rc=0
  "$REPO_ROOT/scripts/security-scan.sh" "$@" > "$ATTACK_OUT/$label.log" 2>&1 || rc=$?
  log "security-scan $* → exit $rc ($ATTACK_OUT/$label.log)"
  return "$rc"
}

# Assert the working tree has no leftover probe files (the harness must never
# leave anything that could be committed).
assert_clean_tree() {
  local dirty
  dirty="$(cd "$REPO_ROOT" && git status --porcelain --untracked-files=all -- . ':!artifacts' | grep -v '^?? tools/attack/' || true)"
  if [ -n "$dirty" ]; then
    log "working tree not clean after probe:"
    printf '%s\n' "$dirty" >&2
    return 1
  fi
}

held() { echo "RESULT: HELD — $*"; exit 0; }
broken() { echo "RESULT: BROKEN — $*"; exit 1; }
inconclusive() { echo "RESULT: INCONCLUSIVE — $*"; exit 3; }
