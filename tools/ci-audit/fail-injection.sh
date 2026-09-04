#!/usr/bin/env bash
# Fail-injection harness for the canonical Linux gate (scripts/verify-cloud.sh).
#
#   tools/ci-audit/fail-injection.sh --scratch DIR --out DIR [--only s1,s2] [--list]
#
# For every scenario: reset the scratch clone to the audited SHA, apply ONE
# deliberate breakage (the "seed" — saved verbatim as <out>/<scenario>/seed.patch
# plus seed.txt), run the exact CI-equivalent command
# (`scripts/verify-cloud.sh --only <stage>` with VERIFY_ARTIFACTS pointing into
# <out>), and compare what happened against what the gate MUST do:
#
#   expect=red     process exit != 0 AND summary.json records the stage as
#                  failed/unavailable AND summary.ok == false
#   expect=green   process exit == 0 AND the stage is recorded as passed
#                  (used to document places where a breakage is NOT caught —
#                  those rows are findings, not passes)
#
# Never run this against a real checkout: it rewrites the tree. The scratch
# clone must come from tools/ci-audit/make-scratch.sh (marker check in lib.sh).
#
# Output: <out>/matrix.json (one row per scenario), <out>/matrix.tsv, and the
# full verify-cloud stdout + per-stage logs + summary.json per scenario.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$HERE/lib.sh"
export CI_AUDIT_SOURCE_REPO
CI_AUDIT_SOURCE_REPO="$(cd "$HERE/../.." && pwd)"

SCRATCH="" OUT="" ONLY="" LIST=0
while [ $# -gt 0 ]; do
  case "$1" in
    --scratch) SCRATCH="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --only) ONLY="$2"; shift 2 ;;
    --list) LIST=1; shift ;;
    *) ca_die "unknown argument: $1" ;;
  esac
done

# A deterministic, fake credential pair for the secret-scan scenarios. Derived from
# fixed seed strings (replayable) but shaped like real material: gitleaks' AWS and
# generic rules require Shannon entropy above ~3.0/3.5, so a low-entropy sentinel
# such as AKIACIAUDITQQQQQQQUS is silently ignored and would fake a scanner gap.
FAKE_AWS_ID="AKIA$(printf 'ci-audit-aws-id-seed' | sha256sum | cut -c1-16 | tr 'abcdef0123456789' 'ABCDEFGHJKLMNPQR')"
FAKE_AWS_SECRET="$(printf 'ci-audit-aws-secret-seed' | sha256sum | cut -c1-64 | xxd -r -p | base64 | tr -d '=\n' | cut -c1-40)"

# ---------------------------------------------------------------- scenarios ----
# scenario <name> <stage(s)> <expect> <description>
SCN_NAMES=() SCN_STAGES=() SCN_EXPECT=() SCN_DESC=()
scenario() { SCN_NAMES+=("$1"); SCN_STAGES+=("$2"); SCN_EXPECT+=("$3"); SCN_DESC+=("$4"); }

scenario deps-lockfile-drift        deps      red   "add a dependency to a workspace package.json without updating pnpm-lock.yaml (frozen-lockfile must refuse)"
scenario format-violation           format    red   "new .ts source file with non-prettier formatting"
scenario lint-error                 lint      red   "new .ts source file violating error-level rules (@typescript-eslint/no-explicit-any, no-console)"
scenario typecheck-error            typecheck red   "type error appended to packages/scoring/src/index.ts"
scenario test-new-failing           test      red   "new vitest file in packages/scoring/test asserting 1 === 2"
scenario test-logic-regression      test      red   "flip a comparison in packages/scoring/src/priority.ts so existing tests fail"
scenario test-sqs-unreachable       test      green "SQS_ENDPOINT_TEST explicitly set to a closed port: the stage unsets it and passes with the 3 SQS tests skipped (silent downgrade)"
scenario test-passwithnotests       test      green "delete every test in apps/admin-web + packages/shared-types: vitest --passWithNoTests keeps the stage green"
scenario db-bad-migration           db        red   "new packages/database/migrations/0020_ci_audit_bad.sql containing invalid SQL"
scenario mobile-tsc-error           mobile    red   "type error appended to apps/mobile/src/config/runtimeConfig.ts"
scenario mobile-jest-failing        mobile    red   "new apps/mobile/__tests__/ciAuditInjected.test.ts asserting 1 === 2"
scenario ml-failing-unittest        ml        red   "new ml/scripts/test_ci_audit_injected.py with a failing unittest"
scenario edge-failing-deno-test     edge      red   "new __wf__/ci_audit_injected.test.ts asserting 1 === 2"
scenario edge-typeerror-checked-mod edge      red   "type error appended to supabase/functions/api/http.ts (covered by deno check)"
scenario edge-typeerror-index       edge      green "type error appended to supabase/functions/api/index.ts (NOT covered: tests run --no-check, deno check lists 4 modules)"
scenario rls-disable-rls-migration  rls       red   "new supabase migration disabling row level security on public.shots"
scenario rls-open-policy-migration  rls       red   "new supabase migration replacing shots_select_own with USING (true) (cross-user read)"
scenario rls-assertion-failure      rls       red   "append RAISE EXCEPTION to supabase/tests/security_regression.sql"
scenario security-worktree-secret   security  red   "uncommitted file containing a fake AWS access key pair"
scenario security-history-secret    security  red   "commit a fake AWS key, then delete it in a second commit (history-only leak)"
scenario security-low-entropy-sentinel security green "uncommitted AKIACIAUDITQQQQQQQUS-style sentinel: below gitleaks' entropy floor, so the scan stays green (documents the detector threshold, not a repo defect)"

