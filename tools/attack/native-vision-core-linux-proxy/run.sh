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
#   tools/attack/native-vision-core-linux-proxy/run.sh [--out DIR] [--filter REGEX] [--swift PATH] [--exclude-test FILE.swift]...
# Exit code: that of `swift test` (0 = all selected tests passed; a trap in a
# test body kills the xctest process → non-zero, typically 132/133/134/139).
set -u
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
OUT="${OUT:-/tmp/vision-core-linux-proxy}"
FILTER=""
EXCLUDE_TESTS=""
SWIFT_BIN="${SWIFT_BIN:-$(command -v swift || true)}"
while [ $# -gt 0 ]; do
  case "$1" in
    --out) OUT="$2"; shift 2 ;;
    --filter) FILTER="$2"; shift 2 ;;
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
} | tee "$LOGS/provenance.txt"

"$SWIFT_BIN" build --package-path "$PKG" >"$LOGS/swift-build.log" 2>&1
build_rc=$?
tail -5 "$LOGS/swift-build.log"
echo "swift build exit=$build_rc" | tee -a "$LOGS/provenance.txt"
[ "$build_rc" -eq 0 ] || exit "$build_rc"

if [ -n "$FILTER" ]; then
  "$SWIFT_BIN" test --package-path "$PKG" --filter "$FILTER" --xunit-output "$LOGS/xunit.xml" >"$LOGS/swift-test.log" 2>&1
else
  "$SWIFT_BIN" test --package-path "$PKG" --xunit-output "$LOGS/xunit.xml" >"$LOGS/swift-test.log" 2>&1
fi
test_rc=$?
grep -E "error:|failed|Executed|passed at" "$LOGS/swift-test.log" | grep -v "Test Case .* passed" | tail -60
echo "swift test exit=$test_rc" | tee -a "$LOGS/provenance.txt"
exit "$test_rc"
