#!/usr/bin/env bash
# scripts/verify-cloud.sh summary.json must always be valid JSON.
#
# The unavailable note is `tail -n 1 <stage log>`, i.e. tool output. json_escape
# handles only backslash, quote and newline, so any other control character in
# the note (TAB, CR, ESC from ANSI colour codes) yields an unparsable summary.
#
# Asserts (desired behaviour):
#   J1  ordinary run → summary.json parses (control)
#   J2  a stage note containing a TAB   → summary.json still parses
#   J3  a stage note containing ESC (ANSI colour) → summary.json still parses
#   J4  a stage note containing CR      → summary.json still parses
#
# The note is fed through the real e2e stage: its exit-75 message embeds
# $PLAYWRIGHT_BROWSERS_PATH verbatim ("Playwright Chromium missing under <path>").
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

SB=$(mktemp -d)
trap 'rm -rf "$SB"' EXIT
new_verify_cloud_sandbox "$SB"

check() { # check <label> <PLAYWRIGHT_BROWSERS_PATH value>
  local label=$1 value=$2 summary
  rm -rf "$SB/artifacts"
  OUT="$(cd "$SB" && HOME="$SB" PATH="$SANDBOX_BIN:/usr/bin:/bin" PLAYWRIGHT_BROWSERS_PATH="$value" \
    scripts/verify-cloud.sh --only e2e 2>&1)"
  summary=$(ls "$SB"/artifacts/verify-cloud/*/summary.json 2>/dev/null | head -1)
  assert_true "$label summary.json exists" test -s "$summary"
  if jq empty "$summary" 2>"$AUDIT_OUT/summary_json_${label}.jq.err"; then
    log "ok   $label summary.json is valid JSON"
  else
    log "FAIL $label summary.json is NOT valid JSON: $(cat "$AUDIT_OUT/summary_json_${label}.jq.err")"
    _assert_failures=$((_assert_failures + 1))
  fi
  cp "$summary" "$AUDIT_OUT/summary_json_${label}.json"
}

TAB=$'\t'; ESC=$'\e'; CR=$'\r'
check J1 "$SB/no-browsers-here"
check J2 "$SB/tab${TAB}here"
check J3 "$SB/esc${ESC}[31mred${ESC}[0m"
check J4 "$SB/cr${CR}here"

finish
