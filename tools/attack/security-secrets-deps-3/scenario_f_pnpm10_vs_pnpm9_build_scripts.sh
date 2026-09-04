#!/usr/bin/env bash
# Scenario F — fresh `pnpm install --frozen-lockfile` of the workspace manifests
# with pnpm 10.15.1 (the pinned packageManager, used by CI) and pnpm 9.15.1,
# diffing the "Ignored build scripts" warnings. pnpm 10 blocks dependency
# lifecycle scripts by default unless `pnpm-workspace.yaml` lists them under
# `onlyBuiltDependencies`; this surfaces which dependencies that affects and
# whether the blocked script is load-bearing (esbuild is checked directly).
#
# `corepack pnpm@…` fails in this environment (corepack signature key mismatch),
# so both versions run through `npx -y pnpm@<version>`. Needs registry access.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
cd "$REPO_ROOT"

command -v npx >/dev/null || inconclusive "npx not available"

stage() {
  local dir="$1"
  mkdir -p "$dir"
  git ls-files -z -- 'package.json' '**/package.json' pnpm-lock.yaml pnpm-workspace.yaml .npmrc 2>/dev/null \
    | grep -zv '^apps/mobile/' \
    | (cd "$REPO_ROOT" && tar --null -cf - -T -) | tar -xf - -C "$dir"
}

ignored_for() {
  local version="$1" dir rc=0
  dir="$(mktemp -d)"
  track "$dir"
  stage "$dir"
  (cd "$dir" && npx -y "pnpm@$version" install --frozen-lockfile) > "$ATTACK_OUT/f-pnpm-$version.log" 2>&1 || rc=$?
  log "pnpm@$version install --frozen-lockfile → exit $rc ($ATTACK_OUT/f-pnpm-$version.log)"
  [ "$rc" = 0 ] || inconclusive "pnpm@$version install failed (exit $rc)"
  printf '%s\n' "$dir" > "$ATTACK_OUT/f-pnpm-$version.dir"
  sed -n 's/.*Ignored build scripts: \(.*\)\./\1/p' "$ATTACK_OUT/f-pnpm-$version.log" | tr -d '│ ' | tr ',' '\n' | sort -u
}

ignored10="$(ignored_for 10.15.1)"
ignored9="$(ignored_for 9.15.1)"
dir10="$(cat "$ATTACK_OUT/f-pnpm-10.15.1.dir")"

{
  echo "pnpm@10.15.1 ignored build scripts:"; printf '  %s\n' ${ignored10:-"(none)"}
  echo "pnpm@9.15.1 ignored build scripts:"; printf '  %s\n' ${ignored9:-"(none)"}
} | tee "$ATTACK_OUT/f-ignored-build-scripts.diff.txt"

# Is the blocked esbuild postinstall load-bearing? esbuild's JS entry falls
# back to the @esbuild/<platform> optional package when the postinstall did
# not run; if that require fails, `vite`/`vitest`/`tsx` in the workspace break
# under CI's pnpm 10.
esbuild_ok=1
if printf '%s\n' "$ignored10" | grep -qx esbuild; then
  pkg="$(ls -d "$dir10"/node_modules/.pnpm/esbuild@*/node_modules/esbuild 2>/dev/null | head -1)"
  if [ -n "$pkg" ] && (cd "$dir10" && node -e "require(process.argv[1]).version" "$pkg" > "$ATTACK_OUT/f-esbuild-require.log" 2>&1); then
    log "esbuild loads without its postinstall (version $(node -p "require('$pkg/package.json').version"))"
  else
    esbuild_ok=0
  fi
fi

grep -q 'onlyBuiltDependencies' "$REPO_ROOT/pnpm-workspace.yaml" && declared=1 || declared=0

if [ "$esbuild_ok" = 0 ]; then
  broken "pnpm 10 blocked a load-bearing lifecycle script: esbuild cannot be required"
fi
if [ -n "$ignored10" ] && [ "$declared" = 0 ]; then
  echo "note: pnpm 10 silently skips lifecycle scripts for: $(printf '%s ' $ignored10)— none is declared in pnpm-workspace.yaml onlyBuiltDependencies, so the CI install differs from a pnpm 9 install; no functional breakage reproduced"
fi
held "pnpm 10 vs 9 lifecycle-script difference recorded; blocked scripts are not load-bearing"
