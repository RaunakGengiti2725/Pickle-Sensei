#!/usr/bin/env bash
# R4 — `verify-cloud.sh --only deps` skips `npm ci` whenever
# apps/mobile/node_modules exists, so a manifest/lockfile drift that npm
# itself rejects (EUSAGE) is not caught on a warm checkout. Runs in a
# throwaway clone (never touches the real tree).
# HELD = the deps stage fails on the drifted manifest; BROKEN = it passes.
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
LAB="$(mktemp -d)"; trap 'rm -rf "$LAB"' EXIT
throwaway_clone "$LAB"
cd "$LAB"
# The skip under test keys only on the directory EXISTING (`[ ! -d ... ]`), so
# an empty one stands in for a warm install. The root install runs for real
# inside the clone — pnpm rewrites the symlinks of whatever node_modules it is
# pointed at, so the source checkout's trees are never shared.
mkdir apps/mobile/node_modules

node -e '
const fs=require("fs");const p="apps/mobile/package.json";const j=JSON.parse(fs.readFileSync(p,"utf8"));
j.dependencies["left-pad"]="1.3.0";fs.writeFileSync(p,JSON.stringify(j,null,2)+"\n");'

rc=0; (cd apps/mobile && npm ci --dry-run --ignore-scripts --no-audit --no-fund) >"$OUT/r4-npm-ci-dryrun.log" 2>&1 || rc=$?
[ "$rc" = 0 ] && die "npm ci --dry-run accepted the drifted manifest; probe is invalid"
verdict HELD r4:npm-ci "npm ci itself rejects the drifted manifest (exit $rc)"

rc=0; VERIFY_ARTIFACTS="$OUT/r4-verify" scripts/verify-cloud.sh --only deps >"$OUT/r4-verify-only-deps.log" 2>&1 || rc=$?
[ "$rc" = 0 ] && verdict BROKEN r4:deps-stage "verify-cloud.sh --only deps exit 0 with drifted apps/mobile/package.json (npm ci skipped: warm node_modules)" \
  || verdict HELD r4:deps-stage "deps stage fails on the drifted manifest (exit $rc)"
finish