# Each mutate_<scenario> runs with CWD = scratch root and may create/modify files.
# Return non-zero to abort the scenario as a harness error.
mutate_deps_lockfile_drift() {
  jq '.dependencies["left-pad"] = "1.3.0"' packages/scoring/package.json >/tmp/ca.pkg.json && mv /tmp/ca.pkg.json packages/scoring/package.json
}
mutate_format_violation() {
  printf 'export const   ciAuditBadlyFormatted = {a:1,\n    b:2}\n' >packages/scoring/src/ciAuditFormat.ts
}
mutate_lint_error() {
  printf 'export const ciAuditAny: any = 1;\nconsole.log(ciAuditAny);\n' >packages/scoring/src/ciAuditLint.ts
}
mutate_typecheck_error() {
  printf '\nexport const ciAuditTypeError: number = "not a number";\n' >>packages/scoring/src/index.ts
}
mutate_test_new_failing() {
  cat >packages/scoring/test/ciAuditInjected.test.ts <<'EOF'
import { describe, expect, it } from "vitest";
describe("ci-audit injected failure", () => {
  it("must turn the test stage red", () => {
    expect(1).toBe(2);
  });
});
EOF
}
mutate_test_logic_regression() {
  # Invert the severity floor in the priority engine (the seed is the diff).
  local f=packages/scoring/src/priority.ts
  grep -q 'if (r.severity < minSeverity) continue;' "$f" || return 1
  sed -i 's/if (r.severity < minSeverity) continue;/if (r.severity >= minSeverity) continue;/' "$f"
  ! git diff --quiet -- "$f"
}
mutate_test_sqs_unreachable() { :; } # env-only scenario, see env_for
mutate_test_passwithnotests() {
  find apps/admin-web/src packages/shared-types -name '*.test.ts' -not -path '*/node_modules/*' -print -delete | sed 's/^/deleted /'
}
mutate_db_bad_migration() {
  printf 'CREATE TABLE ci_audit_bad (id int PRIMARY KEY;\n' >packages/database/migrations/0020_ci_audit_bad.sql
}
mutate_mobile_tsc_error() {
  printf '\nexport const ciAuditTypeError: number = "not a number";\n' >>apps/mobile/src/config/runtimeConfig.ts
}
mutate_mobile_jest_failing() {
  cat >apps/mobile/__tests__/ciAuditInjected.test.ts <<'EOF'
describe("ci-audit injected failure", () => {
  it("must turn the mobile stage red", () => {
    expect(1).toBe(2);
  });
});
EOF
}
mutate_ml_failing_unittest() {
  cat >ml/scripts/test_ci_audit_injected.py <<'EOF'
import unittest


class CiAuditInjected(unittest.TestCase):
    def test_must_turn_ml_stage_red(self):
        self.assertEqual(1, 2)


if __name__ == "__main__":
    unittest.main()
EOF
}
mutate_edge_failing_deno_test() {
  cat >supabase/functions/api/__wf__/ci_audit_injected.test.ts <<'EOF'
import { assertEquals } from "jsr:@std/assert@1";
Deno.test("ci-audit injected failure must turn the edge stage red", () => {
  assertEquals(1, 2);
});
EOF
}
mutate_edge_typeerror_checked_mod() {
  printf '\nexport const ciAuditTypeError: number = "not a number";\n' >>supabase/functions/api/http.ts
}
mutate_edge_typeerror_index() {
  printf '\nexport const ciAuditTypeError: number = "not a number";\n' >>supabase/functions/api/index.ts
}
mutate_rls_disable_rls_migration() {
  printf 'alter table public.shots disable row level security;\n' >supabase/migrations/29990101000000_ci_audit_disable_rls.sql
}
mutate_rls_open_policy_migration() {
  # "shots_select_own" is created by 20260829120000_progress_data.sql (format loop).
  printf 'drop policy if exists "shots_select_own" on public.shots;\ncreate policy "shots_select_own" on public.shots for select to authenticated using (true);\n' \
    >supabase/migrations/29990101000001_ci_audit_open_policy.sql
}
mutate_rls_assertion_failure() {
  printf '\nDO $$ BEGIN RAISE EXCEPTION %s; END $$;\n' "'ci-audit injected assertion failure'" >>supabase/tests/security_regression.sql
}
mutate_security_worktree_secret() {
  printf 'aws_access_key_id = %s\naws_secret_access_key = %s\n' "$FAKE_AWS_ID" "$FAKE_AWS_SECRET" >services/api/ci-audit-credentials.ini
}
mutate_security_low_entropy_sentinel() {
  printf 'aws_access_key_id = AKIACIAUDITQQQQQQQUS\naws_secret_access_key = ciAuditFakeSecretb51f084cc9b9c964ab667381\n' >services/api/ci-audit-credentials.ini
}
mutate_security_history_secret() {
  mutate_security_worktree_secret
  git -c user.name=ci-audit -c user.email=ci-audit@example.invalid add services/api/ci-audit-credentials.ini
  git -c user.name=ci-audit -c user.email=ci-audit@example.invalid commit -qm "ci-audit: plant fake credential (history scenario)"
  git rm -q services/api/ci-audit-credentials.ini
  git -c user.name=ci-audit -c user.email=ci-audit@example.invalid commit -qm "ci-audit: remove fake credential (still in history)"
  git status --porcelain | grep -q . && return 1
  return 0
}

