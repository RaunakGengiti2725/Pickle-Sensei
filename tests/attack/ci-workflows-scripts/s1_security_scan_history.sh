#!/usr/bin/env bash
# Adversarial scenario S1 — scripts/security-scan.sh history mode.
#
# Builds a throwaway git worktree from the commit under test, plants synthetic
# (randomly generated, never real) credentials in several shapes, and checks
# whether `scripts/security-scan.sh --history --log-opts '<base>..HEAD'`
# catches each one. Prints one JSON object per case and a final verdict.
#
#   tests/attack/ci-workflows-scripts/s1_security_scan_history.sh [<commit>] [<out-dir>]
#
# Cases (expected → what the gate SHOULD do):
#   plain      secret added in a normal commit inside the range        → FINDINGS (exit 1)
#   removed    secret added then deleted inside the range              → FINDINGS (still in history)
#   allowpath  secret in a NOT-gitignored dir that .gitleaks.toml path-allowlists
#              (tools/build/…) — the allowlist justification claims such dirs
#              "can never reach the repository"                          → FINDINGS
#   evilmerge  secret introduced only in a merge commit's resolution    → FINDINGS
#   badrange   --log-opts naming a ref that does not exist              → non-zero (never "clean")
#   emptybase  --log-opts '..HEAD' (what "$BASE..HEAD" expands to when BASE is
#              unset/empty in a caller) — git reads it as HEAD..HEAD = nothing → non-zero
#              (the secret IS in HEAD; an empty range must not read as clean)
#   outside    --log-opts range that excludes the secret commit         → clean (documents the
#              behaviour: the range is trusted, the caller must pass the right base)
# Never touches origin. Never uses a real credential; values are generated with
# a seeded PRNG (SEED env, default 20260904).
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
COMMIT="${1:-HEAD}"
OUT="${2:-/tmp/attack-s1}"
SEED="${SEED:-20260904}"
mkdir -p "$OUT"
COMMIT="$(git -C "$REPO_ROOT" rev-parse "$COMMIT")"

WT="$OUT/worktree"
rm -rf "$WT"
git -C "$REPO_ROOT" worktree prune
# Branches are shared with the main repo: drop this harness's own attack-s1/*
# leftovers so a re-run starts from $BASE and not on top of a previous case.
drop_branches() {
  git -C "$REPO_ROOT" for-each-ref --format='%(refname:short)' 'refs/heads/attack-s1/' |
    xargs -r git -C "$REPO_ROOT" branch -q -D
}
drop_branches
git -C "$REPO_ROOT" worktree add -q --detach "$WT" "$COMMIT"
trap 'git -C "$REPO_ROOT" worktree remove --force "$WT" >/dev/null 2>&1 || true; drop_branches' EXIT

# Seeded fake credentials (AWS access key id shape: AKIA + 16 [A-Z2-7]).
fake_aws() { python3 - "$1" <<'PY'
import random, sys
r = random.Random(int(sys.argv[1]))
print("AKIA" + "".join(r.choice("ABCDEFGHIJKLMNOPQRSTUVWXYZ234567") for _ in range(16)))
PY
}
fake_ghp() { python3 - "$1" <<'PY'
import random, sys
r = random.Random(int(sys.argv[1]) + 1)
print("ghp_" + "".join(r.choice("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789") for _ in range(36)))
PY
}

cd "$WT" || exit 2
git config user.email attack@example.invalid
git config user.name "attack harness"
git config commit.gpgsign false
BASE="$(git rev-parse HEAD)"

