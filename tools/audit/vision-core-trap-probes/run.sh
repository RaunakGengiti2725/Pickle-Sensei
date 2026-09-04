#!/usr/bin/env bash
# Builds each *_main.swift trap probe in this directory as an executable
# SwiftPM target against the pure-Swift vision-core sources and runs it in its
# own process, so a Swift precondition failure is captured as an exit code
# instead of killing an XCTest run.
#
# On Linux the Vision-dependent ApplePoseProvider.swift is excluded and the
# `import CoreVideo` line of VisionCoreContracts.swift is replaced by an opaque
# CVPixelBuffer shim (same delta as tools/audit/vision-core-linux-shadow-test.sh).
# On macOS the canonical sources are used unmodified.
#
# Usage: tools/audit/vision-core-trap-probes/run.sh [--out-dir DIR]
# Exit status: number of probes that TRAPPED (0 = every probe survived).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$here/../../.." && pwd)"
src="$repo_root/native/vision-core/Sources"
out_dir="$repo_root/artifacts/vision-core-trap-probes/$(date -u +%Y%m%dT%H%M%SZ)"
work="${VISION_CORE_TRAP_PROBE_DIR:-$HOME/.cache/pickle-vision-core-trap-probes}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --out-dir) out_dir="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done
command -v swift >/dev/null || { echo "swift toolchain not on PATH" >&2; exit 3; }

rm -rf "$work"
mkdir -p "$work/Sources/PickleVisionCore" "$out_dir"

if [[ "$(uname -s)" == "Darwin" ]]; then
  for f in "$src"/*.swift; do ln -s "$f" "$work/Sources/PickleVisionCore/$(basename "$f")"; done
else
  for f in "$src"/*.swift; do
    base="$(basename "$f")"
    case "$base" in
      ApplePoseProvider.swift) continue ;;
      VisionCoreContracts.swift)
        sed 's/^import CoreVideo$/\/\/ [linux shadow] import CoreVideo replaced by LinuxShims.swift/' "$f" \
          > "$work/Sources/PickleVisionCore/$base" ;;
      *) ln -s "$f" "$work/Sources/PickleVisionCore/$base" ;;
    esac
  done
  cat > "$work/Sources/PickleVisionCore/LinuxShims.swift" <<'EOF'
public final class CVPixelBuffer: @unchecked Sendable {}
EOF
fi

probes=()
targets=""
for probe in "$here"/*_main.swift; do
  name="$(basename "$probe" _main.swift)"
  probes+=("$name")
  mkdir -p "$work/Sources/$name"
  ln -s "$probe" "$work/Sources/$name/main.swift"
  targets+="    .executableTarget(name: \"$name\", dependencies: [\"PickleVisionCore\"]),
"
done

cat > "$work/Package.swift" <<EOF
// swift-tools-version:5.9
import PackageDescription

let package = Package(
  name: "VisionCoreTrapProbes",
  platforms: [.macOS(.v13)],
  targets: [
    .target(name: "PickleVisionCore"),
$targets  ]
)
EOF

(cd "$work" && swift build 2>&1) | tee "$out_dir/build.log"

trapped=0
for name in "${probes[@]}"; do
  echo "=== probe: $name" | tee -a "$out_dir/probes.log"
  set +e
  (cd "$work" && swift run --skip-build "$name" 2>&1) | tee -a "$out_dir/probes.log"
  status=${PIPESTATUS[0]}
  set -e
  echo "=== $name exit=$status" | tee -a "$out_dir/probes.log"
  echo "$name exit=$status" >> "$out_dir/exit-codes.txt"
  if [[ $status -ne 0 ]]; then trapped=$((trapped + 1)); fi
done
echo "trapped=$trapped of ${#probes[@]}" | tee -a "$out_dir/probes.log"
echo "artifacts: $out_dir"
exit "$trapped"
