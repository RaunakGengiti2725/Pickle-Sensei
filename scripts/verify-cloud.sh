#!/usr/bin/env bash
# Canonical Linux/Cloud verification for Pickle Sensei.
#
# This is THE entry point future agents and CI use to prove a change on Linux.
# It runs every deterministic gate that can execute without Apple hardware and
# writes machine-readable evidence. Apple/Xcode truth lives in
# scripts/mac-full-verify.sh (self-hosted M4 runner); scripts/verify-all.sh
# chains both.
#
# Stages (all are gates; a stage FAILS the run unless explicitly skipped):
#   deps       pnpm install --frozen-lockfile (+ apps/mobile npm ci when needed)
#   format     pnpm format:check
#   lint       pnpm lint                     (root eslint also covers apps/mobile)
#   typecheck  pnpm typecheck                (pnpm build == pnpm -r typecheck)
#   test       pnpm test with DATABASE_URL_TEST (integration suites need Postgres);
#              @pickle/queue's 3 SQS tests run only when SQS_ENDPOINT_TEST
#              (ElasticMQ) is reachable — the stage reports which it was
#   db         @pickle/database migrate + seed against DATABASE_URL (idempotent)
#   mobile     apps/mobile: npx tsc --noEmit && npx jest --ci --silent
#   ml         python3 -m unittest discover -s ml/scripts -p 'test_*.py'
#   edge       Supabase edge fn: deno task test (__wf__) + deno check of the
#              standalone modules (index.ts has known pre-existing type errors)
#   rls        ./supabase/tests/run_rls_tests.sh (throwaway Postgres 16, Docker)
#   security   scripts/security-scan.sh (secret/dependency scan) when present
#   admin      pnpm --filter @pickle/admin-web build (Vite production build)
#   e2e        admin-web Playwright smoke (Chromium) against a self-started
#              @pickle/api + vite; the authenticated panel test runs when
#              DATABASE_URL is reachable (db stage migrates/seeds it first)
#   release    node tools/release/check-release-manifest.mjs when present
#
# Policy: a SKIPPED stage is never reported as passed. Skips are explicit
# (--skip / --only) and appear in the summary; the exit code is non-zero if any
# stage failed. No stage uses `|| true` to hide a failure.
#
# Usage:
#   scripts/verify-cloud.sh                 # everything (PR gate + the rest)
#   scripts/verify-cloud.sh --tier pr       # exactly what .github/workflows/ci.yml gates
#   scripts/verify-cloud.sh --only test,db  # a subset
#   scripts/verify-cloud.sh --skip rls,edge # everything except some stages
#   scripts/verify-cloud.sh --start-services  # docker compose up the DBs first
#   scripts/verify-cloud.sh --fresh-deps    # force reinstall of node_modules
#
# Environment (defaults match docker-compose.yml / .env.example):
#   DATABASE_URL_TEST  postgres://pickle:pickle_test_password@localhost:5433/pickle_test
#   DATABASE_URL       postgres://pickle:pickle_dev_password@localhost:5432/pickle_dev
#   SQS_ENDPOINT_TEST  http://localhost:9324 (docker compose elasticmq; CI service)
#   VERIFY_ARTIFACTS   artifacts/verify-cloud/<UTC timestamp>  (logs + summary.json)
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

ALL_STAGES=(deps format lint typecheck test db mobile ml edge rls security admin e2e release)
# What .github/workflows/ci.yml gates on every PR (verify + mobile + edge + supabase-security jobs).
PR_STAGES=(deps format lint typecheck test db mobile ml edge rls security)

TIER="full"
ONLY=""
SKIP=""
START_SERVICES=0
FRESH_DEPS=0

usage() {
  sed -n '2,47p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
  case "$1" in
    --tier) TIER="$2"; shift 2 ;;
    --only) ONLY="$2"; shift 2 ;;
    --skip) SKIP="$2"; shift 2 ;;
    --start-services) START_SERVICES=1; shift ;;
    --fresh-deps) FRESH_DEPS=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

