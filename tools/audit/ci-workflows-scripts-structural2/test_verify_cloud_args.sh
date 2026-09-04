#!/usr/bin/env bash
# scripts/verify-cloud.sh argument handling and artifact hygiene.
#
# Asserts (desired behaviour):
#   A1  `--only <unknown>` exits 2 AND leaves no artifact directory behind
#   A2  `--only ml,ml` runs the ml stage once and summary.json lists it once
#   A3  `--only ""` is rejected (or at least not silently widened to the full tier)
#   A4  exit 75 from a stage is recorded as ok:false/status unavailable and the
#       run exits 1 (an unavailable stage is never a pass)
#   A5  a stage failure exits 1 with status "failed"
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

SB=$(mktemp -d)
trap 'rm -rf "$SB"' EXIT
new_verify_cloud_sandbox "$SB"

# A1 unknown stage
run_verify_cloud --only bogus
assert_eq "A1 unknown stage exit code" 2 "$RC"
dirs=$(find "$SB/artifacts" -mindepth 2 -maxdepth 2 -type d 2>/dev/null | wc -l)
assert_eq "A1 no artifact dir created for a rejected invocation" 0 "$dirs"
find "$SB/artifacts" -mindepth 2 -maxdepth 2 -type d 2>/dev/null >"$AUDIT_OUT/args_A1_dirs.txt"

# A2 duplicate stage names
: >"$STUB_LOG"
rm -rf "$SB/artifacts"
run_verify_cloud --only ml,ml
assert_eq "A2 --only ml,ml exit code" 0 "$RC"
runs=$(grep -c '^python3 ' "$STUB_LOG")
assert_eq "A2 ml stage executed once" 1 "$runs"
summary=$(ls "$SB"/artifacts/verify-cloud/*/summary.json 2>/dev/null | head -1)
entries=$(jq '[.stages[] | select(.name=="ml")] | length' "$summary")
assert_eq "A2 summary.json lists ml once" 1 "$entries"
cp "$summary" "$AUDIT_OUT/args_A2_summary.json"

# A3 empty --only
: >"$STUB_LOG"
rm -rf "$SB/artifacts"
run_verify_cloud --only ""
stages_run=$(ls "$SB"/artifacts/verify-cloud/*/ 2>/dev/null | grep -c '\.log$')
printf '%s\n' "$OUT" >"$AUDIT_OUT/args_A3_output.txt"
assert_true "A3 --only '' rejected (exit 2) or runs nothing" test "$RC" -eq 2 -o "$stages_run" -eq 0

# A4 exit 75 (missing tool → `need deno`) → unavailable → run fails
: >"$STUB_LOG"
rm -rf "$SB/artifacts"
rm -f "$SB/bin/deno"
run_verify_cloud --only edge
assert_false "A4 sandbox really has no deno" grep -q '^deno ' "$STUB_LOG"
run_verify_cloud --only edge
assert_eq "A4 unavailable stage fails the run" 1 "$RC"
summary=$(ls "$SB"/artifacts/verify-cloud/*/summary.json | head -1)
assert_eq "A4 summary ok=false" false "$(jq -r '.ok' "$summary")"
assert_eq "A4 stage status unavailable" unavailable "$(jq -r '.stages[0].status' "$summary")"
cp "$summary" "$AUDIT_OUT/args_A4_summary.json"

# A5 plain failure
rm -rf "$SB/artifacts"
make_stub "$SB/bin" deno 'exit 3'
run_verify_cloud --only edge
assert_eq "A5 failed stage exits 1" 1 "$RC"
summary=$(ls "$SB"/artifacts/verify-cloud/*/summary.json | head -1)
assert_eq "A5 stage status failed" failed "$(jq -r '.stages[0].status' "$summary")"
assert_eq "A5 note records exit code" "exit 3" "$(jq -r '.stages[0].note' "$summary")"

finish
