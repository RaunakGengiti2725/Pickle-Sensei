#!/usr/bin/env bash
# S6 — scripts/verify-all.sh --cloud-args '<malformed fragment>'.
#
# verify-all forwards --cloud-args through unquoted word splitting
# (`scripts/verify-cloud.sh $CLOUD_ARGS`). Attack with fragments a human types
# by accident and check that verify-cloud rejects them (exit 2 + usage) BEFORE
# any stage runs, that nothing is "silently the full tier", that artifacts
# (summary.json) survive an argument error mid-run, and what verify-all does
# with the Apple half after the Linux half died on a typo.
#
# SAFETY: every run uses --no-mac except the last check, which executes inside
# a throwaway clone whose origin is a LOCAL bare repo and whose `git push` /
# `gh` are PATH shims — no ci/mac-* branch is ever created, the M4 never runs.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
cd "$REPO_ROOT" || exit 1

run_all() { # <artifacts-dir> <verify-all args...>
  local art="$1"
  shift
  VERIFY_ARTIFACTS="$art" scripts/verify-all.sh "$@"
}

stages_ran() { # <artifacts-dir> → number of stage logs written
  find "$1" -maxdepth 1 -name '*.log' 2>/dev/null | wc -l | tr -d ' '
}

# --- 1. the assigned fragment: '--only ml --skip' (--skip without a value) ----
ART="$OUT/art1"
rc=$(run_capture "$OUT/frag_only_ml_skip.log" run_all "$ART" --no-mac --cloud-args '--only ml --skip')
if grep -q "verify-all: OK" "$OUT/frag_only_ml_skip.log"; then
  record BROKEN s6.dangling_skip "$rc" "$OUT/frag_only_ml_skip.log" "malformed --cloud-args accepted and reported OK"
elif [ "$(stages_ran "$ART")" != 0 ]; then
  record BROKEN s6.dangling_skip "$rc" "$OUT/frag_only_ml_skip.log" "malformed --cloud-args ran $(stages_ran "$ART") stage(s) before failing"
else
  record HELD s6.dangling_skip "$rc" "$OUT/frag_only_ml_skip.log" "no stage ran; verify-all exit $rc — verify-cloud said: $(grep -m1 -E 'unbound variable|unknown argument' "$OUT/frag_only_ml_skip.log" || echo '(no diagnostic)')"
fi
if grep -q "unknown argument" "$OUT/frag_only_ml_skip.log"; then
  record HELD s6.dangling_skip_diag "$rc" "$OUT/frag_only_ml_skip.log" "rejected with the usage error (exit-2 path)"
else
  record BROKEN s6.dangling_skip_diag "$rc" "$OUT/frag_only_ml_skip.log" \
    "rejected only by bash 'set -u' ($(grep -m1 -o '.*unbound variable' "$OUT/frag_only_ml_skip.log" | sed 's/.*: //')), not by the argument parser: no usage text, exit $rc instead of 2"
fi

# --- 2. quotes inside the fragment: --only "ml" → stage name '"ml"' -------------
ART="$OUT/art2"
rc=$(run_capture "$OUT/frag_quoted.log" run_all "$ART" --no-mac --cloud-args '--only "ml"')
if grep -q 'unknown stage: "ml"' "$OUT/frag_quoted.log" && [ "$(stages_ran "$ART")" = 0 ]; then
  record HELD s6.quoted_stage "$rc" "$OUT/frag_quoted.log" "literal quotes rejected as an unknown stage before any stage ran"
else
  record BROKEN s6.quoted_stage "$rc" "$OUT/frag_quoted.log" "exit $rc, stages ran: $(stages_ran "$ART")"
fi

# --- 3. a typo in the SECOND stage: --only ml,bogus ---------------------------
ART="$OUT/art3"
rc=$(run_capture "$OUT/frag_typo_second.log" run_all "$ART" --no-mac --cloud-args '--only ml,bogus')
if [ -f "$ART/summary.json" ]; then
  record HELD s6.typo_after_stage_summary "$rc" "$OUT/frag_typo_second.log" "summary.json written although the run aborted on an unknown stage"
