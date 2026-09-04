#!/usr/bin/env bash
# Shared helpers for the ci-workflows-scripts adversarial pass (tester #2, pass 3).
#
# Every scenario script sources this file, performs ONE attack against the
# checked-out commit, and records a verdict line. Nothing here touches
# production code, the Mac runner, or any remote; scratch state lives under
# $ATTACK_OUT (default: artifacts/attack-ci-workflows-scripts-2/<UTC stamp>).
#
# Verdicts:
#   HELD    the gate behaved as documented under the attack
#   BROKEN  the gate misbehaved (finding; observed/expected recorded)
#   UNKNOWN the attack needs a plane we cannot run from here (Apple runner);
#           only static / artifact evidence was collected
set -uo pipefail

ATTACK_REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
ATTACK_STAMP="${ATTACK_STAMP:-$(date -u +%Y%m%dT%H%M%SZ)}"
ATTACK_OUT="${ATTACK_OUT:-$ATTACK_REPO_ROOT/artifacts/attack-ci-workflows-scripts-2/$ATTACK_STAMP}"
mkdir -p "$ATTACK_OUT"
ATTACK_RESULTS="$ATTACK_OUT/results.jsonl"
ATTACK_SEED="${ATTACK_SEED:-20260904}"

alog() { printf '[attack] %s\n' "$*" >&2; }

# Deterministic pseudo-random alphanumerics from ATTACK_SEED + a label, so a
# rerun reproduces the exact same planted values without printing them.
seeded_token() {
  # $1 = label, $2 = length
  python3 - "$ATTACK_SEED" "$1" "$2" <<'PY'
import random, string, sys
seed, label, n = sys.argv[1], sys.argv[2], int(sys.argv[3])
rng = random.Random(f"{seed}:{label}")
alphabet = string.ascii_letters + string.digits
print("".join(rng.choice(alphabet) for _ in range(n)))
PY
}

sha256_of_string() { printf '%s' "$1" | sha256sum | awk '{print $1}'; }

# Remove ANSI SGR sequences (gitleaks colours its console output).
strip_ansi() { sed -E 's/\x1b\[[0-9;]*m//g' "$1"; }

json_str() {
  python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$1"
}

# record <scenario> <verdict> <observed> <expected> <artifact...>
record_verdict() {
  local scenario="$1" verdict="$2" observed="$3" expected="$4"
  shift 4
  local arts="[]"
  if [ $# -gt 0 ]; then
    arts="$(python3 -c 'import json,sys; print(json.dumps(sys.argv[1:]))' "$@")"
  fi
  printf '{"scenario": %s, "verdict": %s, "observed": %s, "expected": %s, "artifacts": %s, "seed": %s}\n' \
    "$(json_str "$scenario")" "$(json_str "$verdict")" "$(json_str "$observed")" "$(json_str "$expected")" \
    "$arts" "$(json_str "$ATTACK_SEED")" >>"$ATTACK_RESULTS"
  alog "$scenario → $verdict: $observed"
}

# assert_eq <label> <actual> <expected>  → returns 1 on mismatch (caller decides verdict)
assert_eq() {
  if [ "$2" = "$3" ]; then
    alog "  ok   $1 = $2"
    return 0
  fi
  alog "  FAIL $1: got '$2' expected '$3'"
  return 1
}

assert_grep() {
  # $1 label, $2 pattern (ERE), $3 file
  if grep -Eq -- "$2" "$3"; then
    alog "  ok   $1 (/$2/ in $(basename "$3"))"
    return 0
  fi
  alog "  FAIL $1: /$2/ not found in $3"
  return 1
}

assert_not_grep() {
  if grep -Eq -- "$2" "$3"; then
    alog "  FAIL $1: /$2/ unexpectedly present in $3"
    return 1
  fi
  alog "  ok   $1 (/$2/ absent from $(basename "$3"))"
  return 0
}

# Like assert_not_grep but never echoes the pattern (used for planted secrets).
assert_secret_absent() {
  # $1 label, $2 fixed string, $3 file
  if grep -Fq -- "$2" "$3"; then
    alog "  FAIL $1: planted value present in $3"
    return 1
  fi
  alog "  ok   $1 (planted value absent from $(basename "$3"))"
  return 0
}

# A fresh scratch clone of the current HEAD (no remote, no network). Used when
# an attack must commit or delete tracked files without touching this checkout.
scratch_clone() {
  local dest="$1"
  rm -rf "$dest"
  git clone -q --no-hardlinks "$ATTACK_REPO_ROOT" "$dest"
  (cd "$dest" && git checkout -q "$(git -C "$ATTACK_REPO_ROOT" rev-parse HEAD)" && git remote remove origin)
}

cleanup_paths=()
register_cleanup() { cleanup_paths+=("$@"); }
run_cleanup() {
  local p
  for p in "${cleanup_paths[@]+"${cleanup_paths[@]}"}"; do
    rm -rf -- "$p"
  done
}
trap run_cleanup EXIT
