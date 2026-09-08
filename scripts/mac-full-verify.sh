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
#   swift-native native/vision-core and native/managed-media: `swift build`, `swift test` (XCTest,
#                xunit XML), `xcodebuild test` on macOS and on an iOS
#                Simulator (.xcresult each); native/swing-lab: release build
#                and a REAL Apple Vision pose extraction over a committed clip.
#   ios-app      apps/mobile/ios/PickleSensei.xcworkspace, scheme PickleSensei
#                (iOS-only app: SUPPORTED_PLATFORMS = iphoneos iphonesimulator):
#                npm ci, CocoaPods install, SwiftPM resolution, `xcodebuild
#                build` Release for the iOS Simulator (ad-hoc, embedded JS
#                bundle), then install + launch on a simulator and verify the
#                process stays alive.
#
# Artifacts land in $MAC_ARTIFACTS (default macos-ci-artifacts/): logs,
# *.xcresult, xunit XML, Info.plist, launch screenshots/logs, summary.json.
# PICKLE_NATIVE_JOBS bounds compiler/test workers (default 2); SwiftPM scratch
# and Xcode DerivedData both live under PICKLE_CI_CACHE.
# VERIFY_MOBILE_NODE_BIN optionally selects mobile Node for ios-app only;
# workspace/environment stages retain the caller's runtime.
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
#   scripts/mac-full-verify.sh --remote [--ref <branch>]
#     pushes HEAD to the trigger branch ci/mac-<branch>, waits for the "Mac Full
#     Verify" run and downloads its artifacts to artifacts/mac-full-verify/<run>.
#     Needs the GitHub CLI authenticated for RaunakGengiti2725/Pickle-Sensei.
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

usage() { sed -n '2,43p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

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
# Devin's GitHub App token cannot create workflow_dispatch events (HTTP 403),
# so the on-demand path is a PUSH: the commit under test is pushed to a
# `ci/mac-<slug>` trigger branch, which the workflow always runs for. The
# trigger branch is a throwaway vehicle (never merged, force-updated freely).
if [ "$REMOTE" = 1 ]; then
  command -v gh >/dev/null || { echo "gh (GitHub CLI) is required for --remote" >&2; exit 2; }
  if [ -n "$ONLY" ] || [ "$SKIP_LAUNCH" = 1 ] || [ "$SKIP_JS" = 1 ] || [ "$CLEAN" = 1 ]; then
    echo "--remote always runs the full default set (all stages, launch check on, JS checks off);" >&2
    echo "--only/--skip-launch/--skip-js/--clean are for local runs or the Actions UI." >&2
    exit 2
  fi
  if ! git diff --quiet HEAD -- . ':!artifacts' 2>/dev/null; then
    echo "working tree has uncommitted changes — the Mac builds a pushed commit; commit first" >&2
    exit 2
  fi
  SHA="$(git rev-parse HEAD)"
  SRC="${REF:-$(git rev-parse --abbrev-ref HEAD)}"
  case "$SRC" in
    ci/mac-*) TRIGGER="$SRC" ;;
    *) TRIGGER="ci/mac-$(printf '%s' "$SRC" | tr -c 'A-Za-z0-9._-' '-' | cut -c1-60)" ;;
  esac
  echo "pushing $SHA to trigger branch $TRIGGER (self-hosted M4 runner)…"
  git push -q --force-with-lease origin "HEAD:refs/heads/$TRIGGER" || exit 1
  RUN_ID=""
  for _ in $(seq 1 24); do
    sleep 5
    RUN_ID="$(gh run list --workflow "$WORKFLOW_FILE" --branch "$TRIGGER" --limit 5 \
      --json databaseId,headSha --jq ".[] | select(.headSha==\"$SHA\") | .databaseId" | head -1)"
    [ -n "$RUN_ID" ] && break
  done
  [ -n "$RUN_ID" ] || { echo "no $WORKFLOW_FILE run appeared for $SHA on $TRIGGER within 2 minutes" >&2; exit 1; }
  echo "run: $(gh run view "$RUN_ID" --json url --jq .url)"
  gh run watch "$RUN_ID" --exit-status --interval 30
  RC=$?
  OUT="${MAC_ARTIFACTS:-artifacts/mac-full-verify/$RUN_ID}"
  mkdir -p "$OUT"
  gh run download "$RUN_ID" --dir "$OUT" && echo "artifacts downloaded to $OUT"
  gh run view "$RUN_ID" --json databaseId,status,conclusion,url,headSha >"$OUT/run.json"
  exit $RC
