#!/usr/bin/env bash
# Adversarial tests for the CI-04/CI-05 fix in scripts/verify-cloud.sh +
# scripts/security-scan.sh (candidate 429fd62d). Same harness as
# verify-cloud-provenance.test.sh; each case pins a behaviour the fix claims.
#
#   scripts/tests/verify-cloud-provenance-attack.test.sh
#
#   A. security.log must not contain ANY secret material. gitleaks --redact only
#      blanks the secret of the finding being printed; the `Finding:` context
#      line it emits under --verbose still shows up to ~20 chars either side of
#      it — i.e. a neighbouring secret on the same line ends up in the stage log
#      that ci.yml uploads as an artifact. Two variants:
#        A1. two custom-rule (sb_secret_) values on one line -> 19-char prefix of
#            the second and 19-char suffix of the first leak into security.log
#        A2. two 12-char generic-api-key values on one line -> BOTH leak in full
#   B. an untracked path under artifacts/ whose name is non-ASCII is still an
#      artifacts/ path. git status --porcelain (core.quotePath=true, the default)
#      prints it C-quoted: `?? "artifacts/r\303\251sum\303\251.log"`, which the
#      literal `'?? artifacts/'*` prefix match in git_dirty() does not exempt ->
#      dirty=true for a clean checkout.
#
# Needs git, bash, python3 and the pinned gitleaks (scripts/security-scan.sh
# downloads it once into its cache). Exit 0 = all cases passed.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
for tool in git python3; do
  command -v "$tool" >/dev/null 2>&1 || { echo "missing required tool: $tool" >&2; exit 75; }
done

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
SCRATCH="$WORK/repo"

FAILURES=0
pass() { echo "PASS: $*"; }
fail() { echo "FAIL: $*"; FAILURES=$((FAILURES + 1)); }
assert_eq() {
  # assert_eq <label> <expected> <actual>
  if [ "$2" = "$3" ]; then pass "$1 ($3)"; else fail "$1: expected '$2', got '$3'"; fi
}

fresh_scratch() {
  rm -rf "$SCRATCH"
  mkdir -p "$SCRATCH/scripts"
  cp "$REPO_ROOT/scripts/verify-cloud.sh" "$REPO_ROOT/scripts/security-scan.sh" "$SCRATCH/scripts/"
  cp "$REPO_ROOT/.gitleaks.toml" "$SCRATCH/"
  echo "tracked" >"$SCRATCH/tracked.txt"
  git -C "$SCRATCH" init -q
  git -C "$SCRATCH" add -A
  git -C "$SCRATCH" -c user.email=test@example.invalid -c user.name=test commit -q -m "scratch"
}

# dirty_flag <artifacts dir> -> prints "<header dirty>/<summary dirty>" ; exit code of verify-cloud in $?
dirty_flag() {
  local va="$1" out header summary rc
  out="$(cd "$SCRATCH" && VERIFY_ARTIFACTS="$va" scripts/verify-cloud.sh --only ml --skip ml 2>&1)"
  rc=$?
  header="$(printf '%s\n' "$out" | sed -n 's/.*(dirty=\([a-z]*\)).*/\1/p' | head -n 1)"
  summary="$(python3 -c 'import json,sys; print(str(json.load(open(sys.argv[1]))["dirty"]).lower())' "$va/summary.json" 2>/dev/null || echo missing)"
  printf '%s/%s' "$header" "$summary"
  return "$rc"
}

# secret_material_in <file> <value>... -> prints the number of given values whose
# 8+ char runs (any substring of length >= 8) appear in the file. Every finding is
# supposed to be REDACTED, so the answer must be 0 for every planted value.
secret_material_in() {
  python3 - "$@" <<'PY'
import sys
path, values = sys.argv[1], sys.argv[2:]
with open(path, errors="replace") as fh:
    text = fh.read()
hits = 0
for v in values:
    if any(v[i:i + 8] in text for i in range(len(v) - 7)):
        hits += 1
print(hits)
PY
}

