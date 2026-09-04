#!/usr/bin/env bash
# S8 (extra) — probe the .gitleaks.toml policy and the security stage wiring.
#
# Plants SYNTHETIC credentials (seeded, never real) at the exact spots where the
# allowlists in .gitleaks.toml are scoped, and checks that a real-shaped secret
# landing next to a fixture still fails the gate — the property the config header
# promises. Also checks that an unusable scanner cannot turn the stage green.
#
#   s8.a  control      — untracked file at repo root with an sb_secret_ key       → exit 1
#   s8.b  test-fixture — sb_secret_ inside services/api/test/*.test.ts (path allowlisted
#                        ONLY for generic-api-key + "*secret-0123456789")        → exit 1
#   s8.c  runtimeConfig — legacy Supabase service_role JWT appended to
#                        apps/mobile/src/config/runtimeConfig.ts (allowlist covers
#                        appl_/goog_/test_ only)                                 → exit 1
#   s8.d  podfile-lock — AWS key appended to apps/mobile/ios/Podfile.lock (whole
#                        file is path-allowlisted)                               → exit 1 expected
#   s8.e  committed .env — in a temp clone, `git add -f .env` holding an sb_secret_
#                        key, commit, `--history` scan of that commit           → exit 1 expected
#   s8.f  unicode      — zero-width space inside the key (rule regex is ASCII-only;
#                        documents scanner reach, universal to regex scanners)   → informational
#   s8.g  offline+empty cache — verify-cloud --only security with
#                        SECURITY_SCAN_OFFLINE=1 and an empty cache               → run must fail
#   s8.h  generic key   — high-entropy `api_key = "…"` in services/api/test/*.test.ts
#                        (allowlist targets generic-api-key with paths+regexes)   → exit 1 expected
#   s8.i  stripe live   — sk_live_… inside supabase/functions/api/__wf__/          → exit 1 expected
#   s8.j  docs          — AWS key inside docs/DISTRIBUTION.md                     → exit 1 expected
#
# Why s8.c/h/i/j matter: gitleaks allowlists combine `paths` and `regexes` with
# condition = "OR" unless `condition = "AND"` is set (gitleaks README, v8.30.1).
# Every scoped entry in .gitleaks.toml omits `condition`, so matching the PATH
# alone allowlists the finding — the regex never narrows anything.
# Worse, in `gitleaks dir` mode (what security-scan.sh --tree runs) a global
# allowlist (no `targetRules`) whose `paths` matches skips the WHOLE FILE before
# any rule runs (gitleaks v8.30.1 sources/common.go shouldSkipPath →
# "skipping file: global allowlist"), regardless of `condition`/`regexes`.
# Verified out-of-band on a throwaway dir: repo config → exit 0; same entry with
# condition="AND" → git mode exit 1 but dir mode still exit 0; adding
# targetRules + condition="AND" → dir mode exit 1 for the JWT while the
# appl_… key stays allowlisted.
#
# Files touched in the working tree are restored byte-for-byte from backups on
# exit (cp, never git checkout). Nothing is committed to this repository.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

SEED="${ATTACK_SEED:-20260904}"
echo "$SEED" >"$OUT/seed.txt"
B64URL="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-"
SB_KEY="sb_secret_$(seeded_token "$((SEED + 10))" "$B64URL" 40)"
AWS_KEY="AKIA$(seeded_token "$((SEED + 11))" ABCDEFGHIJKLMNOPQRSTUVWXYZ234567 16)"
# Structurally valid three-part JWT with a service_role claim (unsigned; the
# signature is seeded noise). Matches the default `jwt` rule.
jwt_b64() { printf '%s' "$1" | base64 -w0 | tr '+/' '-_' | tr -d '='; }
FAKE_JWT="$(jwt_b64 '{"alg":"HS256","typ":"JWT"}').$(jwt_b64 "{\"iss\":\"supabase\",\"ref\":\"attackprobe$(seeded_token "$((SEED + 12))" abcdefghijklmnopqrstuvwxyz 8)\",\"role\":\"service_role\",\"iat\":1700000000,\"exp\":2000000000}").$(seeded_token "$((SEED + 13))" "$B64URL" 43)"

