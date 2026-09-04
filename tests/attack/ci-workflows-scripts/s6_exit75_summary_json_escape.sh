#!/usr/bin/env bash
# S6 — a stage exits 75 whose LAST LOG LINE carries characters json_escape()
# in scripts/verify-cloud.sh does not escape (tab, ANSI ESC, other C0 controls,
# a lone UTF-16 surrogate is impossible in bash so we add raw non-UTF-8 bytes).
#
# A `python3` wrapper on PATH makes the `ml` stage (`need python3` ok, then
# `python3 -m unittest …` -> our wrapper) print the hostile line and exit 75.
# verify-cloud records `unavailable` with note=$(tail -n 1 log) and emits
# summary.json via printf. Expect: `python3 -m json.tool summary.json` (real
# python3) parses, `jq .` parses, node JSON.parse parses.
#
# Cases (S6_CASE, default all): tab, ansi, ctrl, cr, bytes, all
# Also: the stage note for a plain `failed` stage is "exit N" (constant), so the
# same run confirms a normal failure path stays parseable (control).
#
# Exit 0 = every summary parsed (HELD), 1 = at least one unparseable (BROKEN).
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
OUT="${S6_OUT:-/tmp/attack-s6-$(date -u +%Y%m%dT%H%M%SZ)}"
mkdir -p "$OUT"
cd "$REPO_ROOT" || exit 2
: >"$OUT/results.jsonl"
BROKEN=0
REAL_PY="$(command -v python3)"
[ -n "$REAL_PY" ] || { echo "python3 required" >&2; exit 2; }

# last_line_printf <case> -> printf format for the hostile last line
last_line() {
  case "$1" in
    tab)   printf 'missing\tfixture' ;;
    ansi)  printf 'missing \033[31mfixture\033[0m' ;;
    ctrl)  printf 'missing \001fixture\037' ;;
    cr)    printf 'missing fixture\r' ;;
    bytes) printf 'missing \xff\xfe fixture' ;;
    all)   printf 'missing\tfixture \033[31mred\033[0m "quoted" back\\slash \001ctrl \xff' ;;
  esac
}

run_case() {
  local c="$1" bin="$OUT/$1.bin" art="$OUT/$1-artifacts" rc py jq nd status verdict
  mkdir -p "$bin"
  # the wrapper reproduces the hostile bytes through a bash $'\xNN…' literal
  local hex
  hex="$(last_line "$c" | "$REAL_PY" -c 'import sys; b=sys.stdin.buffer.read(); print("".join("\\x%02x" % x for x in b))')"
  cat >"$bin/python3" <<EOF
#!/usr/bin/env bash
echo "prerequisite probe"
printf '%s\n' \$'$hex'
exit 75
EOF
  chmod +x "$bin/python3"
  rm -rf "$art"
  PATH="$bin:$PATH" VERIFY_ARTIFACTS="$art" scripts/verify-cloud.sh --only ml >"$OUT/$c.out" 2>&1
  rc=$?
  "$REAL_PY" -m json.tool "$art/summary.json" >"$OUT/$c.jsontool.out" 2>&1; py=$?
  if command -v jq >/dev/null; then jq . "$art/summary.json" >/dev/null 2>"$OUT/$c.jq.err"; jq=$?; else jq=na; fi
  node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' "$art/summary.json" 2>"$OUT/$c.node.err"; nd=$?
  status="$(grep -o '"status": "[a-z]*"' "$art/summary.json" | head -1 | cut -d'"' -f4)"
  verdict=HELD
  { [ "$py" -eq 0 ] && [ "$nd" -eq 0 ] && [ "$rc" -eq 1 ] && [ "$status" = unavailable ]; } || verdict=BROKEN
  [ $verdict = BROKEN ] && BROKEN=1
  printf '{"case":"%s","verify_exit":%d,"stage_status":"%s","json_tool_exit":%d,"jq_exit":"%s","node_parse_exit":%d,"verdict":"%s","summary":"%s","json_tool_error":"%s"}\n' \
    "$c" "$rc" "$status" "$py" "$jq" "$nd" "$verdict" "$art/summary.json" "$(tr -d '\n' <"$OUT/$c.jsontool.out" | sed 's/"/\\"/g' | cut -c1-120)" | tee -a "$OUT/results.jsonl"
}

for c in ${S6_CASE:-tab ansi ctrl cr bytes all}; do run_case "$c"; done

# control: an ordinary failing stage (exit 3) -> note "exit 3", must parse
mkdir -p "$OUT/control.bin"; printf '#!/usr/bin/env bash\necho "boom\\tboom"\nexit 3\n' >"$OUT/control.bin/python3"; chmod +x "$OUT/control.bin/python3"
PATH="$OUT/control.bin:$PATH" VERIFY_ARTIFACTS="$OUT/control-artifacts" scripts/verify-cloud.sh --only ml >"$OUT/control.out" 2>&1; rc=$?
"$REAL_PY" -m json.tool "$OUT/control-artifacts/summary.json" >/dev/null 2>&1; py=$?
printf '{"case":"control_exit3","verify_exit":%d,"json_tool_exit":%d,"verdict":"%s"}\n' "$rc" "$py" "$([ $py -eq 0 ] && [ $rc -eq 1 ] && echo HELD || echo BROKEN)" | tee -a "$OUT/results.jsonl"

echo "== results: $OUT/results.jsonl"
exit $BROKEN
