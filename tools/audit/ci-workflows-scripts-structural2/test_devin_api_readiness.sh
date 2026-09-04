#!/usr/bin/env bash
# tools/devin/api_readiness.sh — machine-readable contract without a key.
#
# Never sets DEVIN_API_KEY and never reaches the network: the NO_KEY branch
# exits before the liveness probe (verified by running with curl stubbed to
# fail loudly if invoked).
#
# Asserts (desired behaviour):
#   A1  no key → exit 2 (control, documented)
#   A2  no key + --json → stdout is a JSON document (a coordinator parsing
#       --json output must not have to fall back to scraping stderr text)
#   A3  no network call is made on the NO_KEY path (curl stub never invoked)
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

SB=$(mktemp -d)
trap 'rm -rf "$SB"' EXIT
mkdir -p "$SB/bin"
make_stub "$SB/bin" curl 'echo "curl invoked: $*" >>"$STUB_LOG"; exit 99'
make_stub "$SB/bin" jq 'exit 0'
STUB_LOG="$SB/stub.log"; : >"$STUB_LOG"

run_probe() {
  OUT_STDOUT="$(env -u DEVIN_API_KEY STUB_LOG="$STUB_LOG" PATH="$SB/bin:/usr/bin:/bin" \
    "$REPO_ROOT/tools/devin/api_readiness.sh" "$@" 2>"$SB/stderr")"; RC=$?
  OUT_STDERR="$(cat "$SB/stderr")"
}

run_probe
printf 'exit=%s\nstdout:\n%s\nstderr:\n%s\n' "$RC" "$OUT_STDOUT" "$OUT_STDERR" >"$AUDIT_OUT/api_readiness_A1.log"
assert_eq "A1 no key → exit 2" 2 "$RC"

run_probe --json
printf 'exit=%s\nstdout:\n%s\nstderr:\n%s\n' "$RC" "$OUT_STDOUT" "$OUT_STDERR" >"$AUDIT_OUT/api_readiness_A2.log"
assert_eq "A2 no key + --json → exit 2" 2 "$RC"
assert_true "A2 --json stdout is a JSON document" \
  python3 -c 'import json,sys; d=json.loads(sys.argv[1]); assert isinstance(d, dict), "not an object"' "$OUT_STDOUT"

assert_false "A3 no curl call on the NO_KEY path" test -s "$STUB_LOG"

finish