case "$TIER" in
  pr) STAGES=("${PR_STAGES[@]}") ;;
  full) STAGES=("${ALL_STAGES[@]}") ;;
  *) echo "unknown --tier '$TIER' (pr|full)" >&2; exit 2 ;;
esac
if [ -n "$ONLY" ]; then
  IFS=',' read -r -a STAGES <<<"$ONLY"
fi

export DATABASE_URL_TEST="${DATABASE_URL_TEST:-postgres://pickle:pickle_test_password@localhost:5433/pickle_test}"
export DATABASE_URL="${DATABASE_URL:-postgres://pickle:pickle_dev_password@localhost:5432/pickle_dev}"
export CI="${CI:-true}"
SQS_ENDPOINT_DEFAULT="http://localhost:9324"
# Deno is installed per-user by the environment blueprint; make it visible to
# non-login shells (CI runners, Devin exec).
if [ -d "$HOME/.deno/bin" ]; then
  export PATH="$HOME/.deno/bin:$PATH"
fi

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
ARTIFACTS="${VERIFY_ARTIFACTS:-artifacts/verify-cloud/$STAMP}"
mkdir -p "$ARTIFACTS"
SUMMARY="$ARTIFACTS/summary.json"
GIT_SHA="$(git rev-parse HEAD 2>/dev/null || echo unknown)"
GIT_DIRTY="$(git status --porcelain 2>/dev/null | grep -qv '^?? artifacts/' && echo true || echo false)"

declare -a RESULT_NAMES=() RESULT_STATUS=() RESULT_SECONDS=() RESULT_NOTES=()
FAILED=0

is_skipped() {
  local s="$1"
  [ -n "$SKIP" ] && [[ ",$SKIP," == *",$s,"* ]]
}

record() {
  RESULT_NAMES+=("$1"); RESULT_STATUS+=("$2"); RESULT_SECONDS+=("$3"); RESULT_NOTES+=("$4")
}

# run_stage <name> <function>
run_stage() {
  local name="$1" fn="$2" log="$ARTIFACTS/$1.log" start end rc
  if is_skipped "$name"; then
    echo "==> [$name] SKIPPED (--skip)"
    record "$name" skipped 0 "explicitly skipped"
    return
  fi
  echo "==> [$name] start $(date -u +%H:%M:%S)"
  start=$(date +%s)
  # Each stage runs in a subshell with errexit so any failing command fails the stage.
  ( set -e; "$fn" ) >"$log" 2>&1
  rc=$?
  end=$(date +%s)
  if [ $rc -eq 0 ]; then
    echo "    [$name] PASS in $((end - start))s (log: $log)"
    record "$name" passed $((end - start)) ""
  elif [ $rc -eq 75 ]; then
    # EX_TEMPFAIL: the stage's prerequisite tool/fixture is absent. Still a failure
    # for the run (skipped != passed) but labelled so agents know what to install.
    echo "    [$name] UNAVAILABLE in $((end - start))s — $(tail -n 1 "$log")"
    record "$name" unavailable $((end - start)) "$(tail -n 1 "$log")"
    FAILED=1
  else
    echo "    [$name] FAIL (exit $rc) in $((end - start))s — last lines:"
    tail -n 25 "$log" | sed 's/^/        /'
    record "$name" failed $((end - start)) "exit $rc"
    FAILED=1
  fi
}

need() {
  command -v "$1" >/dev/null 2>&1 || { echo "missing required tool: $1"; exit 75; }
}

pg_ready() {
  # Verify a Postgres URL is reachable using @pickle/database's own pg driver — no psql needed.
  [ -d packages/database/node_modules/pg ] || { echo "packages/database deps missing — run the deps stage"; return 1; }
  NODE_PATH="$REPO_ROOT/packages/database/node_modules" node -e '
const { Client } = require("pg");
const c = new Client({ connectionString: process.argv[1] });
c.connect().then(() => c.query("select 1")).then(() => c.end()).then(() => process.exit(0))
 .catch((e) => { console.error(e.message); process.exit(1); });' "$1"
}

