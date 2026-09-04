#!/usr/bin/env bash
# S6 — flip NSPrivacyTracking to <true/> and see which Linux checks notice.
#
#   tools/release/__attack__/probe-s6-xcprivacy-tracking.sh [artifact-dir]
#
# The mobile jest suites resolve PrivacyInfo.xcprivacy from __dirname, so this
# probe edits the REAL file under a restore trap (byte-identical copy restored on
# every exit path, then verified with cmp). Requires apps/mobile/node_modules.
# Exit 0 = HELD (at least one PR-tier Linux check fails on tracking=true),
# exit 1 = BROKEN (nothing on Linux catches it), exit 75 = prerequisites missing.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
OUT="${1:-$ROOT/artifacts/attack-release-config-docs-3}"
mkdir -p "$OUT"
cd "$ROOT"

X=apps/mobile/ios/PickleSensei/PrivacyInfo.xcprivacy
[ -d apps/mobile/node_modules ] || { echo "apps/mobile/node_modules missing (cd apps/mobile && npm ci)"; exit 75; }
if ! grep -q "NSPrivacyTracking" "$X"; then echo "$X has no NSPrivacyTracking key"; exit 75; fi

BACKUP="$(mktemp)"
cp "$X" "$BACKUP"
restore() {
  cp "$BACKUP" "$X"
  if cmp -s "$BACKUP" "$X"; then echo "restored $X (byte-identical)"; else echo "RESTORE FAILED for $X" >&2; fi
  rm -f "$BACKUP"
}
trap restore EXIT

python3 - "$X" <<'EOF'
import re, sys
p = sys.argv[1]
s = open(p).read()
n = re.sub(r'(<key>NSPrivacyTracking</key>\s*)<false/>', r'\1<true/>', s, count=1)
assert n != s, "NSPrivacyTracking <false/> not found"
open(p, 'w').write(n)
EOF
grep -n -A1 "<key>NSPrivacyTracking</key>" "$X" | head -2

pnpm -s release:check >"$OUT/s6_release_check.log" 2>&1
release_exit=$?
echo "pnpm release:check -> exit=$release_exit"

(cd apps/mobile && node scripts/check-ios-distribution.mjs) >"$OUT/s6_check_distribution.log" 2>&1
dist_exit=$?
echo "apps/mobile check:distribution -> exit=$dist_exit"

(cd apps/mobile && npx jest --ci \
  __tests__/wf/fix-9-privacyManifestCollectedData.test.ts \
  __tests__/wf/flow-app-store-compliance-ios-config.test.ts) >"$OUT/s6_mobile_jest.log" 2>&1
jest_exit=$?
echo "apps/mobile jest (privacy suites) -> exit=$jest_exit"
grep -E "^Tests:|●.*›" "$OUT/s6_mobile_jest.log" | head -5

verdict=BROKEN
[ $jest_exit -ne 0 ] || [ $release_exit -ne 0 ] || [ $dist_exit -ne 0 ] && verdict=HELD
cat >"$OUT/s6_xcprivacy_tracking.json" <<EOF
{
  "scenario": "S6",
  "mutation": "NSPrivacyTracking <false/> -> <true/> in $X (restored afterwards)",
  "release_check_exit": $release_exit,
  "check_distribution_exit": $dist_exit,
  "mobile_jest_privacy_suites_exit": $jest_exit,
  "verdict": "$verdict"
}
EOF
cat "$OUT/s6_xcprivacy_tracking.json"
[ "$verdict" = HELD ]
