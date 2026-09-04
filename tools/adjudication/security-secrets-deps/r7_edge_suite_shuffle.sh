#!/usr/bin/env bash
# R7 — the edge-function suite must be order-independent: the canonical
# `deno task test` (files in path order) AND `deno test --shuffle=<seed>` for
# every seed must pass with 0 failed. The original defect: account_routes.test.ts
# registered its fake-Supabase teardown as an ordinary Deno.test, so under
# --shuffle it could run mid-file and every later route test saw 401 (fake
# GoTrue unreachable) where 400/429 was expected.
# HELD = control + every seed pass; BROKEN = any run fails.
# Seeds default to 1 2 3; override with R7_SEEDS="1 2 3 7 42".
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
cd "$REPO_ROOT/supabase/functions/api/__wf__"
summary_of() { sed 's/\x1b\[[0-9;]*m//g' "$1" | grep -E '^(ok|FAILED) \|' | tail -1; }

rc=0; deno task test >"$OUT/r7-default.log" 2>&1 || rc=$?
summary="$(summary_of "$OUT/r7-default.log")"
[ "$rc" = 0 ] && verdict HELD "r7:default-order" "$summary" || verdict BROKEN "r7:default-order" "exit $rc: $summary"

for seed in ${R7_SEEDS:-1 2 3}; do
  rc=0; deno test -A --no-check --config deno.json --shuffle="$seed" . >"$OUT/r7-shuffle-$seed.log" 2>&1 || rc=$?
  summary="$(summary_of "$OUT/r7-shuffle-$seed.log")"
  [ "$rc" = 0 ] && verdict HELD "r7:shuffle=$seed" "$summary" || verdict BROKEN "r7:shuffle=$seed" "exit $rc: $summary"
done
finish
