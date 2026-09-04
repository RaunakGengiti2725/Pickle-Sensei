#!/usr/bin/env bash
# Scenario 4 — plant a synthetic `sb_secret_<40 chars>` in an UNTRACKED file and
# run `scripts/security-scan.sh --tree --report-dir <dir>`.
#
# Expected: exit 1, rule `supabase-secret-api-key`, `Secret: REDACTED`, a JSON
# report with the finding and no plaintext secret anywhere.
#
# Two properties are measured separately because they have different owners:
#   detection    exit 1 + redacted JSON report naming the rule and file
#   attribution  the CONSOLE output (what CI's security.log contains) names the
#                rule/file/`Secret: REDACTED` — gitleaks only prints that with
#                --verbose, which scripts/security-scan.sh does not pass by
#                default and verify-cloud.sh's stage_security never passes.
#
# Variants (same expectation each):
#   plain      untracked file at the repo root
#   unicode    untracked file whose name has spaces + non-ASCII + CRLF content
#   huge       secret on the last line of a ~30 MB untracked file
#   ignored    same secret inside the gitignored artifacts/ tree (informational:
#              shows whether `gitleaks dir` reads gitignored paths at all)
# shellcheck source=tests/attack/ci-workflows-scripts-2/lib.sh
source "$(dirname "$0")/lib.sh"
cd "$ATTACK_REPO_ROOT" || exit 2

SUFFIX="$(seeded_token s4 40)"          # never printed; only its sha256 is recorded
SECRET="sb_secret_${SUFFIX}"
echo "planted_secret_sha256=$(sha256_of_string "$SECRET")" >"$ATTACK_OUT/s4-planted.sha256"

plant() {
  # $1 path, $2 mode (plain|crlf|huge)
  mkdir -p "$(dirname "$1")"
  case "$2" in
    plain) printf 'SUPABASE_SECRET_KEY=%s\n' "$SECRET" >"$1" ;;
    crlf)  printf 'clave = "%s"\r\n\xe2\x9c\x93 done\r\n' "$SECRET" >"$1" ;;
    huge)
      head -c $((30 * 1024 * 1024)) /dev/zero | tr '\0' 'x' | fold -w 4000 >"$1"
      printf '\nSUPABASE_SECRET_KEY=%s\n' "$SECRET" >>"$1"
      ;;
  esac
}

run_variant() {
  # $1 = variant, $2 = path to plant, $3 = mode, $4 = extra scan flags (may be empty)
  local variant="$1" path="$2" mode="$3" extra="${4:-}" rc=0
  local report="$ATTACK_OUT/s4-$variant-report" log="$ATTACK_OUT/s4-$variant.log"
  mkdir -p "$report"
  register_cleanup "$path"
  plant "$path" "$mode"
  if [ "$variant" != ignored ] && ! git status --porcelain -- "$path" | grep -q '^??'; then
    alog "warning: $path is not reported untracked by git"
  fi
  # shellcheck disable=SC2086 # $extra is a deliberate word-split flag list
  scripts/security-scan.sh --tree --report-dir "$report" $extra >"$log" 2>&1 || rc=$?
  rm -f -- "$path"
  echo "exit=$rc" >>"$log"
  strip_ansi "$log" >"$log.clean"

  local det=1 attr=1 findings=0 esc
  esc="$(basename "$path" | sed 's/[][\\.*^$]/\\&/g')"
  assert_eq "$variant exit code" "$rc" 1 || det=0
  assert_secret_absent "$variant plaintext leak (console)" "$SUFFIX" "$log" || det=0
  if [ -f "$report/gitleaks-tree.json" ]; then
    findings="$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(sum(1 for f in d if f.get("RuleID")=="supabase-secret-api-key" and f.get("Secret")=="REDACTED"))' "$report/gitleaks-tree.json")"
    if [ "$findings" -ge 1 ]; then alog "  ok   $variant report: $findings redacted supabase-secret-api-key finding(s)"; else alog "  FAIL $variant report has no redacted finding"; det=0; fi
    assert_grep "$variant report names the file" "\"File\": *\"[^\"]*$esc\"" "$report/gitleaks-tree.json" || det=0
    assert_secret_absent "$variant plaintext leak (report)" "$SUFFIX" "$report/gitleaks-tree.json" || det=0
  else
    alog "  FAIL $variant report missing"; det=0
  fi
  assert_grep "$variant console RuleID" 'RuleID:\s+supabase-secret-api-key' "$log.clean" || attr=0
  assert_grep "$variant console Secret: REDACTED" 'Secret:\s+REDACTED' "$log.clean" || attr=0
  assert_grep "$variant console File:" "File:\s+.*$esc" "$log.clean" || attr=0

  if [ "$variant" = ignored ]; then
    record_verdict "s4-$variant" INFO \
      "exit=$rc; secret inside gitignored artifacts/ $( [ $det = 1 ] && echo 'IS' || echo 'is NOT') detected by --tree" \
      "informational: does 'gitleaks dir' consult .gitignore? (script header says 'tracked, untracked, unignored')" "$log"
    return 0
  fi
  record_verdict "s4-$variant-detection" "$([ $det = 1 ] && echo HELD || echo BROKEN)" \
    "exit=$rc; report findings=$findings (redacted, file attributed)" \
    "exit 1; JSON report with RuleID supabase-secret-api-key, Secret REDACTED, file path; no plaintext" "$log" "$report/gitleaks-tree.json"
  record_verdict "s4-$variant-console-attribution${extra:+ (flags:$extra)}" "$([ $attr = 1 ] && echo HELD || echo BROKEN)" \
    "console $( [ $attr = 1 ] && echo 'names RuleID/File and prints Secret: REDACTED' || echo 'shows only \"leaks found: N\" — no RuleID, File, or Secret: REDACTED line')" \
    "console output identifies rule + file with Secret: REDACTED (what a CI log must show to be actionable)" "$log"
  [ $det = 1 ]
}

