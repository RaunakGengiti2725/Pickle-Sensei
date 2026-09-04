#!/usr/bin/env bash
# scripts/verify-cloud.sh must run under macOS's stock /bin/bash (3.2.57).
#
# scripts/verify-all.sh runs verify-cloud.sh locally on macOS ("on macOS it
# runs locally") before mac-full-verify.sh, through `#!/usr/bin/env bash` —
# on a Mac without Homebrew bash that is 3.2.57. Two checks:
#
#   1. static (always runs): verify-cloud.sh and tools/macos-ci/select-simulator.sh
#      use no bash >= 4 only syntax (declare -A, mapfile/readarray, ${v,,},
#      ${v^^}, |&, ;;&, ;&, local -n, ${v@Q}). Under bash 3.2 with `set -u`,
#      `declare -A X=([passed]=0 ...)` is parsed as an indexed array whose
#      subscript `passed` is an unbound variable: the script aborts on that
#      line with exit status 0, so summary.json is never written and
#      verify-all.sh counts the Linux half as passed.
#   2. functional (bash 3.2 required): run verify-cloud.sh with every stage
#      skipped under bash 3.2 and require the same contract Linux gets —
#      non-zero exit, summary.json present, valid JSON, ok:false — and require
#      json_escape to round-trip valid UTF-8 (bash 3.2's printf %d "'c" yields
#      a negative number for bytes >= 0x80, which the escaper turns into
#      \uffffffffffffffc3-style garbage).
#
# A bash 3.2 is found via $BASH32 (path to a bash 3.2 binary), a `bash-3.2`
# or `bash3.2` on PATH, or the `bash:3.2` Docker image. If none is available
# the functional half exits 75 (EX_TEMPFAIL, prerequisite absent) after the
# static half has run — an absent bash 3.2 is never reported as a pass.
#
# Usage: scripts/tests/test_verify_cloud_bash32.sh
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="$REPO_ROOT/scripts/verify-cloud.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
RC=0

pass() { echo "[test_verify_cloud_bash32] PASS: $*"; }
flunk() { echo "[test_verify_cloud_bash32] FAIL: $*" >&2; }

for tool in jq python3; do
  command -v "$tool" >/dev/null 2>&1 || { echo "missing required tool: $tool" >&2; exit 75; }
done

# ------------------------------------------------------------- 1. static ----
# One pattern per bash >= 4 construct; each hit is a line the stock macOS bash
# cannot run. Comments are stripped first so documentation cannot trip it.
BASH4_PATTERNS=(
  'declare[[:space:]]+-[A-Za-z]*A'
  '\bmapfile\b'
  '\breadarray\b'
  '\$\{[A-Za-z_][A-Za-z0-9_]*(\[[^]]*\])?,,?\}'
  '\$\{[A-Za-z_][A-Za-z0-9_]*(\[[^]]*\])?\^\^?\}'
  '\|&'
  ';;&'
  ';&$'
  'local[[:space:]]+-[A-Za-z]*n[[:space:]]'
  '\$\{[A-Za-z_][A-Za-z0-9_]*@[QEPAa]\}'
)
for f in scripts/verify-cloud.sh tools/macos-ci/select-simulator.sh; do
  hits=""
  for p in "${BASH4_PATTERNS[@]}"; do
    h="$(sed -e 's/^[[:space:]]*#.*$//' -e 's/[[:space:]]#[^"'"'"']*$//' "$REPO_ROOT/$f" | grep -nE "$p" || true)"
    [ -n "$h" ] && hits+="$h (pattern: $p)"$'\n'
  done
  if [ -n "$hits" ]; then
    RC=1; flunk "$f uses bash >= 4 only syntax (breaks macOS /bin/bash 3.2):"$'\n'"$hits"
  else
    pass "$f uses no bash >= 4 only syntax"
  fi
done

# --------------------------------------------------------- 2. functional ----
# bash32 <script> <args...>: runs <script> (a path inside $REPO_ROOT or $WORK)
# under bash 3.2 with the same paths visible. Sets BASH32_RUN to a runner
# prefix or leaves it empty when no bash 3.2 is available.
BASH32_RUN=()
if [ -n "${BASH32:-}" ] && [ -x "$BASH32" ]; then
  BASH32_RUN=("$BASH32")
elif command -v bash-3.2 >/dev/null 2>&1; then
  BASH32_RUN=("$(command -v bash-3.2)")
elif command -v bash3.2 >/dev/null 2>&1; then
  BASH32_RUN=("$(command -v bash3.2)")
