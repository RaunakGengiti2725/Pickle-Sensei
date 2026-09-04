#!/usr/bin/env bash
# S5 — is the release checker ever executed by CI?
#
#   tools/release/__attack__/probe-s5-ci-release-stage.sh [artifact-dir]
#
# Runs `scripts/verify-cloud.sh --tier pr --only release` (which DOES execute the
# checker locally, because --only overrides the tier), then checks whether the
# `release` stage is part of PR_STAGES and whether any GitHub workflow invokes it.
# Exit 0 = HELD (CI gates the checker), exit 1 = BROKEN (CI never runs it).
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
OUT="${1:-$ROOT/artifacts/attack-release-config-docs-3}"
mkdir -p "$OUT"
cd "$ROOT"

scripts/verify-cloud.sh --tier pr --only release >"$OUT/s5_verify_cloud_only_release.log" 2>&1
only_exit=$?
echo "scripts/verify-cloud.sh --tier pr --only release -> exit=$only_exit (log: $OUT/s5_verify_cloud_only_release.log)"
summary=$(grep -o 'summary: .*' "$OUT/s5_verify_cloud_only_release.log" | awk '{print $2}')
[ -n "$summary" ] && cp "$summary" "$OUT/s5_verify_cloud_only_release_summary.json"

pr_stages=$(grep -E '^PR_STAGES=' scripts/verify-cloud.sh)
all_stages=$(grep -E '^ALL_STAGES=' scripts/verify-cloud.sh)
echo "$all_stages"
echo "$pr_stages"

in_pr=0
[[ "$pr_stages" == *" release"* || "$pr_stages" == *"(release"* ]] && in_pr=1

# no `set -e`: a grep miss is data here, not an error
ci_hits=$(grep -n -E 'release:check|check-release-manifest|--only[^\n]*release|--tier full' .github/workflows/*.yml)
echo "workflow references to the release stage/checker: ${ci_hits:-<none>}"

{
  echo "{"
  echo "  \"scenario\": \"S5\","
  echo "  \"only_release_exit\": $only_exit,"
  echo "  \"release_in_PR_STAGES\": $([ $in_pr = 1 ] && echo true || echo false),"
  echo "  \"workflow_invokes_checker\": $([ -n "$ci_hits" ] && echo true || echo false),"
  echo "  \"PR_STAGES\": \"$pr_stages\","
  echo "  \"verdict\": \"$([ $in_pr = 1 ] || [ -n "$ci_hits" ] && echo HELD || echo BROKEN)\""
  echo "}"
} | tee "$OUT/s5_ci_release_stage.json"

if [ $in_pr = 1 ] || [ -n "$ci_hits" ]; then exit 0; fi
echo "BROKEN: release stage is not in PR_STAGES and no workflow runs the checker" >&2
exit 1
