#!/usr/bin/env bash
# Regression tests for scripts/verify-cloud.sh summary.json encoding.
#
# summary.json must be valid JSON whatever a stage's last log line contains
# (tabs, ESC colour codes, CR, raw non-UTF-8 bytes): the note is a readable
# rendering of the line, never a parse error and never silently emptied.
# Two layers:
#   1. end-to-end — an `e2e` run whose "Chromium missing" message echoes a
#      PLAYWRIGHT_BROWSERS_PATH stuffed with hostile bytes; the resulting
#      summary.json must parse with jq, python3 and node;
#   2. unit — `json_escape` (extracted verbatim from verify-cloud.sh) is fed
#      every C0 control character and must round-trip through jq.
# Needs jq, python3 and node.
#
#   scripts/tests/test_verify_cloud_summary.sh
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
cd "$REPO_ROOT"

FAILURES=0
pass() { printf 'ok   - %s\n' "$*"; }
fail() { printf 'FAIL - %s\n' "$*"; FAILURES=$((FAILURES + 1)); }
check() { # check <description> <command...>
  local desc="$1"; shift
  if "$@"; then pass "$desc"; else fail "$desc"; fi
}
for tool in jq python3 node; do
  command -v "$tool" >/dev/null 2>&1 || { echo "missing required tool: $tool" >&2; exit 2; }
done

parses_everywhere() { # parses_everywhere <file> — jq, python3 and node must all accept it
  jq -e . "$1" >/dev/null \
    && python3 -m json.tool "$1" >/dev/null \
    && node -e 'JSON.parse(require("fs").readFileSync(process.argv[1]))' "$1"
}

echo "# --- end-to-end: hostile bytes in a stage note ---"
# tab, ESC + SGR sequence, CR, DEL, and two bytes that are invalid UTF-8.
hostile="$(printf '/nonexistent/with\ttab\033[31mred\033[0m\rcarriage\177del\377\376bytes')"
art="$WORK/e2e"
PLAYWRIGHT_BROWSERS_PATH="$hostile" VERIFY_ARTIFACTS="$art" scripts/verify-cloud.sh --only e2e >"$WORK/e2e.log" 2>&1
rc=$?
check "e2e stage is reported unavailable, run exits non-zero (exit $rc)" [ "$rc" -ne 0 ]
check "summary.json parses with jq, python3 -m json.tool and node JSON.parse" parses_everywhere "$art/summary.json"
check "e2e stage status is 'unavailable'" \
  jq -e '.stages[] | select(.name == "e2e") | .status == "unavailable"' "$art/summary.json" >/dev/null
check "note is a readable rendering of the line (keeps the path text, not emptied)" \
  jq -e '.stages[] | select(.name == "e2e") | .note | test("nonexistent/with") and test("tab") and test("carriage") and test("bytes")' "$art/summary.json" >/dev/null
check "summary.json is valid UTF-8" python3 -c 'import sys; open(sys.argv[1], encoding="utf-8").read()' "$art/summary.json"

echo "# --- unit: json_escape round-trips every C0 control through jq ---"
# The function is extracted verbatim so the test exercises the shipped
# implementation without running the gate (keep it a top-level `json_escape() {`
# … `}` block in verify-cloud.sh).
fn_src="$(sed -n '/^json_escape() {$/,/^}$/p' scripts/verify-cloud.sh)"
[ -n "$fn_src" ] || { echo "json_escape() not found in scripts/verify-cloud.sh" >&2; exit 2; }
eval "$fn_src"
declare -F json_escape >/dev/null || { echo "json_escape did not define" >&2; exit 2; }

roundtrip() { # roundtrip <label> <raw-bytes-file>
  local label="$1" raw="$2" escaped
  escaped="$(json_escape "$(cat "$raw")")"
  printf '"%s"' "$escaped" >"$WORK/rt.json"
  if ! jq -e . "$WORK/rt.json" >/dev/null 2>&1; then
    fail "$label: json_escape output is not a valid JSON string ($(od -An -c "$WORK/rt.json" | tr -s ' ' | head -c 120))"
    return
  fi
  jq -j . "$WORK/rt.json" >"$WORK/rt.out"
  if cmp -s "$raw" "$WORK/rt.out"; then
    pass "$label: round-trips through jq"
  else
    fail "$label: decoded bytes differ (got $(od -An -c "$WORK/rt.out" | tr -s ' ' | head -c 120))"
  fi
}

# Bash variables cannot hold NUL (U+0000), so 0x01..0x1F are the testable C0 set;
# each is embedded between printable text so an emptied note would be caught.
for ((i = 1; i < 32; i++)); do
  printf "before\\$(printf '%03o' "$i")after" >"$WORK/c0.raw"
  roundtrip "$(printf 'U+%04X' "$i")" "$WORK/c0.raw"
done
printf 'quote " backslash \\ slash / del \177 tab\tnl\ncr\r' >"$WORK/mixed.raw"
roundtrip 'quote/backslash/slash/DEL/tab/LF/CR mix' "$WORK/mixed.raw"
printf 'unicode: caf\303\251 \342\200\224 \360\237\245\222' >"$WORK/utf8.raw"
roundtrip 'valid multi-byte UTF-8 (2/3/4-byte sequences)' "$WORK/utf8.raw"
printf 'plain ascii note' >"$WORK/plain.raw"
roundtrip 'plain ASCII' "$WORK/plain.raw"

# Invalid UTF-8 cannot round-trip byte-for-byte; it must still yield a valid,
# readable JSON string that keeps the surrounding text.
printf 'abc\377\376def' >"$WORK/bad.raw"
escaped="$(json_escape "$(cat "$WORK/bad.raw")")"
printf '{"note": "%s"}' "$escaped" >"$WORK/bad.json"
check "invalid UTF-8 bytes: output parses with jq, python3 and node" parses_everywhere "$WORK/bad.json"
check "invalid UTF-8 bytes: surrounding text is kept" \
  jq -e '.note | test("abc") and test("def")' "$WORK/bad.json" >/dev/null

echo
if [ "$FAILURES" -ne 0 ]; then
  echo "test_verify_cloud_summary: $FAILURES failure(s); artifacts under $WORK"
  trap - EXIT # keep the evidence
  exit 1
fi
echo "test_verify_cloud_summary: all checks passed"
