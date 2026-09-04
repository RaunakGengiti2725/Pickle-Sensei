#!/usr/bin/env bash
# scripts/security-scan.sh — scope determinism, finding visibility, pin bypass.
#
# Runs an unmodified copy of the script (plus .gitleaks.toml) inside throwaway
# git repositories. Uses the pinned gitleaks already cached by a previous run
# (~/.cache/pickle-sensei) — if it is absent the script downloads it exactly as
# it would in CI. Planted "secrets" are random strings generated at runtime
# (GitHub PAT shape) and never written into this repository.
#
# Asserts (desired behaviour):
#   G1  positive detection: a planted secret in the tree → exit 1 and the
#       planted value itself never appears in the output (redaction)
#   G2  when findings exist the output (or a report) names the offending file —
#       "FINDINGS — see output above" must point at something actionable
#   G3  the history scan is scoped to the commit under test: a secret that
#       lives only on an UNRELATED ref (another branch) must not fail the gate
#       for HEAD (otherwise the gate is non-deterministic across clones)
#   G4  GITLEAKS_BIN pointing at a binary that is not gitleaks v8.30.1 must be
#       refused, not merely warned about (GITLEAKS_BIN=/bin/true → PASS otherwise)
#   G5  with --report-dir, the JSON reports must exist after a "PASS"
#   G6  the resolved scanner is the pinned version (control)
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

SB=$(mktemp -d)
trap 'rm -rf "$SB"' EXIT

new_repo() { # new_repo <dir>
  mkdir -p "$1/scripts"
  cp "$REPO_ROOT/scripts/security-scan.sh" "$1/scripts/"
  cp "$REPO_ROOT/.gitleaks.toml" "$1/"
  echo "# clean" >"$1/README.md"
  git -C "$1" init -q -b main
  git -C "$1" -c user.email=a@b -c user.name=audit add -A
  git -C "$1" -c user.email=a@b -c user.name=audit commit -qm clean
}
planted() { printf 'ghp_%s' "$(tr -dc 'A-Za-z0-9' </dev/urandom | head -c 36)"; }
scan() { # scan <repo> <args...> → OUT, RC
  OUT="$(cd "$1" && shift && PATH="/usr/bin:/bin" scripts/security-scan.sh "$@" 2>&1)"
  RC=$?
}

# G6 pinned version resolved
R=$SB/r0; new_repo "$R"
scan "$R" --tree
printf '%s\n' "$OUT" >"$AUDIT_OUT/security_G6.log"
assert_eq "G6 clean repo passes" 0 "$RC"
assert_true "G6 scanner is the pinned 8.30.1" grep -q 'gitleaks 8.30.1 at' <<<"$OUT"

# G1 + G2 planted secret in the working tree
R=$SB/r1; new_repo "$R"
SECRET=$(planted)
printf 'token = "%s"\n' "$SECRET" >"$R/config.txt"
scan "$R" --tree
sed "s/$SECRET/<planted-value>/g" <<<"$OUT" >"$AUDIT_OUT/security_G1_G2.log"
assert_eq "G1 planted secret fails the gate" 1 "$RC"
assert_false "G1 planted value never printed" grep -qF "$SECRET" <<<"$OUT"
assert_true "G2 output names the offending file (config.txt)" grep -q 'config.txt' <<<"$OUT"

# G3 secret only on an unrelated ref
R=$SB/r3; new_repo "$R"
git -C "$R" checkout -q -b unrelated-feature
SECRET=$(planted)
printf 'token = "%s"\n' "$SECRET" >"$R/leak.txt"
git -C "$R" -c user.email=a@b -c user.name=audit add leak.txt
git -C "$R" -c user.email=a@b -c user.name=audit commit -qm "unrelated branch commit"
git -C "$R" checkout -q main
assert_false "G3 precondition: HEAD history does not contain the leak" \
  bash -c "git -C '$R' log -p main | grep -qF '$SECRET'"
scan "$R" --history
sed "s/$SECRET/<planted-value>/g" <<<"$OUT" >"$AUDIT_OUT/security_G3.log"
assert_eq "G3 history scan of a clean HEAD passes despite an unrelated ref" 0 "$RC"

# G4 GITLEAKS_BIN pin bypass
R=$SB/r4; new_repo "$R"
SECRET=$(planted)
printf 'token = "%s"\n' "$SECRET" >"$R/config.txt"
OUT="$(cd "$R" && GITLEAKS_BIN=/bin/true PATH="/usr/bin:/bin" scripts/security-scan.sh 2>&1)"; RC=$?
printf '%s\n' "$OUT" >"$AUDIT_OUT/security_G4.log"
assert_ne "G4 GITLEAKS_BIN=/bin/true is refused (must not PASS with a planted secret)" 0 "$RC"

# G5 --report-dir reports exist after a PASS
OUT="$(cd "$R" && GITLEAKS_BIN=/bin/true PATH="/usr/bin:/bin" scripts/security-scan.sh --report-dir "$R/out" 2>&1)"; RC=$?
printf '%s\n' "$OUT" >"$AUDIT_OUT/security_G5.log"
if [ "$RC" -eq 0 ]; then
  assert_true "G5 gitleaks-tree.json exists after PASS" test -s "$R/out/gitleaks-tree.json"
  assert_true "G5 gitleaks-history.json exists after PASS" test -s "$R/out/gitleaks-history.json"
else
  log "ok   G5 (run did not PASS, report check not applicable)"
fi

finish
