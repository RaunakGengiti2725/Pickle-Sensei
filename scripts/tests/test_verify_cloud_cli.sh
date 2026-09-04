#!/usr/bin/env bash
# Regression tests for scripts/verify-cloud.sh verdict semantics.
#
# "Skipped is not a pass": `ok` in summary.json must equal "at least one stage
# ran and every recorded stage passed", the exit code must agree with `ok`,
# and a run whose selected stages were all skipped must say so. Runs the real
# script against this checkout with cheap stage selections (`release` is a
# sub-second node check; `e2e`/`ml` are only ever skipped here). Needs jq.
#
#   scripts/tests/test_verify_cloud_cli.sh
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
cd "$REPO_ROOT"

FAILURES=0
pass() { printf 'ok   - %s\n' "$*"; }
fail() { printf 'FAIL - %s\n' "$*"; FAILURES=$((FAILURES + 1)); }
check() { # check <description> <command...>  (stdout of the command is discarded)
  local desc="$1"; shift
  if "$@" >/dev/null; then pass "$desc"; else fail "$desc"; fi
}

declare -a RUNS=()
# run <label> <args...> — runs verify-cloud.sh with its own artifact dir; records exit code.
run() {
  local label="$1"; shift
  RUNS+=("$label")
  VERIFY_ARTIFACTS="$WORK/$label" scripts/verify-cloud.sh "$@" >"$WORK/$label.log" 2>&1
  echo "$?" >"$WORK/$label.rc"
}
rc_of() { cat "$WORK/$1.rc"; }
summary_of() { printf '%s' "$WORK/$1/summary.json"; }

pr_stages="$(sed -n 's/^PR_STAGES=(\(.*\))$/\1/p' scripts/verify-cloud.sh | tr ' ' ',')"
[ -n "$pr_stages" ] || { echo "could not read PR_STAGES from scripts/verify-cloud.sh" >&2; exit 2; }

echo "# --- zero stages executed ---"
run only-skip-same --only ml --skip ml
check "--only ml --skip ml exits non-zero (exit $(rc_of only-skip-same))" [ "$(rc_of only-skip-same)" -ne 0 ]
check "--only ml --skip ml: ok is false" jq -e '.ok == false' "$(summary_of only-skip-same)"
check "--only ml --skip ml: reason says no stages executed" \
  jq -e '.reason | test("no stages executed"; "i")' "$(summary_of only-skip-same)"
check "--only ml --skip ml: stdout does not end in 'verify-cloud: OK'" \
  bash -c '! grep -qx "verify-cloud: OK" "$1"' _ "$WORK/only-skip-same.log"

run pr-skip-all --tier pr --skip "$pr_stages"
check "--tier pr --skip <all pr stages> exits non-zero (exit $(rc_of pr-skip-all))" [ "$(rc_of pr-skip-all)" -ne 0 ]
check "--tier pr --skip <all>: ok is false with a no-stages-executed reason" \
  jq -e '.ok == false and (.reason | test("no stages executed"; "i"))' "$(summary_of pr-skip-all)"

echo "# --- a skipped stage beside passing ones is not a pass ---"
run partial-skip --only release,e2e --skip e2e
check "--only release,e2e --skip e2e exits non-zero (exit $(rc_of partial-skip))" [ "$(rc_of partial-skip)" -ne 0 ]
check "partial skip: release passed, e2e recorded as skipped" \
  jq -e '(.stages | map({(.name): .status}) | add) == {"release": "passed", "e2e": "skipped"}' "$(summary_of partial-skip)"
check "partial skip: ok is false and reason names the skipped stage" \
  jq -e '.ok == false and (.reason | test("skipped") and test("e2e"))' "$(summary_of partial-skip)"

echo "# --- a normal all-passed run is unaffected ---"
run all-passed --only release
check "--only release exits 0 (exit $(rc_of all-passed))" [ "$(rc_of all-passed)" -eq 0 ]
check "--only release: ok is true and reason is null" \
  jq -e '.ok == true and .reason == null' "$(summary_of all-passed)"
check "--only release: stdout ends in 'verify-cloud: OK'" grep -qx "verify-cloud: OK" "$WORK/all-passed.log"

echo "# --- invariants over every run above ---"
for label in "${RUNS[@]}"; do
  s="$(summary_of "$label")"
  check "$label: summary.json is valid JSON" jq -e . "$s"
  check "$label: ok == (stages non-empty and every recorded status is passed)" \
    jq -e '.ok == ((.stages | length) > 0 and all(.stages[]; .status == "passed"))' "$s"
  if jq -e '.ok' "$s" >/dev/null 2>&1; then
    check "$label: exit code 0 iff ok (exit $(rc_of "$label"))" [ "$(rc_of "$label")" -eq 0 ]
  else
    check "$label: exit code non-zero iff not ok (exit $(rc_of "$label"))" [ "$(rc_of "$label")" -ne 0 ]
  fi
done

echo
if [ "$FAILURES" -ne 0 ]; then
  echo "test_verify_cloud_cli: $FAILURES failure(s); logs under $WORK:"
  for label in "${RUNS[@]}"; do echo "--- $label (exit $(rc_of "$label"))"; tail -n 8 "$WORK/$label.log" | sed 's/^/    /'; done
  trap - EXIT # keep the evidence
  exit 1
fi
echo "test_verify_cloud_cli: all checks passed"
