#!/usr/bin/env bash
# Adjudication harness — area `mobile-ios-config` (IOSCFG-3 guard gaps; M9–M12 are
# P3 and informational).
#
# Applies one iOS-config mutation at a time in a throwaway git worktree of the
# given revision, runs the Linux gates against it, and reports which gates
# went red. Exits 1 when ANY mutation is caught by NO gate (a false green).
#
# Usage:
#   tools/adjudicate/mobile-ios-config/mutate-guards.sh [REV] [--no-audit]
#     REV         revision to test (default HEAD)
#     --no-audit  only the gates that existed at 4d812e1a (check:distribution,
#                 wf/ compliance + privacy + secrets suites, release manifest);
#                 with this flag the script exits 1 at 4d812e1a — that IS the
#                 finding. Without it, apps/mobile/__tests__/audit/*.test.ts
#                 are added to the Jest run and every mutation must be caught.
#
# The worktree shares this checkout's apps/mobile/node_modules via symlink
# (run `cd apps/mobile && npm ci` first). Nothing outside the worktree is
# modified; the worktree is removed on exit.
set -uo pipefail

REV=HEAD
AUDIT=1
for arg in "$@"; do
  case "$arg" in
    --no-audit) AUDIT=0 ;;
    *) REV="$arg" ;;
  esac
done

ROOT="$(git rev-parse --show-toplevel)"
SHA="$(git -C "$ROOT" rev-parse "$REV")"
WT="$(mktemp -d "${TMPDIR:-/tmp}/ios-config-mutate.XXXXXX")"
trap 'git -C "$ROOT" worktree remove --force "$WT" >/dev/null 2>&1 || true' EXIT
git -C "$ROOT" worktree add --detach "$WT" "$SHA" >/dev/null 2>&1 || { echo "worktree add failed for $SHA"; exit 2; }
ln -s "$ROOT/apps/mobile/node_modules" "$WT/apps/mobile/node_modules"
[ -d "$ROOT/node_modules" ] && ln -s "$ROOT/node_modules" "$WT/node_modules"

M="$WT/apps/mobile"
PBX="$M/ios/PickleSensei.xcodeproj/project.pbxproj"
PLIST="$M/ios/PickleSensei/Info.plist"
PRIV="$M/ios/PickleSensei/PrivacyInfo.xcprivacy"
ENT="$M/ios/PickleSensei/PickleSensei.entitlements"
APPJSON="$M/app.json"
restore() { git -C "$WT" checkout -- apps/mobile >/dev/null 2>&1; }

JEST_FILES=(
  __tests__/wf/flow-app-store-compliance-ios-config.test.ts
  __tests__/wf/fix-9-privacyManifestCollectedData.test.ts
  __tests__/wf/be-mobile-security-secrets.test.ts
)
if [ "$AUDIT" = 1 ]; then
  for f in "$M"/__tests__/audit/ios-config-guards.test.ts; do
    [ -f "$f" ] && JEST_FILES+=("__tests__/audit/$(basename "$f")")
  done
fi

FALSE_GREEN=0
gates() {
  local tag="$1"
  (cd "$M" && node scripts/check-ios-distribution.mjs >/dev/null 2>&1); local g1=$?
  (cd "$M" && npx jest --ci --silent "${JEST_FILES[@]}" >/dev/null 2>&1); local g2=$?
  (cd "$WT" && node tools/release/check-release-manifest.mjs >/dev/null 2>&1); local g3=$?
  printf '%-58s check:distribution=%s jest=%s release:check=%s' "$tag" "$g1" "$g2" "$g3"
  case "$tag" in
    baseline) echo ;;
    info:*) if [ "$g1$g2$g3" = "000" ]; then echo '  (not caught; P3 — informational, not counted)'; else echo; fi ;;
    *) if [ "$g1$g2$g3" = "000" ]; then echo '  <-- FALSE GREEN'; FALSE_GREEN=1; else echo; fi ;;
  esac
}

# Replace the 2nd occurrence of a setting line (the Release block follows Debug).
rel_only() {
  python3 - "$PBX" "$1" "$2" <<'EOF'
import re, sys
p, pat, rep = sys.argv[1:4]
s = open(p).read()
ms = list(re.finditer(pat, s))
assert len(ms) == 2, (pat, len(ms))
m = ms[1]
open(p, 'w').write(s[:m.start()] + re.sub(pat, rep, m.group(0)) + s[m.end():])
EOF
}

echo "rev $SHA  audit-tests=$AUDIT  jest files: ${JEST_FILES[*]}"
gates baseline