elif command -v docker >/dev/null 2>&1 && docker image inspect bash:3.2 >/dev/null 2>&1 \
  || { command -v docker >/dev/null 2>&1 && docker pull -q bash:3.2 >/dev/null 2>&1; }; then
  BASH32_RUN=(docker run --rm -v "$REPO_ROOT:$REPO_ROOT:ro" -v "$WORK:$WORK" -w "$REPO_ROOT" bash:3.2 bash)
fi

if [ ${#BASH32_RUN[@]} -eq 0 ]; then
  echo "[test_verify_cloud_bash32] no bash 3.2 available (set BASH32=/path/to/bash-3.2, or provide docker with the bash:3.2 image)" >&2
  [ $RC -eq 0 ] && exit 75
  exit $RC
fi

ver="$("${BASH32_RUN[@]}" -c 'echo "$BASH_VERSION"' 2>/dev/null)"
case "$ver" in
  3.2.*) pass "bash 3.2 runner found ($ver)" ;;
  *) echo "[test_verify_cloud_bash32] runner is not bash 3.2 (got '$ver')" >&2; exit 75 ;;
esac

# 2a. all stages skipped under bash 3.2: same contract as Linux.
out="$WORK/skipall"; mkdir -p "$out"
"${BASH32_RUN[@]}" -c 'VERIFY_ARTIFACTS="$1" "$2" --only ml --skip ml' _ "$out" "$SCRIPT" >"$out/run.out" 2>&1
code=$?
if [ $code -eq 0 ]; then
  RC=1; flunk "bash 3.2: --only ml --skip ml exited 0 (expected non-zero); output:"$'\n'"$(cat "$out/run.out")"
else
  pass "bash 3.2: --only ml --skip ml exits non-zero ($code)"
fi
if [ ! -s "$out/summary.json" ]; then
  RC=1; flunk "bash 3.2: summary.json was not written; output:"$'\n'"$(cat "$out/run.out")"
elif ! jq -e . "$out/summary.json" >/dev/null 2>&1; then
  RC=1; flunk "bash 3.2: summary.json is not valid JSON"
elif [ "$(jq -r '.ok' "$out/summary.json")" != false ]; then
  RC=1; flunk "bash 3.2: summary.json ok != false for an all-skipped run"
else
  pass "bash 3.2: summary.json written, valid, ok:false"
fi
if grep -q 'unbound variable' "$out/run.out"; then
  RC=1; flunk "bash 3.2: verify-cloud.sh aborted on an unbound variable: $(grep -m1 'unbound variable' "$out/run.out")"
fi

# 2b. json_escape under bash 3.2 must round-trip valid UTF-8 and stay valid JSON.
awk '/^json_escape\(\) \{/,/^\}/' "$SCRIPT" >"$WORK/json_escape.sh"
if ! grep -q '^json_escape() {' "$WORK/json_escape.sh"; then
  RC=1; flunk "could not extract json_escape() from $SCRIPT"
else
  cat >"$WORK/escape_probe.sh" <<'SH'
. "$1/json_escape.sh"
i=0
while IFS= read -r line; do
  i=$((i+1))
  printf '{"s":"%s"}' "$(json_escape "$line")" >"$1/esc_$i.json"
done <"$1/escape_inputs.txt"
SH
  printf '%s\n' 'héllo wörld' '日本語テキスト' $'\xf0\x9f\x8f\x93 emoji' 'ascii "quoted" \back' >"$WORK/escape_inputs.txt"
  "${BASH32_RUN[@]}" "$WORK/escape_probe.sh" "$WORK"
  n=0
  while IFS= read -r line; do
    n=$((n+1))
    f="$WORK/esc_$n.json"
    if [ ! -s "$f" ]; then RC=1; flunk "bash 3.2 json_escape: no output for input #$n"; continue; fi
    if ! jq -e . "$f" >/dev/null 2>&1; then RC=1; flunk "bash 3.2 json_escape: invalid JSON for input #$n: $(cat "$f")"; continue; fi
    got="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1], encoding="utf-8"))["s"])' "$f")"
    if [ "$got" != "$line" ]; then
      RC=1; flunk "bash 3.2 json_escape: '$line' became '$got' (raw: $(cat "$f"))"
    fi
  done <"$WORK/escape_inputs.txt"
  [ $RC -eq 0 ] && pass "bash 3.2 json_escape round-trips valid UTF-8 ($n inputs)"
fi

if [ $RC -eq 0 ]; then
  echo "[test_verify_cloud_bash32] OK: verify-cloud.sh runs under bash 3.2 with the Linux contract"
else
  echo "[test_verify_cloud_bash32] FAILED" >&2
fi
exit $RC
