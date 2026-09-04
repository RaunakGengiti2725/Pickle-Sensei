#!/usr/bin/env bash
# Targeted adversarial checks for the CI gate logic that fail-injection.sh
# cannot reach by breaking a stage:
#
#   * ci.yml `ci-gate` jq aggregation (every non-success result must fail)
#   * verify-cloud.sh: --skip / unavailable (exit 75) / unknown-stage semantics
#   * verify-all.sh: exit-code aggregation of the cloud half and Mac guards
#   * mac-full-verify.sh: refuses to run locally on Linux; every --remote guard
#     fires BEFORE anything is pushed (exercised with the scratch's origin removed)
#   * mac-full-verify.sh `xcodebuild … | tee | { grep || true; } | tail` pipeline
#     shape under `set -uo pipefail`: the real run_stage() and the real pipeline
#     text are executed on Linux bash with a fake xcodebuild exiting 65
#   * tools/macos-ci/apple-paths-changed.sh path matrix
#   * log hygiene: credential-shaped strings in every artifact produced so far
#
#   tools/ci-audit/gate-logic-tests.sh --scratch DIR --out DIR [--artifacts DIR ...] [--e2e]
#
# --e2e additionally runs the full-tier `e2e` stage with DATABASE_URL unreachable
# (needs Playwright Chromium under ~/.cache/ms-playwright and free ports 3001/5173;
# several minutes) to check whether the authenticated-panel downgrade stays green.
#
# --scratch must be a make-scratch.sh clone NOT shared with a running
# fail-injection.sh (this script also resets it). Every check appends a row to
# <out>/results.json: {check, verdict: pass|FAIL|harness-error, exit, expected, observed, evidence}.
# "pass" means the gate behaved as the audit expects; "FAIL" is a finding.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$HERE/lib.sh"
export CI_AUDIT_SOURCE_REPO
CI_AUDIT_SOURCE_REPO="$(cd "$HERE/../.." && pwd)"
REPO="$CI_AUDIT_SOURCE_REPO"

SCRATCH="" OUT="" EXTRA_ARTIFACTS=() RUN_E2E=0
while [ $# -gt 0 ]; do
  case "$1" in
    --scratch) SCRATCH="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --artifacts) EXTRA_ARTIFACTS+=("$2"); shift 2 ;;
    --e2e) RUN_E2E=1; shift ;;
    *) ca_die "unknown argument: $1" ;;
  esac
done
[ -n "$SCRATCH" ] && [ -n "$OUT" ] || ca_die "--scratch and --out are required"
ca_assert_scratch "$SCRATCH"
SCRATCH="$(cd "$SCRATCH" && pwd -P)"
mkdir -p "$OUT"; OUT="$(cd "$OUT" && pwd -P)"
BASE_SHA="$(git -C "$SCRATCH" rev-parse HEAD)"
[ -d "$HOME/.deno/bin" ] && export PATH="$HOME/.deno/bin:$PATH"

ROWS=(); FAILS=0
# row <check> <verdict> <exit> <expected> <observed> <evidence>
row() {
  local verdict=$2
  [ "$verdict" = pass ] || FAILS=$((FAILS + 1))
  printf '    %-52s %s (exit=%s) %s\n' "$1" "$verdict" "$3" "$5"
  ROWS+=("$(printf '{"check":"%s","verdict":"%s","exit":"%s","expected":"%s","observed":"%s","evidence":"%s"}' \
    "$(ca_json_escape "$1")" "$verdict" "$3" "$(ca_json_escape "$4")" "$(ca_json_escape "$5")" "$(ca_json_escape "$6")")")
}
section() { echo; echo "## $*"; }

# ------------------------------------------------------------------ ci-gate ----
section "ci.yml ci-gate aggregation"
FILTER="$(grep -oE "jq -r '[^']*'" "$REPO/.github/workflows/ci.yml" | head -1 | sed -E "s/^jq -r '//; s/'$//")"
if [ -z "$FILTER" ]; then
  row "ci-gate: extract jq filter from ci.yml" harness-error 0 "filter found" "no jq -r '…' in ci.yml" "-"