RUNTIME_CONFIG="$REPO_ROOT/apps/mobile/src/config/runtimeConfig.ts"
PODFILE_LOCK="$REPO_ROOT/apps/mobile/ios/Podfile.lock"
PROBE_ROOT="$REPO_ROOT/.attack-s8-probe-$(seeded_token "$SEED" abcdefghijklmnopqrstuvwxyz 6).txt"
PROBE_TEST="$REPO_ROOT/services/api/test/zz-attack-s8-probe.test.ts"
PROBE_UNICODE="$REPO_ROOT/.attack-s8-unicode-$(seeded_token "$((SEED + 2))" abcdefghijklmnopqrstuvwxyz 6).txt"
PROBE_WF="$REPO_ROOT/supabase/functions/api/__wf__/zz_attack_s8_probe.test.ts"
GENERIC_KEY="$(seeded_token "$((SEED + 14))" ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 40)"
STRIPE_KEY="sk_live_$(seeded_token "$((SEED + 15))" ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 32)"
DISTRIBUTION_MD="$REPO_ROOT/docs/DISTRIBUTION.md"
BACKUP="$(mktemp -d)"
CLONE="$(mktemp -d)"
EMPTY_CACHE="$(mktemp -d)"
cp -p "$RUNTIME_CONFIG" "$BACKUP/runtimeConfig.ts"
[ -f "$PODFILE_LOCK" ] && cp -p "$PODFILE_LOCK" "$BACKUP/Podfile.lock"
[ -f "$DISTRIBUTION_MD" ] && cp -p "$DISTRIBUTION_MD" "$BACKUP/DISTRIBUTION.md"

cleanup() {
  rm -f "$PROBE_ROOT" "$PROBE_TEST" "$PROBE_UNICODE" "$PROBE_WF"
  cp -p "$BACKUP/runtimeConfig.ts" "$RUNTIME_CONFIG"
  [ -f "$BACKUP/Podfile.lock" ] && cp -p "$BACKUP/Podfile.lock" "$PODFILE_LOCK"
  [ -f "$BACKUP/DISTRIBUTION.md" ] && cp -p "$BACKUP/DISTRIBUTION.md" "$DISTRIBUTION_MD"
  rm -rf "$BACKUP" "$CLONE" "$EMPTY_CACHE"
}
trap cleanup EXIT

scan() { # <label> — tree scan from the repo root; log + redacted JSON report under $OUT
  local label="$1" logfile="$OUT/$1.log" rc=0
  (cd "$REPO_ROOT" && scripts/security-scan.sh --tree --report-dir "$OUT/$label-report" >"$logfile" 2>&1) || rc=$?
  printf 'exit=%s\n' "$rc" >>"$logfile"
  printf '%s' "$rc"
}

rule_hit() { # <label> <rule-id> — did the JSON report record a finding for rule-id?
  node -e '
const fs = require("fs");
const p = process.argv[1];
if (!fs.existsSync(p)) process.exit(1);
const findings = JSON.parse(fs.readFileSync(p, "utf8"));
process.exit(findings.some((f) => f.RuleID === process.argv[2]) ? 0 : 1);
' "$OUT/$1-report/gitleaks-tree.json" "$2"
}

# ── s8.a control ────────────────────────────────────────────────────────────────
printf 'SUPABASE_SECRET_KEY=%s\n' "$SB_KEY" >"$PROBE_ROOT"
rc="$(scan s8a-control)"
rm -f "$PROBE_ROOT"
if [ "$rc" = 1 ] && rule_hit s8a-control supabase-secret-api-key; then
  record HELD s8.a-control 1 "$OUT/s8a-control.log" "untracked sb_secret_ key at repo root is caught by the custom rule"
else
  record BROKEN s8.a-control "$rc" "$OUT/s8a-control.log" "control probe not detected — scanner not functional, later checks are moot"
fi

