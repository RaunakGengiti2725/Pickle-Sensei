#!/usr/bin/env bash
# Regression suite for scripts/security-scan.sh and verify-cloud's security stage.
#
#   scripts/tests/test_security_scan.sh
#
# Builds a throwaway git repository under mktemp that carries a copy of
# scripts/security-scan.sh, scripts/verify-cloud.sh and .gitleaks.toml. Both
# scripts resolve REPO_ROOT from their own location, so the copies scan the
# fixture, never this checkout. Every planted "secret" is synthetic and
# generated at run time. Uses the pinned gitleaks (GITLEAKS_BIN /
# SECURITY_SCAN_CACHE are honoured, so the cached binary is reused).
#
# Cases:
#   history --log-opts with a bad ref / empty range / --max-count=0 → exit 2,
#     names the bad ref, never says "clean" or "PASS"
#   history --log-opts over a clean 3-commit range → exit 0, log states 3 commits
#   a planted sb_secret_ token → exit 1 with redacted per-finding attribution
#     (RuleID, File, Line, Commit, Fingerprint) and a JSON report; the value
#     never appears in the log or the report
#   verify-cloud --only security → security.log carries the attribution and the
#     report path, the JSON report lands in the artifacts dir; a clean run's log
#     differs from a direct scan only by the report path line
#
# Exit 0 = every case passed, 1 = at least one failed.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORK="$(mktemp -d)"
FIXTURE="$WORK/fixture"
OUT="$WORK/out"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$FIXTURE/scripts" "$OUT"

PASSED=0
FAILED=0
ok() {
  PASSED=$((PASSED + 1))
  printf 'ok   - %s\n' "$1"
}
fail() {
  FAILED=$((FAILED + 1))
  printf 'FAIL - %s\n' "$1"
  if [ -n "${2:-}" ] && [ -f "$2" ]; then
    sed 's/^/       | /' "$2"
  fi
}

# run <log> <command...>: run inside the fixture, capture stdout+stderr with
# ANSI colour stripped into <log>; returns the command's exit code.
run() {
  local logf="$1"
  shift
  (cd "$FIXTURE" && "$@") >"$logf.raw" 2>&1
  local rc=$?
  sed 's/\x1b\[[0-9;]*m//g' "$logf.raw" >"$logf"
  return "$rc"
}

assert_exit() { # <case> <expected> <actual> <log>
  if [ "$2" = "$3" ]; then ok "$1: exit $2"; else fail "$1: expected exit $2, got $3" "$4"; fi
}
assert_grep() { # <case> <pattern> <file>
  if grep -Eq -- "$2" "$3"; then ok "$1: output matches /$2/"; else fail "$1: output lacks /$2/" "$3"; fi
}
assert_not_grep() { # <case> <pattern> <file>
  if grep -Eq -- "$2" "$3"; then fail "$1: output must not match /$2/" "$3"; else ok "$1: output free of /$2/"; fi
}

git_fx() { git -C "$FIXTURE" "$@"; }
commit_file() { # <path> <content> <message>
  printf '%s\n' "$2" >"$FIXTURE/$1"
  git_fx add -- "$1"
  git_fx -c user.name=fixture -c user.email=fixture@example.invalid commit -q -m "$3"
}

# ------------------------------------------------------------- fixture repo --
git_fx init -q
cp "$REPO_ROOT/.gitleaks.toml" "$FIXTURE/.gitleaks.toml"
cp "$REPO_ROOT/scripts/security-scan.sh" "$REPO_ROOT/scripts/verify-cloud.sh" "$FIXTURE/scripts/"
chmod 0755 "$FIXTURE/scripts/"*.sh
printf 'artifacts/\n' >"$FIXTURE/.gitignore"
git_fx add -A
git_fx -c user.name=fixture -c user.email=fixture@example.invalid commit -q -m "scaffold: policy + scripts"
commit_file notes-a.txt "first clean change" "a"
commit_file notes-b.txt "second clean change" "b"
commit_file notes-c.txt "third clean change" "c"
# HEAD~3..HEAD is now exactly the three commits a, b, c.

# ------------------------------------------ CI-13: invalid / empty ranges ----
case="bad-ref"
run "$OUT/$case.log" scripts/security-scan.sh --history --log-opts 'nonexistent..HEAD'
rc=$?
assert_exit "$case" 2 "$rc" "$OUT/$case.log"
assert_grep "$case" 'nonexistent' "$OUT/$case.log"
assert_not_grep "$case" 'history: clean|PASS' "$OUT/$case.log"

case="empty-range"
run "$OUT/$case.log" scripts/security-scan.sh --history --log-opts 'HEAD..HEAD'
rc=$?
assert_exit "$case" 2 "$rc" "$OUT/$case.log"
assert_not_grep "$case" 'clean|PASS' "$OUT/$case.log"

case="max-count-0"
run "$OUT/$case.log" scripts/security-scan.sh --history --log-opts '--max-count=0'
rc=$?
assert_exit "$case" 2 "$rc" "$OUT/$case.log"
assert_not_grep "$case" 'clean|PASS' "$OUT/$case.log"

case="clean-range"
run "$OUT/$case.log" scripts/security-scan.sh --history --log-opts 'HEAD~3..HEAD'
rc=$?
assert_exit "$case" 0 "$rc" "$OUT/$case.log"
assert_grep "$case" '3 commits' "$OUT/$case.log"
assert_grep "$case" 'history: clean' "$OUT/$case.log"
assert_grep "$case" 'PASS' "$OUT/$case.log"

