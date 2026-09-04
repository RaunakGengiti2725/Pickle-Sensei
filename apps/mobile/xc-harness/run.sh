#!/usr/bin/env bash
# xc-journey-settings-account-deletion — mobile half of the deletion journey.
#
# Runs the store-level and full-tree UI harnesses under apps/mobile's own jest
# config. The files are deliberately named *.xc.ts(x) (not *.test.*) so the
# canonical `npx jest --ci --silent` never picks them up: they need Node 22's
# `node:sqlite` (behind --experimental-sqlite on 22.x) to run the REAL SQLite
# migrations instead of an in-memory fake.
#
#   cd apps/mobile && xc-harness/run.sh            # both suites
#   cd apps/mobile && xc-harness/run.sh ui         # one suite (stores|ui)
#
# Artifacts (scenario tables, request logs, survival matrices, heap numbers,
# finding.*.json repros) land OUTSIDE the tree in $XC_ARTIFACT_DIR (default
# ~/.cache/pickle-sensei/xc-artifacts/account-deletion) so the raw dumps never
# trip format:check or the gitleaks gate; see account-deletion/helpers/artifactDir.ts.
set -euo pipefail
cd "$(dirname "$0")/.."

suite="${1:-all}"
if [ $# -gt 0 ]; then shift; fi
case "$suite" in
  all) match='**/xc-harness/**/*.xc.ts?(x)' ;;
  stores) match='**/xc-harness/**/journey.stores.xc.ts' ;;
  ui) match='**/xc-harness/**/journey.ui.xc.tsx' ;;
  *) echo "usage: $0 [all|stores|ui]" >&2; exit 2 ;;
esac

node -e 'require("node:sqlite")' 2>/dev/null || export NODE_OPTIONS="${NODE_OPTIONS:-} --experimental-sqlite"

export XC_ARTIFACT_DIR="${XC_ARTIFACT_DIR:-$HOME/.cache/pickle-sensei/xc-artifacts/account-deletion}"
echo "xc-harness: artifacts -> $XC_ARTIFACT_DIR" >&2
exec npx jest --ci --rootDir . --testMatch "$match" --forceExit "$@"
