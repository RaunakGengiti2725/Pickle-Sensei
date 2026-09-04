#!/usr/bin/env bash
# Execution audit harness for subsystem mobile-settings-account.
# Runs the 47 subsystem suites in several modes and records exit codes.
set -u
cd "$(git rev-parse --show-toplevel)/apps/mobile"
OUT=${AUDIT_OUT:-/tmp/audit-artifacts}
mkdir -p "$OUT"
HERE=$(cd "$(dirname "$0")" && pwd)
SUITES=$(tr '\n' ' ' < "$HERE/subsystem_suites.txt")

run() {
  local name=$1; shift
  echo "== $name: npx jest --ci $* ($(date -u +%H:%M:%S))" | tee -a "$OUT/exit-codes.txt"
  # shellcheck disable=SC2086
  npx jest --ci "$@" $SUITES > "$OUT/$name.log" 2>&1
  local rc=$?
  echo "$name exit=$rc" | tee -a "$OUT/exit-codes.txt"
}

: > "$OUT/exit-codes.txt"
run subsystem-randomize-seed1 --randomize --seed 1
run subsystem-randomize-seed2 --randomize --seed 2
run subsystem-verbose-noSilent --verbose
run subsystem-detectOpenHandles --detectOpenHandles --runInBand
run subsystem-coverage --silent --coverage --coverageDirectory "$OUT/coverage" \
  --collectCoverageFrom 'src/screens/SettingsScreen.tsx' \
  --collectCoverageFrom 'src/screens/ManageAccountScreen.tsx' \
  --collectCoverageFrom 'src/screens/ConsentSettingsScreen.tsx' \
  --collectCoverageFrom 'src/screens/NotificationSettingsScreen.tsx' \
  --collectCoverageFrom 'src/state/consentStore.ts' \
  --collectCoverageFrom 'src/notifications/**/*.{ts,tsx}' \
  --coverageReporters text --coverageReporters json-summary
echo DONE >> "$OUT/exit-codes.txt"