# ── s8.b real-shaped secret next to an allowlisted fixture path ────────────────
cat >"$PROBE_TEST" <<EOF
import { describe, it } from "vitest";
const devSecret = "test-secret-0123456789"; // allowlisted fixture shape
const leaked = "$SB_KEY";
describe("probe", () => { it("noop", () => { void devSecret; void leaked; }); });
EOF
rc="$(scan s8b-test-fixture-path)"
rm -f "$PROBE_TEST"
if [ "$rc" = 1 ] && rule_hit s8b-test-fixture-path supabase-secret-api-key; then
  record HELD s8.b-fixture-path-scoped 1 "$OUT/s8b-test-fixture-path.log" "sb_secret_ in services/api/test/*.test.ts still fails (allowlist is targetRules-scoped to generic-api-key)"
else
  record BROKEN s8.b-fixture-path-scoped "$rc" "$OUT/s8b-test-fixture-path.log" "services/api/test allowlist hid a real-shaped Supabase secret"
fi

# ── s8.c service_role JWT beside the RevenueCat public-key allowlist ───────────
printf '\nexport const ATTACK_PROBE_SERVICE_ROLE = "%s";\n' "$FAKE_JWT" >>"$RUNTIME_CONFIG"
rc="$(scan s8c-runtime-config-jwt)"
cp -p "$BACKUP/runtimeConfig.ts" "$RUNTIME_CONFIG"
# Same JWT in an unlisted path must be caught, or the JWT probe itself is invalid.
printf 'export const X = "%s";\n' "$FAKE_JWT" >"$PROBE_ROOT"
rc_ctl="$(scan s8c-runtime-config-jwt-control)"
rm -f "$PROBE_ROOT"
if [ "$rc_ctl" != 1 ] || ! rule_hit s8c-runtime-config-jwt-control jwt; then
  record BROKEN s8.c-runtime-config-jwt "ctl=$rc_ctl" "$OUT/s8c-runtime-config-jwt-control.log" "JWT probe not detected even at an unlisted path — probe invalid"
elif [ "$rc" = 1 ] && rule_hit s8c-runtime-config-jwt jwt; then
  record HELD s8.c-runtime-config-jwt 1 "$OUT/s8c-runtime-config-jwt.log" "service_role JWT in runtimeConfig.ts is caught (allowlist limited to appl_/goog_/test_ regex)"
else
  record BROKEN s8.c-runtime-config-jwt "$rc" "$OUT/s8c-runtime-config-jwt.log" "a Supabase service_role JWT appended to apps/mobile/src/config/runtimeConfig.ts passes the gate (same JWT at an unlisted path: exit $rc_ctl, RuleID jwt) — the RevenueCat allowlist has paths+regexes without condition=AND, so the path alone allowlists EVERY rule in that file"
fi

# ── s8.d whole-file Podfile.lock allowlist ─────────────────────────────────────
if [ -f "$PODFILE_LOCK" ]; then
  printf '\n# aws_access_key_id = %s\n' "$AWS_KEY" >>"$PODFILE_LOCK"
  rc="$(scan s8d-podfile-lock)"
  cp -p "$BACKUP/Podfile.lock" "$PODFILE_LOCK"
  if [ "$rc" = 1 ]; then
    record HELD s8.d-podfile-lock 1 "$OUT/s8d-podfile-lock.log" "AWS key appended to Podfile.lock is caught"
  else
    record BROKEN s8.d-podfile-lock "$rc" "$OUT/s8d-podfile-lock.log" "AWS access key appended to apps/mobile/ios/Podfile.lock passes: the file is path-allowlisted wholesale (SPEC CHECKSUMS justification), so ANY secret in it is invisible"
  fi
else
  record BROKEN s8.d-podfile-lock 2 "$OUT/seed.txt" "apps/mobile/ios/Podfile.lock absent in this checkout — probe not executable"
fi

