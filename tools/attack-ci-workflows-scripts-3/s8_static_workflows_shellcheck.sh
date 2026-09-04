#!/usr/bin/env bash
# S8 (extra) — static + small dynamic probes on the scope that the seven
# assigned scenarios do not touch:
#   * shellcheck (warning severity) over scripts/*.sh, tools/devin/*.sh,
#     tools/macos-ci/*.sh — the harness hint for this subsystem;
#   * workflow YAML hygiene (text-level, no yaml lib): every workflow declares
#     `permissions:`, every self-hosted job has `timeout-minutes`, no
#     `${{ inputs.* }}` is interpolated straight into a `run:` script, and
#     artifact uploads that follow a step which can exit before writing
#     summary.json use if-no-files-found: ignore (silent empty evidence);
#   * tools/macos-ci/apple-paths-changed.sh with an unknown base sha, a
#     docs-only range and an Apple range (this is what decides whether a push
#     to main wakes the M4).
# Read-only against the checkout; .github/workflows/mac-*.yml are only read.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
cd "$REPO_ROOT" || exit 1

# --- 1. shellcheck ------------------------------------------------------------
if ! command -v shellcheck >/dev/null 2>&1 && [ -x "$HOME/.local/bin/shellcheck" ]; then
  export PATH="$HOME/.local/bin:$PATH"
