#!/usr/bin/env bash
# Canonical Apple verification for Pickle Sensei — runs ON A MAC (the
# self-hosted Apple Silicon runner: labels self-hosted, macOS, ARM64), or from
# Linux with --remote, which dispatches the "Mac Full Verify" GitHub workflow
# on that runner and downloads its artifacts.
#
# Nothing Apple-specific is ever inferred from Linux. Everything below is real
# xcodebuild / swift / simctl execution and produces artifacts.
#
# Stages (each is a gate; the run fails if any stage fails):
#   environment  macOS / Xcode / Swift / SDK / simulator inventory; the actual
#                Xcode workspace, scheme and SwiftPM package layout are printed.
#   swift-native native/vision-core: `swift build`, `swift test` (XCTest,
#                xunit XML), `xcodebuild test` on macOS and on an iOS
#                Simulator (.xcresult each); native/swing-lab: release build
#                and a REAL Apple Vision pose extraction over a committed clip.
#   ios-app      apps/mobile/ios/PickleSensei.xcworkspace, scheme PickleSensei
#                (iOS-only app: SUPPORTED_PLATFORMS = iphoneos iphonesimulator):
#                npm ci, CocoaPods install, SwiftPM resolution, `xcodebuild
#                build` Release for the iOS Simulator (unsigned, embedded JS
#                bundle), then install + launch on a simulator and verify the
#                process stays alive.
#
# Artifacts land in $MAC_ARTIFACTS (default macos-ci-artifacts/): logs,
# *.xcresult, xunit XML, Info.plist, launch screenshots/logs, summary.json.
# Per-step helpers live in tools/macos-ci/ (simulator selection, CocoaPods,
# launch/crash check, xcresult and swing-lab summaries); this script is the
# only orchestrator, so the workflow YAML stays a thin wrapper.
#
# Usage (on the Mac):
#   scripts/mac-full-verify.sh                       # all stages
#   scripts/mac-full-verify.sh --only swift-native   # subset (comma list)
#   scripts/mac-full-verify.sh --skip-launch         # build the app, skip simulator launch
#   scripts/mac-full-verify.sh --skip-js             # skip tsc/jest on the Mac (Linux gate covers them)
#   scripts/mac-full-verify.sh --clean               # wipe DerivedData / SwiftPM caches first
# Usage (from Linux / a Devin Cloud session):
#   scripts/mac-full-verify.sh --remote [--ref <branch>] [--skip-launch] [--clean]
#     needs the GitHub CLI authenticated for RaunakGengiti2725/Pickle-Sensei.
#
# Never reads Keychain items, signing identities, or files outside the checkout
# and the per-machine build cache ($PICKLE_CI_CACHE).
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

WORKFLOW_FILE="mac-full-verify.yml"
ALL_STAGES=(environment swift-native ios-app)
ONLY=""
SKIP_LAUNCH=0
SKIP_JS=0
CLEAN=0
REMOTE=0
REF=""

usage() { sed -n '2,45p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

while [ $# -gt 0 ]; do
  case "$1" in
    --only) ONLY="$2"; shift 2 ;;
    --skip-launch) SKIP_LAUNCH=1; shift ;;
    --skip-js) SKIP_JS=1; shift ;;
    --clean) CLEAN=1; shift ;;
    --remote) REMOTE=1; shift ;;
    --ref) REF="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

# ------------------------------------------------------------- remote mode ----
if [ "$REMOTE" = 1 ]; then
  command -v gh >/dev/null || { echo "gh (GitHub CLI) is required for --remote" >&2; exit 2; }
  REF="${REF:-$(git rev-parse --abbrev-ref HEAD)}"
  ARGS=(-f "clean_build=$([ $CLEAN = 1 ] && echo true || echo false)"
        -f "launch_check=$([ $SKIP_LAUNCH = 1 ] && echo false || echo true)"
        -f "js_checks=$([ $SKIP_JS = 1 ] && echo false || echo true)")
  [ -n "$ONLY" ] && ARGS+=(-f "only=$ONLY")
  echo "dispatching $WORKFLOW_FILE on ref $REF (self-hosted M4 runner)…"
  gh workflow run "$WORKFLOW_FILE" --ref "$REF" "${ARGS[@]}" || exit 1
  sleep 8
  RUN_ID="$(gh run list --workflow "$WORKFLOW_FILE" --branch "$REF" --limit 1 --json databaseId --jq '.[0].databaseId')"
  [ -n "$RUN_ID" ] || { echo "could not find the dispatched run" >&2; exit 1; }
  echo "run: $(gh run view "$RUN_ID" --json url --jq .url)"
  gh run watch "$RUN_ID" --exit-status
  RC=$?
  OUT="${MAC_ARTIFACTS:-artifacts/mac-full-verify/$RUN_ID}"
  mkdir -p "$OUT"
  gh run download "$RUN_ID" --dir "$OUT" && echo "artifacts downloaded to $OUT"
  exit $RC
