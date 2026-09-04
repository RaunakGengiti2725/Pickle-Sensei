#!/usr/bin/env bash
# Reset every piece of mutable local state that scripts/verify-cloud.sh can
# observe, so two consecutive runs start from the SAME point. Used by
# tools/determinism/verify-cloud-twice.sh; safe to run on its own.
#
# What it resets (and why):
#   - docker compose volumes (pgdata, miniodata) + containers  -> DB stages
#     (test/db/e2e) never see rows left by a previous run
#   - apps/mobile jest cache + node_modules/.cache dirs         -> transform
#     caches cannot mask ordering / timing effects
#   - vite/vitest/tsbuildinfo/playwright output dirs            -> admin/e2e/
#     typecheck stages rebuild from scratch
#   - leftover RLS-matrix containers (pickle-rls-*)              -> rls stage
#     cannot collide with a stale container
# What it deliberately KEEPS (tool binaries, not state): the pnpm store,
# root node_modules (the deps stage re-runs `pnpm install --frozen-lockfile`),
# Playwright browsers, the pinned gitleaks binary, the Deno module cache.
# apps/mobile/node_modules is removed only when --fresh-mobile is passed
# (verify-cloud --fresh-deps then does `npm ci`, which is what CI does).
#
# Refuses to run on a dirty tree (untracked artifacts/ and tools/determinism
# outputs are tolerated) because verify-cloud stamps `dirty` into summary.json.
set -euo pipefail

REPO_ROOT="${PICKLE_REPO:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
HARNESS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$REPO_ROOT"

FRESH_MOBILE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --fresh-mobile) FRESH_MOBILE=1; shift ;;
    -h|--help) sed -n '2,22p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

log() { printf '[clean-state] %s\n' "$*" >&2; }

if git status --porcelain | grep -Ev '^\?\? (artifacts/|tools/determinism/)' | grep -q .; then
  git status --porcelain >&2
  echo "[clean-state] working tree is dirty — refusing (verify-cloud records dirty=true)" >&2
  exit 1
fi

if command -v docker >/dev/null 2>&1; then
  log "docker compose down -v (drops pgdata/miniodata volumes)"
  if ! docker compose down -v --remove-orphans >/dev/null 2>&1; then
    log "docker compose down failed (no compose project yet?) — continuing"
  fi
  stale="$(docker ps -aq --filter 'name=pickle-rls' --filter 'name=pickle-audit')"
else
  log "docker not installed — skipping container/volume reset (verify-cloud will report db-backed stages unavailable)"
  stale=""
fi
if [ -n "$stale" ]; then
  log "removing stale test containers: $(echo "$stale" | tr '\n' ' ')"
  # shellcheck disable=SC2086
  docker rm -f $stale >/dev/null
fi

log "clearing jest/vite/tsc caches"
if [ -d apps/mobile/node_modules/.bin ] && [ $FRESH_MOBILE = 0 ]; then
  if ! (cd apps/mobile && npx jest --clearCache >/dev/null 2>&1); then
    log "jest --clearCache failed — continuing (cache dir is removed below)"
  fi
fi
rm -rf /tmp/jest_*
find . -path ./node_modules -prune -o -path '*/node_modules/.cache' -type d -print 2>/dev/null \
  | while read -r d; do rm -rf "$d"; done
find . -path '*/node_modules' -prune -o -name '*.tsbuildinfo' -type f -print 2>/dev/null \
  | while read -r f; do rm -f "$f"; done
rm -rf apps/admin-web/dist apps/admin-web/e2e/dist apps/admin-web/node_modules/.vite \
  apps/admin-web/test-results apps/admin-web/playwright-report

if [ $FRESH_MOBILE = 1 ]; then
  log "removing apps/mobile/node_modules (verify-cloud --fresh-deps will npm ci)"
  rm -rf apps/mobile/node_modules
fi

log "state reset complete"
