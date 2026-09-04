#!/usr/bin/env bash
# Adversarial scenario S7 — vulnerability status of the edge function's npm
# tree (@supabase/supabase-js and transitives) via osv-scanner.
#
# osv-scanner has no deno.lock parser, so two trees are converted to CycloneDX:
#   (a) the tree Deno ACTUALLY resolves for supabase/functions/api/index.ts in
#       this environment (`deno install --entrypoint --lock` into a temp dir);
#   (b) the committed supabase/functions/api/__wf__/deno.lock (npm section).
# Both are scanned; a difference between (a) and (b) means the committed lock
# does not describe what ships (index.ts imports `npm:@supabase/supabase-js@2`
# — a floating major — and __wf__/deno.json sets "lock": false).
#
#   tools/attack/security-secrets-deps/s7_deno_lock_osv.sh [out-dir]
#
# Exit 0 = no known vulns in either tree, 1 = vulns found, 2 = tooling failure.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
OUT="${1:-$REPO_ROOT/artifacts/attack/s7}"
mkdir -p "$OUT"
export PATH="$HOME/.deno/bin:$PATH"
OSV="${OSV_SCANNER:-$HOME/.cache/pickle-sensei/osv/osv-scanner}"
if [ ! -x "$OSV" ]; then
  mkdir -p "$(dirname "$OSV")"
  curl -fsSL -o "$OSV" https://github.com/google/osv-scanner/releases/latest/download/osv-scanner_linux_amd64
  chmod +x "$OSV"
fi
"$OSV" --version | head -1 | tee "$OUT/osv-version.txt"

API="$REPO_ROOT/supabase/functions/api"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# (a) what Deno resolves right now for the production entrypoint.
# --node-modules-dir=none: the repo root's package.json would otherwise put
# Deno into "manual node_modules" mode and refuse npm: specifiers.
mkdir -p "$WORK/resolved"
printf '{ "nodeModulesDir": "none" }\n' >"$WORK/resolved/deno.json"
(cd "$WORK/resolved" && deno install --entrypoint --lock=deno.lock --config deno.json "$API/index.ts") >"$OUT/deno-install.log" 2>&1
cp "$WORK/resolved/deno.lock" "$OUT/resolved-now.deno.lock"
deno info --node-modules-dir=none "$API/index.ts" 2>/dev/null | sed 's/\x1b\[[0-9;]*m//g' >"$OUT/deno-info-tree.txt"

# (b) the committed lock.
cp "$API/__wf__/deno.lock" "$OUT/committed.deno.lock"

to_cdx() { # <deno.lock> <out.cdx.json>
  python3 - "$1" "$2" <<'PY'
import json, sys
lock = json.load(open(sys.argv[1]))
comps = []
for key in lock.get("npm", {}):
    # key looks like "@supabase/supabase-js@2.112.4" or "tslib@2.8.1"
    name, _, ver = key.rpartition("@")
    if not name:
        continue
    if "_" in ver:  # peer-dep variant suffix e.g. "1.2.3_foo@1.0.0"
        ver = ver.split("_", 1)[0]
    comps.append({
        "type": "library", "name": name, "version": ver,
        "purl": "pkg:npm/" + name.replace("@", "%40") + "@" + ver,
    })
json.dump({"bomFormat": "CycloneDX", "specVersion": "1.5", "version": 1, "components": comps},
          open(sys.argv[2], "w"), indent=1)
print(f"{sys.argv[1]}: {len(comps)} npm components")
PY
}
to_cdx "$OUT/resolved-now.deno.lock" "$OUT/resolved-now.cdx.json" | tee "$OUT/results.txt"
to_cdx "$OUT/committed.deno.lock" "$OUT/committed.cdx.json" | tee -a "$OUT/results.txt"

grep -o '"npm:@supabase/supabase-js@2": "[^"]*"' "$OUT/resolved-now.deno.lock" | sed 's/^/resolved-now  /' | tee -a "$OUT/results.txt"
grep -o '"npm:@supabase/supabase-js@2": "[^"]*"' "$OUT/committed.deno.lock" | sed 's/^/committed     /' | tee -a "$OUT/results.txt"
curl -fsS https://registry.npmjs.org/@supabase/supabase-js/latest | python3 -c 'import json,sys; print("registry latest", json.load(sys.stdin)["version"])' | tee -a "$OUT/results.txt"

# (c) the tree `deno info` shows from the LOCAL DENO CACHE (may differ again —
# without an enforced lock, whatever version happens to be cached wins).
python3 - "$OUT/deno-info-tree.txt" "$OUT/cached-info.cdx.json" <<'PY' | tee -a "$OUT/results.txt"
import json, re, sys
seen = {}
for m in re.finditer(r"npm:/((?:@[^/@\s]+/)?[^/@\s]+)@([0-9][^\s()]*)", open(sys.argv[1]).read()):
    seen[m.group(1)] = m.group(2)
comps = [{"type": "library", "name": n, "version": v, "purl": "pkg:npm/" + n.replace("@", "%40") + "@" + v} for n, v in seen.items()]
json.dump({"bomFormat": "CycloneDX", "specVersion": "1.5", "version": 1, "components": comps}, open(sys.argv[2], "w"), indent=1)
print(f"deno-info(cache) tree: {len(comps)} npm components; supabase-js@{seen.get('@supabase/supabase-js')}")
PY

vulns=0
for tree in resolved-now committed cached-info; do
  rc=0
  "$OSV" scan source -L "$OUT/$tree.cdx.json" --format json --output-file "$OUT/osv-$tree.json" >"$OUT/osv-$tree.log" 2>&1 || rc=$?
  n=$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(sum(len(p["vulnerabilities"]) for r in d.get("results",[]) for p in r["packages"]))' "$OUT/osv-$tree.json" 2>/dev/null || echo "?")
  echo "osv-scanner($tree) rc=$rc vulnerabilities=$n" | tee -a "$OUT/results.txt"
  python3 - "$OUT/osv-$tree.json" <<'PY' | tee -a "$OUT/results.txt"
import json, sys
d = json.load(open(sys.argv[1]))
for r in d.get("results", []):
    for p in r["packages"]:
        for v in p["vulnerabilities"]:
            print(f"  {p['package']['name']}@{p['package']['version']}: {v['id']} {', '.join(v.get('aliases', []))} — {v.get('summary','')[:90]}")
PY
  case "$rc" in 0) ;; 1) vulns=1 ;; *) echo "osv-scanner tooling failure rc=$rc" | tee -a "$OUT/results.txt"; exit 2 ;; esac
done
if [ "$vulns" = 1 ]; then echo "BROKEN: known vulnerabilities in the edge fn npm tree" | tee -a "$OUT/results.txt"; exit 1; fi
echo "HELD: no known vulnerabilities in either tree" | tee -a "$OUT/results.txt"