fi

# -------------------------------------------------------------- local mode ----
[ "$(uname -s)" = "Darwin" ] || { echo "this script runs on macOS; from Linux use --remote" >&2; exit 2; }

NATIVE_JOBS="${PICKLE_NATIVE_JOBS:-2}"
case "$NATIVE_JOBS" in
  ''|*[!0-9]*|0*) echo "PICKLE_NATIVE_JOBS must be a positive integer" >&2; exit 2 ;;
esac

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
    echo "--- native/managed-media (SwiftPM) ---"; (cd native/managed-media && swift package describe --type json | "$HELPERS/describe-package.py")
    echo "--- native/swing-lab (SwiftPM executable, macOS) ---"; (cd native/swing-lab && swift package describe --type json | "$HELPERS/describe-package.py")
  } | tee -a "$ARTIFACTS/environment.txt"
}

verify_swift_package() {
  local name="$1" package="$2" fallback_scheme="$3" list scheme udid result
  local scratch="$PICKLE_CI_CACHE/$name-swiftpm" derived="$PICKLE_CI_CACHE/$name-derived"
  (cd "$package" && swift build --scratch-path "$scratch" --jobs "$NATIVE_JOBS" 2>&1 \
     | tee "$ARTIFACTS/$name-swift-build.log" | tail -20)
  (cd "$package" && swift test --scratch-path "$scratch" --jobs "$NATIVE_JOBS" \
     --parallel --num-workers "$NATIVE_JOBS" --xunit-output "$ARTIFACTS/$name-xunit.xml" 2>&1 \
     | tee "$ARTIFACTS/$name-swift-test.log" | tail -40)

  list="$(cd "$package" && xcodebuild -list 2>&1)"; echo "$list" >"$ARTIFACTS/$name-xcodebuild-list.txt"
  scheme="$fallback_scheme-Package"; echo "$list" | grep -q "$scheme" || scheme="$fallback_scheme"
  echo "$name xcodebuild scheme: $scheme"

  result="$ARTIFACTS/$name-macos.xcresult"; rm -rf "$result"
  (cd "$package" && xcodebuild test -scheme "$scheme" -destination 'platform=macOS,arch=arm64' \
     -jobs "$NATIVE_JOBS" -parallel-testing-enabled NO \
     -derivedDataPath "$derived" -resultBundlePath "$result" CODE_SIGNING_ALLOWED=NO 2>&1 \
     | tee "$ARTIFACTS/$name-xcodebuild-macos.log" | { grep -E 'Test Suite|Executed|error:|\*\* TEST' || true; } | tail -30)

  udid="$("$HELPERS/select-simulator.sh" --boot)"
  result="$ARTIFACTS/$name-ios-simulator.xcresult"; rm -rf "$result"
  (cd "$package" && xcodebuild test -scheme "$scheme" -destination "platform=iOS Simulator,id=$udid" \
     -jobs "$NATIVE_JOBS" -parallel-testing-enabled NO \
     -derivedDataPath "$derived" -resultBundlePath "$result" CODE_SIGNING_ALLOWED=NO 2>&1 \
     | tee "$ARTIFACTS/$name-xcodebuild-ios.log" | { grep -E 'Test Suite|Executed|error:|\*\* TEST' || true; } | tail -30)
}