fi
if command -v shellcheck >/dev/null 2>&1; then
  mapfile -t SCOPE_SH < <(ls scripts/*.sh tools/devin/*.sh tools/macos-ci/*.sh)
  rc=$(run_capture "$OUT/shellcheck_warning.log" shellcheck -S warning -f gcc "${SCOPE_SH[@]}")
  n=$(grep -c ': warning:\|: error:' "$OUT/shellcheck_warning.log" || true)
  if [ "$rc" = 0 ]; then
    record HELD s8.shellcheck_warning "$rc" "$OUT/shellcheck_warning.log" "shellcheck -S warning clean over ${#SCOPE_SH[@]} scripts"
  else
    record BROKEN s8.shellcheck_warning "$rc" "$OUT/shellcheck_warning.log" "$n warning/error-level shellcheck findings: $(grep ': warning:\|: error:' "$OUT/shellcheck_warning.log" | cut -d' ' -f1 | tr '\n' ' ')"
  fi
  run_capture "$OUT/shellcheck_style.log" shellcheck -S style -f gcc "${SCOPE_SH[@]}" >/dev/null
else
  record BROKEN s8.shellcheck_warning 127 "$OUT" "shellcheck not installed — check NOT executed"
fi

# --- 2. workflow YAML hygiene (text level) -------------------------------------
WF=(.github/workflows/*.yml)
missing_perms=()
for f in "${WF[@]}"; do grep -q '^permissions:' "$f" || missing_perms+=("$f"); done
if [ ${#missing_perms[@]} = 0 ]; then
  record HELD s8.wf_permissions 0 "$OUT/workflows.txt" "every workflow declares top-level permissions"
else
  record BROKEN s8.wf_permissions 1 "$OUT/workflows.txt" "no permissions: block (default GITHUB_TOKEN scope) in: ${missing_perms[*]}"
fi

no_timeout=()
for f in "${WF[@]}"; do
  if grep -q 'runs-on:.*self-hosted' "$f" && ! grep -q 'timeout-minutes' "$f"; then no_timeout+=("$f"); fi
done
if [ ${#no_timeout[@]} = 0 ]; then
  record HELD s8.wf_selfhosted_timeout 0 "$OUT/workflows.txt" "every self-hosted job has timeout-minutes"
else
  record BROKEN s8.wf_selfhosted_timeout 1 "$OUT/workflows.txt" "self-hosted job without timeout-minutes (GitHub default 360 min on the single M4): ${no_timeout[*]}"
fi

# `${{ inputs.x }}` inside run: is expanded by the runner BEFORE bash sees it.
inj="$(grep -n 'inputs\.' .github/workflows/*.yml | grep -v 'description\|default\|type:' | grep '\${{' || true)"
printf '%s\n' "$inj" >"$OUT/inputs_in_run.txt"
if [ -z "$inj" ]; then
  record HELD s8.wf_input_interpolation 0 "$OUT/inputs_in_run.txt" "no \${{ inputs.* }} interpolated into run: scripts"
else
  record BROKEN s8.wf_input_interpolation 1 "$OUT/inputs_in_run.txt" "$(printf '%s\n' "$inj" | wc -l) run: lines splice \${{ inputs.* }} directly into bash (e.g. $(printf '%s\n' "$inj" | head -1 | cut -d: -f1,2)); an env: indirection is the documented safe form"
fi

{
  for f in "${WF[@]}"; do
    printf '%s: permissions=%s concurrency=%s timeout=%s ignore-empty-artifacts=%s retention-days=%s\n' "$f" \
      "$(grep -c '^permissions:' "$f")" "$(grep -c '^concurrency:' "$f")" "$(grep -c 'timeout-minutes' "$f")" \
      "$(grep -c 'if-no-files-found: ignore' "$f")" "$(grep -c 'retention-days' "$f")"
  done
} >"$OUT/workflows.txt"
ign=$(grep -c 'if-no-files-found: ignore' .github/workflows/ci.yml || true)
if [ "$ign" = 0 ]; then
  record HELD s8.wf_ignore_empty_artifacts 0 "$OUT/workflows.txt" "ci.yml artifact uploads fail loudly when the evidence dir is empty"
else
  record BROKEN s8.wf_ignore_empty_artifacts 1 "$OUT/workflows.txt" "$ign ci.yml uploads use if-no-files-found: ignore — combined with verify-cloud exiting 2 before summary.json (S6 check 3) a job can fail with no retained evidence at all"
fi

# --- 3. apple-paths-changed.sh --------------------------------------------------
APC=tools/macos-ci/apple-paths-changed.sh
HEAD_SHA="$(git rev-parse HEAD)"
out=$("$APC" 0000000000000000000000000000000000000000 "$HEAD_SHA" 2>"$OUT/apc_zero_base.err"); rc=$?
if [ "$rc" = 0 ] && [ "$out" = true ]; then
  record HELD s8.apc_zero_base "$rc" "$OUT/apc_zero_base.err" "unknown/zero base sha → 'true' (fail-safe: run the Mac)"
else
  record BROKEN s8.apc_zero_base "$rc" "$OUT/apc_zero_base.err" "zero base sha → '$out' exit $rc"
fi

# Synthesize two commits on top of HEAD in a scratch clone: docs-only, then Apple.
WORK="$(mktemp -d "${TMPDIR:-/tmp}/attack-s8.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
git clone -q --local --no-hardlinks "$REPO_ROOT" "$WORK/c"
git -C "$WORK/c" checkout -q -B attack/s8 "$HEAD_SHA"
GA=(-c user.name=attack -c user.email=attack@example.invalid)
echo "s8" >>"$WORK/c/README.md"; git -C "$WORK/c" add README.md; git -C "$WORK/c" "${GA[@]}" commit -q -m "docs only"
DOCS_SHA="$(git -C "$WORK/c" rev-parse HEAD)"
mkdir -p "$WORK/c/native/Sources/Attack"; echo "// s8" >"$WORK/c/native/Sources/Attack/A.swift"
git -C "$WORK/c" add native; git -C "$WORK/c" "${GA[@]}" commit -q -m "apple path"
APPLE_SHA="$(git -C "$WORK/c" rev-parse HEAD)"
out=$(cd "$WORK/c" && "$REPO_ROOT/$APC" "$HEAD_SHA" "$DOCS_SHA" 2>"$OUT/apc_docs_only.err"); rc=$?
if [ "$rc" = 0 ] && [ "$out" = false ]; then
  record HELD s8.apc_docs_only "$rc" "$OUT/apc_docs_only.err" "docs-only push → 'false' (Mac not woken)"
else
  record BROKEN s8.apc_docs_only "$rc" "$OUT/apc_docs_only.err" "docs-only → '$out' exit $rc"
fi
out=$(cd "$WORK/c" && "$REPO_ROOT/$APC" "$HEAD_SHA" "$APPLE_SHA" 2>"$OUT/apc_apple.err"); rc=$?
if [ "$rc" = 0 ] && [ "$out" = true ]; then
  record HELD s8.apc_apple "$rc" "$OUT/apc_apple.err" "native/ change → 'true'"
else
  record BROKEN s8.apc_apple "$rc" "$OUT/apc_apple.err" "native/ change → '$out' exit $rc"
fi
# The mobile JS bundle ships inside the iOS app, but only apps/mobile/ios/,
# package.json and Gemfile count as Apple-relevant — record what a src/ change does.
echo "// s8" >>"$WORK/c/apps/mobile/src/App.tsx" 2>/dev/null || echo "// s8" >"$WORK/c/apps/mobile/s8.ts"
git -C "$WORK/c" add -A apps/mobile; git -C "$WORK/c" "${GA[@]}" commit -q -m "mobile js"
JS_SHA="$(git -C "$WORK/c" rev-parse HEAD)"
out=$(cd "$WORK/c" && "$REPO_ROOT/$APC" "$APPLE_SHA" "$JS_SHA" 2>"$OUT/apc_mobile_js.err"); rc=$?
printf 'apps/mobile JS-only change → %s (exit %s)\n' "$out" "$rc" >"$OUT/apc_mobile_js.txt"
record HELD s8.apc_mobile_js "$rc" "$OUT/apc_mobile_js.txt" "apps/mobile JS-only change → '$out' (documented: Linux CI gates tsc/jest; recorded for the coordinator, not a break)"

verdict
