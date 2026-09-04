#!/usr/bin/env bash
# Scenario 6 — `GITLEAKS_BIN=/bin/true scripts/security-scan.sh --tree --report-dir <dir>`.
#
# Documented behaviour (scripts/security-scan.sh:133-140): any executable is
# accepted; a version mismatch is only a `warning:` log line. We measure what
# that buys an attacker / a careless developer:
#
#   true            /bin/true as the scanner, clean tree        → exit 0 PASS?
#   true+secret     /bin/true as the scanner, planted sb_secret → exit 0 PASS?  (bypass)
#   spoof+secret    fake binary that answers `version` with 8.30.1 and exits 0
#                   otherwise → exit 0 PASS with NO warning at all?
#   cloud+secret    GITLEAKS_BIN=/bin/true scripts/verify-cloud.sh --only security
#                   with a planted secret → summary.json ok:true?
#   nonexec         GITLEAKS_BIN pointing at a non-executable → exit 2 (setup)
#
# Expected by the pinned-gate contract: a scanner that is not the pinned
# gitleaks must not be able to produce PASS. Anything else is BROKEN.
# shellcheck source=tests/attack/ci-workflows-scripts-2/lib.sh
source "$(dirname "$0")/lib.sh"
cd "$ATTACK_REPO_ROOT" || exit 2

SUFFIX="$(seeded_token s6 40)"
SECRET="sb_secret_${SUFFIX}"
PLANT="attack-s6-plant-$(seeded_token s6-name 6).txt"
register_cleanup "$PLANT" "$ATTACK_OUT/s6-fake-gitleaks"

plant() { printf 'SUPABASE_SECRET_KEY=%s\n' "$SECRET" >"$PLANT"; }
unplant() { rm -f -- "$PLANT"; }

overall=0

# --- true (clean tree) -----------------------------------------------------
report="$ATTACK_OUT/s6-true-report"; log="$ATTACK_OUT/s6-true.log"; rc=0
GITLEAKS_BIN=/bin/true scripts/security-scan.sh --tree --report-dir "$report" >"$log" 2>&1 || rc=$?
echo "exit=$rc" >>"$log"
ls -la "$report" >"$ATTACK_OUT/s6-true-report.ls" 2>&1 || true
nfiles="$(find "$report" -type f 2>/dev/null | wc -l | tr -d ' ')"
ok=1
assert_eq "true: exit" "$rc" 0 || ok=0                 # documenting, not endorsing
assert_grep "true: PASS printed" 'PASS: no secrets detected' "$log" || ok=0
assert_grep "true: version warning printed" 'warning: GITLEAKS_BIN is not v8\.30\.1' "$log" || ok=0
assert_eq "true: report dir file count" "$nfiles" 0 || ok=0
if [ $ok = 1 ]; then
  record_verdict s6-true BROKEN \
    "exit 0 + 'PASS: no secrets detected' with /bin/true as the scanner; report dir empty ($nfiles files); only a warning line" \
    "non-pinned scanner must be fatal (exit 2) or require an explicit override flag" "$log" "$ATTACK_OUT/s6-true-report.ls"
  overall=1
else
  record_verdict s6-true HELD "GITLEAKS_BIN=/bin/true did not yield a clean PASS (exit $rc)" "no PASS from a non-pinned scanner" "$log"
fi

# --- true + planted secret (the actual bypass) -----------------------------
plant
report="$ATTACK_OUT/s6-true-secret-report"; log="$ATTACK_OUT/s6-true-secret.log"; rc=0
GITLEAKS_BIN=/bin/true scripts/security-scan.sh --tree --report-dir "$report" >"$log" 2>&1 || rc=$?
unplant
echo "exit=$rc" >>"$log"
assert_secret_absent "true+secret: no plaintext in log" "$SUFFIX" "$log" || true
if [ "$rc" = 0 ] && grep -q 'PASS: no secrets detected' "$log"; then
  record_verdict s6-true-secret BROKEN \
    "planted sb_secret_ in the tree + GITLEAKS_BIN=/bin/true → exit 0 PASS (secret not detected, no report written)" \
    "exit 1 (finding) or exit 2 (refuse non-pinned scanner)" "$log"
  overall=1
else
  record_verdict s6-true-secret HELD "exit $rc" "exit 1 or 2" "$log"
fi

