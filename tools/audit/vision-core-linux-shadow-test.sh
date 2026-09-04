#!/usr/bin/env bash
# Linux replay harness for the PURE-SWIFT part of native/vision-core.
#
# Linux has no Vision/CoreVideo, so this builds a shadow SwiftPM package that
# symlinks every source and test file EXCEPT the two Vision-dependent ones
# (ApplePoseProvider.swift, ApplePoseProviderSeedTests.swift) and replaces the
# single `import CoreVideo` line in VisionCoreContracts.swift with a shim
# declaring an opaque `CVPixelBuffer` type. Nothing else is altered; the diff
# against the canonical file is printed so the delta is auditable.
#
# This is a LINUX PROXY: it proves detector / readiness / accumulator / trail /
# stream logic with the swift.org Linux toolchain. It proves nothing about
# Apple Vision, iOS, or the Xcode build — those need the Mac runner
# (scripts/mac-full-verify.sh).
#
# Usage: tools/audit/vision-core-linux-shadow-test.sh [--out-dir DIR] [-- <swift test args>]
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
src="$repo_root/native/vision-core"
out_dir="$repo_root/artifacts/vision-core-linux-shadow/$(date -u +%Y%m%dT%H%M%SZ)"
shadow="${VISION_CORE_SHADOW_DIR:-$HOME/.cache/pickle-vision-core-shadow}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --out-dir) out_dir="$2"; shift 2 ;;
    --) shift; break ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

command -v swift >/dev/null || { echo "swift toolchain not on PATH (install swift.org Linux toolchain)" >&2; exit 3; }

rm -rf "$shadow/Sources" "$shadow/Tests"
mkdir -p "$shadow/Sources" "$shadow/Tests" "$out_dir"
cp "$src/Package.swift" "$shadow/Package.swift"

for f in "$src"/Sources/*.swift; do
  base="$(basename "$f")"
  case "$base" in
    ApplePoseProvider.swift) continue ;;
    VisionCoreContracts.swift)
      sed 's/^import CoreVideo$/\/\/ [linux shadow] import CoreVideo replaced by LinuxShims.swift/' "$f" > "$shadow/Sources/$base"
      ;;
    *) ln -s "$f" "$shadow/Sources/$base" ;;
  esac
done
cat > "$shadow/Sources/LinuxShims.swift" <<'EOF'
// Linux shadow shim: CoreVideo does not exist here. The protocols only name
// the type; no code in the pure-Swift sources dereferences it.
public final class CVPixelBuffer: @unchecked Sendable {}
EOF

for f in "$src"/Tests/*.swift; do
  base="$(basename "$f")"
  case "$base" in
    ApplePoseProviderSeedTests.swift) continue ;;
    *) ln -s "$f" "$shadow/Tests/$base" ;;
  esac
done

{
  echo "# shadow package: $shadow"
  echo "# swift: $(swift --version 2>&1 | head -1)"
  echo "# repo sha: $(git -C "$repo_root" rev-parse HEAD)"
  echo "# excluded: Sources/ApplePoseProvider.swift Tests/ApplePoseProviderSeedTests.swift"
  echo "# delta vs canonical VisionCoreContracts.swift (must be exactly the one import line):"
  set +e
  delta="$(diff -u "$src/Sources/VisionCoreContracts.swift" "$shadow/Sources/VisionCoreContracts.swift")"
  diff_status=$?
  set -e
  echo "$delta"
  # diff exits 1 when files differ; anything else (0 = shim not applied, 2 = error) is a harness fault.
  [[ $diff_status -eq 1 ]] || { echo "shadow harness fault: unexpected diff status $diff_status" >&2; exit 4; }
  changed_lines="$(printf '%s\n' "$delta" | grep -cE '^[-+][^-+]')"
  [[ "$changed_lines" -eq 2 ]] || { echo "shadow harness fault: $changed_lines changed lines, expected 2" >&2; exit 4; }
} | tee "$out_dir/shadow-manifest.txt"

set +e
(cd "$shadow" && swift test "$@" 2>&1) | tee "$out_dir/swift-test.log"
status=${PIPESTATUS[0]}
set -e
echo "exit=$status" | tee "$out_dir/exit-code.txt"
echo "artifacts: $out_dir"
exit "$status"
