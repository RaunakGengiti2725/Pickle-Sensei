#!/usr/bin/env bash
# Structural-audit probes for native/swing-lab + native/camera-engine.
#
# Linux-runnable only: static contracts over the Swift sources, a downstream
# vitest probe in packages/swing-lab, and (when a Mac `swing-lab extract`
# bundle is supplied) the self-consistency check of that bundle. Nothing here
# compiles Swift or claims Apple runtime behaviour.
#
# Usage:
#   tools/audit/native-swing-lab-camera-engine/run.sh [<swing-lab-extract dir>] [<source clip>]
#
# Writes logs + JSON under artifacts/audit-native-swing-lab-camera-engine/ and
# exits non-zero when any probe fails (each probe's own exit code is recorded;
# a failing probe is a suspected defect, never a pass).
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
OUT="$ROOT/artifacts/audit-native-swing-lab-camera-engine"
mkdir -p "$OUT"
EXTRACT_DIR="${1:-}"
VIDEO="${2:-}"
status=0

echo "== static contracts (python unittest)"
if ! (cd "$ROOT" && python3 -m unittest tools/audit/native-swing-lab-camera-engine/test_native_structural_contracts.py -v \
  >"$OUT/static-contracts.log" 2>&1); then
  echo "   FAIL -> $OUT/static-contracts.log"; status=1
else
  echo "   ok   -> $OUT/static-contracts.log"
fi
tail -n 3 "$OUT/static-contracts.log"

echo "== downstream fps loss-gate probe (vitest, packages/swing-lab)"
if ! (cd "$ROOT/packages/swing-lab" && SWING_LAB_EXTRACT_DIR="$EXTRACT_DIR" npx vitest run test/auditExtractFpsLossGate.test.ts \
  >"$OUT/vitest-fps-loss-gate.log" 2>&1); then
  echo "   FAIL -> $OUT/vitest-fps-loss-gate.log"; status=1
else
  echo "   ok   -> $OUT/vitest-fps-loss-gate.log"
fi
grep -E "Tests|Test Files" "$OUT/vitest-fps-loss-gate.log"

if [[ -n "$EXTRACT_DIR" ]]; then
  echo "== extract bundle self-consistency ($EXTRACT_DIR)"
  args=("$EXTRACT_DIR" --report "$OUT/extract-consistency.json")
  [[ -n "$VIDEO" ]] && args+=(--video "$VIDEO")
  if ! (cd "$ROOT" && python3 tools/audit/native-swing-lab-camera-engine/check_extract_consistency.py "${args[@]}" \
    >"$OUT/extract-consistency.log" 2>&1); then
    echo "   FAIL -> $OUT/extract-consistency.log"; status=1
  else
    echo "   ok   -> $OUT/extract-consistency.log"
  fi
  cat "$OUT/extract-consistency.log"
else
  echo "== extract bundle self-consistency: SKIPPED (no bundle dir given; e.g. gh run download 33841813597)"
fi

exit "$status"