stage_swift_native() {
  if [ "$CLEAN" = 1 ]; then
    rm -rf "$PICKLE_CI_CACHE/vision-core-swiftpm" "$PICKLE_CI_CACHE/vision-core-derived" \
      "$PICKLE_CI_CACHE/managed-media-swiftpm" "$PICKLE_CI_CACHE/managed-media-derived" \
      "$PICKLE_CI_CACHE/swing-lab-swiftpm"
  fi
  verify_swift_package vision-core native/vision-core PickleVisionCore
  verify_swift_package managed-media native/managed-media PickleManagedMedia

  (cd native/swing-lab && swift build -c release --scratch-path "$PICKLE_CI_CACHE/swing-lab-swiftpm" \
     --jobs "$NATIVE_JOBS" 2>&1 | tee "$ARTIFACTS/swing-lab-swift-build.log" | tail -10)
  local bin out
  bin="$(cd native/swing-lab && swift build -c release --scratch-path "$PICKLE_CI_CACHE/swing-lab-swiftpm" \
    --jobs "$NATIVE_JOBS" --show-bin-path)/swing-lab"
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
  # run_stage executes this function in its own subshell, so verify-all can
  # keep Node20 for workspace gates while npm, Pods and the bundle use Node22.
  if [ -n "${VERIFY_MOBILE_NODE_BIN:-}" ]; then
    if [ ! -x "$VERIFY_MOBILE_NODE_BIN/node" ]; then
      echo "VERIFY_MOBILE_NODE_BIN must contain an executable node: $VERIFY_MOBILE_NODE_BIN" >&2
      return 75
    fi
    export PATH="$VERIFY_MOBILE_NODE_BIN:$PATH"
  fi
  if [ "$CLEAN" = 1 ]; then rm -rf "$PICKLE_CI_CACHE/app-derived"; fi
  command -v node >/dev/null || { echo "node is required (apps/mobile engines >= 22.11)"; return 1; }
  echo "mobile runtime: $(node --version) at $(command -v node)"
  npm --version
  (cd apps/mobile && npm ci --no-audit --no-fund)
  if [ "$SKIP_JS" = 0 ]; then
    (cd apps/mobile && npx tsc --noEmit && npx jest --ci --silent --maxWorkers="$NATIVE_JOBS" 2>&1 | tee "$ARTIFACTS/jest.log" | tail -15)
  fi

  "$HELPERS/pod-install.sh" 2>&1 | tee "$ARTIFACTS/pod-install.log" | tail -20

  # The RN bundle phase resolves node via ios/.xcode.env(.local). Preserve an
  # existing local configuration, including when Xcode exits unsuccessfully.
  local node_env="apps/mobile/ios/.xcode.env.local" node_env_backup had_node_env=0
  [ ! -L "$node_env" ] || { echo "refusing to replace a symlinked .xcode.env.local" >&2; return 1; }
  node_env_backup="$(mktemp "$PICKLE_CI_CACHE/xcode-env.XXXXXX")"
  if [ -f "$node_env" ]; then had_node_env=1; cp -p "$node_env" "$node_env_backup"; fi
  restore_xcode_node_environment() {
    if [ "$had_node_env" = 1 ]; then cp -p "$node_env_backup" "$node_env"; else rm -f "$node_env"; fi
    rm -f "$node_env_backup"
  }
  trap restore_xcode_node_environment EXIT
  printf 'export NODE_BINARY=%q\n' "$(command -v node)" >"$node_env"

  xcodebuild -list -workspace "$WORKSPACE" 2>&1 | tee "$ARTIFACTS/xcodebuild-list.txt" | head -40
  xcodebuild -resolvePackageDependencies -jobs "$NATIVE_JOBS" -workspace "$WORKSPACE" -scheme "$SCHEME" \
    -derivedDataPath "$PICKLE_CI_CACHE/app-derived" 2>&1 | tee "$ARTIFACTS/xcodebuild-resolve.log" | tail -10

  local result app
  result="$ARTIFACTS/PickleSensei-build.xcresult"; rm -rf "$result"
  # Xcode places simulated entitlements in the binary for Keychain access.
  # The explicit '-' identity signs locally without a certificate or profile;
  # this command is fixed to iOS Simulator and never archives for distribution.
  xcodebuild build -jobs "$NATIVE_JOBS" -workspace "$WORKSPACE" -scheme "$SCHEME" -configuration "$CONFIGURATION" \
    -destination 'generic/platform=iOS Simulator' -derivedDataPath "$PICKLE_CI_CACHE/app-derived" \
    -resultBundlePath "$result" ARCHS=arm64 CODE_SIGNING_ALLOWED=YES CODE_SIGNING_REQUIRED=NO \
    CODE_SIGN_IDENTITY=- COMPILER_INDEX_STORE_ENABLE=NO 2>&1 \
    | tee "$ARTIFACTS/xcodebuild-build.log" \
    | { grep -E '^(\*\* BUILD|=== |error:|.*: error:|PhaseScriptExecution|The following build commands failed)' || true; } | tail -60
  restore_xcode_node_environment
  trap - EXIT
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
echo "stages: ${STAGES[*]}   native jobs: $NATIVE_JOBS   artifacts: $ARTIFACTS   cache: $PICKLE_CI_CACHE"
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
