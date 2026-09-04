#!/usr/bin/env bash
# Execution audit — per-file coverage for the services-api-legacy-admin-web
# subsystem WITHOUT adding a dependency to the repo.
#
# The workspace has no @vitest/coverage-* package, so this installs
# vitest + @vitest/coverage-v8 (same major/minor as the workspace, 3.2.x) into a
# throwaway directory OUTSIDE the repo and points vitest at it through
# `coverage.customProviderModule`. Package manifests and the lockfile are not
# touched. Reports (text + json-summary) land under ARTIFACTS_DIR/<pkg>/.
#
# Usage: tools/audit/services-api-legacy-admin-web/run-coverage.sh [ARTIFACTS_DIR]
set -uo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$REPO_ROOT"
OUT="${1:-artifacts/audit-coverage/$(date -u +%Y%m%dT%H%M%SZ)}"
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"
TOOLS="${AUDIT_COVERAGE_TOOLS:-$HOME/audit-cov}"
VITEST_VERSION="$(node -p "require('$REPO_ROOT/node_modules/.pnpm/node_modules/vitest/package.json').version" 2>/dev/null || echo 3.2.7)"
export DATABASE_URL_TEST="${DATABASE_URL_TEST:-postgres://pickle:pickle_test_password@localhost:5433/pickle_test}"
export SQS_ENDPOINT_TEST="${SQS_ENDPOINT_TEST:-http://localhost:9324}"
export CI=true

if [ ! -f "$TOOLS/node_modules/@vitest/coverage-v8/dist/index.js" ]; then
  mkdir -p "$TOOLS"
  (cd "$TOOLS" && { [ -f package.json ] || npm init -y >/dev/null; } &&
    npm i --no-audit --no-fund "vitest@$VITEST_VERSION" "@vitest/coverage-v8@$VITEST_VERSION")
fi
VITEST="$TOOLS/node_modules/vitest/vitest.mjs"
PROVIDER="$TOOLS/node_modules/@vitest/coverage-v8/dist/index.js"

RESULTS="$OUT/results.tsv"
printf 'package\texit\tlines_pct\tstatements_pct\tbranches_pct\tfunctions_pct\tsummary\n' >"$RESULTS"
FAILED=0
for entry in "packages/api-contracts:api-contracts" "packages/database:database" "services/api:api" "apps/admin-web:admin-web"; do
  dir="${entry%%:*}"
  slug="${entry##*:}"
  report="$OUT/$slug"
  mkdir -p "$report"
  (cd "$dir" && node "$VITEST" run --coverage --coverage.provider=custom \
    --coverage.customProviderModule="$PROVIDER" \
    --coverage.include='src/**' --coverage.all=true \
    --coverage.reporter=text --coverage.reporter=json-summary \
    --coverage.reportsDirectory="$report") >"$OUT/$slug.vitest.log" 2>&1
  rc=$?
  [ $rc -ne 0 ] && FAILED=1
  summary="$report/coverage-summary.json"
  if [ -f "$summary" ]; then
    read -r l s b f < <(node -p "const t=require('$summary').total;[t.lines.pct,t.statements.pct,t.branches.pct,t.functions.pct].join(' ')")
  else
    l=- s=- b=- f=-
  fi
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$slug" "$rc" "$l" "$s" "$b" "$f" "$summary" >>"$RESULTS"
  echo "$slug exit=$rc lines=$l% stmts=$s% branches=$b% funcs=$f% -> $report"
  if [ -f "$summary" ]; then
    node -e '
      const s = require(process.argv[1]); const root = process.argv[2] + "/";
      const rows = Object.entries(s).filter(([k]) => k !== "total")
        .map(([k, v]) => [k.replace(root, ""), v.lines.pct, v.branches.pct, v.functions.pct])
        .sort((a, b) => a[1] - b[1]);
      console.log("file\tlines_pct\tbranches_pct\tfunctions_pct");
      for (const r of rows) console.log(r.join("\t"));
    ' "$summary" "$REPO_ROOT/$dir" >"$OUT/$slug.per-file.tsv"
  fi
done
echo "results: $RESULTS"
exit $FAILED
