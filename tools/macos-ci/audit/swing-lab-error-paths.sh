#!/usr/bin/env bash
# Audit harness for `swing-lab extract` error paths and the fps/duration
# contract (main.swift:52-103,108-114,196-213,941-973). Mac plane only: needs
# the Release swing-lab binary, so it runs after `swift build -c release`.
#
# Usage: tools/macos-ci/audit/swing-lab-error-paths.sh <artifacts dir>
#
# Cases (each prints PASS/FAIL; exit 1 if any FAIL):
#   E1  missing input file → exit 1, and --out is NOT left behind (the CLI
#       creates --out before validating the input: main.swift:108-114).
#   E2  a non-media file → exit 1, --out NOT left behind.
#   E3  `extract` without --out → exit 1 (usage).
#   E4  unknown command → exit 1 (usage).
#   E5  a read-only --out parent → exit 1 (createDirectory throws).
#   F1  on the CI reference clip, video.durationMs is within 2% of the
#       container duration and video.fps within 10% of its frame rate as
#       read by tools/macos-ci/audit/check_swing_lab_meta_against_source.py.
set -uo pipefail

ARTIFACTS="${1:?artifacts dir required}"
mkdir -p "$ARTIFACTS"
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$ROOT"

BIN="$(cd native/swing-lab && swift build -c release --show-bin-path)/swing-lab"
[ -x "$BIN" ] || { echo "swing-lab Release binary missing at $BIN (run swift build -c release first)"; exit 2; }

FAILED=0
report() { # name ok detail
  if [ "$2" = 1 ]; then echo "PASS $1 — $3"; else echo "FAIL $1 — $3"; FAILED=1; fi
}

SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/swing-lab-audit.XXXXXX")"
trap 'rm -rf "$SCRATCH"' EXIT

# E1 missing input
OUT="$SCRATCH/e1-out"
"$BIN" extract "$SCRATCH/does-not-exist.mp4" --out "$OUT" >"$ARTIFACTS/e1.log" 2>&1; code=$?
report E1.exit "$([ $code -eq 1 ] && echo 1 || echo 0)" "exit=$code (expected 1)"
report E1.no-partial-out "$([ ! -e "$OUT" ] && echo 1 || echo 0)" "--out $( [ -e "$OUT" ] && echo 'EXISTS (partial output dir left behind)' || echo 'absent')"

# E2 non-media input
OUT="$SCRATCH/e2-out"; printf 'not a movie' >"$SCRATCH/garbage.mp4"
"$BIN" extract "$SCRATCH/garbage.mp4" --out "$OUT" >"$ARTIFACTS/e2.log" 2>&1; code=$?
report E2.exit "$([ $code -eq 1 ] && echo 1 || echo 0)" "exit=$code (expected 1)"
report E2.no-partial-out "$([ ! -e "$OUT" ] && echo 1 || echo 0)" "--out $( [ -e "$OUT" ] && echo 'EXISTS (partial output dir left behind)' || echo 'absent')"

# E3 missing --out
"$BIN" extract "$SCRATCH/garbage.mp4" >"$ARTIFACTS/e3.log" 2>&1; code=$?
report E3.usage "$([ $code -eq 1 ] && echo 1 || echo 0)" "exit=$code (expected 1)"

# E4 unknown command
"$BIN" frobnicate >"$ARTIFACTS/e4.log" 2>&1; code=$?
report E4.usage "$([ $code -eq 1 ] && echo 1 || echo 0)" "exit=$code (expected 1)"

# E5 read-only parent
mkdir -p "$SCRATCH/ro" && chmod 500 "$SCRATCH/ro"
"$BIN" extract "$SCRATCH/garbage.mp4" --out "$SCRATCH/ro/out" >"$ARTIFACTS/e5.log" 2>&1; code=$?
chmod 700 "$SCRATCH/ro"
report E5.exit "$([ $code -eq 1 ] && echo 1 || echo 0)" "exit=$code (expected 1)"

# F1 fps/duration contract on the CI reference clip
CLIP="datasets/pickleball/fresh-candidates/va-O1dLhGGPErc.mp4"
if [ -f "$CLIP" ]; then
  OUT="$ARTIFACTS/f1-extract"
  "$BIN" extract "$CLIP" --out "$OUT" >"$ARTIFACTS/f1-extract.log" 2>&1; code=$?
  report F1.extract "$([ $code -eq 0 ] && echo 1 || echo 0)" "exit=$code"
  python3 tools/macos-ci/audit/check_swing_lab_meta_against_source.py "$OUT" --json "$ARTIFACTS/f1-meta-vs-source.json" \
    >"$ARTIFACTS/f1-meta-vs-source.log" 2>&1; code=$?
  report F1.meta-vs-source "$([ $code -eq 0 ] && echo 1 || echo 0)" "exit=$code (see f1-meta-vs-source.log; 2 = ffprobe/clip unavailable, NOT a pass)"
  python3 tools/macos-ci/audit/check_swing_lab_artifact_contracts.py "$OUT" --json "$ARTIFACTS/f1-artifact-contracts.json" \
    >"$ARTIFACTS/f1-artifact-contracts.log" 2>&1; code=$?
  report F1.artifact-contracts "$([ $code -eq 0 ] && echo 1 || echo 0)" "exit=$code (see f1-artifact-contracts.log)"
else
  report F1.clip-present 0 "$CLIP missing"
fi

exit $FAILED
