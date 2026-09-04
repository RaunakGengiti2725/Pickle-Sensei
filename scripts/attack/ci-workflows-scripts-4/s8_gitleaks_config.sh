#!/usr/bin/env bash
# S8 — scripts/security-scan.sh setup failures must exit 2 with a reason, never
# degrade into a default-rules "PASS":
#   1. .gitleaks.toml hidden (scratch worktree)      → exit 2 "missing"
#   2. .gitleaks.toml present but empty / malformed → gitleaks error, not PASS
#   3. shallow clone (history scan has ~1 commit)   → must not report a clean
#      full history (records behaviour; asserts a warning or non-zero)
#   4. unknown flag                                  → exit 2
#   5. read-only cache dir + no cached binary        → exit 2 (setup), not a raw mv/mkdir error
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

OUT="$ATTACK_EVIDENCE/s8"
rm -rf "$OUT" && mkdir -p "$OUT"
export SECURITY_SCAN_CACHE="${ATTACK_GITLEAKS_CACHE:-${XDG_CACHE_HOME:-$HOME/.cache}/pickle-sensei}"

WT="$(scratch_worktree s8)"
trap 'remove_worktree "$WT"; chmod -R u+w "$OUT/ro-cache" 2>/dev/null || true' EXIT
cd "$WT" || exit 2

scan() { # $1 label, rest = args → prints rc
  local label="$1" rc=0; shift
  scripts/security-scan.sh --tree "$@" >"$OUT/$label.log" 2>&1 || rc=$?
  echo "$rc"
}

# Warm the cache so later probes exercise policy, not download.
rc="$(scan warm)"
assert_eq "control: tree scan on a clean scratch checkout exits 0" 0 "$rc"

# 1. hidden config
mv .gitleaks.toml "$OUT/.gitleaks.toml.hidden"
rc="$(scan no-config)"
assert_eq "hidden .gitleaks.toml → exit 2" 2 "$rc"
assert_grep "hidden .gitleaks.toml → 'missing' message" "ERROR: missing .*\.gitleaks\.toml" "$OUT/no-config.log"
assert_not_grep "hidden .gitleaks.toml → no PASS" "PASS: no secrets detected" "$OUT/no-config.log"
mv "$OUT/.gitleaks.toml.hidden" .gitleaks.toml

# 2. empty / malformed config (present, so the -f check passes). Plant a
#    synthetic, seeded (seed=4) fake credential in an untracked file so the
#    scan has something it MUST catch; the repo policy is the control.
cp .gitleaks.toml "$OUT/.gitleaks.toml.orig"
python3 - >planted-leak.txt <<'PY'
import random, string
random.seed(4)
u = string.ascii_uppercase + string.digits
a = string.ascii_letters + string.digits
print('aws_access_key_id = "AKIA' + ''.join(random.choice(u) for _ in range(16)) + '"')
print('github_token = "ghp_' + ''.join(random.choice(a) for _ in range(36)) + '"')
PY
rc="$(scan planted-repo-config)"
assert_eq "control: planted fake credential is caught by the repo policy (exit 1)" 1 "$rc"
assert_grep "control: repo policy reports FINDINGS" "tree: FINDINGS" "$OUT/planted-repo-config.log"
: >.gitleaks.toml
rc="$(scan empty-config)"
log "empty .gitleaks.toml → rc=$rc; $(grep -m1 -E 'tree:|ERROR|PASS|FAIL' "$OUT/empty-config.log")"
if [ "$rc" = 0 ] && grep -q "PASS: no secrets detected" "$OUT/empty-config.log"; then
  verdict BROKEN "empty .gitleaks.toml with a planted credential does not yield a PASS" \
    "rc=0, 'PASS: no secrets detected' while the same tree fails under the real policy — empty policy = zero rules, scan is a no-op"
else
  verdict HELD "empty .gitleaks.toml with a planted credential does not yield a PASS" "rc=$rc"
fi
rm -f planted-leak.txt
printf '[[rules]]\nid = "broken\n' >.gitleaks.toml
rc="$(scan malformed-config)"
assert_ne "malformed .gitleaks.toml → non-zero" 0 "$rc"
assert_not_grep "malformed .gitleaks.toml → no PASS" "PASS: no secrets detected" "$OUT/malformed-config.log"
cp "$OUT/.gitleaks.toml.orig" .gitleaks.toml

# 4. unknown flag
rc=0; scripts/security-scan.sh --bogus >"$OUT/bogus-flag.log" 2>&1 || rc=$?
assert_eq "unknown flag → exit 2" 2 "$rc"
rc=0; scripts/security-scan.sh --tree --history >"$OUT/tree-history.log" 2>&1 || rc=$?
assert_eq "--tree --history → exit 2 (mutually exclusive)" 2 "$rc"

# 3. shallow clone: history scan sees one commit.
SHALLOW="$(mktemp -d "${TMPDIR:-/tmp}/attack-s8-shallow-XXXXXX")"
git clone -q --depth 1 "file://$REPO_ROOT" "$SHALLOW/repo" 2>>"$OUT/shallow-clone.log"
if [ -d "$SHALLOW/repo" ]; then
  rc=0; (cd "$SHALLOW/repo" && scripts/security-scan.sh --history) >"$OUT/shallow-history.log" 2>&1 || rc=$?
  n="$(git -C "$SHALLOW/repo" rev-list --count HEAD)"
  log "shallow clone has $n commit(s); --history rc=$rc; $(grep -m1 -E 'history:|PASS|FAIL' "$OUT/shallow-history.log")"
  if [ "$rc" = 0 ] && grep -q "PASS: no secrets detected" "$OUT/shallow-history.log" && ! grep -qi "shallow" "$OUT/shallow-history.log"; then
    verdict BROKEN "history scan on a shallow clone warns or fails" "rc=0 PASS on $n-commit shallow clone, no shallow warning (vacuous full-history claim)"
  else
    verdict HELD "history scan on a shallow clone warns or fails" "rc=$rc"
  fi
  rm -rf "$SHALLOW"
fi

# 5. read-only cache dir, no binary, PATH without gitleaks → setup failure must be exit 2.
mkdir -p "$OUT/ro-cache" && chmod 555 "$OUT/ro-cache"
rc=0
SECURITY_SCAN_CACHE="$OUT/ro-cache" PATH="$(dirname "$(command -v bash)"):$(dirname "$(command -v curl)"):$(dirname "$(command -v git)"):/usr/bin:/bin" \
  scripts/security-scan.sh --tree >"$OUT/ro-cache.log" 2>&1 || rc=$?
chmod 755 "$OUT/ro-cache"
log "read-only cache → rc=$rc; $(tail -n 1 "$OUT/ro-cache.log")"
assert_eq "read-only cache dir → exit 2 (setup failure)" 2 "$rc"

finish