else
  echo "    filter: $FILTER"
  gate() { # gate <needs-json> -> prints exit code of the gate logic (1 = red)
    local failed
    failed=$(echo "$1" | jq -r "$FILTER")
    if [ -n "$failed" ]; then echo 1; else echo 0; fi
  }
  base='{"verify":{"result":"success"},"mobile":{"result":"success"},"edge":{"result":"success"},"supabase-security":{"result":"success"}}'
  cases=(
    "all-success|$base|0"
    "verify-failure|$(echo "$base" | jq -c '.verify.result="failure"')|1"
    "mobile-cancelled|$(echo "$base" | jq -c '.mobile.result="cancelled"')|1"
    "edge-skipped|$(echo "$base" | jq -c '.edge.result="skipped"')|1"
    "security-empty-result|$(echo "$base" | jq -c '.["supabase-security"].result=""')|1"
    "security-null-result|$(echo "$base" | jq -c '.["supabase-security"].result=null')|1"
    "all-skipped|$(echo "$base" | jq -c 'map_values(.result="skipped")')|1"
    "mixed-3-success-1-failure|$(echo "$base" | jq -c '.edge.result="failure"')|1"
  )
  for c in "${cases[@]}"; do
    IFS='|' read -r name needs want <<<"$c"
    got="$(gate "$needs")"
    v=pass; [ "$got" = "$want" ] || v=FAIL
    row "ci-gate/$name" "$v" "$got" "gate exit $want" "gate exit $got" "needs=$needs"
  done
  # Structural: every job except ci-gate and the main-only containers job is a required need.
  jobs="$(awk '/^jobs:/{j=1;next} j && /^  [a-z-]+:$/{gsub(/[ :]/,""); print}' "$REPO/.github/workflows/ci.yml" | grep -vE '^(ci-gate|containers)$' | sort | tr '\n' ' ')"
  needs="$(awk '/^  ci-gate:$/{g=1} g && /^    needs: \[/{sub(/.*\[/,""); sub(/\].*/,""); print; exit}' "$REPO/.github/workflows/ci.yml" | tr -d ' ' | tr ',' '\n' | sort | tr '\n' ' ')"
  v=pass; [ "$jobs" = "$needs" ] || v=FAIL
  row "ci-gate/needs-covers-every-required-job" "$v" 0 "jobs={$jobs}" "needs={$needs}" ".github/workflows/ci.yml ci-gate.needs"
  # `containers` is main-only and NOT gated: confirm it is guarded by a ref check.
  if grep -qE "^\s+if: github\.ref == 'refs/heads/main'" "$REPO/.github/workflows/ci.yml"; then v=pass; else v=FAIL; fi
  row "ci-gate/containers-job-main-only" "$v" 0 "containers guarded by github.ref == refs/heads/main" "grep result" ".github/workflows/ci.yml containers.if"
fi

# ------------------------------------------------------- verify-cloud semantics ----
section "verify-cloud.sh --skip / unavailable / unknown-stage semantics (source checkout, read-only)"
vc() { # vc <artifact-subdir> [env...] -- args...  ; runs in $REPO, prints rc
  local sub=$1; shift
  local envs=()
  while [ "$1" != "--" ]; do envs+=("$1"); shift; done; shift
  (cd "$REPO" && env "${envs[@]}" VERIFY_ARTIFACTS="$OUT/vc/$sub" scripts/verify-cloud.sh "$@") >"$OUT/vc/$sub.stdout" 2>&1
  echo $?
}
mkdir -p "$OUT/vc"

rc=$(vc skip-all -- --only ml,typecheck --skip ml,typecheck)
s="$OUT/vc/skip-all/summary.json"
observed="exit=$rc ok=$(ca_summary_ok "$s") ml=$(ca_stage_status "$s" ml) typecheck=$(ca_stage_status "$s" typecheck)"
# Repository rule (.agents/skills/pre-pr-verification): skipped is NOT a pass → the run must not be green.
v=FAIL; { [ "$rc" -ne 0 ] || [ "$(ca_summary_ok "$s")" = false ]; } && v=pass
row "verify-cloud/--skip-every-selected-stage-is-not-green" "$v" "$rc" "exit!=0 or summary.ok=false when every stage is skipped" "$observed" "$OUT/vc/skip-all/summary.json"

rc=$(vc skip-one -- --only ml,typecheck --skip typecheck)
s="$OUT/vc/skip-one/summary.json"
observed="exit=$rc ok=$(ca_summary_ok "$s") typecheck=$(ca_stage_status "$s" typecheck)"
v=FAIL; { [ "$rc" -ne 0 ] || [ "$(ca_summary_ok "$s")" = false ]; } && v=pass
row "verify-cloud/--skip-one-stage-is-not-green" "$v" "$rc" "exit!=0 or summary.ok=false" "$observed" "$OUT/vc/skip-one/summary.json"

rc=$(vc unknown-stage -- --only bogus)
v=pass; [ "$rc" -eq 2 ] || v=FAIL
row "verify-cloud/unknown---only-stage-exits-2" "$v" "$rc" "exit 2" "exit=$rc summary=$([ -f "$OUT/vc/unknown-stage/summary.json" ] && echo written || echo absent)" "$OUT/vc/unknown-stage.stdout"

