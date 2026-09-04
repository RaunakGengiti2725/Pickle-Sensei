#!/usr/bin/env bash
# S8 (self-added) — CLI / workflow edge cases for scripts/verify-cloud.sh,
# .github/workflows/mac-full-verify.yml and tools/macos-ci/apple-paths-changed.sh.
# Nothing here touches GitHub or the Mac runner: workflow `run:` blocks are
# executed locally with stubs, exactly as GitHub would (bash -eo pipefail).
#
# Cases:
#   all_skipped        --tier pr --skip <every pr stage>  -> exit 0 / ok:true with 0 stages run?
#   stamp_collision    two verify-cloud runs started in the same second share
#                      artifacts/verify-cloud/<STAMP> (logs/summary clobber each other)
#   dirty_bigtree      "dirty" field with a huge `git status` (pipefail + grep -q SIGPIPE race)
#   changes_swallow    `echo "run=$(apple-paths-changed.sh ...)"` hides a script failure -> run= (Mac silently skipped)
#   step_summary_red   does the "Step summary" step exit 1 when launch/launch-summary.txt is
#                      absent (launch_check=false / ios-app failed)? (`[ -f ] && cat` under -e)
#   lint               shellcheck run on scripts/*.sh tools/**/*.sh (informational; severity=error only counts)
#
# Exit 0 = all HELD, 1 = at least one BROKEN. Results in $OUT/results.jsonl.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
OUT="${S8_OUT:-/tmp/attack-s8-$(date -u +%Y%m%dT%H%M%SZ)}"
mkdir -p "$OUT"
WT="$OUT/worktree"
BROKEN=0
: >"$OUT/results.jsonl"

cd "$REPO_ROOT" || exit 2
git worktree add --detach -q "$WT" HEAD || exit 2
trap 'cd "$REPO_ROOT"; git worktree remove --force "$WT" >/dev/null 2>&1' EXIT

rec() { # case verdict detail-json-fragment
  [ "$2" = BROKEN ] && BROKEN=1
  printf '{"case":"%s","verdict":"%s",%s}\n' "$1" "$2" "$3" | tee -a "$OUT/results.jsonl"
}

# ---------------------------------------------------------------- all_skipped
ART="$OUT/all_skipped-artifacts"
(cd "$WT" && VERIFY_ARTIFACTS="$ART" scripts/verify-cloud.sh --tier pr \
  --skip deps,format,lint,typecheck,test,db,mobile,ml,edge,rls,security) >"$OUT/all_skipped.out" 2>&1
rc=$?
ok="$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(d["ok"], sum(s["status"]=="passed" for s in d["stages"]), sum(s["status"]=="skipped" for s in d["stages"]))' "$ART/summary.json")"
read -r okv passed skipped <<<"$ok"
v=HELD; [ $rc -eq 0 ] && [ "$okv" = True ] && [ "$passed" = 0 ] && v=BROKEN
rec all_skipped $v "\"verify_exit\":$rc,\"ok\":\"$okv\",\"passed\":$passed,\"skipped\":$skipped,\"last_line\":\"$(tail -n1 "$OUT/all_skipped.out")\",\"summary\":\"$ART/summary.json\""

# ------------------------------------------------------------ stamp_collision
collided=no; attempts=0; dirA=""; dirB=""
while [ $attempts -lt 8 ] && [ $collided = no ]; do
  attempts=$((attempts + 1))
  (cd "$WT" && scripts/verify-cloud.sh --only release >"$OUT/stamp_A.$attempts.out" 2>&1) &
  (cd "$WT" && scripts/verify-cloud.sh --only release >"$OUT/stamp_B.$attempts.out" 2>&1) &
  wait
  dirA="$(grep -o 'artifacts/verify-cloud/[0-9TZ]*' "$OUT/stamp_A.$attempts.out" | head -1)"
  dirB="$(grep -o 'artifacts/verify-cloud/[0-9TZ]*' "$OUT/stamp_B.$attempts.out" | head -1)"
  [ -n "$dirA" ] && [ "$dirA" = "$dirB" ] && collided=yes
done
if [ $collided = yes ]; then
  n_summaries="$(find "$WT/$dirA" -name summary.json | wc -l)"
  rec stamp_collision BROKEN "\"attempts\":$attempts,\"shared_dir\":\"$dirA\",\"summaries_in_dir\":$n_summaries,\"outA\":\"$OUT/stamp_A.$attempts.out\",\"outB\":\"$OUT/stamp_B.$attempts.out\""
else
  rec stamp_collision HELD "\"attempts\":$attempts,\"dirA\":\"$dirA\",\"dirB\":\"$dirB\",\"note\":\"could not start two runs within one second\""
fi

# -------------------------------------------------------------- dirty_bigtree
# top-level files: `git status --porcelain` collapses an untracked DIRECTORY to
# one line, so each file must sit in the worktree root to produce its own line.
(cd "$WT" && for i in $(seq 1 20000); do : >"attack-untracked-file-with-a-long-name-to-fill-the-pipe-$i.txt"; done)
status_bytes="$(cd "$WT" && git status --porcelain | wc -c)"
false_clean=0; runs=10
for i in $(seq 1 $runs); do
  ART="$OUT/dirty_bigtree-$i"
  (cd "$WT" && VERIFY_ARTIFACTS="$ART" scripts/verify-cloud.sh --only release) >/dev/null 2>&1
  grep -q '"dirty": true' "$ART/summary.json" || false_clean=$((false_clean + 1))
done
(cd "$WT" && find . -maxdepth 1 -name 'attack-untracked-file-*' -delete)
v=HELD; [ $false_clean -gt 0 ] && v=BROKEN
rec dirty_bigtree $v "\"git_status_bytes\":$status_bytes,\"runs\":$runs,\"dirty_false_count\":$false_clean,\"example_summary\":\"$OUT/dirty_bigtree-1/summary.json\""