# ------------------------------- CI-14: clean verify-cloud run (reference) ----
case="verify-cloud-clean"
run "$OUT/$case.direct.log" scripts/security-scan.sh
rc=$?
assert_exit "$case (direct scan)" 0 "$rc" "$OUT/$case.direct.log"
run "$OUT/$case.log" env VERIFY_ARTIFACTS="$FIXTURE/artifacts/clean" scripts/verify-cloud.sh --only security
rc=$?
assert_exit "$case" 0 "$rc" "$OUT/$case.log"
CLEAN_STAGE_LOG="$FIXTURE/artifacts/clean/security.log"
if [ -f "$CLEAN_STAGE_LOG" ]; then
  # Strip colour, timings and byte counts; the stage log must then equal the
  # direct scan's output except for the line(s) naming the JSON report.
  normalize() {
    sed -E 's/\x1b\[[0-9;]*m//g; s/^[0-9]{1,2}:[0-9]{2}(AM|PM) //; s/ in [0-9.]+m?s$//; s/\([0-9]+s\)$//; /scanned ~[0-9]+ bytes/d' "$1"
  }
  normalize "$OUT/$case.direct.log" >"$OUT/$case.direct.norm"
  normalize "$CLEAN_STAGE_LOG" | grep -v 'report' >"$OUT/$case.stage.norm"
  if diff -u "$OUT/$case.direct.norm" "$OUT/$case.stage.norm" >"$OUT/$case.diff"; then
    ok "$case: security.log equals a direct scan apart from report path lines"
  else
    fail "$case: security.log differs from a direct scan beyond report path lines" "$OUT/$case.diff"
  fi
  assert_grep "$case" 'gitleaks-history\.json' "$CLEAN_STAGE_LOG"
else
  fail "$case: $CLEAN_STAGE_LOG was not written" "$OUT/$case.log"
fi

# ------------------------------------- CI-14: planted synthetic secret --------
# Runtime-generated so nothing in this file (or the fixture) is a real credential.
SECRET="sb_secret_$(LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 40)"
commit_file planted-config.ts "export const serviceKey = \"$SECRET\";" "feat: planted synthetic key (test fixture)"

case="planted-history"
run "$OUT/$case.log" scripts/security-scan.sh --history --report-dir "$FIXTURE/artifacts/planted-direct"
rc=$?
assert_exit "$case" 1 "$rc" "$OUT/$case.log"
assert_grep "$case" 'RuleID: +supabase-secret-api-key' "$OUT/$case.log"
assert_grep "$case" 'File: +planted-config\.ts' "$OUT/$case.log"
assert_grep "$case" 'Line: +1' "$OUT/$case.log"
assert_grep "$case" 'Commit: +[0-9a-f]{40}' "$OUT/$case.log"
assert_grep "$case" 'Fingerprint: +[0-9a-f]{40}:planted-config\.ts:supabase-secret-api-key:1' "$OUT/$case.log"
assert_not_grep "$case" "$SECRET" "$OUT/$case.log"
assert_not_grep "$case" 'sb_secret_' "$OUT/$case.log"
assert_not_grep "$case" 'see output above' "$OUT/$case.log"
REPORT="$FIXTURE/artifacts/planted-direct/gitleaks-history.json"
if [ -f "$REPORT" ]; then
  ok "$case: JSON report written"
  assert_grep "$case (report)" '"RuleID": *"supabase-secret-api-key"' "$REPORT"
  assert_grep "$case (report)" '"File": *"planted-config\.ts"' "$REPORT"
  assert_not_grep "$case (report)" "$SECRET" "$REPORT"
  assert_not_grep "$case (report)" 'sb_secret_' "$REPORT"
else
  fail "$case: JSON report $REPORT missing" "$OUT/$case.log"
fi

case="verify-cloud-planted"
run "$OUT/$case.log" env VERIFY_ARTIFACTS="$FIXTURE/artifacts/planted" scripts/verify-cloud.sh --only security
rc=$?
assert_exit "$case" 1 "$rc" "$OUT/$case.log"
STAGE_LOG="$FIXTURE/artifacts/planted/security.log"
if [ -f "$STAGE_LOG" ]; then
  assert_grep "$case" 'RuleID: +supabase-secret-api-key' "$STAGE_LOG"
  assert_grep "$case" 'File: +planted-config\.ts' "$STAGE_LOG"
  assert_grep "$case" 'Commit: +[0-9a-f]{40}' "$STAGE_LOG"
  assert_not_grep "$case" "$SECRET" "$STAGE_LOG"
  assert_not_grep "$case" 'sb_secret_' "$STAGE_LOG"
  if ls "$FIXTURE"/artifacts/planted/*/gitleaks-history.json >/dev/null 2>&1; then
    ok "$case: gitleaks-history.json lives under the verify-cloud artifacts dir"
    for report in "$FIXTURE"/artifacts/planted/*/gitleaks-*.json; do
      assert_not_grep "$case ($(basename "$report"))" 'sb_secret_' "$report"
    done
  else
    fail "$case: no gitleaks-history.json under $FIXTURE/artifacts/planted/" "$OUT/$case.log"
  fi
else
  fail "$case: $STAGE_LOG was not written" "$OUT/$case.log"
fi

printf '\n%d passed, %d failed\n' "$PASSED" "$FAILED"
[ "$FAILED" -eq 0 ]