rc=$(vc unknown-tier -- --tier nightly)
v=pass; [ "$rc" -eq 2 ] || v=FAIL
row "verify-cloud/unknown---tier-exits-2" "$v" "$rc" "exit 2" "exit=$rc" "$OUT/vc/unknown-tier.stdout"

rc=$(vc test-db-unreachable DATABASE_URL_TEST=postgres://pickle:x@127.0.0.1:9/nope -- --only test)
s="$OUT/vc/test-db-unreachable/summary.json"
observed="exit=$rc ok=$(ca_summary_ok "$s") test=$(ca_stage_status "$s" test)"
v=FAIL; [ "$rc" -eq 1 ] && [ "$(ca_stage_status "$s" test)" = unavailable ] && [ "$(ca_summary_ok "$s")" = false ] && v=pass
row "verify-cloud/test-stage-db-unreachable-is-unavailable+red" "$v" "$rc" "exit 1, test=unavailable, ok=false" "$observed" "$s"

rc=$(vc db-unreachable DATABASE_URL=postgres://pickle:x@127.0.0.1:9/nope -- --only db)
s="$OUT/vc/db-unreachable/summary.json"
observed="exit=$rc ok=$(ca_summary_ok "$s") db=$(ca_stage_status "$s" db)"
v=FAIL; [ "$rc" -eq 1 ] && [ "$(ca_stage_status "$s" db)" = unavailable ] && [ "$(ca_summary_ok "$s")" = false ] && v=pass
row "verify-cloud/db-stage-db-unreachable-is-unavailable+red" "$v" "$rc" "exit 1, db=unavailable, ok=false" "$observed" "$s"

# verify-cloud.sh re-adds $HOME/.deno/bin itself, so HOME must also point somewhere without deno.
nodeno="$(printf '%s' "$PATH" | tr ':' '\n' | grep -v '/\.deno/bin$' | paste -sd: -)"
nohome="$(mktemp -d)"
rc=$(vc edge-no-deno PATH="$nodeno" HOME="$nohome" -- --only edge)
rm -rf "$nohome"
s="$OUT/vc/edge-no-deno/summary.json"
observed="exit=$rc ok=$(ca_summary_ok "$s") edge=$(ca_stage_status "$s" edge)"
v=FAIL; [ "$rc" -eq 1 ] && [ "$(ca_stage_status "$s" edge)" = unavailable ] && [ "$(ca_summary_ok "$s")" = false ] && v=pass
row "verify-cloud/edge-stage-deno-missing-is-unavailable+red" "$v" "$rc" "exit 1, edge=unavailable, ok=false" "$observed" "$s"

# SQS broker unavailable: stage_test unsets SQS_ENDPOINT_TEST and pnpm test runs with the SQS suite skipped.
rc=$(vc test-sqs-unreachable SQS_ENDPOINT_TEST=http://127.0.0.1:9 -- --only test)
s="$OUT/vc/test-sqs-unreachable/summary.json"
skipped="$(grep -hoE '[0-9]+ skipped' "$OUT/vc/test-sqs-unreachable/test.log" 2>/dev/null | awk '{s+=$1} END {print s+0}')"
observed="exit=$rc ok=$(ca_summary_ok "$s") test=$(ca_stage_status "$s" test) skipped_tests=$skipped note=$(grep -o 'unreachable — @pickle/queue skips' "$OUT/vc/test-sqs-unreachable/test.log" | head -1)"
v=FAIL; { [ "$rc" -ne 0 ] || [ "$(ca_summary_ok "$s")" = false ]; } && v=pass
row "verify-cloud/test-stage-sqs-unreachable-is-not-green" "$v" "$rc" "broker down ⇒ not green (skipped is not a pass)" "$observed" "$s"

# ffmpeg absent: capture-envelope probe suites are describe.skipIf(!hasFfmpeg) (self-skip); only
# packages/first-party-intake/test/intake.test.ts throws without ffmpeg. Record which one goes red.
noff="$(mktemp -d)"; for b in node pnpm npm bash sh env jq awk sed grep tail head curl psql pg_isready python3 docker git tee date seq sleep cat uname tr cut sort uniq wc mktemp dirname basename readlink realpath timeout xargs find cp mv rm mkdir ls printf echo true false test '[' expr; do p="$(command -v "$b" 2>/dev/null)"; [ -n "$p" ] && ln -sf "$p" "$noff/$b"; done
rc=$(vc test-no-ffmpeg PATH="$noff:$HOME/.deno/bin" -- --only test)
s="$OUT/vc/test-no-ffmpeg/summary.json"
skipped="$(grep -hoE '[0-9]+ skipped' "$OUT/vc/test-no-ffmpeg/test.log" 2>/dev/null | awk '{s+=$1} END {print s+0}')"
skipped_base="$(grep -hoE '[0-9]+ skipped' "$REPO/artifacts/verify-cloud/baseline-pr/test.log" 2>/dev/null | awk '{s+=$1} END {print s+0}')"
failed_by="$(sed 's/\x1b\[[0-9;]*m//g' "$OUT/vc/test-no-ffmpeg/test.log" 2>/dev/null | grep -oE 'FAIL +[^ ]+\.test\.ts' | sort -u | tr '\n' ' ')"
observed="exit=$rc ok=$(ca_summary_ok "$s") test=$(ca_stage_status "$s" test) skipped_tests=$skipped (baseline with ffmpeg: $skipped_base) red_because=${failed_by:-none}"
v=FAIL; { [ "$rc" -ne 0 ] || [ "$(ca_summary_ok "$s")" = false ]; } && v=pass
row "verify-cloud/test-stage-ffmpeg-missing-is-not-green" "$v" "$rc" "ffmpeg missing ⇒ not green, or at least identical skip count" "$observed" "$s"
rm -rf "$noff"

# Full-tier e2e: stage_e2e leaves PICKLE_E2E_DATABASE_URL unset when DATABASE_URL is
# unreachable and smoke.e2e.ts test.skip()s the authenticated-panel case (same shape
# as the SQS downgrade above). Opt-in: needs Chromium + free :3001/:5173.
if [ "$RUN_E2E" = 1 ]; then
  rc=$(vc e2e-db-unreachable DATABASE_URL=postgres://pickle:x@127.0.0.1:9/nope -- --only e2e)
  s="$OUT/vc/e2e-db-unreachable/summary.json"
  e2elog="$OUT/vc/e2e-db-unreachable/e2e.log"
  skipped="$(sed 's/\x1b\[[0-9;]*m//g' "$e2elog" 2>/dev/null | grep -oE '[0-9]+ skipped' | head -1)"
  observed="exit=$rc ok=$(ca_summary_ok "$s") e2e=$(ca_stage_status "$s" e2e) playwright=${skipped:-?} note=$(grep -o 'DATABASE_URL unreachable[^\n]*' "$e2elog" 2>/dev/null | head -1)"
  v=FAIL; { [ "$rc" -ne 0 ] || [ "$(ca_summary_ok "$s")" = false ]; } && v=pass
  row "verify-cloud/e2e-stage-db-unreachable-is-not-green" "$v" "$rc" "datastore down ⇒ not green (skipped is not a pass)" "$observed" "$s"
fi

# ------------------------------------------------------- scratch-based checks ----
section "verify-all.sh aggregation + mac-full-verify.sh guards (scratch clone, origin removed)"
ca_reset_scratch "$SCRATCH" "$BASE_SHA"
git -C "$SCRATCH" remote remove origin 2>/dev/null || true
[ -z "$(git -C "$SCRATCH" remote)" ] || ca_die "scratch still has a remote; refusing to exercise --remote guards"
before_refs="$(git -C "$SCRATCH" for-each-ref --format='%(refname)' | sort | sha256sum)"
mkdir -p "$OUT/mac"

(cd "$SCRATCH" && scripts/mac-full-verify.sh) >"$OUT/mac/local-on-linux.stdout" 2>&1; rc=$?
v=pass; { [ "$rc" -eq 2 ] && grep -qi 'darwin\|macos\|--remote' "$OUT/mac/local-on-linux.stdout"; } || v=FAIL
row "mac-full-verify/local-mode-refused-on-linux" "$v" "$rc" "exit 2 + guidance" "exit=$rc: $(tail -n1 "$OUT/mac/local-on-linux.stdout")" "$OUT/mac/local-on-linux.stdout"

(cd "$SCRATCH" && scripts/mac-full-verify.sh --remote --only environment) >"$OUT/mac/remote-with-only.stdout" 2>&1; rc=$?
v=pass; [ "$rc" -eq 2 ] || v=FAIL
row "mac-full-verify/--remote-rejects---only-before-push" "$v" "$rc" "exit 2" "exit=$rc: $(head -n1 "$OUT/mac/remote-with-only.stdout")" "$OUT/mac/remote-with-only.stdout"

printf '\nexport const ciAuditTypeError: number = "not a number";\n' >>"$SCRATCH/packages/scoring/src/index.ts"
(cd "$SCRATCH" && scripts/mac-full-verify.sh --remote) >"$OUT/mac/remote-dirty-tree.stdout" 2>&1; rc=$?
v=pass; { [ "$rc" -eq 2 ] && grep -q 'uncommitted' "$OUT/mac/remote-dirty-tree.stdout"; } || v=FAIL
row "mac-full-verify/--remote-refuses-dirty-tree-before-push" "$v" "$rc" "exit 2 'uncommitted changes'" "exit=$rc: $(head -n1 "$OUT/mac/remote-dirty-tree.stdout")" "$OUT/mac/remote-dirty-tree.stdout"

(cd "$SCRATCH" && scripts/verify-all.sh --no-mac --cloud-args "--only typecheck") >"$OUT/mac/verify-all-cloud-red.stdout" 2>&1; rc=$?
v=pass; { [ "$rc" -eq 1 ] && grep -q 'verify-all: FAILED' "$OUT/mac/verify-all-cloud-red.stdout"; } || v=FAIL
row "verify-all/--no-mac-propagates-cloud-failure" "$v" "$rc" "exit 1 'verify-all: FAILED'" "exit=$rc: $(tail -n1 "$OUT/mac/verify-all-cloud-red.stdout")" "$OUT/mac/verify-all-cloud-red.stdout"

(cd "$SCRATCH" && scripts/verify-all.sh --no-mac --cloud-args "--only ml") >"$OUT/mac/verify-all-no-mac-green.stdout" 2>&1; rc=$?
v=pass; { [ "$rc" -eq 0 ] && grep -q 'Apple-specific claims are unverified' "$OUT/mac/verify-all-no-mac-green.stdout"; } || v=FAIL
row "verify-all/--no-mac-green-is-labelled-apple-unverified" "$v" "$rc" "exit 0 + explicit 'Apple-specific claims are unverified'" "exit=$rc: $(grep -m1 'SKIPPED' "$OUT/mac/verify-all-no-mac-green.stdout")" "$OUT/mac/verify-all-no-mac-green.stdout"

# Cloud half green, Mac half fails its pre-push guard (dirty tree) ⇒ verify-all must be red.
(cd "$SCRATCH" && scripts/verify-all.sh --cloud-args "--only ml") >"$OUT/mac/verify-all-mac-guard-red.stdout" 2>&1; rc=$?
v=pass; { [ "$rc" -eq 1 ] && grep -q 'uncommitted' "$OUT/mac/verify-all-mac-guard-red.stdout" && grep -q 'verify-all: FAILED' "$OUT/mac/verify-all-mac-guard-red.stdout"; } || v=FAIL
row "verify-all/mac-half-failure-propagates" "$v" "$rc" "exit 1 after mac guard fired" "exit=$rc: $(tail -n1 "$OUT/mac/verify-all-mac-guard-red.stdout")" "$OUT/mac/verify-all-mac-guard-red.stdout"

(cd "$SCRATCH" && scripts/verify-all.sh --bogus) >"$OUT/mac/verify-all-bogus.stdout" 2>&1; rc=$?
v=pass; [ "$rc" -eq 2 ] || v=FAIL
row "verify-all/unknown-argument-exits-2" "$v" "$rc" "exit 2" "exit=$rc" "$OUT/mac/verify-all-bogus.stdout"

# The pre-push guard is `git diff --quiet HEAD` (tracked changes only): an UNTRACKED
# new file leaves the tree "clean" and the Mac would verify a commit that lacks it.
# With origin removed the push itself fails, which is the only thing stopping it here.
ca_reset_scratch "$SCRATCH" "$BASE_SHA"
printf 'import Foundation\nlet ciAuditUntracked = 1\n' >"$SCRATCH/native/ci-audit-untracked.swift"
(cd "$SCRATCH" && scripts/mac-full-verify.sh --remote) >"$OUT/mac/remote-untracked-file.stdout" 2>&1; rc=$?
v=pass; { [ "$rc" -eq 2 ] && grep -q 'uncommitted' "$OUT/mac/remote-untracked-file.stdout"; } || v=FAIL
row "mac-full-verify/--remote-refuses-untracked-new-file-before-push" "$v" "$rc" "exit 2 'uncommitted changes' before any push" "exit=$rc: $(grep -m1 -E 'pushing|uncommitted|fatal' "$OUT/mac/remote-untracked-file.stdout")" "$OUT/mac/remote-untracked-file.stdout"
rm -f "$SCRATCH/native/ci-audit-untracked.swift"

after_refs="$(git -C "$SCRATCH" for-each-ref --format='%(refname)' | sort | sha256sum)"
v=pass; [ "$before_refs" = "$after_refs" ] || v=FAIL
row "mac-full-verify/no-ref-was-created-or-pushed" "$v" 0 "ref set unchanged" "refs sha256 before=${before_refs:0:12} after=${after_refs:0:12}" "git for-each-ref"
ca_reset_scratch "$SCRATCH" "$BASE_SHA"

# ------------------------------------------------ security-scan on a shallow clone ----
section "scripts/security-scan.sh history scan on a depth-1 clone (history-only leak)"
# Same deterministic fake pair as fail-injection.sh (entropy above gitleaks' floor).
FAKE_AWS_ID="AKIA$(printf 'ci-audit-aws-id-seed' | sha256sum | cut -c1-16 | tr 'abcdef0123456789' 'ABCDEFGHJKLMNPQR')"
FAKE_AWS_SECRET="$(printf 'ci-audit-aws-secret-seed' | sha256sum | cut -c1-64 | xxd -r -p | base64 | tr -d '=\n' | cut -c1-40)"
mkdir -p "$OUT/shallow"
printf 'aws_access_key_id = %s\naws_secret_access_key = %s\n' "$FAKE_AWS_ID" "$FAKE_AWS_SECRET" >"$SCRATCH/services/api/ci-audit-credentials.ini"
git -C "$SCRATCH" add services/api/ci-audit-credentials.ini
git -C "$SCRATCH" -c user.name=ci-audit -c user.email=ci-audit@localhost commit -qm 'ci-audit: plant fake credential (harness, never real)'
git -C "$SCRATCH" rm -q services/api/ci-audit-credentials.ini
git -C "$SCRATCH" -c user.name=ci-audit -c user.email=ci-audit@localhost commit -qm 'ci-audit: remove fake credential'
(cd "$SCRATCH" && scripts/security-scan.sh) >"$OUT/shallow/full-clone.stdout" 2>&1; rc_full=$?
v=pass; [ "$rc_full" -eq 1 ] || v=FAIL
row "security-scan/full-clone-detects-history-only-leak" "$v" "$rc_full" "exit 1 (history FINDINGS)" "exit=$rc_full: $(grep -m1 'history:' "$OUT/shallow/full-clone.stdout")" "$OUT/shallow/full-clone.stdout"
rm -rf "$OUT/shallow/clone"
git clone -q --depth 1 "file://$SCRATCH" "$OUT/shallow/clone" 2>/dev/null
depth="$(git -C "$OUT/shallow/clone" rev-list --count HEAD)"
(cd "$OUT/shallow/clone" && scripts/security-scan.sh) >"$OUT/shallow/depth1-clone.stdout" 2>&1; rc_shallow=$?
v=pass; [ "$rc_shallow" -ne 0 ] || v=FAIL
row "security-scan/depth-1-clone-refuses-or-fails-vacuous-history-scan" "$v" "$rc_shallow" "non-zero (refuse shallow clone or still find the leak)" "exit=$rc_shallow with $depth commit(s) visible: $(grep -m1 -E 'history:|PASS|FAIL' "$OUT/shallow/depth1-clone.stdout")" "$OUT/shallow/depth1-clone.stdout"
leak=false; grep -rq -- "$FAKE_AWS_SECRET" "$OUT/shallow"/*.stdout && leak=true
v=pass; [ "$leak" = false ] || v=FAIL
row "security-scan/planted-secret-redacted-in-output" "$v" 0 "secret value absent from scan output" "present=$leak" "$OUT/shallow/*.stdout"
rm -rf "$OUT/shallow/clone"
ca_reset_scratch "$SCRATCH" "$BASE_SHA"

# ------------------------------------------- mac pipeline shape under pipefail ----
section "mac-full-verify.sh xcodebuild pipelines: real run_stage() + real pipeline text, fake xcodebuild exit 65"
MAC="$REPO/scripts/mac-full-verify.sh"
FAKEBIN="$(mktemp -d)"
cat >"$FAKEBIN/xcodebuild" <<'EOF'
#!/usr/bin/env bash
echo "Test Suite 'All tests' started"
echo "error: ci-audit fake xcodebuild failure"
echo "** TEST FAILED **"
exit 65
EOF
chmod +x "$FAKEBIN/xcodebuild"
grep -q '^set -uo pipefail' "$MAC" || row "mac-pipeline/header-has-pipefail" FAIL 0 "set -uo pipefail" "missing" "$MAC"
run_stage_src="$(sed -n '/^run_stage() {/,/^}/p' "$MAC")"
record_src="$(grep -E '^record\(\) ' "$MAC")"
pipelines="$(grep -nE '\| \{ grep -E .*\|\| true; \} \| tail' "$MAC" | cut -d: -f1)"
mkdir -p "$OUT/mac-pipeline"
for ln in $pipelines; do
  # Each pipeline is one logical command spanning continuation lines; take the block ending at $ln.
  start=$ln; while [ "$start" -gt 1 ] && sed -n "$((start - 1))p" "$MAC" | grep -qE '\\$'; do start=$((start - 1)); done
  cmd="$(sed -n "${start},${ln}p" "$MAC")"
  fixture="$OUT/mac-pipeline/line-$ln"; mkdir -p "$fixture/artifacts" "$fixture/cache"
  # Run the REAL run_stage/record with a stage function whose body is the REAL pipeline text.
  script="$(cat <<EOF
set -uo pipefail
RESULT_NAMES=(); RESULT_STATUS=(); RESULT_SECONDS=(); RESULT_NOTES=(); FAILED=0
ARTIFACTS="$fixture/artifacts"; PICKLE_CI_CACHE="$fixture/cache"; scheme=CiAudit; udid=0000; result="$fixture/r.xcresult"
WORKSPACE=x.xcworkspace; SCHEME=CiAudit; CONFIGURATION=Release
$record_src
$run_stage_src
stage_under_test() {
$cmd
}
cd "$REPO"
run_stage pipeline-line-$ln stage_under_test
echo "RESULT_STATUS=\${RESULT_STATUS[*]} RESULT_NOTES=\${RESULT_NOTES[*]} FAILED=\$FAILED"
EOF
)"
  PATH="$FAKEBIN:$PATH" bash -c "$script" >"$fixture/run.log" 2>&1; rc=$?
  status="$(grep -oE 'RESULT_STATUS=[a-z]+' "$fixture/run.log" | cut -d= -f2)"
  note="$(grep -oE 'RESULT_NOTES=exit [0-9]+' "$fixture/run.log" | cut -d= -f2)"
  v=pass; { [ "$status" = failed ] && [ "$note" = "exit 65" ]; } || v=FAIL
  row "mac-pipeline/line-$ln-fake-xcodebuild-65-recorded-failed" "$v" "$rc" "stage failed, note 'exit 65'" "status=$status note=$note (bash $BASH_VERSION, Linux — Apple tool behaviour UNKNOWN)" "$fixture/run.log"
done
rm -rf "$FAKEBIN"

# ---------------------------------------------------- apple-paths-changed ----
section "tools/macos-ci/apple-paths-changed.sh path matrix"
APC="$REPO/tools/macos-ci/apple-paths-changed.sh"
T="$(mktemp -d)"; git -C "$T" init -q; git -C "$T" -c user.name=a -c user.email=a@b.c commit -q --allow-empty -m base; base="$(git -C "$T" rev-parse HEAD)"
apc_case() { # apc_case <expected> <path>... ; one commit touching all paths
  local want=$1; shift
  git -C "$T" checkout -q "$base"
  for p in "$@"; do mkdir -p "$T/$(dirname "$p")"; echo "$RANDOM" >"$T/$p"; git -C "$T" add -f "$p"; done
  git -C "$T" -c user.name=a -c user.email=a@b.c commit -q -m "touch $*"
  local head got rc; head="$(git -C "$T" rev-parse HEAD)"
  got="$(cd "$T" && "$APC" "$base" "$head" 2>/dev/null)"; rc=$?
  local v=pass; [ "$got" = "$want" ] || v=FAIL
  row "apple-paths/$(printf '%s+' "$@" | sed 's/+$//')" "$v" "$rc" "$want" "$got" "APPLE_PATHS regex in $APC"
}
apc_case true  native/vision-core/Sources/VisionCore/Foo.swift
apc_case true  native/vision-core/Package.swift
apc_case true  apps/mobile/ios/Podfile
apc_case true  apps/mobile/ios/Podfile.lock
apc_case true  apps/mobile/ios/PickleSensei/Info.plist
apc_case true  apps/mobile/package.json
apc_case true  apps/mobile/package-lock.json
apc_case true  apps/mobile/Gemfile.lock
apc_case true  tools/macos-ci/pod-install.sh
apc_case true  scripts/mac-full-verify.sh
apc_case true  .github/workflows/mac-full-verify.yml
apc_case true  docs/README.md native/x.swift
apc_case false docs/README.md
apc_case false packages/scoring/src/index.ts
apc_case false supabase/functions/api/index.ts
apc_case false .github/workflows/ci.yml
# The Mac stage builds Release, which runs Metro and asserts main.jsbundle exists
# (scripts/mac-full-verify.sh ios-app stage). These inputs feed that bundle:
apc_case true  apps/mobile/metro.config.js
apc_case true  apps/mobile/babel.config.js
apc_case true  apps/mobile/app.json
apc_case true  apps/mobile/index.js
apc_case true  apps/mobile/react-native.config.js
apc_case true  apps/mobile/src/App.tsx
# Unknown base ⇒ run (safe default); wrong arity ⇒ exit 2.
got="$(cd "$T" && "$APC" 0000000000000000000000000000000000000000 "$base" 2>/dev/null)"; rc=$?
v=pass; [ "$got" = true ] && [ $rc -eq 0 ] || v=FAIL
row "apple-paths/unknown-base-sha-runs" "$v" "$rc" "true" "$got" "$APC"
(cd "$T" && "$APC" "$base") >/dev/null 2>&1; rc=$?
v=pass; [ $rc -eq 2 ] || v=FAIL
row "apple-paths/wrong-arity-exits-2" "$v" "$rc" "exit 2" "exit $rc" "$APC"
rm -rf "$T"

# ------------------------------------------------------------- log hygiene ----
section "log hygiene: credential-shaped strings in verification artifacts"
scan_dirs=("$REPO/artifacts/verify-cloud" "$OUT" "${EXTRA_ARTIFACTS[@]}")
patterns=(
  "pickle_ci_password|pickle_test_password|pickle_dev_password"
  "SUPABASE_SERVICE_ROLE_KEY=[A-Za-z0-9]"
  "eyJ[A-Za-z0-9_-]{30,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}"
  "AKIA[A-Z2-7]{16}"
  "-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----"
  "ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{20,}"
  "sk_live_[A-Za-z0-9]{10,}|appl_[A-Za-z0-9]{20,}"
)
mkdir -p "$OUT/log-hygiene"
for pat in "${patterns[@]}"; do
  hits="$(grep -rIlE --exclude='seed.patch' --exclude='mutate.log' --exclude='results.json' "$pat" "${scan_dirs[@]}" 2>/dev/null | grep -v '/log-hygiene/' | grep -v '/security-' | sort -u)"
  n=$(printf '%s' "$hits" | grep -c . || true)
  printf '%s\n' "$hits" | grep . >"$OUT/log-hygiene/$(printf '%s' "$pat" | tr -c 'A-Za-z0-9' '_' | cut -c1-40).files" || true
  v=pass; [ "$n" -eq 0 ] || v=FAIL
  row "log-hygiene/$(printf '%s' "$pat" | cut -c1-40)" "$v" 0 "0 files" "$n files: $(printf '%s' "$hits" | head -3 | tr '\n' ' ')" "$OUT/log-hygiene/"
done
# The planted fake key in the security-* scenarios must be redacted by gitleaks in the stage log.
for d in "${EXTRA_ARTIFACTS[@]}"; do
  for sc in "$d"/security-*; do
    [ -d "$sc" ] || continue
    if grep -rqE 'AKIA[A-Z2-7]{16}' "$sc/artifacts" "$sc/verify-cloud.stdout" 2>/dev/null; then v=FAIL; obs="planted key id visible in stage output"; else v=pass; obs="redacted (--redact=100)"; fi
    row "log-hygiene/$(basename "$sc")-planted-key-redacted" "$v" 0 "redacted" "$obs" "$sc/artifacts/security.log"
  done
done

# ------------------------------------------------------------------ report ----
{
  echo "{"
  echo "  \"tool\": \"tools/ci-audit/gate-logic-tests.sh\","
  echo "  \"base_sha\": \"$BASE_SHA\","
  echo "  \"finished_utc\": \"$(ca_now)\","
  echo "  \"host\": \"$(uname -srm) bash-$BASH_VERSION\","
  echo "  \"checks\": ${#ROWS[@]},"
  echo "  \"failing_checks\": $FAILS,"
  echo "  \"rows\": ["
  for i in "${!ROWS[@]}"; do sep=","; [ "$i" -eq $((${#ROWS[@]} - 1)) ] && sep=""; echo "    ${ROWS[$i]}$sep"; done
  echo "  ]"
  echo "}"
} >"$OUT/results.json"
jq -e . "$OUT/results.json" >/dev/null || ca_die "results.json is not valid JSON"
echo
echo "results: $OUT/results.json (${#ROWS[@]} checks, $FAILS FAIL rows = findings)"
[ "$FAILS" -eq 0 ] && exit 0
exit 1
