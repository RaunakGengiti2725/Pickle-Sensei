#!/usr/bin/env bash
# Adversarial probes against the secret-scanning gate (scripts/security-scan.sh
# + .gitleaks.toml). Each probe plants a SYNTHETIC credential-shaped string in
# an untracked file (or a throwaway local commit), runs the gate, and records
# whether the gate failed (exit 1 = HELD) or passed (exit 0 = BROKEN).
#
#   tools/attack/security-secrets-deps-2/gitleaks-probes.sh [out-dir]
#
# Nothing here is a real credential: every value is built from a fixed
# prefix + a seeded pseudo-random or constant suffix. The script cleans up
# every planted file and the throwaway branch on exit, and never pushes.
# Exit code: 0 when every probe HELD, 1 when at least one probe is BROKEN.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
# Reports go OUTSIDE the repo: `gitleaks dir` scans gitignored paths too, so a
# report written under artifacts/ would be re-scanned by the next probe.
OUT_DIR="${1:-${TMPDIR:-/tmp}/attack-security-secrets-deps-2/gitleaks}"
mkdir -p "$OUT_DIR"
OUT_DIR="$(cd "$OUT_DIR" && pwd)"
SEED="${PROBE_SEED:-20260904}"
GATE="$REPO_ROOT/scripts/security-scan.sh"

cd "$REPO_ROOT"
START_REF="$(git rev-parse HEAD)"
START_BRANCH="$(git branch --show-current)" # empty when detached
PROBE_BRANCH="wf-probe-env-history-$$"

PLANTED=()
remove_planted() { # remove the file, then any now-empty parent dirs we created
  local rel="$1" dir
  rm -rf -- "$REPO_ROOT/$rel"
  dir="$(dirname "$rel")"
  while [ "$dir" != "." ] && [ -d "$REPO_ROOT/$dir" ] && [ -z "$(ls -A "$REPO_ROOT/$dir")" ]; do
    rmdir -- "$REPO_ROOT/$dir"
    dir="$(dirname "$dir")"
  done
}

cleanup() {
  local f
  for f in "${PLANTED[@]:-}"; do
    [ -n "$f" ] && remove_planted "$f"
  done
  local b
  for b in "$PROBE_BRANCH" "wf-probe-sibling-$$"; do
    if git show-ref --verify --quiet "refs/heads/$b"; then
      if [ -n "$START_BRANCH" ]; then git checkout -q "$START_BRANCH"; else git checkout -q "$START_REF"; fi
      git branch -D -q "$b"
    fi
  done
}
trap cleanup EXIT

# Deterministic "random" alphanumerics: sha256 of seed+label, hex → alnum.
synth() {
  local label="$1" len="$2"
  printf '%s:%s' "$SEED" "$label" | sha256sum | awk '{print $1}' | tr '0-9' 'a-j' | cut -c1-"$len"
}

RESULTS="$OUT_DIR/results.jsonl"
: >"$RESULTS"
BROKEN=0