# Extra environment for a scenario (printed into seed.txt).
env_for() {
  case "$1" in
    test-sqs-unreachable) echo "SQS_ENDPOINT_TEST=http://127.0.0.1:9" ;;
    *) ;;
  esac
}

# ---------------------------------------------------------------- runner ----
if [ "$LIST" = 1 ]; then
  for i in "${!SCN_NAMES[@]}"; do printf '%-28s %-9s %-5s %s\n' "${SCN_NAMES[$i]}" "${SCN_STAGES[$i]}" "${SCN_EXPECT[$i]}" "${SCN_DESC[$i]}"; done
  exit 0
fi
[ -n "$SCRATCH" ] && [ -n "$OUT" ] || ca_die "--scratch and --out are required"
ca_assert_scratch "$SCRATCH"
SCRATCH="$(cd "$SCRATCH" && pwd -P)"
mkdir -p "$OUT"; OUT="$(cd "$OUT" && pwd -P)"
BASE_SHA="$(git -C "$SCRATCH" rev-parse HEAD)"
[ -d "$HOME/.deno/bin" ] && export PATH="$HOME/.deno/bin:$PATH"

selected() { [ -z "$ONLY" ] || [[ ",$ONLY," == *",$1,"* ]]; }

ROWS=()
HARNESS_FAIL=0
for i in "${!SCN_NAMES[@]}"; do
  name="${SCN_NAMES[$i]}" stage="${SCN_STAGES[$i]}" expect="${SCN_EXPECT[$i]}" desc="${SCN_DESC[$i]}"
  selected "$name" || continue
  sdir="$OUT/$name"; rm -rf "$sdir"; mkdir -p "$sdir"
  echo "=== [$name] stage=$stage expect=$expect"
  ca_reset_scratch "$SCRATCH" "$BASE_SHA"

  fn="mutate_${name//-/_}"
  if ! (cd "$SCRATCH" && "$fn") >"$sdir/mutate.log" 2>&1; then
    echo "    harness error: $fn failed (see $sdir/mutate.log)"; HARNESS_FAIL=1
    ROWS+=("$(printf '{"scenario":"%s","stage":"%s","expect":"%s","result":"harness-error","description":"%s"}' "$name" "$stage" "$expect" "$(ca_json_escape "$desc")")")
    continue
  fi
  # Seed: everything that distinguishes the scratch from BASE_SHA.
  {
    echo "base_sha=$BASE_SHA"
    echo "scratch_head=$(git -C "$SCRATCH" rev-parse HEAD)"
    echo "stage=$stage"
    echo "env=$(env_for "$name")"
    echo "command=VERIFY_ARTIFACTS=<out>/$name/artifacts scripts/verify-cloud.sh --only $stage"
    echo "description=$desc"
  } >"$sdir/seed.txt"
  git -C "$SCRATCH" add -A -N . 2>/dev/null
  git -C "$SCRATCH" diff "$BASE_SHA" >"$sdir/seed.patch"
  git -C "$SCRATCH" reset -q 2>/dev/null

  extra_env="$(env_for "$name")"
  start=$(date +%s)
  # shellcheck disable=SC2086
  (cd "$SCRATCH" && env $extra_env VERIFY_ARTIFACTS="$sdir/artifacts" scripts/verify-cloud.sh --only "$stage") >"$sdir/verify-cloud.stdout" 2>&1
  rc=$?
  end=$(date +%s)
  summary="$sdir/artifacts/summary.json"
  status="$(ca_stage_status "$summary" "$stage")"
  ok="$(ca_summary_ok "$summary")"
  json_valid=false; ca_json_valid "$summary" && json_valid=true

  case "$expect" in
    red)   if [ $rc -ne 0 ] && { [ "$status" = failed ] || [ "$status" = unavailable ]; } && [ "$ok" = false ]; then result=as-expected; else result=UNEXPECTED; fi ;;
    green) if [ $rc -eq 0 ] && [ "$status" = passed ] && [ "$ok" = true ]; then result=as-expected; else result=UNEXPECTED; fi ;;
  esac
  # Extra assertions for the secret-scan scenarios: the planted value must never appear in any log.
  leak=false
  if [[ "$name" == security-* ]] && grep -rq -- "$FAKE_AWS_SECRET" "$sdir/artifacts" "$sdir/verify-cloud.stdout" 2>/dev/null; then leak=true; result=UNEXPECTED; fi
  skipped_tests="$(grep -hoE '[0-9]+ skipped' "$sdir/artifacts/$stage.log" 2>/dev/null | awk '{s+=$1} END {print s+0}')"
  echo "    exit=$rc status=$status ok=$ok json_valid=$json_valid secret_in_logs=$leak skipped_tests=$skipped_tests => $result ($((end - start))s)"
  [ "$result" = as-expected ] || HARNESS_FAIL=1
  ROWS+=("$(printf '{"scenario":"%s","stage":"%s","expect":"%s","exit":%d,"stage_status":"%s","summary_ok":"%s","summary_json_valid":%s,"secret_in_logs":%s,"skipped_tests_in_log":%s,"seconds":%d,"result":"%s","seed":"%s","description":"%s"}' \
    "$name" "$stage" "$expect" "$rc" "$status" "$ok" "$json_valid" "$leak" "$skipped_tests" "$((end - start))" "$result" "$name/seed.patch" "$(ca_json_escape "$desc")")")
