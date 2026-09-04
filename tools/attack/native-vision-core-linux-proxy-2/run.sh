#!/usr/bin/env bash
# Linux REPLAY PROXY for the pure-Swift logic of native/vision-core.
#
# What it is: assembles a throwaway SwiftPM package from the repo's
# native/vision-core Sources + Tests, minus the Apple-only files
# (ApplePoseProvider.swift needs Vision; ApplePoseProviderSeedTests.swift needs
# VNHumanBodyPoseObservation), with `import CoreVideo` in the contracts file
# replaced by a one-line CVPixelBuffer stub, and runs `swift build` +
# `swift test` with a swift.org Linux toolchain.
#
# What it proves: behaviour of PoseReadinessEvaluator, TemporalStrokeDetector,
# CaptureEvidenceAccumulator, PoseMotionTrailBuffer, SessionMotionStream and
# CaptureQualitySignals — Foundation-only Swift whose semantics (Dictionary
# traps, IEEE-754 NaN/inf comparisons, Int arithmetic) are identical across
# swift-corelibs-foundation and Apple platforms.
#
# What it does NOT prove: anything about Apple Vision, iOS/macOS runtime,
# XCTest-on-Xcode, or the simulator. Apple truth comes only from the M4 runner
# (scripts/mac-full-verify.sh). Never cite this proxy as Apple evidence.
#
# Usage:
#   tools/attack/native-vision-core-linux-proxy-2/run.sh [--out DIR] [--filter REGEX] [--swift PATH] [--release] [--skip REGEX] [--exclude-test FILE.swift]...
#
# --release builds/tests with -c release (closer to the shipped optimisation
# level for the timing probes). Besides native/vision-core/Tests, the package
# also gets the harness-only suites in ./tests (the EXPECTED-RED gap suite and
# the process-killing trap suite) — those deliberately do NOT live in the
# package's test target so the Mac gate stays green; --skip passes
# `swift test --skip` to leave them out of a run. Adapted from pass 1's proxy
# (origin/devin/attack-native-vision-core-1).
# Exit code: that of `swift test` (0 = all selected tests passed; a trap in a
# test body kills the xctest process → non-zero, typically 132/133/134/139).
set -u
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
OUT="${OUT:-/tmp/vision-core-linux-proxy-2}"
FILTER=""
SKIP=""
CONFIG="debug"
EXCLUDE_TESTS=""
SWIFT_BIN="${SWIFT_BIN:-$(command -v swift || true)}"
while [ $# -gt 0 ]; do
  case "$1" in
    --out) OUT="$2"; shift 2 ;;
    --filter) FILTER="$2"; shift 2 ;;
    --skip) SKIP="$2"; shift 2 ;;
    --release) CONFIG="release"; shift ;;
    --swift) SWIFT_BIN="$2"; shift 2 ;;
    --exclude-test) EXCLUDE_TESTS="$EXCLUDE_TESTS $2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done
if [ -z "$SWIFT_BIN" ] || [ ! -x "$SWIFT_BIN" ]; then
  echo "swift toolchain not found (set --swift or SWIFT_BIN); install from https://www.swift.org/install/linux/" >&2
  exit 2
fi

SRC="$REPO/native/vision-core/Sources"
TST="$REPO/native/vision-core/Tests"
PKG="$OUT/pkg"
LOGS="$OUT/logs"
rm -rf "$PKG"
mkdir -p "$PKG/Sources" "$PKG/Tests" "$LOGS"

for f in "$SRC"/*.swift; do
  base="$(basename "$f")"
  case "$base" in
    ApplePoseProvider.swift) continue ;;
    VisionCoreContracts.swift)
      # Foundation on Linux ships CGPoint/CGRect; only CVPixelBuffer needs a stub.
      sed 's/^import CoreVideo$/#if canImport(CoreVideo)\nimport CoreVideo\n#else\npublic final class CVPixelBuffer {}\n#endif/' "$f" >"$PKG/Sources/$base"
      ;;
    *) cp "$f" "$PKG/Sources/$base" ;;
  esac
done
for f in "$TST"/*.swift; do
  base="$(basename "$f")"
  case "$base" in
    ApplePoseProviderSeedTests.swift) continue ;;
  esac
  case " $EXCLUDE_TESTS " in
    *" $base "*) continue ;;
  esac
  cp "$f" "$PKG/Tests/$base"
done
for f in "$REPO/tools/attack/native-vision-core-linux-proxy-2/tests"/*.swift; do
  base="$(basename "$f")"
  case " $EXCLUDE_TESTS " in
    *" $base "*) continue ;;
  esac
  cp "$f" "$PKG/Tests/$base"
done
cat >"$PKG/Package.swift" <<'EOF'
// swift-tools-version: 5.9
import PackageDescription

let package = Package(
  name: "PickleVisionCore",
  products: [
    .library(name: "PickleVisionCore", targets: ["PickleVisionCore"]),
  ],
  targets: [
    .target(name: "PickleVisionCore", path: "Sources"),
    .testTarget(
      name: "PickleVisionCoreTests",
      dependencies: ["PickleVisionCore"],
      path: "Tests"
    ),
  ]
)
EOF

{
  echo "repo_sha=$(git -C "$REPO" rev-parse HEAD)"
  echo "repo_dirty=$(git -C "$REPO" status --porcelain -- native/vision-core | wc -l | tr -d ' ')"
  echo "swift=$("$SWIFT_BIN" --version 2>&1 | head -1)"
  echo "host=$(uname -srm)"
  echo "sources=$(ls "$PKG/Sources" | tr '\n' ' ')"
  echo "tests=$(ls "$PKG/Tests" | tr '\n' ' ')"
  echo "filter=${FILTER:-<all>}"
  echo "skip=${SKIP:-<none>}"
  echo "configuration=$CONFIG"
} | tee "$LOGS/provenance.txt"

EXTRA=()
[ "$CONFIG" = release ] && EXTRA=(-Xswiftc -enable-testing)
"$SWIFT_BIN" build -c "$CONFIG" "${EXTRA[@]}" --build-tests --package-path "$PKG" >"$LOGS/swift-build.log" 2>&1
build_rc=$?
tail -5 "$LOGS/swift-build.log"
echo "swift build exit=$build_rc" | tee -a "$LOGS/provenance.txt"
[ "$build_rc" -eq 0 ] || exit "$build_rc"

TEST_ARGS=(test -c "$CONFIG" "${EXTRA[@]}" --package-path "$PKG" --xunit-output "$LOGS/xunit.xml")
[ -n "$FILTER" ] && TEST_ARGS+=(--filter "$FILTER")
[ -n "$SKIP" ] && TEST_ARGS+=(--skip "$SKIP")
"$SWIFT_BIN" "${TEST_ARGS[@]}" >"$LOGS/swift-test.log" 2>&1
test_rc=$?
grep -E "error:|failed|Executed|passed at" "$LOGS/swift-test.log" | grep -v "Test Case .* passed" | tail -60
echo "swift test exit=$test_rc" | tee -a "$LOGS/provenance.txt"
exit "$test_rc"