# ---------------------------------------------------------------- stages ----
selected() { [[ " ${STAGES[*]} " == *" $1 "* ]]; }

stage_deps() {
  need node
  local root_needed=0 s
  for s in "${STAGES[@]}"; do
    case "$s" in deps|mobile|ml|rls|edge) ;; *) root_needed=1 ;; esac
  done
  if [ $root_needed = 1 ] || [ "${#STAGES[@]}" -eq 1 ]; then
    need pnpm
    pnpm install --frozen-lockfile
  else
    echo "no pnpm-workspace stage selected; skipping root pnpm install"
  fi
  if selected mobile || [ "${#STAGES[@]}" -eq 1 ]; then
    need npm
    if [ "$FRESH_DEPS" = 1 ] || [ ! -d apps/mobile/node_modules ]; then
      (cd apps/mobile && npm ci --no-audit --no-fund)
    else
      echo "apps/mobile/node_modules present; skipping npm ci (use --fresh-deps to force)"
    fi
  fi
}

stage_format() { pnpm format:check; }
stage_lint() { pnpm lint; }
stage_typecheck() { pnpm typecheck; }

stage_test() {
  if ! pg_ready "$DATABASE_URL_TEST"; then
    echo "test database unreachable at DATABASE_URL_TEST — run: docker compose up -d postgres_test (or --start-services)"
    exit 75
  fi
  local sqs="${SQS_ENDPOINT_TEST:-$SQS_ENDPOINT_DEFAULT}"
  # ElasticMQ answers a bare GET with 400 — any HTTP response means it is up.
  if curl -sS -m 3 -o /dev/null "$sqs/" 2>/dev/null; then
    echo "SQS_ENDPOINT_TEST=$sqs reachable — @pickle/queue SQS integration tests WILL run"
    export SQS_ENDPOINT_TEST="$sqs"
  else
    echo "SQS_ENDPOINT_TEST=$sqs unreachable — @pickle/queue skips its 3 SQS tests (docker compose up -d elasticmq, or --start-services)"
    unset SQS_ENDPOINT_TEST
  fi
  pnpm test
}

stage_db() {
  if ! pg_ready "$DATABASE_URL"; then
    echo "dev database unreachable at DATABASE_URL — run: docker compose up -d postgres (or --start-services)"
    exit 75
  fi
  pnpm --filter @pickle/database migrate
  pnpm --filter @pickle/database seed
}

stage_mobile() {
  need npm
  [ -d apps/mobile/node_modules ] || { echo "apps/mobile/node_modules missing — run the deps stage"; exit 75; }
  (cd apps/mobile && npx tsc --noEmit && npx jest --ci --silent)
}

stage_ml() {
  need python3
  python3 -m unittest discover -s ml/scripts -p 'test_*.py'
}

stage_edge() {
  need deno
  (cd supabase/functions/api/__wf__ && deno task test)
  (cd supabase/functions/api && deno check cache.ts rateLimit.ts http.ts legal.ts)
}

stage_rls() {
  if ! command -v docker >/dev/null 2>&1 && ! command -v initdb >/dev/null 2>&1; then
    echo "neither docker nor initdb available for the RLS matrix"
    exit 75
  fi
  ./supabase/tests/run_rls_tests.sh
}

stage_security() {
  if [ ! -x scripts/security-scan.sh ]; then
    echo "scripts/security-scan.sh not present in this checkout"
    exit 75
  fi
  # Redacted JSON reports land beside security.log so CI uploads them with the
  # rest of the artifacts and a red gate can be traced to rule/file/commit.
  scripts/security-scan.sh --report-dir "$ARTIFACTS/security"
}

stage_admin() { pnpm --filter @pickle/admin-web build; }

