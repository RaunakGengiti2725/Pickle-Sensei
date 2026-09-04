#!/usr/bin/env bash
# S1 — summary.json `dirty` must flip for an untracked non-artifacts file and
# for a modified tracked file, and must stay false when only artifacts/ differs.
# Extra probes: the run's own VERIFY_ARTIFACTS dir outside artifacts/, and a
# user-level `status.showUntrackedFiles=no` (does the evidence field depend on
# the operator's git config?).
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

WT="$(scratch_worktree s1)"
trap 'remove_worktree "$WT"' EXIT
cd "$WT" || exit 2

run_ml() {
  # $1 = artifacts dir; prints the dirty value from summary.json
  local out="$1"
  mkdir -p "$(dirname "$out")"
  # stdout goes OUTSIDE the worktree so the harness itself never dirties it.
  VERIFY_ARTIFACTS="$out" scripts/verify-cloud.sh --only ml >"$ATTACK_EVIDENCE/s1-$(basename "$out").stdout" 2>&1
  summary_field "$out/summary.json" dirty
}

assert_eq "clean worktree reports dirty=false" false "$(run_ml "$WT/artifacts/verify-cloud/clean")"

echo scratch >"$WT/scratch_untracked.txt"
assert_eq "untracked non-artifacts file flips dirty=true" true "$(run_ml "$WT/artifacts/verify-cloud/untracked")"
rm -f "$WT/scratch_untracked.txt"

printf '\n# scratch\n' >>"$WT/README.md"
assert_eq "modified tracked file flips dirty=true" true "$(run_ml "$WT/artifacts/verify-cloud/modified")"
git -C "$WT" checkout -q -- README.md

# artifacts/ now holds three previous runs (and is gitignored).
assert_eq "artifacts/-only differences keep dirty=false" false "$(run_ml "$WT/artifacts/verify-cloud/artifacts-only")"

# The exclusion is `^?? artifacts/` — a dir called artifacts-scratch/ is NOT excluded.
mkdir -p "$WT/artifacts-scratch" && echo x >"$WT/artifacts-scratch/f"
assert_eq "sibling dir artifacts-scratch/ is not mistaken for artifacts/" true "$(run_ml "$WT/artifacts/verify-cloud/sibling")"
rm -rf "$WT/artifacts-scratch"

# VERIFY_ARTIFACTS outside artifacts/: first run is clean (dir still empty at
# the check), the SECOND run sees the first run's logs and self-reports dirty.
first="$(run_ml "$WT/out-scratch/run1")"
second="$(run_ml "$WT/out-scratch/run2")"
assert_eq "VERIFY_ARTIFACTS outside artifacts/: first run dirty=false" false "$first"
assert_eq "VERIFY_ARTIFACTS outside artifacts/: second run is self-contaminated (documented quirk)" true "$second"
rm -rf "$WT/out-scratch"

# Operator git config must not change the evidence field.
echo scratch >"$WT/scratch_hidden.txt"
hidden="$(GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=status.showUntrackedFiles GIT_CONFIG_VALUE_0=no run_ml "$WT/artifacts/verify-cloud/config-hidden")"
assert_eq "dirty ignores status.showUntrackedFiles=no (untracked file still detected)" true "$hidden"
rm -f "$WT/scratch_hidden.txt"

finish
