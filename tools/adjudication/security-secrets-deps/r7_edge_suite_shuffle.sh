#!/usr/bin/env bash
# R7 — the edge-function suite is order-dependent: `deno task test` (files in
# path order) passes, `--shuffle` fails in account_routes.test.ts (401 where
# 400/429 expected — auth/rate-limit state leaks in from other files).
# HELD = seeds 1..3 all pass; BROKEN = any seed fails.
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
cd "$REPO_ROOT/supabase/functions/api/__wf__"
for seed in 1 2 3; do
  rc=0; deno test -A --no-check --config deno.json --shuffle="$seed" . >"$OUT/r7-shuffle-$seed.log" 2>&1 || rc=$?
  summary="$(sed 's/\x1b\[[0-9;]*m//g' "$OUT/r7-shuffle-$seed.log" | grep -E '^(ok|FAILED) \|' | tail -1)"
  [ "$rc" = 0 ] && verdict HELD "r7:shuffle=$seed" "$summary" || verdict BROKEN "r7:shuffle=$seed" "exit $rc: $summary"
done
finish
