#!/usr/bin/env bash
# Linux PROXY harness for native/vision-core (adversarial pass 3).
#
# Linux cannot compile the real package: `VisionCoreContracts.swift` imports
# CoreVideo and `ApplePoseProvider.swift` imports Vision. Everything else in
# the package is pure Foundation Swift, so this script materialises a scratch
# SwiftPM package that
#   * copies every Foundation-only source verbatim from native/vision-core,
#   * copies VisionCoreContracts.swift with ONLY the `import CoreVideo` line
#     replaced (Linux `CVPixelBuffer` placeholder; see LinuxShims.swift),
#   * copies ApplePoseProvider.swift with ONLY the `import Vision` line
#     replaced (VisionStub.swift supplies the VN*/CGImagePropertyOrientation
#     symbols; `perform` always throws, so no inference can happen) — the
#     anchor lock + `primaryPerson` logic is the production text,
#   * copies every XCTest file (existing + adversarial),
# and runs `swift test` (optionally with `--sanitize=thread`). Both source
# edits are recorded as diffs in the artifact directory.
#
# This is a PROXY plane. It exercises the same Swift source text with the
# swift.org Linux toolchain; it is NOT Apple runtime truth. Apple truth for
# the same tests comes from `scripts/mac-full-verify.sh` on the M4 runner.
#
# Usage:
#   tools/linux-swift-proxy/vision-core/run.sh [--tsan] [--filter <regex>] [--out <dir>]
# Requires a swift toolchain on PATH (tested with swift-5.10.1-RELEASE-ubuntu22.04).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SRC="$REPO_ROOT/native/vision-core/Sources"
TESTS="$REPO_ROOT/native/vision-core/Tests"
HERE="$REPO_ROOT/tools/linux-swift-proxy/vision-core"
PKG="$HERE/.package"
OUT=""
TSAN=0
FILTER=""
while [ $# -gt 0 ]; do
  case "$1" in
    --tsan) TSAN=1 ;;
    --filter) FILTER="$2"; shift ;;
    --out) OUT="$2"; shift ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
  shift
done
[ -n "$OUT" ] || OUT="$HERE/artifacts/$(date -u +%Y%m%dT%H%M%SZ)$([ "$TSAN" = 1 ] && echo -tsan)"
mkdir -p "$OUT"

command -v swift >/dev/null || { echo "swift toolchain not on PATH" >&2; exit 3; }

# diff exits 1 when the files differ — the expected state for a shimmed copy.
# Exactly ONE changed line (the import) is allowed; anything else aborts.
record_shim_diff() {
  local original="$1" shimmed="$2" out="$3" rc=0
  diff -u "$original" "$shimmed" > "$out" || rc=$?
  if [ "$rc" -ne 1 ]; then
    echo "shim diff for $(basename "$original") unexpected (rc=$rc)" >&2
    exit 4
  fi
  local removed added
  removed=$(grep -c '^-[^-]' "$out")
  added=$(grep -c '^+[^+]' "$out")
  if [ "$removed" -ne 1 ] || [ "$added" -ne 1 ]; then
    echo "shim for $(basename "$original") changed more than the import line (-$removed/+$added)" >&2
    exit 4
  fi
}

rm -rf "$PKG/Sources" "$PKG/Tests"
mkdir -p "$PKG/Sources/PickleVisionCore" "$PKG/Sources/CoreGraphics" "$PKG/Tests/PickleVisionCoreTests"
cp "$HERE/Package.swift" "$PKG/Package.swift"
cp "$HERE/CoreGraphicsStub.swift" "$PKG/Sources/CoreGraphics/CoreGraphics.swift"
cp "$HERE/LinuxShims.swift" "$PKG/Sources/PickleVisionCore/LinuxShims.swift"
cp "$HERE/VisionStub.swift" "$PKG/Sources/PickleVisionCore/VisionStub.swift"

# Foundation-only sources: copied byte-for-byte.
for f in TemporalStrokeDetector CaptureEvidenceAccumulator PoseMotionTrail PoseReadinessEvaluator SessionMotionStream CaptureQualitySignals; do
  cp "$SRC/$f.swift" "$PKG/Sources/PickleVisionCore/$f.swift"
done
# Contracts: import CoreVideo -> Linux stub (the ONLY edit; diff recorded).
sed 's/^import CoreVideo$/\/\/ [linux-proxy] import CoreVideo replaced; CVPixelBuffer comes from LinuxShims.swift/' \
  "$SRC/VisionCoreContracts.swift" > "$PKG/Sources/PickleVisionCore/VisionCoreContracts.swift"
record_shim_diff "$SRC/VisionCoreContracts.swift" "$PKG/Sources/PickleVisionCore/VisionCoreContracts.swift" "$OUT/contracts-shim.diff"
# Provider: import Vision -> stub (the ONLY edit; diff recorded).
sed 's/^import Vision$/\/\/ [linux-proxy] import Vision replaced; VN* symbols come from VisionStub.swift/' \
  "$SRC/ApplePoseProvider.swift" > "$PKG/Sources/PickleVisionCore/ApplePoseProvider.swift"
record_shim_diff "$SRC/ApplePoseProvider.swift" "$PKG/Sources/PickleVisionCore/ApplePoseProvider.swift" "$OUT/provider-shim.diff"

# Every XCTest file (existing + adversarial), plus proxy-only tests that need
# the Vision stub's synthetic observations (not constructible on Apple).
for t in "$TESTS"/*.swift "$HERE"/ProxyOnlyTests/*.swift; do
  cp "$t" "$PKG/Tests/PickleVisionCoreTests/$(basename "$t")"
done

{
  echo "git_sha=$(git -C "$REPO_ROOT" rev-parse HEAD)"
  echo "swift=$(swift --version 2>&1 | head -1)"
  echo "tsan=$TSAN"
  echo "filter=${FILTER:-<none>}"
  echo "sources:"; (cd "$PKG/Sources/PickleVisionCore" && sha256sum -- *.swift)
  echo "tests:"; (cd "$PKG/Tests/PickleVisionCoreTests" && sha256sum -- *.swift)
} > "$OUT/manifest.txt"

ARGS=(test --package-path "$PKG" --xunit-output "$OUT/xunit.xml")
[ "$TSAN" = 1 ] && ARGS+=(--sanitize=thread)
[ -n "$FILTER" ] && ARGS+=(--filter "$FILTER")
export TSAN_OPTIONS="${TSAN_OPTIONS:-halt_on_error=0 report_signal_unsafe=0 log_path=$OUT/tsan-report}"

set +e
swift "${ARGS[@]}" 2>&1 | tee "$OUT/swift-test.log"
rc=${PIPESTATUS[0]}
set -e
echo "exit=$rc" | tee "$OUT/exit-code.txt"
echo "artifacts: $OUT"
exit "$rc"
