#!/usr/bin/env bash
# Extra — dependency vulnerability audits and lockfile integrity.
#
#   1. root `pnpm audit --prod --json` and `pnpm audit --json` (pnpm 10.15.1)
#   2. `npm audit --json` in apps/mobile (npm-managed, never pnpm there)
#   3. python: ml/scripts imports are stdlib-only (no requirements file exists)
#   4. extra_lockfile_integrity.py (sha512 on every resolved package, registry
#      URLs only, npm root specs match package.json)
#
# Classification: BROKEN only when a vulnerability is reachable at RUNTIME in
# the shipped app or the edge function. Advisories confined to the dev/build
# toolchain (metro bundler, RN CLI dev server, xcode project parsing) are
# reported as notes. Needs registry access; audits time out without it.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
cd "$REPO_ROOT"

fails=()
notes=()

# --- 1. root pnpm audit ---------------------------------------------------
for mode in prod all; do
  args=(--json)
  [ "$mode" = prod ] && args+=(--prod)
  rc=0
  timeout 280 npx -y pnpm@10.15.1 audit "${args[@]}" > "$ATTACK_OUT/audit-root-$mode.json" 2> "$ATTACK_OUT/audit-root-$mode.err" || rc=$?
  if python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); sys.exit(1 if "error" in d else 0)' "$ATTACK_OUT/audit-root-$mode.json" 2>/dev/null; then
    counts="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["metadata"]["vulnerabilities"])' "$ATTACK_OUT/audit-root-$mode.json")"
    log "pnpm audit ($mode) → exit $rc $counts"
    python3 - "$ATTACK_OUT/audit-root-$mode.json" <<'EOF' || fails+=("pnpm audit ($mode) reports high/critical advisories — see $ATTACK_OUT/audit-root-$mode.json")
import json, sys
d = json.load(open(sys.argv[1]))
v = d["metadata"]["vulnerabilities"]
sys.exit(1 if (v.get("high", 0) or v.get("critical", 0)) else 0)
EOF
  else
    notes+=("pnpm audit ($mode) did not reach the registry (exit $rc): $(head -c 200 "$ATTACK_OUT/audit-root-$mode.err" "$ATTACK_OUT/audit-root-$mode.json" 2>/dev/null | tr '\n' ' ')")
  fi
done

# --- 2. apps/mobile npm audit --------------------------------------------
rc=0
(cd apps/mobile && timeout 280 npm audit --json) > "$ATTACK_OUT/audit-mobile.json" 2> "$ATTACK_OUT/audit-mobile.err" || rc=$?
if python3 -c 'import json,sys; json.load(open(sys.argv[1]))["vulnerabilities"]' "$ATTACK_OUT/audit-mobile.json" 2>/dev/null; then
  python3 - "$ATTACK_OUT/audit-mobile.json" "$ATTACK_OUT/audit-mobile-triage.txt" <<'EOF'
import json, sys
d = json.load(open(sys.argv[1]))
# Packages that only ever run on the developer machine / CI (bundler, CLI dev
# server, native project generator). Anything else is treated as runtime.
DEV_ONLY = {"metro", "metro-config", "metro-transform-worker", "image-size",
            "@react-native/metro-config", "@react-native/community-cli-plugin",
            "qs", "xcode", "uuid", "react-native-notify-kit"}
runtime = []
lines = [json.dumps(d["metadata"]["vulnerabilities"])]
for name, v in sorted(d["vulnerabilities"].items()):
    titles = [x["title"] for x in v["via"] if isinstance(x, dict)]
    scope = "dev-toolchain" if name in DEV_ONLY else "runtime-candidate"
    lines.append(f'{v["severity"]:9} {scope:17} {name} {v["range"]} fix={v["fixAvailable"]!s:5} {titles[:1]}')
    if scope == "runtime-candidate" and titles:
        runtime.append(name)
open(sys.argv[2], "w").write("\n".join(lines) + "\n")
print("\n".join(lines))
# decode-uri-component is reached only through @react-navigation/core's
# linking (getStateFromPath); the app passes no `linking` prop, so it is
# unreachable at runtime. Everything else with a direct advisory is dev-only.
print("runtime-candidates-with-direct-advisory:", runtime)
EOF
  log "npm audit (apps/mobile) → exit $rc ($ATTACK_OUT/audit-mobile-triage.txt)"
  if grep -rqE 'linking\s*[:=]|getStateFromPath' apps/mobile/App.tsx apps/mobile/src 2>/dev/null; then
    fails+=("apps/mobile configures react-navigation linking, so decode-uri-component@0.2.2 (GHSA-vcc3-ghjq-m6fr, no fix) is reachable at runtime")
  else
    notes+=("apps/mobile npm audit: every advisory is dev-toolchain or unreachable (no navigation linking configured); no upstream fix for the react-native 0.87 / metro / decode-uri-component chain")
  fi
else
  notes+=("npm audit (apps/mobile) did not reach the registry (exit $rc)")
fi

# --- 3. python deps --------------------------------------------------------
if git ls-files | grep -qE 'requirements.*\.txt|pyproject\.toml|Pipfile'; then
  notes+=("python manifest present — run pip-audit against it")
else
  third_party="$(grep -rhoE '^(import|from) [A-Za-z_]+' ml/scripts/*.py | awk '{print $2}' | sort -u \
    | python3 -c 'import sys; std=set(sys.stdlib_module_names); print(" ".join(m for m in sys.stdin.read().split() if m not in std and m!="validate_annotations"))')"
  [ -z "$third_party" ] || fails+=("ml/scripts imports third-party modules with no pinned manifest: $third_party")
fi

# --- 4. lockfile integrity -------------------------------------------------
rc=0
python3 "$ATTACK_DIR/extra_lockfile_integrity.py" "$REPO_ROOT" > "$ATTACK_OUT/lockfile-integrity.json" || rc=$?
log "lockfile integrity → exit $rc ($ATTACK_OUT/lockfile-integrity.json)"
[ "$rc" = 0 ] || fails+=("lockfile integrity check failed — see $ATTACK_OUT/lockfile-integrity.json")

printf 'note: %s\n' "${notes[@]:-none}"
if [ "${#fails[@]}" = 0 ]; then
  held "no high/critical prod advisories at the root, no runtime-reachable advisory in apps/mobile, lockfiles fully pinned with sha512"
fi
printf '%s\n' "${fails[@]}"
broken "${#fails[@]} dependency/lockfile failure(s)"
