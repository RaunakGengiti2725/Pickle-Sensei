#!/usr/bin/env bash
# Compiles the trap probe directly against the canonical production source
# (PoseReadinessEvaluator.swift, untouched) plus the harness' shimmed
# contracts copy, then runs it. Exits with the probe's own exit code.
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
harness="$here/../linux-harness"
out="${AUDIT_PROBE_OUT:-$here/.build}"
mkdir -p "$out"
"$harness/generate-contracts.sh" || exit 2
swiftc \
  "$here/readiness_duplicate_landmark_trap/main.swift" \
  "$harness/Sources/VisionCoreContracts.swift" \
  "$here/../../Sources/PoseReadinessEvaluator.swift" \
  -o "$out/readiness_duplicate_landmark_trap" || exit 3
"$out/readiness_duplicate_landmark_trap"
code=$?
echo "probe exit code: $code"
exit $code