# ------------------------------------------------------------- changes_swallow
# The `changes` job step verbatim (mac-full-verify.yml `decide`), run the way
# GitHub runs `run:` blocks: bash -eo pipefail. AFTER = unknown sha => the
# helper dies (git diff fails, set -e) but echo still succeeds.
GH_OUT="$OUT/changes_swallow.github_output"; : >"$GH_OUT"
(cd "$WT" && BEFORE="$(git rev-parse HEAD~1)" AFTER="deadbeefdeadbeefdeadbeefdeadbeefdeadbeef" ON_DEMAND=false GITHUB_OUTPUT="$GH_OUT" \
  bash -eo pipefail -c '
if [ "$ON_DEMAND" = "true" ]; then
  echo "on-demand run"; echo "run=true" >> "$GITHUB_OUTPUT"; exit 0
fi
echo "run=$(tools/macos-ci/apple-paths-changed.sh "$BEFORE" "$AFTER")" >> "$GITHUB_OUTPUT"
') >"$OUT/changes_swallow.out" 2>&1
step_rc=$?
(cd "$WT" && tools/macos-ci/apple-paths-changed.sh "$(git rev-parse HEAD~1)" deadbeefdeadbeefdeadbeefdeadbeefdeadbeef) >"$OUT/changes_direct.out" 2>&1
direct_rc=$?
out_line="$(cat "$GH_OUT" | tr -d '\n')"
v=HELD; [ $step_rc -eq 0 ] && [ $direct_rc -ne 0 ] && v=BROKEN
rec changes_swallow $v "\"step_exit\":$step_rc,\"helper_exit\":$direct_rc,\"github_output\":\"$out_line\",\"effect\":\"needs.changes.outputs.run != true => mac job skipped, workflow green\",\"log\":\"$OUT/changes_swallow.out\""

# ------------------------------------------------------------ step_summary_red
# "Step summary" step verbatim, with sw_vers/xcodebuild stubbed and an
# artifacts dir as left by a SUCCESSFUL run with launch_check=false
# (summary.json + xcresult summary present, launch/ absent).
STUB="$OUT/stub"; mkdir -p "$STUB"
printf '#!/usr/bin/env bash\necho stub-%s\n' sw_vers >"$STUB/sw_vers"
printf '#!/usr/bin/env bash\necho stub-xcodebuild\n' >"$STUB/xcodebuild"
chmod +x "$STUB"/*
step_summary() { # artifacts-dir
  PATH="$STUB:$PATH" MAC_ARTIFACTS="$1" GITHUB_STEP_SUMMARY="$OUT/step_summary.md" bash -eo pipefail -c '
{
  echo "### Mac Full Verify"
  echo '"'"'```'"'"'
  sw_vers; xcodebuild -version
  [ -f "$MAC_ARTIFACTS/summary.json" ] && cat "$MAC_ARTIFACTS/summary.json"
  [ -f "$MAC_ARTIFACTS/swift-native-xcresult-summary.txt" ] && cat "$MAC_ARTIFACTS/swift-native-xcresult-summary.txt"
  [ -f "$MAC_ARTIFACTS/launch/launch-summary.txt" ] && cat "$MAC_ARTIFACTS/launch/launch-summary.txt"
  echo '"'"'```'"'"'
} >> "$GITHUB_STEP_SUMMARY"
'
}
A1="$OUT/mac-artifacts-nolaunch"; mkdir -p "$A1"
echo '{"ok": true}' >"$A1/summary.json"; echo "xcresult ok" >"$A1/swift-native-xcresult-summary.txt"
step_summary "$A1"; rc_nolaunch=$?
A2="$OUT/mac-artifacts-full"; mkdir -p "$A2/launch"
cp "$A1"/* "$A2/"; echo "launch ok" >"$A2/launch/launch-summary.txt"
step_summary "$A2"; rc_full=$?
A3="$OUT/mac-artifacts-empty"; mkdir -p "$A3"
step_summary "$A3"; rc_empty=$?
v=HELD; [ $rc_nolaunch -ne 0 ] && v=BROKEN
rec step_summary_red $v "\"exit_without_launch_summary\":$rc_nolaunch,\"exit_all_files\":$rc_full,\"exit_no_files\":$rc_empty,\"note\":\"step has if: always(); a non-zero exit marks the job failed even when the verify step passed\""

# ------------------------------------------------------------------ shellcheck
if command -v shellcheck >/dev/null 2>&1; then
  mapfile -t SH < <(cd "$WT" && git ls-files 'scripts/*.sh' 'tools/macos-ci/*.sh' 'tools/devin/*.sh')
  (cd "$WT" && shellcheck -S warning -f gcc "${SH[@]}") >"$OUT/shellcheck.gcc.txt" 2>&1
  sc_rc=$?
  errors="$(grep -c ': error:' "$OUT/shellcheck.gcc.txt")"
  warnings="$(grep -c ': warning:' "$OUT/shellcheck.gcc.txt")"
  v=HELD; [ "$errors" -gt 0 ] && v=BROKEN
  rec shellcheck $v "\"shellcheck_exit\":$sc_rc,\"files\":${#SH[@]},\"errors\":$errors,\"warnings\":$warnings,\"report\":\"$OUT/shellcheck.gcc.txt\",\"version\":\"$(shellcheck --version | sed -n 's/^version: //p')\""
else
  rec shellcheck HELD "\"note\":\"shellcheck not installed; not run\""
fi

echo "== results: $OUT/results.jsonl"
exit $BROKEN
