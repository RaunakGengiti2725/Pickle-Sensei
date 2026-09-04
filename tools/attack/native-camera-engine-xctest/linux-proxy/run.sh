#!/usr/bin/env bash
# Linux-side checks for the camera-engine attack harness (pass 3).
# Everything here is either a STATIC check of the production source or a
# Foundation-only MODEL — none of it is Apple runtime truth. The XCTest
# bundle itself runs only through `xcodebuild test` on a Mac (see ../README.md).
#
# usage: tools/attack/native-camera-engine-xctest/linux-proxy/run.sh [out-dir]
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HARNESS="$(cd "$HERE/.." && pwd)"
REPO_ROOT="$(cd "$HARNESS/../../.." && pwd)"
OUT="${1:-$REPO_ROOT/artifacts/attack/native-camera-engine-3}"
mkdir -p "$OUT"

COORD="$REPO_ROOT/native/camera-engine/Sources/SessionCaptureCoordinator.swift"
ENGINE="$REPO_ROOT/native/camera-engine/Sources/CameraEngine.swift"
PREVIEW="$REPO_ROOT/apps/mobile/ios/LocalPods/PickleNative/Sources/PickleSessionPreview.swift"

status=0
note() { printf '%s\n' "$*" | tee -a "$OUT/linux-proxy.log"; }
: >"$OUT/linux-proxy.log"
note "git_sha=$(git -C "$REPO_ROOT" rev-parse HEAD)"
note "swift=$(swift --version 2>&1 | head -1)"

# ── 1. Static pins: the source facts the seven attacks rely on ─────────────
note "== static pins =="
pin() { # pin <label> <file> <regex>
  local label="$1" file="$2" regex="$3" line
  if line="$(grep -nE -- "$regex" "$file" | head -1)"; then
    note "PIN ok   $label -> $(basename "$file"):${line%%:*}"
  else
    note "PIN MISS $label ($regex) in $file"; status=1
  fi
}
pin "S1 unconditional arm"      "$ENGINE" 'public func suppressNextRecordingFinishAndDiscard\(\)'
pin "S1 guarded discard no-op"  "$ENGINE" 'guard self\.movieOutput\.isRecording else \{ return \}'
pin "S1 one-shot consume"       "$ENGINE" 'suppressNextRecordingFinish = false'
pin "S3 sessionNotRunning guard" "$ENGINE" 'guard self\.session\.isRunning else'
pin "S5 removeObservers in deinit" "$ENGINE" 'removeObservers\(\)'
pin "S6 not-configured refusal" "$ENGINE" 'The camera session is not configured\.'
pin "S4 alreadyStopped guard"   "$COORD"  'completion\(\.failure\(CoordinatorError\.alreadyStopped\)\)'
pin "S4 recordingNotStarted guard" "$COORD" 'completion\(\.failure\(CoordinatorError\.recordingNotStarted\)\)'
pin "S7 serial extraction queue" "$COORD" 'private let extractionQueue = DispatchQueue\(label: "pickle\.session\.extract", qos: \.userInitiated\)'
pin "S7 coverage timeout"       "$COORD"  'private static let coverageTimeoutMs = 10_000'
pin "S7 coverage poll"          "$COORD"  'private static let coveragePollMs = 250'
pin "S7 blocking sleep in poll" "$COORD"  'Thread\.sleep\(forTimeInterval: Double\(Self\.coveragePollMs\)'
pin "S2 weak coordinator"       "$PREVIEW" 'private weak var coordinator: SessionCaptureCoordinator\?'
pin "S2 attached:false path"    "$PREVIEW" 'onPreviewState\?\(\["attached": false\]\)'
pin "S2 willMove detaches only coordinator" "$PREVIEW" 'if newWindow == nil \{ detachCoordinator\(\) \}'

# The one thing that would make S7 HELD by construction: a concurrent queue
# or an async (non-blocking) wait. Neither exists at this revision.
if grep -nE 'attributes: \.concurrent' "$COORD" >/dev/null; then
  note "S7: extraction queue is concurrent (serialization claim would be void)"
else
  note "S7: no concurrent attribute on any queue in SessionCaptureCoordinator.swift (serial confirmed)"
fi

# ── 2. Symlink integrity: the harness compiles the REAL files, unmodified ───
note "== harness symlinks =="
for link in "$HARNESS"/Sources/PickleCameraEngineUnderTest/*.swift; do
  if [ -L "$link" ] && [ -e "$link" ]; then
    note "LINK ok   $(basename "$link") -> $(readlink "$link")"
  else
    note "LINK BAD  $link"; status=1
  fi
done

# ── 3. Syntax parse of every new Swift file (no type-check on Linux) ───────
note "== swiftc -parse (syntax only; UIKit/XCTest/AVFoundation unavailable on Linux) =="
for f in "$HARNESS"/Tests/*.swift "$HARNESS"/Sources/ReactShim/*.swift "$HERE"/*.swift; do
  if swiftc -parse "$f" 2>>"$OUT/swiftc-parse.log"; then
    note "PARSE ok   ${f#"$REPO_ROOT"/}"
  else
    note "PARSE FAIL ${f#"$REPO_ROOT"/}"; status=1
  fi
done

# ── 4. Manifest evaluates ──────────────────────────────────────────────────
note "== swift package dump-package =="
if (cd "$HARNESS" && swift package dump-package >"$OUT/dump-package.json" 2>>"$OUT/linux-proxy.log"); then
  note "MANIFEST ok targets=$(python3 -c 'import json,sys;print([t["name"] for t in json.load(open(sys.argv[1]))["targets"]])' "$OUT/dump-package.json")"
else
  note "MANIFEST FAIL"; status=1
fi

# ── 5. S7 scheduling model (Foundation/Dispatch only) ──────────────────────
note "== S7 coverage-queue model (scale 1/50: 10 000 ms -> 200 ms, 250 ms -> 5 ms) =="
MODEL_BIN="$OUT/CoverageQueueModel"
swiftc -O -o "$MODEL_BIN" "$HERE/CoverageQueueModel.swift" 2>>"$OUT/linux-proxy.log"
"$MODEL_BIN" 5 10000 250 50 serial     >"$OUT/s7-model-serial.json"
"$MODEL_BIN" 5 10000 250 50 concurrent >"$OUT/s7-model-concurrent.json"
python3 - "$OUT/s7-model-serial.json" "$OUT/s7-model-concurrent.json" <<'EOF' | tee -a "$OUT/linux-proxy.log"
import json, sys
serial = json.load(open(sys.argv[1])); conc = json.load(open(sys.argv[2]))
print("serial     completion offsets (unscaled ms):", serial["completion_offsets_ms_unscaled"],
      "total", serial["total_ms_unscaled"], "bounded_by_one_timeout", serial["bounded_by_one_timeout"])
print("concurrent completion offsets (unscaled ms):", conc["completion_offsets_ms_unscaled"],
      "total", conc["total_ms_unscaled"], "bounded_by_one_timeout", conc["bounded_by_one_timeout"])
ok = serial["serialized_shape_detected"] and not serial["bounded_by_one_timeout"] and conc["bounded_by_one_timeout"]
print("MODEL", "ok: production shape (serial queue + blocking poll) exceeds one coverage timeout; concurrent reference does not" if ok else "UNEXPECTED")
sys.exit(0 if ok else 1)
EOF
[ "${PIPESTATUS[0]}" -eq 0 ] || status=1

note "== result: $([ "$status" -eq 0 ] && echo PASS || echo FAIL) (artifacts in $OUT) =="
exit "$status"
