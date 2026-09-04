#!/usr/bin/env bash
# Behavioural probes for scripts/security-scan.sh + .gitleaks.toml.
#
# Plants ONE synthetic Supabase-style secret (never a real credential) in
# untracked paths chosen to exercise each path allowlist, runs the tree scan,
# and checks the outcome against the policy's own intent: a path that git would
# COMMIT (not ignored) must be detected; a gitignored path may be skipped.
# Also checks that GITLEAKS_BIN cannot turn the gate into a no-op PASS.
#
#   tools/audit/security-scan-probes.sh [--report-dir DIR]
#
# Exit 0 = every probe behaved as the policy intends, 1 = at least one gap,
# 2 = setup failure. Probe files are removed on exit (also on Ctrl-C); the
# script refuses to run on a dirty working tree so `git status` stays clean.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"
[ -x scripts/security-scan.sh ] || { echo "scripts/security-scan.sh missing" >&2; exit 2; }

REPORT_DIR=""
while [ $# -gt 0 ]; do
  case "$1" in
    --report-dir) [ $# -ge 2 ] || { echo "--report-dir needs a value" >&2; exit 2; }; REPORT_DIR="$2"; shift ;;
    -h|--help) sed -n '2,15p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

if [ -n "$(git status --porcelain)" ]; then
  echo "working tree is dirty; commit or stash first so probe cleanup is verifiable" >&2
  exit 2
fi

PROBE_DIR="tmp_secscan_probe"
SYNTHETIC='sb_secret_PROBE0000000000000000000000000000AAAA'
[ -n "$REPORT_DIR" ] && mkdir -p "$REPORT_DIR"

cleanup() {
  rm -rf "$PROBE_DIR" "$REPO_ROOT/.env.staging.probe"
  if [ -n "$(git status --porcelain)" ]; then
    echo "WARNING: working tree not clean after cleanup:" >&2
    git status --short >&2
  fi
}
trap cleanup EXIT INT TERM

fail=0
printf '%-6s %-52s %-10s %-8s %s\n' PROBE PATH EXPECT EXIT RESULT

# run_probe NAME RELATIVE_PATH — plants the synthetic value and scans the tree.
run_probe() {
  local name="$1" rel="$2" expect rc=0 result
  mkdir -p "$(dirname "$rel")"
  printf 'PROBE_KEY=%s\n' "$SYNTHETIC" > "$rel"
  if git check-ignore -q "$rel"; then expect=either; else expect=detect; fi
  local log=/dev/null
  [ -n "$REPORT_DIR" ] && log="$REPORT_DIR/$name.log"
  scripts/security-scan.sh --tree > "$log" 2>&1 || rc=$?
  rm -f "$rel"
  case "$rc" in
    1) result=detected ;;
    0) result=MISSED ;;
    *) result="scanner-error($rc)" ;;
  esac
  if [ "$expect" = detect ] && [ "$rc" != 1 ]; then
    result="$result <- GAP (path is committable)"
    fail=1
  fi
  printf '%-6s %-52s %-10s %-8s %s\n' "$name" "$rel" "$expect" "$rc" "$result"
}

run_probe A "$PROBE_DIR/planted.env"
run_probe B "$PROBE_DIR/build/hidden.txt"
run_probe C "$PROBE_DIR/other/hidden.txt"
run_probe D "$PROBE_DIR/.env"
run_probe F1 "$PROBE_DIR/Pods/hidden.txt"
run_probe F2 "$PROBE_DIR/.build/hidden.txt"
run_probe F3 "$PROBE_DIR/.venv/hidden.txt"
run_probe F4 "$PROBE_DIR/dist/hidden.txt"
run_probe G ".env.staging.probe"
run_probe I "$PROBE_DIR/Podfile.lock"
run_probe J "$PROBE_DIR/notes.json.mp4"

# E: a no-op scanner binary must not yield a PASS.
rc=0
log=/dev/null
[ -n "$REPORT_DIR" ] && log="$REPORT_DIR/E.log"
GITLEAKS_BIN=/bin/true scripts/security-scan.sh --tree > "$log" 2>&1 || rc=$?
if [ "$rc" = 0 ]; then
  printf '%-6s %-52s %-10s %-8s %s\n' E "GITLEAKS_BIN=/bin/true" "non-zero" "$rc" "PASS without scanning <- GAP"
  fail=1
else
  printf '%-6s %-52s %-10s %-8s %s\n' E "GITLEAKS_BIN=/bin/true" "non-zero" "$rc" "refused"
fi

[ "$fail" = 0 ] && echo "security-scan probes: all as intended" || echo "security-scan probes: gaps found (see GAP rows)"
exit "$fail"
