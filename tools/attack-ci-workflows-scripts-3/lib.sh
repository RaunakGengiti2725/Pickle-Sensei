#!/usr/bin/env bash
# Shared helpers for the ci-workflows-scripts (pass 3) attack harnesses.
#
# Every scenario script sources this file, writes its logs under $OUT, and
# finishes with `verdict`. A scenario exits 0 only when EVERY protection it
# probes HELD; any BROKEN check makes it exit 1 so the scripts double as
# regression tests once the gaps are fixed.
#
# None of these harnesses ever contacts GitHub, pushes a branch, or touches the
# Mac runner: every `git push` / `gh` the scripts under test would issue is
# intercepted by the PATH shims in `shims/` (see shim_path).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HARNESS_DIR="$REPO_ROOT/tools/attack-ci-workflows-scripts-3"
SCENARIO="${SCENARIO:-$(basename "$0" | sed 's/\.[a-z]*$//')}"
OUT="${ATTACK_ARTIFACTS:-$REPO_ROOT/artifacts/attack-ci-workflows-scripts-3}/$SCENARIO"
mkdir -p "$OUT"
export REPO_ROOT HARNESS_DIR SCENARIO OUT

BROKEN=0
HELD=0
RESULTS=()

log() { printf '[%s] %s\n' "$SCENARIO" "$*" >&2; }

# record <HELD|BROKEN> <check-id> <exit-code> <artifact> <one-line summary>
record() {
  local status="$1" id="$2" code="$3" artifact="$4" summary="$5"
  RESULTS+=("$status|$id|exit=$code|$artifact|$summary")
  if [ "$status" = HELD ]; then HELD=$((HELD + 1)); else BROKEN=$((BROKEN + 1)); fi
  log "$status  $id  exit=$code  $artifact  — $summary"
}

# run_capture <logfile> <cmd...> — runs cmd, captures stdout+stderr, echoes exit code.
run_capture() {
  local logfile="$1"
  shift
  local rc=0
  "$@" >"$logfile" 2>&1 || rc=$?
  printf 'exit=%s\n' "$rc" >>"$logfile"
  printf '%s' "$rc"
}

# run_split <stdout-file> <stderr-file> <cmd...> — like run_capture but keeps the
# two streams apart (for "is stdout a JSON document" checks); echoes exit code.
run_split() {
  local outfile="$1" errfile="$2"
  shift 2
  local rc=0
  "$@" >"$outfile" 2>"$errfile" || rc=$?
  printf '%s' "$rc"
}

# temp_export <dest> <paths...> — `git archive HEAD` of the given paths into dest
# (a hermetic copy of exactly the commit under test, no node_modules).
temp_export() {
  local dest="$1"
  shift
  mkdir -p "$dest"
  (cd "$REPO_ROOT" && git archive HEAD "$@" | tar -x -C "$dest")
}

# shim_path — a PATH prefix whose `git` forwards everything except `push`
# (logged to $SHIM_LOG, never executed) and whose `gh` answers canned data.
shim_path() {
  chmod +x "$HARNESS_DIR"/shims/* 2>/dev/null || true
  printf '%s' "$HARNESS_DIR/shims"
}

verdict() {
  {
    printf 'scenario: %s\ncommit: %s\n' "$SCENARIO" "$(git -C "$REPO_ROOT" rev-parse HEAD)"
    printf 'held: %s\nbroken: %s\n' "$HELD" "$BROKEN"
    printf '%s\n' "${RESULTS[@]}"
  } | tee "$OUT/verdict.txt" >&2
  if [ "$BROKEN" -gt 0 ]; then
    log "VERDICT: BROKEN ($BROKEN check(s) failed, $HELD held)"
    exit 1
  fi
  log "VERDICT: HELD ($HELD check(s))"
  exit 0
}