rel_only 'CURRENT_PROJECT_VERSION = 1;' 'CURRENT_PROJECT_VERSION = 7;';           gates 'M1 Release-only CURRENT_PROJECT_VERSION=7'; restore
rel_only 'MARKETING_VERSION = 1\.0;' 'MARKETING_VERSION = 2.0;';                  gates 'M2 Release-only MARKETING_VERSION=2.0'; restore
rel_only 'PRODUCT_BUNDLE_IDENTIFIER = com\.picklesensei;' 'PRODUCT_BUNDLE_IDENTIFIER = com.picklesensei.staging;'; gates 'M3 Release-only bundle id changed'; restore
rel_only 'TARGETED_DEVICE_FAMILY = 1;' 'TARGETED_DEVICE_FAMILY = 2;';              gates 'M4 Release-only TARGETED_DEVICE_FAMILY=2'; restore
rel_only 'DEVELOPMENT_TEAM = H26U6W4K6V;' 'DEVELOPMENT_TEAM = ZZZZZZZZZZ;';        gates 'M5 Release-only DEVELOPMENT_TEAM changed'; restore
rel_only 'CODE_SIGN_ENTITLEMENTS = PickleSensei/PickleSensei\.entitlements;\n' ''; gates 'M6 Release-only CODE_SIGN_ENTITLEMENTS removed'; restore

python3 - "$PBX" <<'EOF'
import sys; p = sys.argv[1]; s = open(p).read()
i = s.index('name = Release;'); j = s.rfind('CLANG_ENABLE_MODULES = YES;', 0, i)
s = s[:j] + 'CLANG_ENABLE_MODULES = YES;\n\t\t\t\tGCC_PREPROCESSOR_DEFINITIONS = ("DEBUG=1", "$(inherited)");\n\t\t\t\tSWIFT_ACTIVE_COMPILATION_CONDITIONS = DEBUG;' + s[j + len('CLANG_ENABLE_MODULES = YES;'):]
open(p, 'w').write(s)
EOF
gates 'M7 Release-only DEBUG=1 / SWIFT DEBUG condition'; restore

python3 - "$PBX" <<'EOF'
import sys; p = sys.argv[1]; s = open(p).read()
line = '\t\t\t\t9E6182F5C0175ABA960681B5 /* PrivacyInfo.xcprivacy in Resources */,\n'
assert s.count(line) == 1; open(p, 'w').write(s.replace(line, ''))
EOF
gates 'M8 PrivacyInfo removed from Resources build phase'; restore

sed -i 's/"name": "PickleSensei"/"name": "PickleSenseiApp"/' "$APPJSON";           gates 'info: M9 app.json name != AppDelegate withModuleName (P3)'; restore

python3 - "$PBX" <<'EOF'
import sys; p = sys.argv[1]; s = open(p).read()
# Secret-SHAPED placeholder assembled at runtime so the source never contains it
# (GitHub push protection would otherwise reject this harness).
fake = "sk_" + "live_" + "ADJUDICATEfakeSECRETvalue" + "0123456789"
s = s.replace('\t\t\t\tINFOPLIST_FILE = PickleSensei/Info.plist;\n', '\t\t\t\tINFOPLIST_FILE = PickleSensei/Info.plist;\n\t\t\t\tINFOPLIST_KEY_PickleSecret = "' + fake + '";\n', 1)
open(p, 'w').write(s)
EOF
gates 'info: M10 sk_live_ in pbxproj (jest suite; gitleaks catches)'; restore

python3 - "$PRIV" <<'EOF'
import sys; p = sys.argv[1]; s = open(p).read()
i = s.rfind('</dict>\n</plist>'); open(p, 'w').write(s[:i] + '\t<key>NSPrivacyTracking</key>\n\t<true/>\n' + s[i:])
EOF
gates 'info: M11 duplicate NSPrivacyTracking=true appended'; restore

python3 - "$PLIST" <<'EOF'
import re, sys; p = sys.argv[1]; s = open(p).read()
n = re.subn(r'(<key>NSAllowsLocalNetworking</key>\s*)<true/>', r'\1<false/>', s); assert n[1] == 1; open(p, 'w').write(n[0])
EOF
gates 'info: M12 NSAllowsLocalNetworking flipped to false'; restore

python3 - "$ENT" <<'EOF'
import re, sys; p = sys.argv[1]; s = open(p).read()
n = re.subn(r'(<key>com\.apple\.developer\.applesignin</key>\s*)<array>\s*<string>Default</string>\s*</array>', r'\1<array/>', s); assert n[1] == 1; open(p, 'w').write(n[0])
EOF
gates 'M13 applesignin entitlement emptied (control: caught)'; restore

python3 - "$PLIST" <<'EOF'
import re, sys; p = sys.argv[1]; s = open(p).read()
n = re.subn(r'\t<key>NSMicrophoneUsageDescription</key>\s*<string>[^<]*</string>\n', '', s); assert n[1] == 1; open(p, 'w').write(n[0])
EOF
gates 'M14 NSMicrophoneUsageDescription removed (control: caught)'; restore

if [ "$FALSE_GREEN" = 1 ]; then echo "RESULT: at least one mutation passed every Linux gate"; exit 1; fi
echo "RESULT: every mutation was caught by a Linux gate"