stage_e2e() {
  local browsers="${PLAYWRIGHT_BROWSERS_PATH:-$HOME/.cache/ms-playwright}"
  if ! ls -d "$browsers"/chromium-* >/dev/null 2>&1; then
    echo "Playwright Chromium missing under $browsers — run: pnpm --filter @pickle/admin-web exec playwright install chromium"
    exit 75
  fi
  # playwright.config.ts refuses to reuse stray servers under CI=true: :3001/:5173 must be free.
  for port in 3001 5173; do
    if curl -sS -m 2 -o /dev/null "http://127.0.0.1:$port/" 2>/dev/null; then
      echo "port $port already in use — stop the dev server (pnpm dev:api / admin-web dev) before the e2e stage"
      exit 1
    fi
  done
  if pg_ready "$DATABASE_URL" 2>/dev/null; then
    echo "DATABASE_URL reachable — authenticated-panel e2e test WILL run"
    export PICKLE_E2E_DATABASE_URL="$DATABASE_URL"
  else
    echo "DATABASE_URL unreachable — authenticated-panel e2e test is reported skipped by Playwright"
  fi
  pnpm --filter @pickle/admin-web e2e
}

stage_release() {
  if [ ! -f tools/release/check-release-manifest.mjs ]; then
    echo "tools/release/check-release-manifest.mjs not present"
    exit 75
  fi
  node tools/release/check-release-manifest.mjs
}

# -------------------------------------------------------------------- main ----
echo "Pickle Sensei — verify-cloud @ $GIT_SHA (dirty=$GIT_DIRTY) tier=$TIER"
echo "stages: ${STAGES[*]}"
echo "artifacts: $ARTIFACTS"

if [ "$START_SERVICES" = 1 ]; then
  need docker
  docker compose up -d postgres postgres_test redis elasticmq
  for url in "$DATABASE_URL" "$DATABASE_URL_TEST"; do
    for _ in $(seq 1 30); do pg_ready "$url" 2>/dev/null && break; sleep 1; done
  done
fi

for s in "${STAGES[@]}"; do
  if ! declare -F "stage_$s" >/dev/null; then
    echo "unknown stage: $s" >&2; exit 2
  fi
  run_stage "$s" "stage_$s"
done

# Machine-readable summary.
json_escape() {
  local s=$1
  s=${s//\\/\\\\}
  s=${s//\"/\\\"}
  s=${s//$'\n'/\\n}
  printf '%s' "$s"
}
{
  echo "{"
  echo "  \"tool\": \"verify-cloud\","
  echo "  \"git_sha\": \"$GIT_SHA\","
  echo "  \"dirty\": $GIT_DIRTY,"
  echo "  \"tier\": \"$TIER\","
  echo "  \"started_utc\": \"$STAMP\","
  echo "  \"host\": \"$(uname -srm)\","
  echo "  \"node\": \"$(node --version 2>/dev/null || echo unknown)\","
  echo "  \"ok\": $([ $FAILED -eq 0 ] && echo true || echo false),"
  echo "  \"stages\": ["
  for i in "${!RESULT_NAMES[@]}"; do
    sep=","; [ "$i" -eq $((${#RESULT_NAMES[@]} - 1)) ] && sep=""
    printf '    {"name": "%s", "status": "%s", "seconds": %s, "note": "%s", "log": "%s"}%s\n' \
      "${RESULT_NAMES[$i]}" "${RESULT_STATUS[$i]}" "${RESULT_SECONDS[$i]}" "$(json_escape "${RESULT_NOTES[$i]}")" \
      "$(json_escape "$ARTIFACTS/${RESULT_NAMES[$i]}.log")" "$sep"
  done
  echo "  ]"
  echo "}"
} >"$SUMMARY"

echo
printf '%-10s %-12s %6s  %s\n' STAGE STATUS SECS NOTE
for i in "${!RESULT_NAMES[@]}"; do
  printf '%-10s %-12s %6s  %s\n' "${RESULT_NAMES[$i]}" "${RESULT_STATUS[$i]}" "${RESULT_SECONDS[$i]}" "${RESULT_NOTES[$i]}"
done
echo "summary: $SUMMARY"

if [ $FAILED -ne 0 ]; then
  echo "verify-cloud: FAILED"
  exit 1
fi
echo "verify-cloud: OK"
