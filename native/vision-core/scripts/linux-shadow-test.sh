#!/usr/bin/env bash
# Linux-plane shadow build of PickleVisionCore for the pure-Swift subset.
#
# `swift build` of the real package is impossible on Linux: ApplePoseProvider
# imports Vision and the contracts import CoreVideo. This script assembles a
# SHADOW package under a scratch directory that
#   * symlinks every Source except ApplePoseProvider.swift,
#   * replaces `import CoreVideo` with a one-line CVPixelBuffer stand-in so the
#     protocol signatures still type-check,
#   * symlinks every Test except ApplePoseProviderSeedTests.swift (needs Vision),
# and runs `swift test` on it with a Linux toolchain.
#
# Evidence produced here is LINUX-PLANE evidence about the pure-Swift logic
# (TemporalStrokeDetector, PoseReadinessEvaluator, CaptureEvidenceAccumulator,
# PoseMotionTrailBuffer, SessionMotionStream). It says NOTHING about Apple
# Vision, iOS or the Xcode build — those are only proven by
# scripts/mac-full-verify.sh on the M4 runner.
#
# Usage:
#   native/vision-core/scripts/linux-shadow-test.sh [extra swift test args]
# Env:
#   SHADOW_DIR      scratch location (default: $HOME/.cache/pickle-vision-shadow)
#   STRESS_ITER     iterations per stress campaign (default set in the tests)
#   STRESS_SEED     base seed for the campaigns
#   STRESS_RESULTS  path of the JSON seed→outcome table the stress tests write
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG="$(cd "$HERE/.." && pwd)"
SHADOW_DIR="${SHADOW_DIR:-$HOME/.cache/pickle-vision-shadow}"

rm -rf "$SHADOW_DIR/Sources" "$SHADOW_DIR/Tests"
mkdir -p "$SHADOW_DIR/Sources" "$SHADOW_DIR/Tests"

for f in "$PKG"/Sources/*.swift; do
  base="$(basename "$f")"
  case "$base" in
    ApplePoseProvider.swift) continue ;;
    VisionCoreContracts.swift)
      sed 's/^import CoreVideo$/\/\/ CoreVideo unavailable on Linux (shadow build)/' "$f" \
        > "$SHADOW_DIR/Sources/$base"
      ;;
    *) ln -sf "$f" "$SHADOW_DIR/Sources/$base" ;;
  esac
done
cat > "$SHADOW_DIR/Sources/LinuxCoreVideoShim.swift" <<'EOF'
// Shadow-build stand-in for CoreVideo's CVPixelBuffer so the PoseProviding /
// PaddleDetecting protocol signatures compile on Linux. Never shipped.
public final class CVPixelBuffer {}
EOF

for f in "$PKG"/Tests/*.swift; do
  base="$(basename "$f")"
  case "$base" in
    ApplePoseProviderSeedTests.swift) continue ;;
    *) ln -sf "$f" "$SHADOW_DIR/Tests/$base" ;;
  esac
done

cat > "$SHADOW_DIR/Package.swift" <<'EOF'
// swift-tools-version: 5.9
import PackageDescription

let package = Package(
  name: "PickleVisionCoreShadow",
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

cd "$SHADOW_DIR"
echo "shadow package: $SHADOW_DIR"
swift test "$@"
