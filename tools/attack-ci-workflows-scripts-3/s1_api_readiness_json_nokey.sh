#!/usr/bin/env bash
# S1 — tools/devin/api_readiness.sh --json without DEVIN_API_KEY.
#
# Attack: a machine consumer runs the probe in --json mode and pipes stdout
# into a JSON parser. The documented contract is "exit 2 no key"; the question
# is whether --json still yields a JSON document on that path (and on the
# other early exits), or whether the consumer gets nothing/plain text.
#
# Never prints or needs a real key; the only network call is skipped because
# the script exits before it (NO_KEY) or is fed an unreachable DEVIN_API_BASE.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
cd "$REPO_ROOT"

SCRIPT=tools/devin/api_readiness.sh

# --- 1. NO_KEY under --json: stdout must be a JSON document ------------------
rc=$(run_split "$OUT/nokey_stdout.txt" "$OUT/nokey_stderr.txt" env -u DEVIN_API_KEY "$SCRIPT" --json)
if [ "$rc" = 2 ]; then
  record HELD s1.exit_code "$rc" "$OUT/nokey_stdout.txt" "NO_KEY exits 2 as documented"
else
  record BROKEN s1.exit_code "$rc" "$OUT/nokey_stdout.txt" "NO_KEY exit code is $rc, documented 2"
fi
if python3 -m json.tool "$OUT/nokey_stdout.txt" >"$OUT/nokey_parsed.json" 2>"$OUT/nokey_parse_error.txt"; then
  record HELD s1.json_on_nokey "$rc" "$OUT/nokey_parsed.json" "--json emitted a JSON document on NO_KEY"
else
  record BROKEN s1.json_on_nokey "$rc" "$OUT/nokey_parse_error.txt" \
    "--json emitted NO JSON on NO_KEY (stdout $(wc -c <"$OUT/nokey_stdout.txt") bytes, stderr $(wc -c <"$OUT/nokey_stderr.txt") bytes of text): $(head -1 "$OUT/nokey_parse_error.txt")"
fi

# --- 2. the documented pipeline itself: `… --json | python3 -m json.tool` -----
set +e
env -u DEVIN_API_KEY "$SCRIPT" --json 2>/dev/null | python3 -m json.tool >"$OUT/pipeline.txt" 2>&1
ps=("${PIPESTATUS[@]}")
set -e
printf 'pipestatus: %s\n' "${ps[*]}" >>"$OUT/pipeline.txt"
if [ "${ps[1]}" = 0 ]; then
  record HELD s1.pipeline "${ps[0]}" "$OUT/pipeline.txt" "json.tool accepted the --json output"
else
  record BROKEN s1.pipeline "${ps[0]}" "$OUT/pipeline.txt" "json.tool rejected the --json output (pipestatus ${ps[*]})"
fi

# --- 3. UNREACHABLE under --json (exit 3) — same contract question ------------
rc=$(run_split "$OUT/unreachable_stdout.txt" "$OUT/unreachable_stderr.txt" env DEVIN_API_KEY=cog_attack_placeholder_not_a_real_key \
  DEVIN_API_BASE=http://127.0.0.1:9/api "$SCRIPT" --json)
if [ "$rc" = 3 ] && python3 -m json.tool "$OUT/unreachable_stdout.txt" >/dev/null 2>&1; then
  record HELD s1.json_on_unreachable "$rc" "$OUT/unreachable_stdout.txt" "UNREACHABLE exit 3 with JSON"
else
  record BROKEN s1.json_on_unreachable "$rc" "$OUT/unreachable_stdout.txt" \
    "UNREACHABLE path: exit $rc, stdout $(wc -c <"$OUT/unreachable_stdout.txt") bytes (non-JSON), stderr $(wc -c <"$OUT/unreachable_stderr.txt") bytes"
fi

# --- 4. --json is only honoured as argv[1]; an unknown flag is not rejected ----
rc=$(run_capture "$OUT/unknown_flag.txt" env -u DEVIN_API_KEY "$SCRIPT" --jsno 2>&1)
if grep -q "unknown" "$OUT/unknown_flag.txt"; then
  record HELD s1.unknown_flag "$rc" "$OUT/unknown_flag.txt" "typo'd flag rejected"
else
  record BROKEN s1.unknown_flag "$rc" "$OUT/unknown_flag.txt" "typo'd flag --jsno silently accepted (falls through to text mode)"
fi

verdict
