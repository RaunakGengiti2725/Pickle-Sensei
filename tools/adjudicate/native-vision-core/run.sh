#!/usr/bin/env bash
# Adjudication harness: runs the PURE-SWIFT part of native/vision-core on Linux
# plus the reproduction tests kept under tools/adjudicate/native-vision-core/Tests.
#
# Linux has no Vision/CoreVideo, so a shadow SwiftPM package is assembled that
# symlinks every canonical source/test file EXCEPT ApplePoseProvider.swift and
# ApplePoseProviderSeedTests.swift, and replaces the single `import CoreVideo`
# in VisionCoreContracts.swift with an opaque `CVPixelBuffer` shim. The delta is
# asserted to be exactly that one line. The reproduction tests are NOT part of
# the package test target on purpose: several are expected red (they assert the
# desired behaviour) and one aborts the xctest process.
#
# This is a LINUX PROXY, not Apple evidence.
#
# Usage: tools/adjudicate/native-vision-core/run.sh [--out-dir DIR] [--no-repro] [-- <swift test args>]
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
src="$repo_root/native/vision-core"
repro="$repo_root/tools/adjudicate/native-vision-core/Tests"
out_dir="$repo_root/artifacts/adjudicate-vision-core/$(date -u +%Y%m%dT%H%M%SZ)"
shadow="${VISION_CORE_SHADOW_DIR:-$HOME/.cache/pickle-vision-core-adjudicate}"
include_repro=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --out-dir) out_dir="$2"; shift 2 ;;
    --no-repro) include_repro=0; shift ;;
    --) shift; break ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

command -v swift >/dev/null || { echo "swift toolchain not on PATH" >&2; exit 3; }

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
if [[ $include_repro -eq 1 ]]; then
  for f in "$repro"/*.swift; do
    ln -s "$f" "$shadow/Tests/$(basename "$f")"
  done
fi

{
  echo "# shadow package: $shadow"
  echo "# swift: $(swift --version 2>&1 | head -1)"
  echo "# repo sha: $(git -C "$repo_root" rev-parse HEAD)"
  echo "# repro tests included: $include_repro"
  echo "# excluded: Sources/ApplePoseProvider.swift Tests/ApplePoseProviderSeedTests.swift"
  echo "# delta vs canonical VisionCoreContracts.swift (must be exactly the one import line):"
  set +e
  delta="$(diff -u "$src/Sources/VisionCoreContracts.swift" "$shadow/Sources/VisionCoreContracts.swift")"
  diff_status=$?
  set -e
  echo "$delta"
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
