#!/usr/bin/env bash
# S2 — dependency-advisory endpoint unavailable: does anything surface it?
#
# Attack: make `registry.npmjs.org/-/npm/v1/security/*` unavailable (via the
# local reverse proxy advisory-blackhole-proxy.mjs, which forwards every other
# registry path untouched) and run the two audit commands the security playbook
# names. Then check whether the canonical pipeline would ever have run them.
#
# Checks:
#   s2.a  `npm audit --omit=dev` in apps/mobile against the black-holed registry → must exit non-zero
#   s2.b  `pnpm audit --prod` at the root against the black-holed registry       → must exit non-zero
#   s2.c  `npm audit` with the advisory endpoint resetting the connection        → must exit non-zero
#   s2.d  the pipeline (scripts/verify-cloud.sh + .github/workflows/ci.yml) contains an audit stage
#
# Usage: tools/attack-security-secrets-deps/s2_audit_blackhole.sh
# Env:   ATTACK_PROXY_PORT (default 4873)
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

PORT="${ATTACK_PROXY_PORT:-4873}"
PROXY="$REPO_ROOT/tools/attack-security-secrets-deps/advisory-blackhole-proxy.mjs"
PROXY_PID=""

stop_proxy() {
  if [ -n "$PROXY_PID" ] && kill -0 "$PROXY_PID" 2>/dev/null; then
    kill "$PROXY_PID" 2>/dev/null || true
    wait "$PROXY_PID" 2>/dev/null || true
  fi
  PROXY_PID=""
}
trap stop_proxy EXIT

start_proxy() { # <mode>
  local mode="$1"
  node "$PROXY" --port "$PORT" --mode "$mode" 2>"$OUT/proxy-$mode.requests.jsonl" >"$OUT/proxy-$mode.stdout" &
  PROXY_PID=$!
  for _ in $(seq 1 50); do
    grep -q LISTENING "$OUT/proxy-$mode.stdout" 2>/dev/null && return 0
    sleep 0.1
  done
  log "proxy did not start"
  exit 2
}

# The proxy must forward normal metadata (so failures below are ONLY the advisory path).
start_proxy 503
code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/zod/latest" || true)"
[ "$code" = 200 ] || { log "proxy sanity check failed (GET /zod/latest -> $code)"; exit 2; }
code="$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$PORT/-/npm/v1/security/advisories/bulk" || true)"
[ "$code" = 503 ] || { log "proxy sanity check failed (POST advisories/bulk -> $code)"; exit 2; }

# ── s2.a npm audit (apps/mobile, npm — never pnpm there) ───────────────────────
rc="$(cd "$REPO_ROOT/apps/mobile" && run_capture "$OUT/s2a-npm-audit-503.log" npm audit --omit=dev "--registry=http://127.0.0.1:$PORT")"
if [ "$rc" != 0 ] && grep -q 'audit endpoint returned an error' "$OUT/s2a-npm-audit-503.log"; then
  record HELD s2.a-npm-audit-503 "$rc" "$OUT/s2a-npm-audit-503.log" "npm audit fails loudly when the advisory endpoint returns 503"
else
  record BROKEN s2.a-npm-audit-503 "$rc" "$OUT/s2a-npm-audit-503.log" "npm audit did not fail on a 503 advisory endpoint"
fi

# ── s2.b pnpm audit (root workspace) ───────────────────────────────────────────
rc="$(cd "$REPO_ROOT" && run_capture "$OUT/s2b-pnpm-audit-503.log" pnpm audit --prod "--registry=http://127.0.0.1:$PORT")"
if [ "$rc" != 0 ] && grep -q 'ERR_PNPM_AUDIT_BAD_RESPONSE' "$OUT/s2b-pnpm-audit-503.log"; then
  record HELD s2.b-pnpm-audit-503 "$rc" "$OUT/s2b-pnpm-audit-503.log" "pnpm audit fails with ERR_PNPM_AUDIT_BAD_RESPONSE"
else
  record BROKEN s2.b-pnpm-audit-503 "$rc" "$OUT/s2b-pnpm-audit-503.log" "pnpm audit did not fail on a 503 advisory endpoint"
fi
stop_proxy

# ── s2.c connection reset instead of an HTTP error ─────────────────────────────
start_proxy reset
rc="$(cd "$REPO_ROOT/apps/mobile" && run_capture "$OUT/s2c-npm-audit-reset.log" npm audit --omit=dev "--registry=http://127.0.0.1:$PORT" --fetch-retries=0)"
if [ "$rc" != 0 ]; then
  record HELD s2.c-npm-audit-reset "$rc" "$OUT/s2c-npm-audit-reset.log" "npm audit fails when the advisory socket is reset"
else
  record BROKEN s2.c-npm-audit-reset "$rc" "$OUT/s2c-npm-audit-reset.log" "npm audit reported green with the advisory socket reset"
fi
stop_proxy

# ── s2.d does the pipeline ever run an audit? ──────────────────────────────────
{
  echo "grep -nE 'npm audit|pnpm audit|audit ' scripts/verify-cloud.sh .github/workflows/*.yml package.json apps/mobile/package.json"
  (cd "$REPO_ROOT" && grep -nE 'npm audit|pnpm audit|audit ' scripts/verify-cloud.sh .github/workflows/*.yml package.json apps/mobile/package.json) || echo "(no matches)"
  echo
  echo "stages in scripts/verify-cloud.sh:"
  (cd "$REPO_ROOT" && grep -nE '^ALL_STAGES=|^stage_[a-z]+\(\)' scripts/verify-cloud.sh)
  echo
  echo "npm ci flags in the deps stage:"
  (cd "$REPO_ROOT" && grep -n 'npm ci' scripts/verify-cloud.sh)
} >"$OUT/s2d-pipeline-audit-coverage.txt" 2>&1
if (cd "$REPO_ROOT" && grep -qE 'npm audit|pnpm audit' scripts/verify-cloud.sh .github/workflows/*.yml); then
  record HELD s2.d-pipeline-has-audit-stage 0 "$OUT/s2d-pipeline-audit-coverage.txt" "verify-cloud/ci invoke a dependency audit"
else
  record BROKEN s2.d-pipeline-has-audit-stage 1 "$OUT/s2d-pipeline-audit-coverage.txt" "no stage in verify-cloud.sh or ci.yml runs npm/pnpm audit; deps stage uses npm ci --no-audit — advisory outage (or a real CVE) can never turn the pipeline red"
fi

verdict
