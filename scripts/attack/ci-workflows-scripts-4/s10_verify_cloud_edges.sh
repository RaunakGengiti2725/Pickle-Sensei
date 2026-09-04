#!/usr/bin/env bash
# S10 (extra) — verify-cloud.sh argument / summary edge cases:
#   1. `--only ""`            → must not report OK with zero stages
#   2. `--only ml --skip ml`  → summary.ok with a skipped stage
#   3. `--only ml,bogus`      → unknown stage must be rejected BEFORE any stage runs
#   4. two runs in the same second without VERIFY_ARTIFACTS → distinct artifact dirs?
#   5. stage exit 75 (DATABASE_URL_TEST at a closed port) → status=unavailable, ok=false, exit 1, valid JSON
#   6. mac-full-verify.sh pipeline shape `cmd | tee | { grep || true; } | tail` under
#      `set -uo pipefail` + stage `set -e`: a failing cmd must still fail the stage
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

OUT="$ATTACK_EVIDENCE/s10"
rm -rf "$OUT" && mkdir -p "$OUT"
cd "$REPO_ROOT" || exit 2
json_ok() { node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' "$1" 2>/dev/null; }

# 1. empty --only: only the header is needed (`stages: …` prints before any
#    stage runs); the process is stopped as soon as it appears so a
#    "run everything" answer does not cost a full-tier run.
VERIFY_ARTIFACTS="$OUT/empty-only" setsid scripts/verify-cloud.sh --only "" >"$OUT/empty-only.stdout" 2>&1 &
EMPTY_PID=$!
for _ in $(seq 1 100); do grep -q '^stages: ' "$OUT/empty-only.stdout" 2>/dev/null && break; sleep 0.1; done
kill -TERM -- "-$EMPTY_PID" 2>/dev/null; wait "$EMPTY_PID" 2>/dev/null || true
stages_line="$(grep -m1 '^stages: ' "$OUT/empty-only.stdout" | cut -d' ' -f2-)"
log "--only '' → stages: ${stages_line:-<none>}"
if [ -z "$stages_line" ]; then
  verdict HELD "--only '' is rejected or runs nothing" "no stages line (exited before running)"
else
  verdict BROKEN "--only '' is rejected or runs nothing" "silently expands to the full tier: '$stages_line' (an empty stage list from a caller variable runs every stage instead of erroring)"
fi

# 2. skipped stage → ok?
rc=0; VERIFY_ARTIFACTS="$OUT/skip" scripts/verify-cloud.sh --only ml --skip ml >"$OUT/skip.stdout" 2>&1 || rc=$?
ok="$(summary_field "$OUT/skip/summary.json" ok)"; st="$(stage_status "$OUT/skip/summary.json" ml)"
log "--only ml --skip ml → rc=$rc ok=$ok ml=$st"
if [ "$rc" = 0 ] && [ "$ok" = true ]; then
  verdict BROKEN "explicitly skipped stage does not yield summary.ok=true / exit 0" "rc=0 ok=true ml=$st — a run with nothing verified reads as green"
else
  verdict HELD "explicitly skipped stage does not yield summary.ok=true / exit 0" "rc=$rc ok=$ok"
fi

# 3. unknown stage after a real one
rc=0; VERIFY_ARTIFACTS="$OUT/bogus" scripts/verify-cloud.sh --only ml,bogus >"$OUT/bogus.stdout" 2>&1 || rc=$?
assert_eq "--only ml,bogus exits 2" 2 "$rc"
assert_grep "--only ml,bogus names the unknown stage" "unknown stage: bogus" "$OUT/bogus.stdout"
if [ -f "$OUT/bogus/ml.log" ]; then
  verdict BROKEN "unknown stage is rejected before any stage runs" "ml stage ran ($(grep -m1 '\[ml\] PASS\|\[ml\] FAIL' "$OUT/bogus.stdout")) and then exit 2 with no summary.json"
else
  verdict HELD "unknown stage is rejected before any stage runs" "no ml.log written"
fi
[ -f "$OUT/bogus/summary.json" ] && verdict BROKEN "no summary after arg error" "summary.json written" || verdict HELD "no summary.json after arg error" ""

# 4. same-second collision on the default artifacts dir
CLEAN_A=$(mktemp -d "${TMPDIR:-/tmp}/attack-s10-XXXXXX")
( cd "$REPO_ROOT" && env -u VERIFY_ARTIFACTS scripts/verify-cloud.sh --only ml >"$CLEAN_A/A.stdout" 2>&1; echo $? >"$CLEAN_A/A.rc" ) &
( cd "$REPO_ROOT" && env -u VERIFY_ARTIFACTS scripts/verify-cloud.sh --only ml >"$CLEAN_A/B.stdout" 2>&1; echo $? >"$CLEAN_A/B.rc" ) &
wait
dirA="$(grep -m1 '^artifacts: ' "$CLEAN_A/A.stdout" | cut -d' ' -f2)"; dirB="$(grep -m1 '^artifacts: ' "$CLEAN_A/B.stdout" | cut -d' ' -f2)"
log "same-second runs: A=$dirA B=$dirB"
cp "$CLEAN_A"/*.stdout "$OUT/"
if [ -n "$dirA" ] && [ "$dirA" = "$dirB" ]; then
  verdict BROKEN "two runs started in the same second get distinct artifact dirs" "both wrote $dirA — second summary.json overwrites the first"
else
  verdict HELD "two runs started in the same second get distinct artifact dirs" "A=$dirA B=$dirB"
fi
rm -rf "$CLEAN_A"

# 5. exit 75 path
rc=0; DATABASE_URL_TEST="postgres://pickle:x@127.0.0.1:1/pickle_test" VERIFY_ARTIFACTS="$OUT/unavail" \
  scripts/verify-cloud.sh --only test >"$OUT/unavail.stdout" 2>&1 || rc=$?
assert_eq "test stage with unreachable DB → exit 1" 1 "$rc"
assert_eq "test stage with unreachable DB → status unavailable" unavailable "$(stage_status "$OUT/unavail/summary.json" test)"
assert_eq "test stage with unreachable DB → summary.ok=false" false "$(summary_field "$OUT/unavail/summary.json" ok)"
if json_ok "$OUT/unavail/summary.json"; then verdict HELD "summary.json with unavailable note is valid JSON" ""; else verdict BROKEN "summary.json with unavailable note is valid JSON" "JSON.parse failed"; fi
assert_grep "unavailable stage is printed as UNAVAILABLE, not PASS" "\[test\] UNAVAILABLE" "$OUT/unavail.stdout"

# 6. mac-full-verify pipeline shape (bash semantics only; no Apple claim)
rc=0
bash -c 'set -uo pipefail; stage() { (exit 65) 2>&1 | tee /dev/null | { grep -E "x" || true; } | tail -30; echo "reached-after-pipeline"; }; ( set -e; stage ) ; echo "stage rc=$?"' >"$OUT/pipeline.txt" 2>&1 || rc=$?
log "pipeline shape: $(tr '\n' ' ' <"$OUT/pipeline.txt")"
assert_not_grep "failing xcodebuild-shaped pipeline aborts the stage (set -e + pipefail)" "reached-after-pipeline" "$OUT/pipeline.txt"
assert_grep "failing pipeline propagates the command's exit code" "stage rc=65" "$OUT/pipeline.txt"

finish