# ── s8.e a force-added .env in git history ─────────────────────────────────────
{
  git clone --quiet --shared --no-checkout "$REPO_ROOT" "$CLONE/repo"
  cd "$CLONE/repo"
  git sparse-checkout init --cone
  git sparse-checkout set scripts
  git checkout --quiet "$(git -C "$REPO_ROOT" rev-parse HEAD)"
  ls -la .gitleaks.toml scripts/security-scan.sh
  printf 'SUPABASE_SECRET_KEY=%s\n' "$SB_KEY" >.env
  git add -f .env
  git -c user.name=attack -c user.email=attack@example.invalid commit --quiet -m "oops: commit local env"
  git log --oneline -2
  git ls-files .env
} >"$OUT/s8e-clone-setup.log" 2>&1
rc=0
(cd "$CLONE/repo" && scripts/security-scan.sh --history --log-opts "HEAD~1..HEAD" >"$OUT/s8e-committed-env-history.log" 2>&1) || rc=$?
printf 'exit=%s\n' "$rc" >>"$OUT/s8e-committed-env-history.log"
rc2=0
(cd "$CLONE/repo" && scripts/security-scan.sh --tree >"$OUT/s8e-committed-env-tree.log" 2>&1) || rc2=$?
printf 'exit=%s\n' "$rc2" >>"$OUT/s8e-committed-env-tree.log"
if [ "$rc" = 1 ] && [ "$rc2" = 1 ]; then
  record HELD s8.e-committed-env 1 "$OUT/s8e-committed-env-history.log" "a force-added .env with an sb_secret_ key fails both history and tree scans"
else
  record BROKEN s8.e-committed-env "history=$rc tree=$rc2" "$OUT/s8e-committed-env-history.log" "a tracked .env (git add -f) holding a Supabase secret key passes the gate: the '.env is gitignored' path allowlist is applied regardless of tracking"
fi

# ── s8.f unicode zero-width space inside the key (informational) ───────────────
ZWSP="$(printf '\xe2\x80\x8b')"
printf 'SUPABASE_SECRET_KEY=%s\n' "${SB_KEY:0:20}${ZWSP}${SB_KEY:20}" >"$PROBE_UNICODE"
rc="$(scan s8f-unicode-zwsp)"
rm -f "$PROBE_UNICODE"
printf 'zwsp-split key detected: exit=%s (1 = detected). Regex rules are ASCII-anchored; a ZWSP-split key is not a usable credential until re-joined, so this is recorded as informational, not a verdict.\n' "$rc" >"$OUT/s8f-note.txt"
log "s8.f informational: zwsp-split key scan exit=$rc (see $OUT/s8f-note.txt)"

# ── s8.g scanner unavailable must not be green ─────────────────────────────────
rc=0
(cd "$REPO_ROOT" && SECURITY_SCAN_OFFLINE=1 SECURITY_SCAN_CACHE="$EMPTY_CACHE" PATH="$(printf '%s' "$PATH" | tr ':' '\n' | grep -v '\.cache/pickle-sensei' | paste -sd:)" scripts/verify-cloud.sh --only security >"$OUT/s8g-verify-cloud-offline.log" 2>&1) || rc=$?
printf 'exit=%s\n' "$rc" >>"$OUT/s8g-verify-cloud-offline.log"
if [ "$rc" != 0 ] && grep -qE 'FAIL|UNAVAILABLE' "$OUT/s8g-verify-cloud-offline.log"; then
  record HELD s8.g-offline-not-green "$rc" "$OUT/s8g-verify-cloud-offline.log" "verify-cloud --only security fails (not green) when no scanner is available offline"
else
  record BROKEN s8.g-offline-not-green "$rc" "$OUT/s8g-verify-cloud-offline.log" "verify-cloud reported green with an unusable scanner"
fi

# ── s8.h generic-api-key shaped secret in services/api/test ────────────────────
cat >"$PROBE_TEST" <<EOF
import { describe, it } from "vitest";
const api_key = "$GENERIC_KEY";
describe("probe", () => { it("noop", () => { void api_key; }); });
EOF
rc="$(scan s8h-generic-key-in-api-tests)"
rm -f "$PROBE_TEST"
printf 'const api_key = "%s";\n' "$GENERIC_KEY" >"$PROBE_ROOT"
rc_ctl="$(scan s8h-generic-key-control)"
rm -f "$PROBE_ROOT"
if [ "$rc_ctl" != 1 ] || ! rule_hit s8h-generic-key-control generic-api-key; then
  record BROKEN s8.h-generic-key-in-api-tests "ctl=$rc_ctl" "$OUT/s8h-generic-key-control.log" "generic-api-key probe not detected at an unlisted path — probe invalid"
