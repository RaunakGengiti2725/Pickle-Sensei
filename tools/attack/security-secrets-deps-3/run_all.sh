#!/usr/bin/env bash
# Adversarial harness — subsystem `security-secrets-deps`, pass 3 (Linux plane).
#
#   tools/attack/security-secrets-deps-3/run_all.sh            # everything
#   tools/attack/security-secrets-deps-3/run_all.sh a d g      # a subset
#
# Runs each scenario_*.sh / extra_*.sh, records its RESULT line and exit code
# in $ATTACK_OUT/results.tsv, and exits nonzero if any scenario is BROKEN.
# Nothing here changes production code or tracked files; every probe file is
# synthetic, untracked, and removed on exit. Env knobs: ATTACK_SEED,
# ATTACK_OUT, ATTACK_OFFLINE=1 (skip network-only probes), ATTACK_SKIP_G2=1.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export ATTACK_OUT="${ATTACK_OUT:-$(cd "$HERE/../../.." && pwd)/artifacts/attack-security-secrets-deps-3}"
mkdir -p "$ATTACK_OUT"
results="$ATTACK_OUT/results.tsv"
: > "$results"

declare -A SCRIPTS=(
  [a]=scenario_a_untracked_env.sh
  [b]=scenario_b_cache_failures.sh
  [c]=scenario_c_jwt_extension_allowlist.sh
  [d]=scenario_d_gitleaks_bin_override.sh
  [e]=scenario_e_offline_empty_cache.sh
  [f]=scenario_f_pnpm10_vs_pnpm9_build_scripts.sh
  [g]=scenario_g_k6_fail_closed.sh
  [x]=extra_dependency_audits.sh
)
order=(a b c d e f g x)
[ $# -gt 0 ] && order=("$@")

broken=0
for key in "${order[@]}"; do
  script="${SCRIPTS[$key]:-}"
  [ -n "$script" ] || { echo "unknown scenario '$key'" >&2; exit 64; }
  echo "=== $script"
  rc=0
  bash "$HERE/$script" 2>&1 | tee "$ATTACK_OUT/$script.out" || rc=${PIPESTATUS[0]}
  verdict="$(grep -m1 '^RESULT:' "$ATTACK_OUT/$script.out" || echo 'RESULT: CRASHED')"
  printf '%s\t%s\t%s\n' "$script" "$rc" "$verdict" >> "$results"
  [ "$rc" = 0 ] || broken=1
done

echo
echo "=== summary ($results)"
cat "$results"
exit "$broken"
