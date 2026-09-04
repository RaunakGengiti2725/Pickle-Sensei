#!/usr/bin/env bash
# Static probe: AGENTS.md states how many detector tests pin the
# temporal-stroke-heuristic-4 contract; the number must equal the count of
# test methods in native/vision-core/Tests/TemporalStrokeDetectorTests.swift.
# Exit 0 = in step; exit 1 = drift (prints both numbers).
set -euo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
claimed="$(grep -oE '[0-9]+ detector tests' "$repo_root/AGENTS.md" | head -1 | grep -oE '^[0-9]+')"
actual="$(grep -cE '^\s*func test' "$repo_root/native/vision-core/Tests/TemporalStrokeDetectorTests.swift")"
echo "AGENTS.md claims: ${claimed:-<no claim found>} detector tests"
echo "TemporalStrokeDetectorTests.swift defines: $actual test methods"
if [[ -z "$claimed" || "$claimed" != "$actual" ]]; then
  echo "DRIFT: AGENTS.md:$(grep -nE '[0-9]+ detector tests' "$repo_root/AGENTS.md" | head -1 | cut -d: -f1) disagrees with the suite"
  exit 1
fi
echo "OK"
