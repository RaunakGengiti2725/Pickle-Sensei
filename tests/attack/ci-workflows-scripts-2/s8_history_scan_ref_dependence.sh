#!/usr/bin/env bash
# Extra scenario 8 — is the history scan a function of the COMMIT under test,
# or of whatever refs happen to exist in the clone?
#
# scripts/security-scan.sh --history (and the default full scan that
# verify-cloud's security stage runs) calls `gitleaks git .` with no
# --log-opts. gitleaks then walks every ref in the repository, not just HEAD's
# ancestry. Consequences measured here, all in a scratch clone so this checkout
# is never modified:
#
#   head-only   scratch clone containing only HEAD → history exit 0 (baseline)
#   stray-ref   add ONE local branch (never checked out, never merged) whose
#               single commit adds a synthetic sb_secret_, switch back to HEAD,
#               run the full scan → exit 1 although HEAD's tree+history are clean
#   dangling    delete that branch; the commit is now unreachable → exit 0 again
#               (i.e. the verdict flips with `git branch -D`, not with any change
#               to the code under test)
#   this-clone  informational: in THIS clone (with origin/* fetched) count the
#               history findings and how many live outside HEAD's ancestry.
#   head-opts   `--history --log-opts HEAD` on this clone → exit 0 confirms
#               HEAD's ancestry is clean and that the flag restores determinism.
# shellcheck source=tests/attack/ci-workflows-scripts-2/lib.sh
source "$(dirname "$0")/lib.sh"
cd "$ATTACK_REPO_ROOT" || exit 2

overall=0
SUFFIX="$(seeded_token s8 40)"
SECRET="sb_secret_${SUFFIX}"
SCRATCH="$ATTACK_OUT/s8-scratch"
register_cleanup "$SCRATCH"
scratch_clone "$SCRATCH"
HEAD_SHA="$(git -C "$SCRATCH" rev-parse HEAD)"

scan() { # $1 label, rest = args; runs in scratch, returns rc
  local label="$1"; shift
  local rc=0
  (cd "$SCRATCH" && scripts/security-scan.sh "$@" --report-dir "$ATTACK_OUT/s8-$label-report") >"$ATTACK_OUT/s8-$label.log" 2>&1 || rc=$?
  echo "exit=$rc" >>"$ATTACK_OUT/s8-$label.log"
  return $rc
}

# --- head-only -----------------------------------------------------------------
rc=0; scan head-only || rc=$?
if [ "$rc" = 0 ]; then
  record_verdict s8-head-only HELD "scratch clone (HEAD only, $(git -C "$SCRATCH" for-each-ref | wc -l | tr -d ' ') ref(s)): full scan exit 0" "exit 0" "$ATTACK_OUT/s8-head-only.log"
else
  record_verdict s8-head-only BROKEN "full scan on a HEAD-only clone exit $rc" "exit 0" "$ATTACK_OUT/s8-head-only.log"; overall=1
  exit $overall   # the rest of the experiment needs a clean baseline
fi

# --- stray-ref -----------------------------------------------------------------
(
  cd "$SCRATCH" || exit 2
  git -c user.name=attack -c user.email=attack@example.invalid checkout -q -b attack/stray-secret
  printf 'SUPABASE_SECRET_KEY=%s\n' "$SECRET" >stray-note.txt
  git add stray-note.txt
  git -c user.name=attack -c user.email=attack@example.invalid commit -q -m "stray branch with a synthetic key"
  git checkout -q --detach "$HEAD_SHA"
)
[ "$(git -C "$SCRATCH" rev-parse HEAD)" = "$HEAD_SHA" ] || { alog "scratch HEAD drifted"; exit 2; }
[ -f "$SCRATCH/stray-note.txt" ] && { alog "plant leaked into HEAD's tree"; exit 2; }
rc=0; scan stray-ref || rc=$?
assert_secret_absent "stray-ref: no plaintext in log" "$SUFFIX" "$ATTACK_OUT/s8-stray-ref.log" || true
if [ "$rc" = 1 ] && grep -q 'history: FINDINGS' "$ATTACK_OUT/s8-stray-ref.log" && grep -q 'tree: clean' "$ATTACK_OUT/s8-stray-ref.log"; then
  record_verdict s8-stray-ref BROKEN \
    "HEAD unchanged ($HEAD_SHA), tree clean, HEAD ancestry clean — yet the full scan exits 1 because an unrelated local branch holds a secret (gitleaks walks all refs)" \
    "the gate for commit X should depend only on X (tree + ancestry), e.g. --log-opts HEAD / \${GITHUB_SHA}; unrelated refs must not flip the verdict" \
    "$ATTACK_OUT/s8-stray-ref.log" "$ATTACK_OUT/s8-stray-ref-report/gitleaks-history.json"
  overall=1