elif [ "$rc" = 1 ] && rule_hit s8h-generic-key-in-api-tests generic-api-key; then
  record HELD s8.h-generic-key-in-api-tests 1 "$OUT/s8h-generic-key-in-api-tests.log" "a high-entropy api_key in services/api/test/*.test.ts is still caught"
else
  record BROKEN s8.h-generic-key-in-api-tests "$rc" "$OUT/s8h-generic-key-in-api-tests.log" "any generic-api-key finding under services/api/test/*.test.ts is allowlisted by path alone (regex '*secret-0123456789' never applied; control at unlisted path exit $rc_ctl)"
fi

# ── s8.i Stripe live key inside the edge-function test dir ─────────────────────
printf 'export const STRIPE = "%s";\n' "$STRIPE_KEY" >"$PROBE_WF"
rc="$(scan s8i-stripe-in-wf)"
rm -f "$PROBE_WF"
printf 'export const STRIPE = "%s";\n' "$STRIPE_KEY" >"$PROBE_ROOT"
rc_ctl="$(scan s8i-stripe-control)"
rm -f "$PROBE_ROOT"
if [ "$rc_ctl" != 1 ] || ! rule_hit s8i-stripe-control stripe-access-token; then
  record BROKEN s8.i-stripe-in-wf "ctl=$rc_ctl" "$OUT/s8i-stripe-control.log" "stripe-access-token probe not detected at an unlisted path — probe invalid"
elif [ "$rc" = 1 ] && rule_hit s8i-stripe-in-wf stripe-access-token; then
  record HELD s8.i-stripe-in-wf 1 "$OUT/s8i-stripe-in-wf.log" "sk_live_ key in supabase/functions/api/__wf__/ is still caught"
else
  record BROKEN s8.i-stripe-in-wf "$rc" "$OUT/s8i-stripe-in-wf.log" "an sk_live_ Stripe key anywhere under supabase/functions/api/__wf__/ passes (allowlist meant for the literal sk_test_revenuecat applies by path alone; control exit $rc_ctl)"
fi

# ── s8.j AWS key inside docs/DISTRIBUTION.md ───────────────────────────────────
if [ -f "$DISTRIBUTION_MD" ]; then
  printf '\naws_access_key_id = %s\n' "$AWS_KEY" >>"$DISTRIBUTION_MD"
  rc="$(scan s8j-aws-in-distribution-md)"
  cp -p "$BACKUP/DISTRIBUTION.md" "$DISTRIBUTION_MD"
  printf 'aws_access_key_id = %s\n' "$AWS_KEY" >"$PROBE_ROOT"
  rc_ctl="$(scan s8j-aws-control)"
  rm -f "$PROBE_ROOT"
  if [ "$rc_ctl" != 1 ] || ! rule_hit s8j-aws-control aws-access-token; then
    record BROKEN s8.j-aws-in-distribution-md "ctl=$rc_ctl" "$OUT/s8j-aws-control.log" "aws-access-token probe not detected at an unlisted path — probe invalid"
  elif [ "$rc" = 1 ] && rule_hit s8j-aws-in-distribution-md aws-access-token; then
    record HELD s8.j-aws-in-distribution-md 1 "$OUT/s8j-aws-in-distribution-md.log" "AWS key in docs/DISTRIBUTION.md is still caught"
  else
    record BROKEN s8.j-aws-in-distribution-md "$rc" "$OUT/s8j-aws-in-distribution-md.log" "an AWS access key in docs/DISTRIBUTION.md passes (ASC identifier allowlist applies by path alone; control exit $rc_ctl)"
  fi
else
  record BROKEN s8.j-aws-in-distribution-md 2 "$OUT/seed.txt" "docs/DISTRIBUTION.md absent — probe not executable"
fi

verdict
