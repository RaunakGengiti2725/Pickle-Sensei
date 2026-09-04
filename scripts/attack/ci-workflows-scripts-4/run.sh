#!/usr/bin/env bash
# Adversarial pass 4 — ci-workflows-scripts (workflows, verify-*.sh,
# security-scan.sh, tools/macos-ci, tools/devin, tools/diagnostics).
#
#   scripts/attack/ci-workflows-scripts-4/run.sh              # every scenario
#   scripts/attack/ci-workflows-scripts-4/run.sh s1 s3 s8     # a subset
#
# Each sN_*.sh performs one attack against the checked-out commit in a scratch
# worktree or with reverted edits, and appends HELD/BROKEN lines to
# $ATTACK_EVIDENCE/verdicts.tsv (default artifacts/attack-ci-workflows-scripts-4/).
# Exit 1 when any scenario recorded a BROKEN assertion. Nothing here changes
# production code or pushes anything.
#
# Prerequisites (cloud plane): node + pnpm, deno, docker (postgres_test,
# elasticmq via `docker compose up -d postgres postgres_test redis elasticmq`),
# python3, curl, shellcheck. s2/s6/s7 take several minutes each.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export ATTACK_EVIDENCE="${ATTACK_EVIDENCE:-$(cd "$HERE/../../.." && pwd)/artifacts/attack-ci-workflows-scripts-4}"
mkdir -p "$ATTACK_EVIDENCE"

if [ $# -gt 0 ]; then
  scenarios=()
  for want in "$@"; do scenarios+=("$HERE"/"${want}"_*.sh); done
else
  scenarios=("$HERE"/s[0-9]*_*.sh)
fi

: >"$ATTACK_EVIDENCE/verdicts.tsv"
overall=0
for s in "${scenarios[@]}"; do
  [ -x "$s" ] || { echo "not executable: $s" >&2; overall=1; continue; }
  name="$(basename "$s" .sh)"
  echo "==> $name"
  if "$s" >"$ATTACK_EVIDENCE/$name.log" 2>&1; then
    echo "    HELD ($ATTACK_EVIDENCE/$name.log)"
  else
    echo "    BROKEN assertions — see $ATTACK_EVIDENCE/$name.log"
    overall=1
  fi
done

echo
printf '%-7s %-26s %s\n' STATUS SCENARIO ASSERTION
awk -F'\t' '{printf "%-7s %-26s %s\n", $1, $2, $3}' "$ATTACK_EVIDENCE/verdicts.tsv"
echo
echo "broken: $(grep -c $'^BROKEN\t' "$ATTACK_EVIDENCE/verdicts.tsv" || true)  held: $(grep -c $'^HELD\t' "$ATTACK_EVIDENCE/verdicts.tsv" || true)"
echo "verdicts: $ATTACK_EVIDENCE/verdicts.tsv"
exit "$overall"