# ---- A1. two sb_secret_ values on one line ---------------------------------
fresh_scratch
VA="$WORK/va-pair"
mkdir -p "$SCRATCH/fixtures"
# Synthetic values shaped like the custom `supabase-secret-api-key` rule (sb_secret_ + 20+ chars).
SECRET_A="sb_secret_$(printf 'A%.0s' $(seq 1 32))"
SECRET_B="sb_secret_$(printf 'B%.0s' $(seq 1 32))"
printf 'keys=%s,%s\n' "$SECRET_A" "$SECRET_B" >"$SCRATCH/fixtures/pair.env"
(cd "$SCRATCH" && VERIFY_ARTIFACTS="$VA" scripts/verify-cloud.sh --only security >"$WORK/pair-run.out" 2>&1)
assert_eq "A1 --only security exit with two planted values on one line" 1 "$?"
if [ -f "$VA/security.log" ]; then
  assert_eq "A1 security.log carries no material of either planted value" 0 "$(secret_material_in "$VA/security.log" "$SECRET_A" "$SECRET_B")"
else
  fail "A1 security.log missing at $VA/security.log"
fi
assert_eq "A1 verify-cloud stdout carries no material of either planted value" 0 "$(secret_material_in "$WORK/pair-run.out" "$SECRET_A" "$SECRET_B")"
if [ -f "$VA/security/gitleaks-tree.json" ]; then
  assert_eq "A1 gitleaks-tree.json carries no material of either planted value" 0 "$(secret_material_in "$VA/security/gitleaks-tree.json" "$SECRET_A" "$SECRET_B")"
else
  fail "A1 JSON report missing at $VA/security/gitleaks-tree.json"
fi

# ---- A2. two short generic-api-key values on one line ----------------------
fresh_scratch
VA="$WORK/va-short"
mkdir -p "$SCRATCH/fixtures"
# 12 distinct chars each (entropy > 3.5 so gitleaks' generic-api-key rule fires);
# separator short enough that each value sits inside the other's context window.
SHORT_A="Zq8Kp2Lm9Xv4"
SHORT_B="Rt7Yw1Nb6Hc3"
printf 'key1="%s";key2="%s"\n' "$SHORT_A" "$SHORT_B" >"$SCRATCH/fixtures/short.env"
(cd "$SCRATCH" && VERIFY_ARTIFACTS="$VA" scripts/verify-cloud.sh --only security >"$WORK/short-run.out" 2>&1)
assert_eq "A2 --only security exit with two short planted values on one line" 1 "$?"
if [ -f "$VA/security.log" ]; then
  if grep -qF "$SHORT_A" "$VA/security.log" || grep -qF "$SHORT_B" "$VA/security.log"; then
    fail "A2 security.log contains a planted value verbatim"
  else
    pass "A2 security.log contains neither planted value verbatim"
  fi
else
  fail "A2 security.log missing at $VA/security.log"
fi
if grep -qF "$SHORT_A" "$WORK/short-run.out" || grep -qF "$SHORT_B" "$WORK/short-run.out"; then
  fail "A2 verify-cloud stdout contains a planted value verbatim"
else
  pass "A2 verify-cloud stdout contains neither planted value verbatim"
fi

# ---- B. only an untracked non-ASCII artifacts/ path -> dirty=false ---------
fresh_scratch
# A tracked placeholder keeps git from collapsing the directory to `?? artifacts/`
# so porcelain reports the untracked file's own (quoted) path.
mkdir -p "$SCRATCH/artifacts"
: >"$SCRATCH/artifacts/.gitkeep"
git -C "$SCRATCH" add artifacts/.gitkeep
git -C "$SCRATCH" -c user.email=test@example.invalid -c user.name=test commit -q -m "artifacts placeholder"
: >"$SCRATCH/artifacts/résumé.log"
porcelain="$(git -C "$SCRATCH" status --porcelain)"
case "$porcelain" in
  '?? "artifacts/'*) pass "B precondition: git quotes the non-ASCII path ($porcelain)" ;;
  *) fail "B precondition: expected a C-quoted porcelain line, got '$porcelain'" ;;
esac
result="$(dirty_flag "$WORK/va-unicode")"
assert_eq "B verify-cloud exit with only a non-ASCII artifacts/ path untracked" 0 "$?"
assert_eq "B dirty flag with only a non-ASCII artifacts/ path untracked" "false/false" "$result"

echo
if [ "$FAILURES" -ne 0 ]; then
  echo "verify-cloud-provenance-attack: $FAILURES assertion(s) FAILED"
  exit 1
fi
echo "verify-cloud-provenance-attack: OK"
