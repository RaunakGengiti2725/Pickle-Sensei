#!/usr/bin/env bash
# S5 — scripts/security-scan.sh --history inside a `git clone --depth 1`.
#
# CI checks out with fetch-depth: 0 so the history scan sees every commit. A
# developer / agent that runs the same script from a shallow clone sees ONE
# commit; a secret that was committed and then removed is invisible there and
# the script prints "PASS: no secrets detected" for "history" without saying
# that it looked at one commit. Question: does the script notice
# (`git rev-parse --is-shallow-repository`) and refuse / warn / degrade to
# exit 2, or does it report clean?
#
# Setup: a throwaway upstream (full clone of HEAD) receives one commit that
# ADDS a synthetic AWS-style access key id (matches gitleaks' default
# aws-access-token rule; not a real credential) and a second commit that
# REMOVES it. Then: full clone vs --depth 1 clone, history scan in both.
# Nothing is written to the real repository or any remote.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/attack-s5.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
UP="$WORK/upstream"
git clone -q --local --no-hardlinks "$REPO_ROOT" "$UP"
git -C "$UP" checkout -q -B attack/s5 "$(git -C "$REPO_ROOT" rev-parse HEAD)"

# Deterministic planted token (seed recorded): "AKIA" + 16 uppercase/digits.
SEED=20260904
PLANT="AKIA$(node -e '
let s = Number(process.argv[1]) >>> 0; const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const next = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s; };
let o = ""; for (let i = 0; i < 16; i++) o += A[next() % A.length]; process.stdout.write(o);' "$SEED")"
printf 'seed=%s planted=%s\n' "$SEED" "${PLANT:0:8}…" >"$OUT/seed.txt"

GIT_AUTH=(-c user.name=attack -c user.email=attack@example.invalid)
printf 'aws_access_key_id = %s\naws_secret_access_key = %s\n' "$PLANT" "attack/$(printf '%040d' 7)" >"$UP/services/api/deploy.env"
git -C "$UP" add services/api/deploy.env
git -C "$UP" "${GIT_AUTH[@]}" commit -q -m "s5: plant (synthetic) credential"
git -C "$UP" rm -q services/api/deploy.env
git -C "$UP" "${GIT_AUTH[@]}" commit -q -m "s5: remove credential (still in history)"
UP_HEAD="$(git -C "$UP" rev-parse HEAD)"

FULL="$WORK/full"
SHALLOW="$WORK/shallow"
git clone -q "file://$UP" "$FULL"
git clone -q --depth 1 "file://$UP" "$SHALLOW"
printf 'full=%s shallow=%s\n' "$(git -C "$FULL" rev-parse --is-shallow-repository)" "$(git -C "$SHALLOW" rev-parse --is-shallow-repository)" >"$OUT/shallowness.txt"
printf 'full commits=%s shallow commits=%s\n' "$(git -C "$FULL" rev-list --count HEAD)" "$(git -C "$SHALLOW" rev-list --count HEAD)" >>"$OUT/shallowness.txt"

# Make sure the pinned gitleaks is available once (download if needed) so the
# two runs below are comparable and offline.
rc=$(run_capture "$OUT/warmup.log" scripts/security-scan.sh --tree --log-opts "HEAD~0..HEAD" 2>&1 || true)
GL="$(grep -o 'gitleaks .* at .*' "$OUT/warmup.log" | sed 's/.* at //' | tail -1)"
if [ -z "$GL" ] || [ ! -x "$GL" ]; then
  record BROKEN s5.precondition 2 "$OUT/warmup.log" "could not resolve the pinned gitleaks (offline?) — scenario NOT executed"
  verdict
fi
export GITLEAKS_BIN="$GL"

# --- 1. full clone: history scan MUST find the planted token ------------------
rc=$(run_capture "$OUT/full_history.log" "$FULL/scripts/security-scan.sh" --history --report-dir "$OUT/full-report")
if [ "$rc" = 1 ] && grep -q "history: FINDINGS" "$OUT/full_history.log"; then
  record HELD s5.full_clone_finds "$rc" "$OUT/full_history.log" "fetch-depth 0 equivalent: history scan finds the removed credential (exit 1)"
else
  record BROKEN s5.full_clone_finds "$rc" "$OUT/full_history.log" "full-history scan did not flag the planted credential (exit $rc) — control failed"
  verdict
fi

# --- 2. shallow clone: same command, same secret in upstream history ----------
rc=$(run_capture "$OUT/shallow_history.log" "$SHALLOW/scripts/security-scan.sh" --history --report-dir "$OUT/shallow-report")
if [ "$rc" = 1 ]; then
  record HELD s5.shallow_clone "$rc" "$OUT/shallow_history.log" "shallow clone still surfaced the credential"
elif [ "$rc" = 2 ]; then
  record HELD s5.shallow_clone "$rc" "$OUT/shallow_history.log" "shallow clone refused with a setup error (exit 2) instead of a false PASS"
else
  record BROKEN s5.shallow_clone "$rc" "$OUT/shallow_history.log" \
    "depth-1 clone (1 commit, is-shallow=true): --history says '$(grep -o 'PASS: no secrets detected' "$OUT/shallow_history.log")' on HEAD $UP_HEAD whose parent contains the credential — no shallow check/warning"
