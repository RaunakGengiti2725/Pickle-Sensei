#!/usr/bin/env bash
# Runs each test in AdversarialPass3Tester2TrapTests in its OWN xctest process
# (a Swift overflow trap kills the process, so one invocation per test) and
# records the exit code per test in $OUT/traps.tsv. Requires a package already
# assembled by run.sh (pass the same --out / OUT).
#
#   OUT=/tmp/vision-core-linux-proxy-2 tools/attack/native-vision-core-linux-proxy-2/run-traps.sh [--release]
#
# Exit code: 0 when every test either TRAPPED (non-zero, signal) or PASSED
# cleanly and was recorded; 2 on harness error. Read traps.tsv for the
# per-site verdict — a trap here is the S09 finding, a clean pass is a HELD.
# Linux replay proxy only: not Apple runtime evidence.
set -u
OUT="${OUT:-/tmp/vision-core-linux-proxy-2}"
CONFIG="debug"
SWIFT_BIN="${SWIFT_BIN:-$(command -v swift || true)}"
while [ $# -gt 0 ]; do
  case "$1" in
    --release) CONFIG="release"; shift ;;
    --out) OUT="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done
PKG="$OUT/pkg"
LOGS="$OUT/logs"
[ -d "$PKG" ] || { echo "no package at $PKG — run run.sh first" >&2; exit 2; }
[ -x "$SWIFT_BIN" ] || { echo "swift toolchain not found" >&2; exit 2; }
mkdir -p "$LOGS"

TESTS=$(grep -oE 'func (testTrap[A-Za-z0-9_]+)' "$PKG/Tests/AdversarialPass3Tester2TrapTests.swift" | awk '{print $2}')
[ -n "$TESTS" ] || { echo "no testTrap* functions found" >&2; exit 2; }

{
  echo "configuration=$CONFIG"
  echo "swift=$("$SWIFT_BIN" --version 2>&1 | head -1)"
  echo "repo_sha=$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse HEAD)"
} | tee "$LOGS/traps-provenance.txt"

printf 'test\texit_code\tverdict\tlog\n' >"$OUT/traps.tsv"
for t in $TESTS; do
  log="$LOGS/trap-$t.log"
  EXTRA=()
  [ "$CONFIG" = release ] && EXTRA=(-Xswiftc -enable-testing)
  "$SWIFT_BIN" test -c "$CONFIG" "${EXTRA[@]}" --package-path "$PKG" --filter "AdversarialPass3Tester2TrapTests/$t" >"$log" 2>&1
  rc=$?
  if [ "$rc" -eq 0 ]; then
    verdict="PASSED_NO_TRAP"
  elif grep -qE "Fatal error|signal code|Illegal instruction|Trace/breakpoint" "$log"; then
    verdict="TRAPPED"
  else
    verdict="FAILED_OTHER"
  fi
  printf '%s\t%s\t%s\t%s\n' "$t" "$rc" "$verdict" "$log" | tee -a "$OUT/traps.tsv"
done
