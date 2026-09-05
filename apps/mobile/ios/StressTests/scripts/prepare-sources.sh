#!/usr/bin/env bash
# Populates Sources/PickleNativeStressCore/Generated with links to the CANONICAL
# production sources so the stress harness compiles the code the LocalPod ships
# (apps/mobile/ios/LocalPods/PickleNative/Sources/Core is itself a symlink farm
# into native/). Nothing here is copied except one Linux-only shim: the contracts
# file imports CoreVideo, which does not exist on Linux, so on Linux the file is
# regenerated with that single import line removed and a `CVPixelBuffer` opaque
# placeholder is added. On Darwin every file is linked verbatim.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
pkg="$(cd "$here/.." && pwd)"
repo="$(cd "$pkg/../../../.." && pwd)"
gen="$pkg/Sources/PickleNativeStressCore/Generated"

vision="$repo/native/vision-core/Sources"
pod="$repo/apps/mobile/ios/LocalPods/PickleNative/Sources"

rm -rf "$gen"
mkdir -p "$gen"

foundation_only=(
  CaptureEvidenceAccumulator.swift
  CaptureQualitySignals.swift
  PoseMotionTrail.swift
  PoseReadinessEvaluator.swift
  SessionMotionStream.swift
  TemporalStrokeDetector.swift
)

for f in "${foundation_only[@]}"; do
  ln -s "$vision/$f" "$gen/$f"
done
ln -s "$pod/StrokeCompletionMonitor.swift" "$gen/StrokeCompletionMonitor.swift"

if [[ "$(uname -s)" == "Darwin" ]]; then
  ln -s "$vision/VisionCoreContracts.swift" "$gen/VisionCoreContracts.swift"
  ln -s "$vision/ApplePoseProvider.swift" "$gen/ApplePoseProvider.swift"
  echo "prepare-sources: Darwin — linked full vision-core (Vision-backed provider included)"
else
  if ! grep -q '^import CoreVideo$' "$vision/VisionCoreContracts.swift"; then
    echo "prepare-sources: expected 'import CoreVideo' in VisionCoreContracts.swift" >&2
    exit 1
  fi
  grep -v '^import CoreVideo$' "$vision/VisionCoreContracts.swift" > "$gen/VisionCoreContracts.linux.swift"
  cat > "$gen/LinuxCoreVideoShim.swift" <<'EOF'
// Linux-only placeholder so the Sendable protocols in VisionCoreContracts
// type-check. No production code path on Linux ever constructs one.
public final class CVPixelBuffer: @unchecked Sendable {
  public init() {}
}
EOF
  echo "prepare-sources: Linux — linked Foundation-only subset; CoreVideo import stripped into VisionCoreContracts.linux.swift"
fi

ls -la "$gen"