fi
grep -ci "shallow" "$OUT/shallow_history.log" >"$OUT/shallow_mentions.txt" || true
if [ "$(cat "$OUT/shallow_mentions.txt")" = 0 ]; then
  record BROKEN s5.shallow_not_mentioned "$rc" "$OUT/shallow_history.log" "output never says the history was truncated ($(git -C "$SHALLOW" rev-list --count HEAD) commit scanned)"
else
  record HELD s5.shallow_not_mentioned "$rc" "$OUT/shallow_history.log" "output mentions shallow history"
fi

# --- 2b. does a FAIL tell you where? (default output, no --verbose) -------------
if grep -q "Fingerprint\|^File:\|Commit:" "$OUT/full_history.log"; then
  record HELD s5.findings_identified 1 "$OUT/full_history.log" "FAIL output names the offending file/commit"
else
  record BROKEN s5.findings_identified 1 "$OUT/full_history.log" \
    "'history: FINDINGS — see output above' but the default run prints only 'leaks found: N' — no file, commit or rule (needs --verbose/--report-dir the caller did not pass)"
fi

# --- 2c. history scope: HEAD's ancestry, or every ref in the checkout? --------
# A secret on an UNMERGED side branch of the upstream must not decide whether
# the commit under test is clean — but `gitleaks git` walks `--all --no-merges`.
git -C "$UP" checkout -q -b other/leak "$(git -C "$REPO_ROOT" rev-parse HEAD)"
printf 'aws_access_key_id = %s\n' "$PLANT" >"$UP/side-branch.env"
git -C "$UP" add side-branch.env
git -C "$UP" "${GIT_AUTH[@]}" commit -q -m "s5: secret on an unmerged side branch"
git -C "$UP" checkout -q attack/s5
git -C "$UP" reset -q --hard "$(git -C "$REPO_ROOT" rev-parse HEAD)" # attack/s5 back to the clean baseline
SIDE="$WORK/side"
git clone -q "file://$UP" "$SIDE" # default clone: all branches become remote-tracking refs
git -C "$SIDE" checkout -q attack/s5
ANC=$(git -C "$SIDE" rev-list --count HEAD --no-merges)
ALL=$(git -C "$SIDE" rev-list --count --all --no-merges)
rc=$(run_capture "$OUT/side_branch_history.log" "$SIDE/scripts/security-scan.sh" --history)
scanned=$(sed 's/\x1b\[[0-9;]*m//g' "$OUT/side_branch_history.log" | grep -o '[0-9]* commits scanned' | head -1)
printf 'HEAD ancestry (no merges)=%s  all refs (no merges)=%s  gitleaks: %s  exit=%s\n' "$ANC" "$ALL" "$scanned" "$rc" >"$OUT/side_branch_scope.txt"
if [ "$rc" = 0 ]; then
  record HELD s5.side_branch_scope "$rc" "$OUT/side_branch_scope.txt" "history scan limited to HEAD's ancestry ($scanned)"
else
  record BROKEN s5.side_branch_scope "$rc" "$OUT/side_branch_scope.txt" \
    "HEAD's ancestry is clean yet --history FAILS (exit $rc): gitleaks scanned $scanned = every fetched ref (--all --no-merges; ancestry=$ANC) — an unmerged branch anywhere on origin fails the gate for every checkout"
fi

# --- 3. --log-opts with a range whose base ref does not exist locally ---------
rc=$(run_capture "$OUT/bad_range.log" "$FULL/scripts/security-scan.sh" --history --log-opts "origin/does-not-exist..HEAD")
if [ "$rc" = 0 ]; then
  record BROKEN s5.bad_log_opts "$rc" "$OUT/bad_range.log" "unresolvable --log-opts range reported PASS"
else
  record HELD s5.bad_log_opts "$rc" "$OUT/bad_range.log" "unresolvable --log-opts range fails (exit $rc), not a false PASS"
fi

# --- 4. --log-opts that selects zero commits (empty range) --------------------
rc=$(run_capture "$OUT/empty_range.log" "$FULL/scripts/security-scan.sh" --history --log-opts "HEAD..HEAD")
if [ "$rc" = 0 ] && grep -q "PASS" "$OUT/empty_range.log"; then
  record BROKEN s5.empty_range_pass "$rc" "$OUT/empty_range.log" "a range selecting 0 commits reports 'PASS: no secrets detected' (a typo'd range in the branch-only mode is a silent skip)"
else
  record HELD s5.empty_range_pass "$rc" "$OUT/empty_range.log" "empty range does not report PASS (exit $rc)"
fi

# --- 5. the same range flag pointed at the planted commit only → must find -----
rc=$(run_capture "$OUT/branch_range.log" "$FULL/scripts/security-scan.sh" --history --log-opts "HEAD~2..HEAD")
if [ "$rc" = 1 ]; then
  record HELD s5.branch_range_finds "$rc" "$OUT/branch_range.log" "branch-only range (HEAD~2..HEAD) finds the credential"
else
  record BROKEN s5.branch_range_finds "$rc" "$OUT/branch_range.log" "branch-only range missed the credential (exit $rc)"
fi

verdict