fi

# -------------------------------------------------------------- local mode ----
[ "$(uname -s)" = "Darwin" ] || { echo "this script runs on macOS; from Linux use --remote" >&2; exit 2; }

if [ -n "$ONLY" ]; then IFS=',' read -r -a STAGES <<<"$ONLY"; else STAGES=("${ALL_STAGES[@]}"); fi

export LANG="${LANG:-en_US.UTF-8}" LC_ALL="${LC_ALL:-en_US.UTF-8}"
export DEVELOPER_DIR="${DEVELOPER_DIR:-$(xcode-select -p)}"
export HOMEBREW_NO_AUTO_UPDATE=1 CI="${CI:-true}" COCOAPODS_DISABLE_STATS=1
# Persistent per-machine build cache OUTSIDE the checkout (survives clean checkouts).
export PICKLE_CI_CACHE="${PICKLE_CI_CACHE:-$HOME/Library/Caches/PickleSensei-CI}"
ARTIFACTS="${MAC_ARTIFACTS:-macos-ci-artifacts}"
mkdir -p "$ARTIFACTS" "$PICKLE_CI_CACHE"
ARTIFACTS="$(cd "$ARTIFACTS" && pwd)"
HELPERS="$REPO_ROOT/tools/macos-ci"
for h in select-simulator.sh inspect-environment.sh simulator-launch-check.sh pod-install.sh \
         xcresult-summary.py check-swing-lab-extract.py describe-package.py; do
  [ -f "$HELPERS/$h" ] || { echo "missing helper tools/macos-ci/$h" >&2; exit 2; }
