#!/usr/bin/env bash
# R5 — no verification stage or CI job runs a dependency audit, while the
# mobile production tree currently carries high-severity advisories.
# HELD = some gate (verify-cloud.sh / ci.yml) invokes `pnpm audit` or
# `npm audit`, AND `npm audit --omit=dev` in apps/mobile reports no high/critical.
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
cd "$REPO_ROOT"

if grep -Eq '(pnpm|npm) audit' scripts/verify-cloud.sh .github/workflows/ci.yml; then
  verdict HELD r5:gate-wiring "a verification gate invokes a dependency audit"
else
  verdict BROKEN r5:gate-wiring "neither scripts/verify-cloud.sh nor .github/workflows/ci.yml runs pnpm/npm audit (mobile install uses npm ci --no-audit)"
fi

rc=0; (cd apps/mobile && npm audit --omit=dev --json) >"$OUT/r5-mobile-audit.json" 2>"$OUT/r5-mobile-audit.err" || rc=$?
if grep -q '"code"' "$OUT/r5-mobile-audit.json" && ! grep -q '"vulnerabilities"' "$OUT/r5-mobile-audit.json"; then
  die "npm advisory endpoint unavailable; audit result is not a pass (see $OUT/r5-mobile-audit.err)"
fi
read -r high critical < <(node -e '
const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).metadata.vulnerabilities;
console.log(r.high, r.critical)' "$OUT/r5-mobile-audit.json")
if [ "$((high + critical))" = 0 ]; then
  verdict HELD r5:mobile-audit "apps/mobile npm audit --omit=dev: 0 high/critical (exit $rc)"
else
  verdict BROKEN r5:mobile-audit "apps/mobile npm audit --omit=dev: high=$high critical=$critical (exit $rc)"
fi

rc=0; pnpm audit --prod --json >"$OUT/r5-root-audit.json" 2>"$OUT/r5-root-audit.err" || rc=$?
verdict "$([ "$rc" = 0 ] && echo HELD || echo BROKEN)" r5:root-audit "pnpm audit --prod exit $rc"
finish