# --- spoofed version + planted secret --------------------------------------
fake="$ATTACK_OUT/s6-fake-gitleaks"
cat >"$fake" <<'SH'
#!/usr/bin/env bash
# Claims to be the pinned gitleaks; scans nothing.
[ "${1:-}" = version ] && { echo 8.30.1; exit 0; }
exit 0
SH
chmod +x "$fake"
plant
report="$ATTACK_OUT/s6-spoof-secret-report"; log="$ATTACK_OUT/s6-spoof-secret.log"; rc=0
GITLEAKS_BIN="$fake" scripts/security-scan.sh --tree --report-dir "$report" >"$log" 2>&1 || rc=$?
unplant
echo "exit=$rc" >>"$log"
if [ "$rc" = 0 ] && grep -q 'PASS: no secrets detected' "$log" && ! grep -q 'warning:' "$log"; then
  record_verdict s6-spoof-secret BROKEN \
    "a 3-line shell script answering 'version'→8.30.1 passes as the pinned scanner: exit 0 PASS, zero warnings, planted secret undetected" \
    "GITLEAKS_BIN should at minimum be checksum-verified against the pinned release, or be refused outside an explicit dev override" "$log" "$fake"
  overall=1
else
  record_verdict s6-spoof-secret HELD "exit $rc (warning present: $(grep -c 'warning:' "$log"))" "no silent PASS" "$log"
fi

# --- through the canonical cloud gate -------------------------------------
plant
log="$ATTACK_OUT/s6-cloud-secret.log"; run_dir="$ATTACK_OUT/s6-cloud-secret-verify"; rc=0
GITLEAKS_BIN=/bin/true VERIFY_ARTIFACTS="$run_dir" scripts/verify-cloud.sh --only security >"$log" 2>&1 || rc=$?
unplant
echo "exit=$rc" >>"$log"
if [ -f "$run_dir/summary.json" ]; then
  cp "$run_dir/summary.json" "$ATTACK_OUT/s6-cloud-secret-summary.json"
  cp "$run_dir/security.log" "$ATTACK_OUT/s6-cloud-secret-security.log" 2>/dev/null || true
  okflag="$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(d.get("ok")); print(next((s["status"] for s in d["stages"] if s["name"]=="security"), "?"))' "$ATTACK_OUT/s6-cloud-secret-summary.json" | tr '\n' ' ')"
else
  okflag="no-summary"
fi
if [ "$rc" = 0 ] && [[ "$okflag" == "True passed "* ]]; then
  record_verdict s6-cloud-secret BROKEN \
    "verify-cloud --only security exit 0, summary ok:true, stage security=passed with a planted secret and GITLEAKS_BIN=/bin/true (env passes straight through stage_security)" \
    "stage security failed / ok:false, or the scanner override refused" "$log" "$ATTACK_OUT/s6-cloud-secret-summary.json"
  overall=1
else
  record_verdict s6-cloud-secret HELD "exit $rc; summary: $okflag" "security stage not passed" "$log"
fi

# --- non-executable override → must be setup failure (exit 2) --------------
nonexec="$ATTACK_OUT/s6-nonexec"; : >"$nonexec"; chmod 0644 "$nonexec"
log="$ATTACK_OUT/s6-nonexec.log"; rc=0
GITLEAKS_BIN="$nonexec" scripts/security-scan.sh --tree >"$log" 2>&1 || rc=$?
echo "exit=$rc" >>"$log"
if assert_eq "nonexec: exit" "$rc" 2 && assert_grep "nonexec: message" 'is not executable' "$log"; then
  record_verdict s6-nonexec HELD "exit 2 'is not executable'" "exit 2" "$log"
else
  record_verdict s6-nonexec BROKEN "exit $rc" "exit 2" "$log"; overall=1
fi

# --- does CI set GITLEAKS_BIN anywhere? (static) ----------------------------
if grep -rn 'GITLEAKS_BIN' .github/workflows scripts/verify-cloud.sh scripts/verify-all.sh 2>/dev/null | grep -v '^scripts/security-scan.sh' >"$ATTACK_OUT/s6-ci-env-grep.txt"; then
  record_verdict s6-ci-sets-override INFO "GITLEAKS_BIN referenced by CI/orchestrators: $(wc -l <"$ATTACK_OUT/s6-ci-env-grep.txt") line(s)" "n/a" "$ATTACK_OUT/s6-ci-env-grep.txt"
else
  record_verdict s6-ci-sets-override INFO "GITLEAKS_BIN is NOT set by ci.yml/verify-cloud.sh/verify-all.sh — the bypass needs a workflow edit (reviewable) or a developer's local env" "n/a"
fi

exit $overall