done
chmod +x "$HELPERS"/*.sh "$HELPERS"/*.py

WORKSPACE="apps/mobile/ios/PickleSensei.xcworkspace"
SCHEME="PickleSensei"
CONFIGURATION="Release"
BUNDLE_ID="com.picklesensei"
CLIP="datasets/pickleball/fresh-candidates/va-O1dLhGGPErc.mp4"
GIT_SHA="$(git rev-parse HEAD 2>/dev/null || echo unknown)"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"

declare -a RESULT_NAMES=() RESULT_STATUS=() RESULT_SECONDS=() RESULT_NOTES=()
FAILED=0
record() { RESULT_NAMES+=("$1"); RESULT_STATUS+=("$2"); RESULT_SECONDS+=("$3"); RESULT_NOTES+=("$4"); }

run_stage() {
  local name="$1" fn="$2" log="$ARTIFACTS/$1.log" start end rc
  echo "==> [$name] start $(date -u +%H:%M:%S)"
  start=$(date +%s)
  ( set -e; "$fn" ) 2>&1 | tee "$log"
  rc=${PIPESTATUS[0]}
  end=$(date +%s)
  if [ "$rc" -eq 0 ]; then
    echo "    [$name] PASS in $((end - start))s"; record "$name" passed $((end - start)) ""
  else
    echo "    [$name] FAIL (exit $rc) in $((end - start))s"; record "$name" failed $((end - start)) "exit $rc"; FAILED=1
  fi
}

# ---------------------------------------------------------------- stages ----
stage_environment() {
  "$HELPERS/inspect-environment.sh" "$ARTIFACTS/environment.txt"
  {
    echo "=== Xcode configuration of Pickle Sensei ==="
    echo "workspace: $WORKSPACE  scheme: $SCHEME  configuration: $CONFIGURATION  bundle: $BUNDLE_ID"
    xcodebuild -list -project apps/mobile/ios/PickleSensei.xcodeproj
    grep -E 'SUPPORTED_PLATFORMS|IPHONEOS_DEPLOYMENT_TARGET|CODE_SIGN_STYLE' apps/mobile/ios/PickleSensei.xcodeproj/project.pbxproj | sort -u
    echo "--- native/vision-core (SwiftPM) ---"; (cd native/vision-core && swift package describe --type json | "$HELPERS/describe-package.py")
    echo "--- native/swing-lab (SwiftPM executable, macOS) ---"; (cd native/swing-lab && swift package describe --type json | "$HELPERS/describe-package.py")
  } | tee -a "$ARTIFACTS/environment.txt"
}

stage_swift_native() {
  if [ "$CLEAN" = 1 ]; then rm -rf "$PICKLE_CI_CACHE/swiftpm-derived" native/vision-core/.build native/swing-lab/.build; fi

  (cd native/vision-core && swift build 2>&1 | tee "$ARTIFACTS/vision-core-swift-build.log" | tail -20)
  (cd native/vision-core && swift test --parallel --xunit-output "$ARTIFACTS/vision-core-xunit.xml" 2>&1 \
     | tee "$ARTIFACTS/vision-core-swift-test.log" | tail -40)

  local list scheme udid result
  list="$(cd native/vision-core && xcodebuild -list 2>&1)"; echo "$list" >"$ARTIFACTS/vision-core-xcodebuild-list.txt"
  scheme="PickleVisionCore-Package"; echo "$list" | grep -q "$scheme" || scheme="PickleVisionCore"
  echo "vision-core xcodebuild scheme: $scheme"

  result="$ARTIFACTS/vision-core-macos.xcresult"; rm -rf "$result"
  (cd native/vision-core && xcodebuild test -scheme "$scheme" -destination 'platform=macOS,arch=arm64' \
     -derivedDataPath "$PICKLE_CI_CACHE/swiftpm-derived" -resultBundlePath "$result" CODE_SIGNING_ALLOWED=NO 2>&1 \
     | tee "$ARTIFACTS/vision-core-xcodebuild-macos.log" | { grep -E 'Test Suite|Executed|error:|\*\* TEST' || true; } | tail -30)

  udid="$("$HELPERS/select-simulator.sh" --boot)"
  result="$ARTIFACTS/vision-core-ios-simulator.xcresult"; rm -rf "$result"
  (cd native/vision-core && xcodebuild test -scheme "$scheme" -destination "platform=iOS Simulator,id=$udid" \
     -derivedDataPath "$PICKLE_CI_CACHE/swiftpm-derived" -resultBundlePath "$result" CODE_SIGNING_ALLOWED=NO 2>&1 \
     | tee "$ARTIFACTS/vision-core-xcodebuild-ios.log" | { grep -E 'Test Suite|Executed|error:|\*\* TEST' || true; } | tail -30)

  (cd native/swing-lab && swift build -c release 2>&1 | tee "$ARTIFACTS/swing-lab-swift-build.log" | tail -10)
  local bin out
  bin="$(cd native/swing-lab && swift build -c release --show-bin-path)/swing-lab"
  file "$bin"
  out="$ARTIFACTS/swing-lab-extract"; rm -rf "$out"
  [ -f "$CLIP" ] || { echo "committed clip missing: $CLIP"; return 1; }
  "$bin" extract "$CLIP" --out "$out" 2>&1 | tee "$ARTIFACTS/swing-lab-extract.log" | tail -20
  [ -f "$out/extract-meta.json" ] || { echo "swing-lab extract produced no extract-meta.json"; return 1; }
  cat "$out/extract-meta.json"; echo
  "$HELPERS/check-swing-lab-extract.py" "$out" | tee "$ARTIFACTS/swing-lab-extract-summary.txt"
  "$HELPERS/xcresult-summary.py" "$ARTIFACTS"/*.xcresult | tee "$ARTIFACTS/swift-native-xcresult-summary.txt"
}

stage_ios_app() {
  if [ "$CLEAN" = 1 ]; then rm -rf "$PICKLE_CI_CACHE/app-derived"; fi
  command -v node >/dev/null || { echo "node is required (apps/mobile engines >= 22.11)"; return 1; }
  node --version; npm --version
  (cd apps/mobile && npm ci --no-audit --no-fund)
  if [ "$SKIP_JS" = 0 ]; then
    (cd apps/mobile && npx tsc --noEmit && npx jest --ci --silent 2>&1 | tee "$ARTIFACTS/jest.log" | tail -15)
  fi

  "$HELPERS/pod-install.sh" 2>&1 | tee "$ARTIFACTS/pod-install.log" | tail -20

  # The RN "Bundle React Native code and images" phase resolves node via ios/.xcode.env(.local).
  echo "export NODE_BINARY=$(command -v node)" >apps/mobile/ios/.xcode.env.local

  xcodebuild -list -workspace "$WORKSPACE" 2>&1 | tee "$ARTIFACTS/xcodebuild-list.txt" | head -40
  xcodebuild -resolvePackageDependencies -workspace "$WORKSPACE" -scheme "$SCHEME" \
    -derivedDataPath "$PICKLE_CI_CACHE/app-derived" 2>&1 | tee "$ARTIFACTS/xcodebuild-resolve.log" | tail -10

  local result app
  result="$ARTIFACTS/PickleSensei-build.xcresult"; rm -rf "$result"
  xcodebuild build -workspace "$WORKSPACE" -scheme "$SCHEME" -configuration "$CONFIGURATION" \
    -destination 'generic/platform=iOS Simulator' -derivedDataPath "$PICKLE_CI_CACHE/app-derived" \
    -resultBundlePath "$result" ARCHS=arm64 CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO \
    CODE_SIGN_IDENTITY="" COMPILER_INDEX_STORE_ENABLE=NO 2>&1 \
    | tee "$ARTIFACTS/xcodebuild-build.log" \
    | { grep -E '^(\*\* BUILD|=== |error:|.*: error:|PhaseScriptExecution|The following build commands failed)' || true; } | tail -60
  rm -f apps/mobile/ios/.xcode.env.local
  app="$PICKLE_CI_CACHE/app-derived/Build/Products/$CONFIGURATION-iphonesimulator/PickleSensei.app"
  [ -d "$app" ] || { echo "no app bundle at $app — see $ARTIFACTS/xcodebuild-build.log"; return 1; }
  [ -f "$app/main.jsbundle" ] || { echo "main.jsbundle missing — the React Native bundle phase did not run"; return 1; }
  cp "$app/Info.plist" "$ARTIFACTS/PickleSensei-Info.plist"
  du -sh "$app" | tee "$ARTIFACTS/app-size.txt"
  /usr/libexec/PlistBuddy -c 'Print' "$app/Info.plist" | { grep -E 'CFBundleIdentifier|CFBundleShortVersionString|CFBundleVersion|MinimumOSVersion|DTSDKName' || true; }

  if [ "$SKIP_LAUNCH" = 1 ]; then echo "launch check skipped (--skip-launch)"; return 0; fi
  "$HELPERS/simulator-launch-check.sh" "$app" "$BUNDLE_ID" "$ARTIFACTS/launch" 25
}

# -------------------------------------------------------------------- main ----
echo "Pickle Sensei — mac-full-verify @ $GIT_SHA on $(hostname -s 2>/dev/null) ($(uname -m))"
echo "stages: ${STAGES[*]}   artifacts: $ARTIFACTS   cache: $PICKLE_CI_CACHE"
for s in "${STAGES[@]}"; do
  fn="stage_${s//-/_}"
  declare -F "$fn" >/dev/null || { echo "unknown stage: $s" >&2; exit 2; }
  run_stage "$s" "$fn"
done

{
  echo "{"
  echo "  \"tool\": \"mac-full-verify\","
  echo "  \"git_sha\": \"$GIT_SHA\","
  echo "  \"started_utc\": \"$STAMP\","
  echo "  \"host\": \"$(sw_vers -productVersion 2>/dev/null) $(uname -m)\","
  echo "  \"xcode\": \"$(xcodebuild -version 2>/dev/null | tr '\n' ' ' | sed 's/ *$//')\","
  echo "  \"ok\": $([ $FAILED -eq 0 ] && echo true || echo false),"
  echo "  \"stages\": ["
  for i in "${!RESULT_NAMES[@]}"; do
    sep=","; [ "$i" -eq $((${#RESULT_NAMES[@]} - 1)) ] && sep=""
    echo "    {\"name\": \"${RESULT_NAMES[$i]}\", \"status\": \"${RESULT_STATUS[$i]}\", \"seconds\": ${RESULT_SECONDS[$i]}, \"note\": \"${RESULT_NOTES[$i]}\", \"log\": \"${RESULT_NAMES[$i]}.log\"}$sep"
  done
  echo "  ]"
  echo "}"
} >"$ARTIFACTS/summary.json"

echo
printf '%-13s %-8s %6s  %s\n' STAGE STATUS SECS NOTE
for i in "${!RESULT_NAMES[@]}"; do
  printf '%-13s %-8s %6s  %s\n' "${RESULT_NAMES[$i]}" "${RESULT_STATUS[$i]}" "${RESULT_SECONDS[$i]}" "${RESULT_NOTES[$i]}"
done
echo "summary: $ARTIFACTS/summary.json"
[ $FAILED -eq 0 ] && { echo "mac-full-verify: OK"; exit 0; }
echo "mac-full-verify: FAILED"; exit 1
