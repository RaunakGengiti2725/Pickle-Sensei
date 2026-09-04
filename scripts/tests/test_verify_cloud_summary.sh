#!/usr/bin/env bash
# Regression tests for scripts/verify-cloud.sh's summary.json writer: the file
# must be valid JSON whatever bytes a stage's last log line contains (tabs,
# escapes, carriage returns, raw non-UTF-8), and the note must still be readable.
#
#   scripts/tests/test_verify_cloud_summary.sh
#
# Needs jq, python3 and node (the three parsers CI/agents use on summary.json).
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
cd "$REPO_ROOT"

PASS=0
FAIL=0
ok() { PASS=$((PASS + 1)); echo "ok   - $*"; }
bad() { FAIL=$((FAIL + 1)); echo "FAIL - $*"; }
check() {
  local desc="$1"
  shift
  if "$@"; then ok "$desc"; else bad "$desc"; fi
}

parses_everywhere() {
  jq . "$1" >/dev/null 2>"$TMP/jq.err" || { echo "    jq: $(cat "$TMP/jq.err")"; return 1; }
  python3 -m json.tool "$1" >/dev/null 2>"$TMP/py.err" || { echo "    python3: $(tail -n 1 "$TMP/py.err")"; return 1; }
  node -e 'JSON.parse(require("fs").readFileSync(process.argv[1]))' "$1" 2>"$TMP/node.err" || { echo "    node: $(head -n 3 "$TMP/node.err" | tail -n 1)"; return 1; }
}

# ---------------------------------------------------------------- end to end ----
# The e2e stage echoes PLAYWRIGHT_BROWSERS_PATH into its log before exiting 75,
# and verify-cloud lifts that last line into the stage note.
echo "# summary.json with a note holding TAB, ESC, CR and raw non-UTF-8 bytes"
NASTY=$'/nonexistent/with\ttab\x1b[31mesc\rcr\xff\xfebytes'
OUT="$TMP/nasty"
PLAYWRIGHT_BROWSERS_PATH="$NASTY" VERIFY_ARTIFACTS="$OUT" scripts/verify-cloud.sh --only e2e >"$TMP/nasty.log" 2>&1
rc=$?
check "the run itself reports failure (unavailable stage; got $rc)" [ "$rc" -ne 0 ]
check "summary.json parses with jq, python3 -m json.tool and node JSON.parse" parses_everywhere "$OUT/summary.json"
if jq . "$OUT/summary.json" >/dev/null 2>&1; then
  NOTE="$(jq -r '.stages[] | select(.name == "e2e") | .note' "$OUT/summary.json")"
  readable_note() { [[ "$1" == *"Playwright Chromium missing"* && "$1" == *"tab"* && "$1" == *"esc"* && "$1" == *"cr"* && "$1" == *"bytes"* ]]; }
  check "note is a readable rendering of the line, not truncated — $(printf '%q' "$NOTE")" readable_note "$NOTE"
  has_tab_and_cr() { [[ "$1" == *$'\t'* && "$1" == *$'\r'* ]]; }
  check "tab and CR survive the round trip as the real characters" has_tab_and_cr "$NOTE"
else
  bad "note readable (summary unparseable, see above)"
  bad "tab and CR survive the round trip (summary unparseable)"
fi

# ---------------------------------------------------------------- unit: json_escape ----
# Lift the function out of the script so each control character can be fed
# through it in isolation and round-tripped with jq.
sed -n '/^json_escape() {$/,/^}$/p' scripts/verify-cloud.sh >"$TMP/json_escape.sh"
if [ ! -s "$TMP/json_escape.sh" ]; then
  bad "json_escape() could not be extracted from scripts/verify-cloud.sh"
else
  # shellcheck disable=SC1090
  source "$TMP/json_escape.sh"

  roundtrip() {
    # roundtrip <input>: the escaped string, wrapped in quotes, must parse with
    # jq and decode back to exactly the input bytes.
    local input="$1" escaped decoded
    escaped="$(json_escape "$input")"
    printf '"%s"' "$escaped" >"$TMP/rt.json"
    jq -e . "$TMP/rt.json" >/dev/null 2>&1 || return 1
    decoded="$(jq -r . "$TMP/rt.json"; printf x)"
    decoded="${decoded%x}"
    [ "$decoded" = "$input" ]
  }

  echo "# json_escape: every C0 control character (0x01..0x1F) and DEL round-trip through jq"
  c0_failures=""
  for code in $(seq 1 31) 127; do
    ch="$(printf "\\$(printf '%03o' "$code")")"
    roundtrip "a${ch}b" || c0_failures="$c0_failures $(printf '0x%02x' "$code")"
  done
  check "all C0 controls + DEL escaped and decoded back to the same bytes${c0_failures:+ (failed:$c0_failures)}" [ -z "$c0_failures" ]
  # NUL cannot live in a bash variable at all: `$(tail -n 1 log)` drops it before
  # json_escape ever sees the note, so 0x00 is unreachable rather than untested.

  echo "# json_escape: JSON metacharacters and multi-byte UTF-8 are preserved"
  check "backslash, double quote, slash and newline round-trip" roundtrip $'back\\slash "quoted" a/b\nline2'
  check "valid UTF-8 (em dash, accented, CJK, emoji) passes through unchanged" roundtrip $'\xe2\x80\x94 caf\xc3\xa9 \xe6\x97\xa5\xe6\x9c\xac \xf0\x9f\x8f\x93'

  echo "# json_escape: bytes that are not valid UTF-8 still yield parseable JSON"
  for bad_bytes in $'\xff' $'\xfe\xfe' $'\xc3' $'\xe2\x82' $'\xc0\xaf' $'\xed\xa0\x80'; do
    printf '"%s"' "$(json_escape "x${bad_bytes}y")" >"$TMP/bad.json"
    check "invalid sequence $(printf '%q' "$bad_bytes") -> parseable, keeps surrounding text — $(cat "$TMP/bad.json")" \
      bash -c 'jq -e . "$1" >/dev/null && python3 -c "import json,sys; s=json.load(open(sys.argv[1])); sys.exit(0 if s.startswith(\"x\") and s.endswith(\"y\") else 1)" "$1"' _ "$TMP/bad.json"
  done
fi

echo
echo "test_verify_cloud_summary: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