# The scan runs from THIS worktree: security-scan.sh resolves REPO_ROOT from
# its own path, so copy the script + policy into the worktree (they are
# tracked files at the same commit — identical bytes).
scan() { # label, expected(findings|clean|nonzero), log-opts
  local label="$1" expected="$2" logopts="$3" rc log verdict
  log="$OUT/$label.log"
  scripts/security-scan.sh --history --log-opts "$logopts" >"$log" 2>&1
  rc=$?
  case "$expected" in
    findings) [ "$rc" -eq 1 ] && grep -q 'FINDINGS' "$log" && verdict=HELD || verdict=BROKEN ;;
    clean) [ "$rc" -eq 0 ] && verdict=HELD || verdict=BROKEN ;;
    nonzero) [ "$rc" -ne 0 ] && verdict=HELD || verdict=BROKEN ;;
  esac
  printf '{"case":"%s","log_opts":"%s","exit":%d,"expected":"%s","verdict":"%s","log":"%s"}\n' \
    "$label" "$logopts" "$rc" "$expected" "$verdict" "$log" | tee -a "$OUT/results.jsonl"
}
: >"$OUT/results.jsonl"

AWS1="$(fake_aws "$SEED")"
GHP1="$(fake_ghp "$SEED")"

# ---- plain: secret in a normal commit ------------------------------------
git checkout -q -b attack-s1/plain "$BASE"
mkdir -p tools/scratch
printf 'AWS_ACCESS_KEY_ID=%s\n' "$AWS1" >tools/scratch/plain.env.example
git add tools/scratch/plain.env.example
git commit -q -m "attack: plain synthetic secret"
scan plain findings "$BASE..HEAD"
UNSET_BASE=""
scan emptybase nonzero "${UNSET_BASE}..HEAD"

# ---- removed: added then deleted inside the range --------------------------
git rm -q tools/scratch/plain.env.example
git commit -q -m "attack: remove synthetic secret (still in history)"
scan removed findings "$BASE..HEAD"

# ---- outside: range excludes the secret commit (HEAD~1..HEAD is the removal) -
scan outside clean "HEAD~1..HEAD"

# ---- allowpath: not-gitignored dir that the policy path-allowlists ---------
git checkout -q -b attack-s1/allowpath "$BASE"
mkdir -p tools/build
printf 'GITHUB_TOKEN=%s\n' "$GHP1" >tools/build/release-token.txt
git check-ignore -q tools/build/release-token.txt && echo "unexpected: gitignored" >&2
git add tools/build/release-token.txt   # no -f needed: NOT gitignored
git commit -q -m "attack: synthetic token under a path-allowlisted, non-ignored dir"
scan allowpath findings "$BASE..HEAD"
# control: identical content outside the allowlisted dir must be caught
git checkout -q -b attack-s1/allowpath-control "$BASE"
mkdir -p tools/scratch
printf 'GITHUB_TOKEN=%s\n' "$GHP1" >tools/scratch/release-token.txt
git add tools/scratch/release-token.txt
git commit -q -m "attack: control"
scan allowpath_control findings "$BASE..HEAD"

# ---- evilmerge: secret introduced only in the merge commit -----------------
git checkout -q -b attack-s1/merge-a "$BASE"
printf 'a\n' >tools/scratch-merge.txt; git add tools/scratch-merge.txt; git commit -q -m "a"
git checkout -q -b attack-s1/merge-b "$BASE"
printf 'b\n' >tools/scratch-merge.txt; git add tools/scratch-merge.txt; git commit -q -m "b"
git merge -q attack-s1/merge-a >/dev/null 2>&1 || true   # conflict expected
printf 'resolved\nAWS_SECRET=%s\n' "$AWS1" >tools/scratch-merge.txt
git add tools/scratch-merge.txt
git -c core.editor=true commit -q -m "attack: evil merge introduces synthetic secret"
scan evilmerge findings "$BASE..HEAD"
scan evilmerge_diffm findings "-m $BASE..HEAD"   # diagnostic: does `git log -m` expose it?

# ---- badrange: nonexistent ref must never come back clean ------------------
scan badrange nonzero "refs/heads/does-not-exist-$SEED..HEAD"

echo
echo "seed=$SEED base=$BASE"
if grep -q '"verdict":"BROKEN"' "$OUT/results.jsonl"; then echo "S1: BROKEN cases present"; exit 1; fi
echo "S1: all cases HELD"