else
  record_verdict s8-stray-ref HELD "exit $rc with a stray secret-bearing branch present" "exit 0 (HEAD is clean)" "$ATTACK_OUT/s8-stray-ref.log"
fi

# --- dangling ------------------------------------------------------------------
git -C "$SCRATCH" branch -q -D attack/stray-secret
rc=0; scan dangling || rc=$?
record_verdict s8-dangling INFO "after 'git branch -D' (no code change) the same scan exits $rc" \
  "shows the verdict tracks ref layout, not the commit under test" "$ATTACK_OUT/s8-dangling.log"

# --- this-clone (informational, real-world instance) --------------------------
rc=0; scripts/security-scan.sh --history --report-dir "$ATTACK_OUT/s8-this-clone-report" >"$ATTACK_OUT/s8-this-clone.log" 2>&1 || rc=$?
echo "exit=$rc" >>"$ATTACK_OUT/s8-this-clone.log"
if [ -f "$ATTACK_OUT/s8-this-clone-report/gitleaks-history.json" ]; then
  python3 - "$ATTACK_OUT/s8-this-clone-report/gitleaks-history.json" "$ATTACK_OUT/s8-this-clone-findings.txt" <<'PY'
import json, subprocess, sys, collections
d = json.load(open(sys.argv[1]))
anc = set(subprocess.run(["git", "rev-list", "HEAD"], capture_output=True, text=True).stdout.split())
commits = sorted({f["Commit"] for f in d})
outside = [c for c in commits if c not in anc]
with open(sys.argv[2], "w") as out:
    out.write(f"findings={len(d)} commits={len(commits)} outside_head_ancestry={len(outside)}\n")
    out.write("rules=" + json.dumps(collections.Counter(f["RuleID"] for f in d)) + "\n")
    for c in commits:
        refs = subprocess.run(["git", "branch", "-a", "--contains", c], capture_output=True, text=True).stdout.split()
        out.write(f"{c} in_head_ancestry={c in anc} refs={refs[:3]}\n")
    for f in d:
        out.write(f"  {f['Commit'][:10]} {f['RuleID']} {f['File']}:{f['StartLine']} Secret={f['Secret']}\n")
print(len(d), len(commits), len(outside))
PY
  summary_line="$(head -n 1 "$ATTACK_OUT/s8-this-clone-findings.txt")"
  record_verdict s8-this-clone INFO "history scan of THIS clone ($(git branch -r | wc -l | tr -d ' ') remote refs): exit $rc; $summary_line" \
    "0 findings expected for HEAD; any findings outside HEAD ancestry come from other pushed branches and will fail the gate for whoever integrates them" \
    "$ATTACK_OUT/s8-this-clone.log" "$ATTACK_OUT/s8-this-clone-findings.txt"
else
  record_verdict s8-this-clone INFO "history scan exit $rc, no report written" "n/a" "$ATTACK_OUT/s8-this-clone.log"
fi

# --- head-opts -----------------------------------------------------------------
rc=0; scripts/security-scan.sh --history --log-opts HEAD --report-dir "$ATTACK_OUT/s8-head-opts-report" >"$ATTACK_OUT/s8-head-opts.log" 2>&1 || rc=$?
echo "exit=$rc" >>"$ATTACK_OUT/s8-head-opts.log"
if [ "$rc" = 0 ]; then
  record_verdict s8-head-opts HELD "--history --log-opts HEAD on this clone exit 0 (HEAD ancestry clean)" "exit 0" "$ATTACK_OUT/s8-head-opts.log"
else
  record_verdict s8-head-opts BROKEN "--log-opts HEAD exit $rc — HEAD ancestry itself has findings" "exit 0" "$ATTACK_OUT/s8-head-opts.log" "$ATTACK_OUT/s8-head-opts-report/gitleaks-history.json"; overall=1
fi

exit $overall
