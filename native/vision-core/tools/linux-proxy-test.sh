#!/usr/bin/env bash
# Linux PROXY run of the pure-Foundation part of native/vision-core.
#
# This is NOT Apple truth (see docs/devin/OPERATING_SYSTEM.md): Apple Vision,
# CoreVideo and the ApplePoseProvider tests only run on the M4 runner via
# scripts/mac-full-verify.sh. What this does prove on Linux is that the
# platform-independent state machines (SessionMotionStream,
# TemporalStrokeDetector, PoseMotionTrailBuffer, PoseReadinessEvaluator,
# CaptureEvidenceAccumulator) and their XCTests compile and pass with a
# swift.org toolchain, so a Linux agent can catch logic regressions before
# spending a Mac run.
#
# The proxy package is generated in a scratch directory from the canonical
# sources (never copied into the repo). VisionCoreContracts.swift gets a
# CVPixelBuffer stub because swift-corelibs has no CoreVideo. Tests that need
# Vision/CoreVideo are dropped by name below.
#
# Usage: native/vision-core/tools/linux-proxy-test.sh [extra `swift test` args]
# Requires `swift` on PATH (https://www.swift.org/install/linux/).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
scratch="${VISION_CORE_PROXY_DIR:-$(mktemp -d "${TMPDIR:-/tmp}/vision-core-linux-proxy.XXXXXX")}"

if ! command -v swift >/dev/null 2>&1; then
  echo "swift toolchain not found on PATH; install from https://www.swift.org/install/linux/" >&2
  exit 127
fi

mkdir -p "$scratch/Sources/PickleVisionCore" "$scratch/Tests/PickleVisionCoreTests"

foundation_only_sources=(
  VisionCoreContracts
  SessionMotionStream
  TemporalStrokeDetector
  PoseMotionTrail
  PoseReadinessEvaluator
  CaptureEvidenceAccumulator
  CaptureQualitySignals
)
for name in "${foundation_only_sources[@]}"; do
  cp "$here/Sources/$name.swift" "$scratch/Sources/PickleVisionCore/"
done

# swift-corelibs-foundation has CGPoint/CGRect but no CoreVideo.
python3 - "$scratch/Sources/PickleVisionCore/VisionCoreContracts.swift" <<'EOF'
import sys
path = sys.argv[1]
src = open(path).read()
stub = (
    "import Foundation\n"
    "#if canImport(CoreVideo)\n"
    "import CoreVideo\n"
    "#else\n"
    "public final class CVPixelBuffer {}\n"
    "#endif\n"
)
assert "import CoreVideo\n" in src, "expected `import CoreVideo` in VisionCoreContracts.swift"
open(path, "w").write(src.replace("import CoreVideo\n", stub, 1))
EOF

foundation_only_tests=(
  SessionMotionStreamTests
  TemporalStrokeDetectorTests
  PoseMotionTrailTests
  PoseReadinessEvaluatorTests
  CaptureEvidenceAccumulatorTests
)
for name in "${foundation_only_tests[@]}"; do
  sed 's/^import CoreGraphics$/import Foundation/' "$here/Tests/$name.swift" \
    > "$scratch/Tests/PickleVisionCoreTests/$name.swift"
done

# VisionCoreExecutionAuditTests mixes Apple-only provider tests with pure
# logic; keep only the latter.
python3 - "$here/Tests/VisionCoreExecutionAuditTests.swift" \
  "$scratch/Tests/PickleVisionCoreTests/VisionCoreExecutionAuditTests.swift" <<'EOF'
import sys
src = open(sys.argv[1]).read()
start = src.index("  // MARK: - ApplePoseProvider: anchor lock")
end = src.index("  // MARK: - SessionMotionStream")
src = src[:start] + src[end:]
helper = src.index("  private func makeBlankPixelBuffer")
src = src[:helper].rstrip() + "\n}\n"
src = src.replace("import CoreGraphics\nimport CoreVideo\n", "", 1)
open(sys.argv[2], "w").write(src)
EOF

cat > "$scratch/Package.swift" <<'EOF'
// swift-tools-version:5.9
// Generated Linux proxy of native/vision-core (pure-Foundation subset). Not Apple truth.
import PackageDescription

let package = Package(
  name: "PickleVisionCoreLinuxProxy",
  targets: [
    .target(name: "PickleVisionCore", path: "Sources/PickleVisionCore"),
    .testTarget(
      name: "PickleVisionCoreTests",
      dependencies: ["PickleVisionCore"],
      path: "Tests/PickleVisionCoreTests"
    ),
  ]
)
EOF

echo "linux proxy package: $scratch" >&2
(cd "$scratch" && swift test "$@")
