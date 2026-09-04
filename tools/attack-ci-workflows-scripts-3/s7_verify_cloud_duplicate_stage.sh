#!/usr/bin/env bash
# S7 — scripts/verify-cloud.sh --only deps,deps,ml (duplicated stage).
#
# `IFS=',' read -r -a STAGES <<<"$ONLY"` keeps duplicates, and run_stage
# derives the log path from the stage name only ($ARTIFACTS/<name>.log), so a
# repeated stage runs twice and the second run truncates the first run's log
# while summary.json lists two entries pointing at the same file.
# Extra probes on the same selection logic:
#   * --only deps,ml  → the deps stage installs NOTHING (no root/mobile stage
#     selected) yet is recorded as "passed";
#   * --only ml --skip ml → zero stages executed, "verify-cloud: OK", exit 0.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
cd "$REPO_ROOT" || exit 1

count_stage_entries() { # <summary.json> <stage>
  python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(sum(1 for s in d["stages"] if s["name"]==sys.argv[2]))' "$1" "$2"
}

# --- 1. duplicated stage ------------------------------------------------------
ART="$OUT/art_dup"
rc=$(run_capture "$OUT/dup_run.log" env VERIFY_ARTIFACTS="$ART" scripts/verify-cloud.sh --only deps,deps,ml)
starts=$(grep -c "==> \[deps\] start" "$OUT/dup_run.log" || true)
if [ "$starts" = 1 ]; then
  record HELD s7.dedup "$rc" "$OUT/dup_run.log" "duplicate stage name collapsed to one run"
else
  record BROKEN s7.dedup "$rc" "$OUT/dup_run.log" "deps executed $starts times for --only deps,deps,ml"
fi
if [ -f "$ART/summary.json" ]; then
  entries=$(count_stage_entries "$ART/summary.json" deps)
  logs=$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(len({s["log"] for s in d["stages"] if s["name"]=="deps"}))' "$ART/summary.json")
  runs_in_log=$(grep -c "skipping root pnpm install\|pnpm install" "$ART/deps.log" || true)
  if [ "$entries" -gt 1 ] && [ "$logs" = 1 ]; then
    record BROKEN s7.log_overwrite "$rc" "$ART/summary.json" \
      "summary.json has $entries deps entries all pointing at the same deps.log; the file holds $runs_in_log run's worth of output (first run's log truncated by the second)"
  else
    record HELD s7.log_overwrite "$rc" "$ART/summary.json" "distinct logs per run ($logs) or single entry ($entries)"
  fi
else
  record BROKEN s7.log_overwrite "$rc" "$OUT/dup_run.log" "no summary.json written"
fi

# --- 2. deps stage with nothing to install still 'passed' ---------------------
ART="$OUT/art_deps_ml"
rc=$(run_capture "$OUT/deps_ml_run.log" env VERIFY_ARTIFACTS="$ART" scripts/verify-cloud.sh --only deps,ml)
status=$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print([s["status"] for s in d["stages"] if s["name"]=="deps"][0])' "$ART/summary.json" 2>/dev/null || echo none)
if [ "$status" = passed ] && grep -q "skipping root pnpm install" "$ART/deps.log" && ! grep -q "npm ci" "$ART/deps.log"; then
  record BROKEN s7.deps_noop_passed "$rc" "$ART/deps.log" "deps recorded 'passed' after installing nothing (no root install, no npm ci) — a no-op reported as a pass"
else
  record HELD s7.deps_noop_passed "$rc" "$ART/deps.log" "deps status=$status with real work or an honest label"
fi

# --- 3. every selected stage skipped → run still OK ---------------------------
ART="$OUT/art_all_skipped"
rc=$(run_capture "$OUT/all_skipped_run.log" env VERIFY_ARTIFACTS="$ART" scripts/verify-cloud.sh --only ml --skip ml)
ok=$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(d["ok"], sum(1 for s in d["stages"] if s["status"]=="passed"))' "$ART/summary.json" 2>/dev/null || echo "none 0")
if [ "$rc" = 0 ] && [ "${ok%% *}" = True ]; then
  record BROKEN s7.all_skipped_ok "$rc" "$ART/summary.json" "0 stages executed, everything --skip'd, yet exit 0 / 'verify-cloud: OK' / summary ok=true (a fully skipped run reads as a pass)"
else
  record HELD s7.all_skipped_ok "$rc" "$ART/summary.json" "fully skipped run is not OK (exit $rc, ok=$ok)"
fi

# --- 4. --only with a trailing comma / empty element --------------------------
ART="$OUT/art_trailing_comma"
rc=$(run_capture "$OUT/trailing_comma.log" env VERIFY_ARTIFACTS="$ART" scripts/verify-cloud.sh --only "ml,")
if [ "$rc" = 0 ]; then
  record HELD s7.trailing_comma "$rc" "$OUT/trailing_comma.log" "trailing comma tolerated (bash read drops the empty trailing field)"
else
  record BROKEN s7.trailing_comma "$rc" "$OUT/trailing_comma.log" "'ml,' → exit $rc: $(grep -m1 'unknown' "$OUT/trailing_comma.log")"
fi
ART="$OUT/art_double_comma"
rc=$(run_capture "$OUT/double_comma.log" env VERIFY_ARTIFACTS="$ART" scripts/verify-cloud.sh --only "ml,,ml")
if grep -q "unknown stage: $" "$OUT/double_comma.log" || grep -q "unknown stage: *$" "$OUT/double_comma.log"; then
  record HELD s7.double_comma "$rc" "$OUT/double_comma.log" "empty stage name rejected (after running the first ml)"
else
  record BROKEN s7.double_comma "$rc" "$OUT/double_comma.log" "'ml,,ml' → exit $rc without an unknown-stage error"
fi

# --- 5. two runs started in the same second share artifacts/verify-cloud/<STAMP> -
# STAMP has 1-second resolution and VERIFY_ARTIFACTS is optional, so parallel
# runs (two agents, a retry racing a hung run) write into ONE directory.
# The launch is retried until both processes land in the same UTC second.
collide=""
for attempt in 1 2 3 4 5; do
  scripts/verify-cloud.sh --only ml >"$OUT/concurrent_a.log" 2>&1 &
  pa=$!
  scripts/verify-cloud.sh --only ml >"$OUT/concurrent_b.log" 2>&1 &
  pb=$!
  wait "$pa" "$pb"
  da=$(grep -m1 '^artifacts: ' "$OUT/concurrent_a.log" | cut -d' ' -f2)
  db=$(grep -m1 '^artifacts: ' "$OUT/concurrent_b.log" | cut -d' ' -f2)
  printf 'attempt %s: a=%s b=%s\n' "$attempt" "$da" "$db" >>"$OUT/concurrent_attempts.txt"
  if [ "$da" = "$db" ]; then collide="$da"; break; fi
done
if [ -n "$collide" ]; then
  record BROKEN s7.same_second_collision 0 "$OUT/concurrent_attempts.txt" "two default runs started in the same second both wrote $collide (ml.log + summary.json overwritten by whichever finished last)"
  rm -rf "$collide"
else
  record HELD s7.same_second_collision 0 "$OUT/concurrent_attempts.txt" "could not land two runs in the same second in 5 attempts (dirs differed) — collision not demonstrated here"
  while read -r line; do rm -rf "${line##*a=}" 2>/dev/null; done <"$OUT/concurrent_attempts.txt"
fi

verdict
