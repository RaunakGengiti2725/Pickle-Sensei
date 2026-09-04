#!/usr/bin/env bash
# .github/workflows/mac-full-verify.yml — `${{ inputs.only }}` is expanded by the
# GitHub expression engine INTO the shell source of the "Run canonical Apple
# verification" step before bash sees it. This test renders that step exactly as
# the runner would (textual substitution of the four `${{ inputs.* }}`
# expressions) with a hostile `only` value and executes it with a stub
# scripts/mac-full-verify.sh. Nothing here contacts GitHub or the Mac runner.
#
# Asserts (desired behaviour):
#   I1  a dispatch input cannot execute arbitrary commands on the runner
#       (the marker file must not be created)
#   I2  the hostile string reaches scripts/mac-full-verify.sh as ONE --only value
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

SB=$(mktemp -d)
trap 'rm -rf "$SB"' EXIT
WF="$REPO_ROOT/.github/workflows/mac-full-verify.yml"

# Extract the run: | body of the step (from `set -o pipefail` to the invocation line).
body=$(sed -n '/name: Run canonical Apple verification/,/- name: Step summary/p' "$WF" \
  | grep -E '^ {10}[^ ]' | sed -E 's/^ {10}//')
assert_true "precondition: step body extracted" grep -q 'scripts/mac-full-verify.sh' <<<"$body"
printf '%s\n' "$body" >"$AUDIT_OUT/injection_step_body.sh"

MARK="$SB/pwned-by-dispatch-input"
# Command substitution is valid in both places the input is spliced (the test
# and the array element), so it executes on the runner as part of the step.
PAYLOAD="\$(touch $MARK)pose"

rendered=${body//'${{ inputs.only }}'/$PAYLOAD}
rendered=${rendered//'${{ inputs.clean_build }}'/false}
rendered=${rendered//'${{ inputs.launch_check }}'/true}
rendered=${rendered//'${{ inputs.js_checks }}'/false}
printf '%s\n' "$rendered" >"$AUDIT_OUT/injection_step_rendered.sh"

mkdir -p "$SB/scripts"
cat >"$SB/scripts/mac-full-verify.sh" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$#" >"$RECEIVED"
printf '%s\n' "$@" >>"$RECEIVED"
EOF
chmod +x "$SB/scripts/mac-full-verify.sh"

(cd "$SB" && RECEIVED="$SB/received.txt" bash -c "$rendered") >"$AUDIT_OUT/injection_run.log" 2>&1
log "rendered step exit code: $?"
cp "$SB/received.txt" "$AUDIT_OUT/injection_received_args.txt" 2>/dev/null

assert_false "I1 dispatch input did not execute commands (marker absent)" test -e "$MARK"
assert_eq "I2 mac-full-verify.sh received --only + one value + --skip-js (4 args)" 4 "$(head -1 "$SB/received.txt" 2>/dev/null)"

finish