else
  record BROKEN s6.typo_after_stage_summary "$rc" "$OUT/frag_typo_second.log" \
    "ml stage RAN ($(stages_ran "$ART") log(s) in $ART) then 'unknown stage: bogus' exit 2 — no summary.json for a run that executed work (stage validation happens per-iteration, not up front)"
fi

# --- 4. space instead of comma: --only ml edge → 'edge' is an unknown argument -
ART="$OUT/art4"
rc=$(run_capture "$OUT/frag_space.log" run_all "$ART" --no-mac --cloud-args '--only ml edge')
if grep -q "unknown argument: edge" "$OUT/frag_space.log" && [ "$(stages_ran "$ART")" = 0 ]; then
  record HELD s6.space_separated "$rc" "$OUT/frag_space.log" "space-separated stage list rejected before running"
else
  record BROKEN s6.space_separated "$rc" "$OUT/frag_space.log" "exit $rc, stages ran: $(stages_ran "$ART")"
fi

# --- 5. empty --only value: --only '' → STAGES stays the tier (silent full run?)
ART="$OUT/art5"
rc=$(run_capture "$OUT/frag_empty_only.log" run_all "$ART" --no-mac --cloud-args "--only '' --tier bogus")
# --tier bogus guarantees we stop before any stage; the question is only what
# --only '' selected. With word splitting, '' arrives as the two characters ''.
if grep -q "unknown stage: ''" "$OUT/frag_empty_only.log"; then
  record HELD s6.empty_only "$rc" "$OUT/frag_empty_only.log" "--only '' becomes the literal stage name '' and is rejected"
elif grep -q "unknown --tier" "$OUT/frag_empty_only.log"; then
  record HELD s6.empty_only "$rc" "$OUT/frag_empty_only.log" "rejected at --tier before any stage"
else
  record BROKEN s6.empty_only "$rc" "$OUT/frag_empty_only.log" "unexpected: exit $rc, stages ran $(stages_ran "$ART")"
fi

# --- 6. what verify-all does with the Apple half after a Linux argument error --
WORK="$(mktemp -d "${TMPDIR:-/tmp}/attack-s6.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
BARE="$WORK/origin.git"; CLONE="$WORK/clone"
git init -q --bare "$BARE"
git clone -q --local --no-hardlinks "$REPO_ROOT" "$CLONE"
git -C "$CLONE" remote set-url origin "$BARE"
git -C "$CLONE" checkout -q -B attack/s6 "$(git rev-parse HEAD)"
export SHIM_LOG="$OUT/shim_calls.log"; : >"$SHIM_LOG"
REAL_GIT="$(command -v git)"; export REAL_GIT
rc=$(run_capture "$OUT/mac_half_after_typo.log" env PATH="$(shim_path):$PATH" VERIFY_ARTIFACTS="$OUT/art6" \
  bash -c "cd '$CLONE' && scripts/verify-all.sh --cloud-args '--only ml --skip'")
if grep -q "git push" "$SHIM_LOG"; then
  record BROKEN s6.mac_after_cloud_typo "$rc" "$OUT/mac_half_after_typo.log" \
    "Linux half died on the typo, yet verify-all pushed HEAD to $(grep -o 'refs/heads/ci/mac-[^ ]*' "$SHIM_LOG" | head -1) — a 1-2 h Mac run for a mistyped flag"
else
  record HELD s6.mac_after_cloud_typo "$rc" "$OUT/mac_half_after_typo.log" "no Mac push after the Linux half failed to parse its arguments"
fi
if ! git -C "$BARE" show-ref | grep -q "ci/mac-"; then
  record HELD s6.no_real_push 0 "$SHIM_LOG" "no ci/mac-* ref reached the (local) origin"
else
  record BROKEN s6.no_real_push 1 "$SHIM_LOG" "a ci/mac-* ref reached origin — shim did not intercept"
fi

verdict
