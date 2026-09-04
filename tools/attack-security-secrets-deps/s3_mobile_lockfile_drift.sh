#!/usr/bin/env bash
# S3 — bump an apps/mobile dependency without regenerating package-lock.json.
#
# Attack: in a temp export of the commit under test, edit the semver range of one
# dependency in apps/mobile/package.json so the lockfile no longer satisfies it,
# then run the exact install the pipeline runs (`npm ci`). The lockfile gate holds
# only if that is a HARD failure (non-zero exit), not a warning.
#
# Checks:
#   s3.a  `npm ci --dry-run --no-audit` with a drifted range → exit != 0, EUSAGE "not in sync"
#   s3.b  same drift, real `npm ci --ignore-scripts`          → exit != 0 (no node_modules written)
#   s3.c  scripts/verify-cloud.sh --only deps with the drift in the working tree
#         → must fail. (The deps stage skips `npm ci` when apps/mobile/node_modules
#         already exists, so a drifted lockfile passes the canonical local gate.)
#
# Never uses pnpm inside apps/mobile.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
temp_export "$TMP" apps/mobile/package.json apps/mobile/package-lock.json
MOBILE="$TMP/apps/mobile"

# Pick a dependency whose locked version cannot satisfy the drifted range.
(cd "$MOBILE" && node -e '
const fs = require("fs");
const p = JSON.parse(fs.readFileSync("package.json", "utf8"));
const lock = JSON.parse(fs.readFileSync("package-lock.json", "utf8"));
const name = "zustand";
const locked = lock.packages[`node_modules/${name}`].version;
const major = Number(locked.split(".")[0]);
p.dependencies[name] = `^${major - 1}.0.0`;
console.log(`${name}: package.json ${p.dependencies[name]} vs lockfile ${locked}`);
fs.writeFileSync("package.json", JSON.stringify(p, null, 2) + "\n");
') >"$OUT/drift.txt" 2>&1
cat "$OUT/drift.txt" >&2

# ── s3.a dry run ───────────────────────────────────────────────────────────────
rc="$(cd "$MOBILE" && run_capture "$OUT/s3a-npm-ci-dry-run.log" npm ci --dry-run --no-audit --no-fund)"
if [ "$rc" != 0 ] && grep -q 'EUSAGE' "$OUT/s3a-npm-ci-dry-run.log" && grep -q 'in sync' "$OUT/s3a-npm-ci-dry-run.log"; then
  record HELD s3.a-npm-ci-dry-run "$rc" "$OUT/s3a-npm-ci-dry-run.log" "npm ci --dry-run hard-fails (EUSAGE, lockfile out of sync)"
else
  record BROKEN s3.a-npm-ci-dry-run "$rc" "$OUT/s3a-npm-ci-dry-run.log" "npm ci --dry-run did not hard-fail on lockfile drift"
fi

# ── s3.b real install ──────────────────────────────────────────────────────────
rc="$(cd "$MOBILE" && run_capture "$OUT/s3b-npm-ci-real.log" npm ci --ignore-scripts --no-audit --no-fund)"
if [ "$rc" != 0 ] && [ ! -d "$MOBILE/node_modules" ]; then
  record HELD s3.b-npm-ci-real "$rc" "$OUT/s3b-npm-ci-real.log" "real npm ci refuses to install anything on drift"
else
  record BROKEN s3.b-npm-ci-real "$rc" "$OUT/s3b-npm-ci-real.log" "npm ci installed despite drift"
fi

# ── s3.c the canonical local gate with node_modules already present ────────────
if [ ! -d "$REPO_ROOT/apps/mobile/node_modules" ]; then
  log "apps/mobile/node_modules absent — s3.c needs a previously installed tree (cd apps/mobile && npm ci)"
  record BROKEN s3.c-verify-cloud-deps 2 "$OUT/drift.txt" "precondition missing: apps/mobile/node_modules not installed; check not executed"
else
  BACKUP="$(mktemp)"
  cp "$REPO_ROOT/apps/mobile/package.json" "$BACKUP"
  restore_pkg() { cp "$BACKUP" "$REPO_ROOT/apps/mobile/package.json"; rm -f "$BACKUP"; }
  trap 'restore_pkg; rm -rf "$TMP"' EXIT
  cp "$MOBILE/package.json" "$REPO_ROOT/apps/mobile/package.json"
  rc="$(cd "$REPO_ROOT" && run_capture "$OUT/s3c-verify-cloud-only-deps.log" env VERIFY_ARTIFACTS="$OUT/verify-cloud" scripts/verify-cloud.sh --only deps)"
  restore_pkg
  trap 'rm -rf "$TMP"' EXIT
  if [ "$rc" != 0 ]; then
    record HELD s3.c-verify-cloud-deps "$rc" "$OUT/s3c-verify-cloud-only-deps.log" "verify-cloud deps stage fails on mobile lockfile drift"
  else
    record BROKEN s3.c-verify-cloud-deps "$rc" "$OUT/s3c-verify-cloud-only-deps.log" "verify-cloud --only deps PASSED with drifted apps/mobile/package.json (npm ci skipped because node_modules exists)"
  fi
fi

verdict