done
ca_reset_scratch "$SCRATCH" "$BASE_SHA"

{
  echo "{"
  echo "  \"tool\": \"tools/ci-audit/fail-injection.sh\","
  echo "  \"base_sha\": \"$BASE_SHA\","
  echo "  \"finished_utc\": \"$(ca_now)\","
  echo "  \"host\": \"$(uname -srm)\","
  echo "  \"all_as_expected\": $([ $HARNESS_FAIL -eq 0 ] && echo true || echo false),"
  echo "  \"rows\": ["
  for i in "${!ROWS[@]}"; do
    sep=","; [ "$i" -eq $((${#ROWS[@]} - 1)) ] && sep=""
    echo "    ${ROWS[$i]}$sep"
  done
  echo "  ]"
  echo "}"
} >"$OUT/matrix.json"
jq -r '.rows[] | [.scenario, .stage, .expect, (.exit|tostring), .stage_status, (.summary_ok|tostring), .result] | @tsv' "$OUT/matrix.json" >"$OUT/matrix.tsv"
echo
column -t "$OUT/matrix.tsv" 2>/dev/null || cat "$OUT/matrix.tsv"
echo "matrix: $OUT/matrix.json"
[ $HARNESS_FAIL -eq 0 ] && { echo "fail-injection: all scenarios behaved as expected"; exit 0; }
echo "fail-injection: at least one scenario did NOT behave as expected"; exit 1