overall=0
run_variant plain   "attack-s4-plain-$(seeded_token s4-name 6).txt" plain || overall=1
run_variant verbose "attack-s4-verbose-$(seeded_token s4-vname 6).txt" plain --verbose || overall=1
run_variant unicode "attack s4 ünïcode $(seeded_token s4-uname 4) 密钥.txt" crlf || overall=1
run_variant huge    "attack-s4-huge-$(seeded_token s4-hname 6).txt" huge || overall=1
run_variant ignored "artifacts/attack-s4-ignored-$(seeded_token s4-iname 6).txt" plain

# Interleaving: two scans at once against the same tree must both fail.
path="attack-s4-parallel-$(seeded_token s4-pname 6).txt"
register_cleanup "$path"
plant "$path" plain
scripts/security-scan.sh --tree --report-dir "$ATTACK_OUT/s4-par1" >"$ATTACK_OUT/s4-par1.log" 2>&1 & p1=$!
scripts/security-scan.sh --tree --report-dir "$ATTACK_OUT/s4-par2" >"$ATTACK_OUT/s4-par2.log" 2>&1 & p2=$!
rc1=0; rc2=0; wait $p1 || rc1=$?; wait $p2 || rc2=$?
rm -f -- "$path"
if [ "$rc1" = 1 ] && [ "$rc2" = 1 ]; then
  record_verdict s4-parallel HELD "two concurrent --tree scans both exit 1 ($rc1,$rc2)" "both exit 1" "$ATTACK_OUT/s4-par1.log" "$ATTACK_OUT/s4-par2.log"
else
  record_verdict s4-parallel BROKEN "concurrent scans exited $rc1,$rc2" "both exit 1" "$ATTACK_OUT/s4-par1.log" "$ATTACK_OUT/s4-par2.log"
  overall=1
fi

# Baseline: with the plant removed the tree must be clean again (exit 0) so the
# failures above are attributable to the plant alone.
rc=0; scripts/security-scan.sh --tree --report-dir "$ATTACK_OUT/s4-baseline-report" >"$ATTACK_OUT/s4-baseline.log" 2>&1 || rc=$?
echo "exit=$rc" >>"$ATTACK_OUT/s4-baseline.log"
if [ "$rc" = 0 ]; then
  record_verdict s4-baseline HELD "clean tree exit 0 after removing the plant" "exit 0" "$ATTACK_OUT/s4-baseline.log"
else
  record_verdict s4-baseline BROKEN "clean tree exit $rc" "exit 0" "$ATTACK_OUT/s4-baseline.log"; overall=1
fi
exit $overall