# run_gate <label> <expected-exit> <gate args...>
run_gate() {
  local label="$1" expected="$2"
  shift 2
  local log="$OUT_DIR/$label.log" rc=0
  "$GATE" "$@" --report-dir "$OUT_DIR/$label-report" >"$log" 2>&1 || rc=$?
  local verdict="HELD"
  if [ "$rc" != "$expected" ]; then
    verdict="BROKEN"
    BROKEN=1
  fi
  local rules=""
  if [ -d "$OUT_DIR/$label-report" ]; then
    rules="$(cat "$OUT_DIR/$label-report"/*.json | sed -n 's/.*"RuleID": *"\([^"]*\)".*/\1/p' | sort -u | paste -sd, -)"
  fi
  printf '{"probe":"%s","args":"%s","expected_exit":%s,"observed_exit":%s,"verdict":"%s","rules_fired":"%s","log":"%s"}\n' \
    "$label" "$*" "$expected" "$rc" "$verdict" "$rules" "$log" >>"$RESULTS"
  printf '[probe] %-42s expected=%s observed=%s → %s%s\n' "$label" "$expected" "$rc" "$verdict" "${rules:+ ($rules)}"
}

plant() { # plant <relpath> <content>
  mkdir -p "$(dirname "$REPO_ROOT/$1")"
  printf '%s\n' "$2" >"$REPO_ROOT/$1"
  PLANTED+=("$1")
}
unplant() {
  remove_planted "$1"
}

SB_SECRET="sb_secret_$(synth sb 40)"
GHP_TOKEN="ghp_$(synth ghp 36)"
WEBHOOK_AUTH="wfwebhook$(synth wh 24)"

# ── Probe B (S7): sb_secret_ under an untracked build/ dir ──────────────────
plant "build/wf-probe/config.json" "{\"supabase\":{\"serviceKey\":\"$SB_SECRET\"}}"
run_gate "S7-build-dir-sb_secret" 1 --tree
unplant "build/wf-probe"

# Control: the same value OUTSIDE build/ must be caught (proves the rule works).
plant "wf-probe-control-sb_secret.json" "{\"supabase\":{\"serviceKey\":\"$SB_SECRET\"}}"
run_gate "S7-control-sb_secret-root" 1 --tree
unplant "wf-probe-control-sb_secret.json"

# Same class: every other blanket directory allowlist, none gitignored at root.
for dir in dist coverage Pods vendor/bundle .build .turbo; do
  slug="$(printf '%s' "$dir" | tr '/.' '--')"
  plant "$dir/wf-probe.json" "{\"serviceKey\":\"$SB_SECRET\"}"
  run_gate "S7x-dir-${slug}-sb_secret" 1 --tree
  unplant "$dir"
done

# ── S6: low-entropy structured RevenueCat-shaped key ────────────────────────
plant "wf-probe-lowentropy.ts" 'export const REVENUECAT_SECRET_API_KEY = "sk_aaaaaaaaaaaaaaaaaaaaaaaa";'
run_gate "S6-low-entropy-sk_key" 1 --tree
unplant "wf-probe-lowentropy.ts"

# Slightly more structured but still low entropy (repeating triad, entropy ≈ 2.4).
plant "wf-probe-lowentropy2.ts" 'export const REVENUECAT_SECRET_API_KEY = "sk_abcabcabcabcabcabcabcabcabc";'
run_gate "S6x-repeating-triad-sk_key" 1 --tree
unplant "wf-probe-lowentropy2.ts"

# Control: a seeded high-entropy sk_ key must be caught.
plant "wf-probe-highentropy.ts" "export const REVENUECAT_SECRET_API_KEY = \"sk_$(synth sk 32)\";"
run_gate "S6-control-high-entropy-sk_key" 1 --tree
unplant "wf-probe-highentropy.ts"

# ── S5: REVENUECAT_WEBHOOK_AUTH in YAML and inside a TS template literal ─────
plant "wf-probe-webhook.yaml" "env:
  REVENUECAT_WEBHOOK_AUTH: \"$WEBHOOK_AUTH\""
run_gate "S5-webhook-auth-yaml-double-quoted" 1 --tree
unplant "wf-probe-webhook.yaml"

plant "wf-probe-webhook-single.yaml" "env:
  REVENUECAT_WEBHOOK_AUTH: '$WEBHOOK_AUTH'"
run_gate "S5x-webhook-auth-yaml-single-quoted" 1 --tree
unplant "wf-probe-webhook-single.yaml"

plant "wf-probe-webhook-bare.yaml" "env:
  REVENUECAT_WEBHOOK_AUTH: $WEBHOOK_AUTH"
run_gate "S5x-webhook-auth-yaml-bare" 1 --tree
unplant "wf-probe-webhook-bare.yaml"

plant "wf-probe-webhook.ts" "export const secretsFile = \`
REVENUECAT_WEBHOOK_AUTH=$WEBHOOK_AUTH
\`;"
run_gate "S5-webhook-auth-ts-template-literal" 1 --tree
unplant "wf-probe-webhook.ts"

# Template literal with the value interpolated as a separate string constant:
# the assignment token is split across the literal boundary.
plant "wf-probe-webhook-interp.ts" "const value = \"$WEBHOOK_AUTH\";
export const secretsFile = \`REVENUECAT_WEBHOOK_AUTH=\${value}\`;"
run_gate "S5x-webhook-auth-ts-interpolated" 1 --tree
unplant "wf-probe-webhook-interp.ts"

# JSON object form: the key is QUOTED, so `AUTH"` precedes the colon — the
# rule's `AUTH\s*[=:]` needs the separator right after the bare key name.
plant "wf-probe-webhook.json" "{\"REVENUECAT_WEBHOOK_AUTH\": \"$WEBHOOK_AUTH\"}"
run_gate "S5x-webhook-auth-json" 1 --tree
unplant "wf-probe-webhook.json"

# Same JSON shape with a seeded HIGH-entropy value: does gitleaks' default
# generic-api-key rule (entropy >= 3.5) backstop the custom rule's gap?
plant "wf-probe-webhook-hi.json" "{\"REVENUECAT_WEBHOOK_AUTH\": \"$(printf '%s:hi' "$SEED" | sha256sum | awk '{print $1}' | base64 -w0 | tr -d '=' | cut -c1-40)\"}"
run_gate "S5x-webhook-auth-json-high-entropy" 1 --tree
unplant "wf-probe-webhook-hi.json"

# Quoted-key YAML (`"REVENUECAT_WEBHOOK_AUTH": value`) and bracket env access.
plant "wf-probe-webhook-quotedkey.yaml" "env:
  \"REVENUECAT_WEBHOOK_AUTH\": \"$WEBHOOK_AUTH\""
run_gate "S5x-webhook-auth-yaml-quoted-key" 1 --tree
unplant "wf-probe-webhook-quotedkey.yaml"

plant "wf-probe-webhook-bracket.ts" "process.env[\"REVENUECAT_WEBHOOK_AUTH\"] = \"$WEBHOOK_AUTH\";"
run_gate "S5x-webhook-auth-ts-bracket-assign" 1 --tree
unplant "wf-probe-webhook-bracket.ts"

# ── S4: committed .env on a throwaway branch → history scan ─────────────────
git checkout -q -b "$PROBE_BRANCH" "$START_REF"
printf 'GITHUB_TOKEN=%s\nSUPABASE_SERVICE_ROLE_KEY=%s\n' "$GHP_TOKEN" "$SB_SECRET" >"$REPO_ROOT/.env"
PLANTED+=(".env")
git add -f .env
git -c user.name=wf-probe -c user.email=wf-probe@example.test commit -q -m "wf probe: synthetic .env (never pushed)"
run_gate "S4-committed-dotenv-history" 1 --history --log-opts "HEAD~1..HEAD"
# The working tree still contains .env (tracked now): tree mode is blind too.
run_gate "S4x-committed-dotenv-tree" 1 --tree
# Rename laundering: a later commit that only RENAMES the allowlisted .env to
# a non-allowlisted path produces a 100%-similarity rename with no content
# hunk, so the history scan of that commit sees zero bytes of the secret.
git mv -f .env wf-probe.env.production
PLANTED+=("wf-probe.env.production")
git -c user.name=wf-probe -c user.email=wf-probe@example.test commit -q -m "wf probe: rename .env (never pushed)"
run_gate "S4x-renamed-dotenv-history" 1 --history --log-opts "HEAD~1..HEAD"
# The renamed file is at a scanned path now: tree mode must catch it.
run_gate "S4x-renamed-dotenv-tree" 1 --tree
# Control: the identical content ADDED (not renamed) under a non-allowlisted
# name IS caught by the history scan (proves the rules + range work). The
# removal is committed separately so git cannot pair it up as a rename.
git rm -q wf-probe.env.production
git -c user.name=wf-probe -c user.email=wf-probe@example.test commit -q -m "wf probe: drop renamed file"
printf 'GITHUB_TOKEN=%s\nSUPABASE_SERVICE_ROLE_KEY=%s\n' "$GHP_TOKEN" "$SB_SECRET" >"$REPO_ROOT/wf-probe-control.env.production"
PLANTED+=("wf-probe-control.env.production")
git add wf-probe-control.env.production
git -c user.name=wf-probe -c user.email=wf-probe@example.test commit -q -m "wf probe control (never pushed)"
run_gate "S4-control-committed-env-production-history" 1 --history --log-opts "HEAD~1..HEAD"
# gitleaks scans ADDED lines only: the deletion commit shows the secret in a
# `-` hunk and is expected to be clean (the addition was the finding).
git rm -q wf-probe-control.env.production
git -c user.name=wf-probe -c user.email=wf-probe@example.test commit -q -m "wf probe cleanup"
run_gate "S4x-deleted-secret-file-history" 0 --history --log-opts "HEAD~1..HEAD"
if [ -n "$START_BRANCH" ]; then git checkout -q "$START_BRANCH"; else git checkout -q "$START_REF"; fi
git branch -D -q "$PROBE_BRANCH"

# ── H: full history mode (no --log-opts) = gitleaks `git log --all` ────────────
# CI checks out with fetch-depth 0 (+refs/heads/*:refs/remotes/origin/*), so
# the history scan of a PR also scans every OTHER branch on the remote.
# H0: the pristine checkout — a clean baseline must be clean.
run_gate "H0-baseline-full-history" 0 --history
# Attribute every H0 finding commit: is it reachable from HEAD at all, and
# which remote branches carry it? (A finding that is NOT an ancestor of HEAD
# comes purely from another branch being present in the clone.)
if compgen -G "$OUT_DIR/H0-baseline-full-history-report/*.json" >/dev/null; then
  cat "$OUT_DIR/H0-baseline-full-history-report"/*.json |
    sed -n 's/.*"Commit": *"\([0-9a-f]\{40\}\)".*/\1/p' | sort -u |
    while read -r sha; do
      if git merge-base --is-ancestor "$sha" "$START_REF"; then reach=ancestor-of-HEAD; else reach=NOT-ancestor-of-HEAD; fi
      branches="$(git branch -r --contains "$sha" | sed 's/^ *//' | paste -sd, -)"
      printf '{"probe":"H0-attribution","commit":"%s","reach":"%s","branches":"%s"}\n' "$sha" "$reach" "$branches" >>"$RESULTS"
      printf '[probe] H0-attribution %s %s %s\n' "${sha:0:10}" "$reach" "$branches"
    done
fi
# H1: a secret committed on a SIBLING local branch that is NOT an ancestor of
# HEAD shows up in HEAD's history scan (fingerprint carries the sibling sha).
SIBLING_BRANCH="wf-probe-sibling-$$"
git checkout -q -b "$SIBLING_BRANCH" "$START_REF"
printf 'export const key = "%s";\n' "$SB_SECRET" >"$REPO_ROOT/wf-probe-sibling.ts"
PLANTED+=("wf-probe-sibling.ts")
git add wf-probe-sibling.ts
git -c user.name=wf-probe -c user.email=wf-probe@example.test commit -q -m "wf probe sibling (never pushed)"
SIBLING_SHA="$(git rev-parse HEAD)"
git rm -q wf-probe-sibling.ts
git -c user.name=wf-probe -c user.email=wf-probe@example.test commit -q -m "wf probe sibling cleanup"
if [ -n "$START_BRANCH" ]; then git checkout -q "$START_BRANCH"; else git checkout -q "$START_REF"; fi
# HEAD is back at START_REF; the sibling branch is unreachable from it.
run_gate "H1-sibling-branch-leaks-into-head-history" 0 --history
sibling_hits="$(cat "$OUT_DIR/H1-sibling-branch-leaks-into-head-history-report"/*.json | grep -c "$SIBLING_SHA" || [ $? = 1 ])"
printf '{"probe":"H1-sibling-commit-in-report","sibling_sha":"%s","hits":%s,"verdict":"%s"}\n' \
  "$SIBLING_SHA" "$sibling_hits" "$([ "$sibling_hits" = 0 ] && echo HELD || echo BROKEN)" >>"$RESULTS"
printf '[probe] %-42s sibling_sha=%s hits=%s\n' "H1-sibling-commit-in-report" "${SIBLING_SHA:0:10}" "$sibling_hits"
[ "$sibling_hits" = 0 ] || BROKEN=1
git branch -D -q "$SIBLING_BRANCH"

# ── Extra: .env.production (not .local) must still be scanned in the tree ───
plant ".env.production" "SUPABASE_SERVICE_ROLE_KEY=$SB_SECRET"
run_gate "X1-dotenv-production-tree" 1 --tree
unplant ".env.production"

# ── Extra: gitignored-but-not-allowlisted artifacts/ IS scanned (dir mode
# ignores .gitignore) — documents what the tree scan actually covers.
plant "artifacts/wf-probe/secret.json" "{\"serviceKey\":\"$SB_SECRET\"}"
run_gate "X2-gitignored-artifacts-dir-tree" 1 --tree
unplant "artifacts/wf-probe"

# ── Extra: fixture-literal allowlists claim to be path-scoped — the same
# literal OUTSIDE its path must be flagged (stripe-access-token matches
# `sk_test_revenuecat` with gitleaks' default config).
plant "wf-probe-fixture-escape.ts" 'Deno.env.set("REVENUECAT_SECRET_API_KEY", "sk_test_revenuecat");'
run_gate "X3-fixture-literal-outside-scope" 1 --tree
unplant "wf-probe-fixture-escape.ts"

# ── A: "path + regexes" allowlists without `condition = "AND"` ──────────────
# gitleaks (README, v8.30.1) evaluates multi-criteria allowlists with OR by
# default: matching the PATH alone is enough. So each "fixture literal scoped
# to a path" entry silently exempts the WHOLE path from the targeted rules
# (or from every rule when targetRules is absent). Planted under a mirror
# prefix so the regex `(?:^|/)<path>$` matches without touching tracked files.
# A1: an sb_secret_ key (custom rule, NO targetRules on that allowlist) in a
# file whose path matches the runtimeConfig.ts allowlist.
plant "wf-probe-mirror/apps/mobile/src/config/runtimeConfig.ts" "export const supabaseKey = \"$SB_SECRET\";"
run_gate "A1-runtimeConfig-path-exempts-all-rules" 1 --tree
unplant "wf-probe-mirror"
# A2: a private key PEM inside a file matching the docs/DISTRIBUTION.md allowlist.
plant "wf-probe-mirror/docs/DISTRIBUTION.md" "$(printf -- '-----%s PRIVATE KEY-----' BEGIN)
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg$(synth pem2 40)
$(printf -- '-----%s PRIVATE KEY-----' END)"
run_gate "A2-DISTRIBUTION-md-path-exempts-all-rules" 1 --tree
unplant "wf-probe-mirror"
# A3: a high-entropy sk_ RevenueCat-shaped key anywhere under __wf__/ (that
# allowlist targets stripe-access-token + revenuecat-secret-api-key).
plant "wf-probe-mirror/supabase/functions/api/__wf__/wf-probe.ts" "export const REVENUECAT_SECRET_API_KEY = \"sk_$(synth sk3 32)\";"
run_gate "A3-wf-dir-path-exempts-revenuecat-rule" 1 --tree
unplant "wf-probe-mirror"
# A4: a Stripe live-shaped key under __wf__/ (same allowlist, stripe rule).
plant "wf-probe-mirror/supabase/functions/api/__wf__/wf-probe2.ts" "export const stripe = \"sk_live_$(synth stripe 32)\";"
run_gate "A4-wf-dir-path-exempts-stripe-rule" 1 --tree
unplant "wf-probe-mirror"
# A5: an sb_secret_ key in the mobile secrets test path (allowlist has NO targetRules).
plant "wf-probe-mirror/apps/mobile/__tests__/wf/be-mobile-security-secrets.test.ts" "const k = \"$SB_SECRET\";"
run_gate "A5-mobile-secrets-test-path-exempts-all-rules" 1 --tree
unplant "wf-probe-mirror"

# ── Extra: private key PEM planted in an untracked TS string ─────────────────
# The PEM armor is assembled at runtime so THIS script (which lives in the
# scanned tree) never contains the literal header the private-key rule matches.
PEM_ARMOR="$(printf -- '-----%s PRIVATE KEY-----' BEGIN)"
PEM_TAIL="$(printf -- '-----%s PRIVATE KEY-----' END)"
plant "wf-probe-pem.ts" "export const pem = \`$PEM_ARMOR
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg$(synth pem 40)
$PEM_TAIL\`;"
run_gate "X4-private-key-pem" 1 --tree
unplant "wf-probe-pem.ts"

# ── Clean tree control: nothing planted → exit 0 ─────────────────────────────
run_gate "X0-clean-tree" 0 --tree

git status --porcelain >"$OUT_DIR/git-status-after.txt"
printf '\nresults: %s\n' "$RESULTS"
if [ "$BROKEN" = 1 ]; then
  printf 'AT LEAST ONE PROBE BROKEN\n'
  exit 1
fi
printf 'ALL PROBES HELD\n'
