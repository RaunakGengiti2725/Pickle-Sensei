#!/usr/bin/env bash
# S10 — dependency vulnerability + lockfile-integrity audits on the checked-out
# tree (read-only: nothing is installed into the repo).
#   root workspace : pnpm audit --prod (JSON) + lockfile ⇄ manifests sync
#                    (pnpm install --frozen-lockfile --lockfile-only) +
#                    every pnpm-lock.yaml package carries a sha512 integrity
#                    and resolves to the npm registry.
#   apps/mobile    : npm audit (JSON, all + --omit=dev) + npm ci --dry-run
#                    (lockfile ⇄ package.json sync) + package-lock.json
#                    integrity/registry checks.
#   python (ml/)   : enumerate third-party imports; there is no requirements
#                    manifest to pip-audit, so record what the scripts import.
#
#   tools/attack/security-secrets-deps/s10_dependency_audits.sh [ARTIFACT_DIR]
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
OUT="${1:-$HOME/attack-artifacts/s10}"
mkdir -p "$OUT"
cd "$REPO_ROOT"

PNPM_WANT="$(python3 -c "import json;print(json.load(open('package.json'))['packageManager'].split('@')[1])")"
# Use the version package.json pins (packageManager) via corepack/npx so the
# lockfile is read by the same major CI uses.
PNPM=(npx -y "pnpm@$PNPM_WANT")
"${PNPM[@]}" --version | tee "$OUT/pnpm-version.txt"
node --version | tee "$OUT/node-version.txt"
npm --version | tee "$OUT/npm-version.txt"

broken=0
note() { echo "$*" | tee -a "$OUT/summary.txt"; }
: >"$OUT/summary.txt"

# ── root: pnpm audit --prod ─────────────────────────────────────────────────
rc=0
"${PNPM[@]}" audit --prod --json >"$OUT/pnpm-audit-prod.json" 2>"$OUT/pnpm-audit-prod.stderr" || rc=$?
python3 - "$OUT/pnpm-audit-prod.json" "$rc" <<'PY' | tee -a "$OUT/summary.txt"
import json, sys
p, rc = sys.argv[1], int(sys.argv[2])
try:
    d = json.load(open(p))
except Exception as e:
    print(f"pnpm audit --prod rc={rc} — output not JSON ({e})"); sys.exit(0)
v = d.get("metadata", {}).get("vulnerabilities", {})
advs = d.get("advisories", {})
print(f"pnpm audit --prod rc={rc} vulnerabilities={v} advisories={len(advs)}")
for a in list(advs.values())[:20]:
    print(f"  [{a.get('severity')}] {a.get('module_name')} {a.get('vulnerable_versions')} — {a.get('title')} (GHSA {a.get('github_advisory_id')}) via {a.get('findings',[{}])[0].get('paths',[''])[:2]}")
PY
if [ "$rc" -ne 0 ]; then broken=1; fi

# ── root: lockfile ⇄ manifests in sync (no install, no scripts) ─────────────
rc=0
"${PNPM[@]}" install --frozen-lockfile --lockfile-only --ignore-scripts >"$OUT/pnpm-frozen-lockfile.log" 2>&1 || rc=$?
note "pnpm install --frozen-lockfile --lockfile-only rc=$rc ($( [ $rc -eq 0 ] && echo 'lockfile matches every workspace manifest' || echo 'LOCKFILE OUT OF SYNC'))"
if [ "$rc" -ne 0 ]; then broken=1; tail -5 "$OUT/pnpm-frozen-lockfile.log" | tee -a "$OUT/summary.txt"; fi
git diff --quiet -- pnpm-lock.yaml || { note "BROKEN: pnpm-lock.yaml was modified by the frozen check"; broken=1; }

# ── root: every locked package has sha512 integrity + registry resolution ───
python3 - pnpm-lock.yaml <<'PY' | tee -a "$OUT/summary.txt"
import re, sys
text = open(sys.argv[1]).read()
sec = text.split("\npackages:\n", 1)[1].split("\nsnapshots:\n", 1)[0]
entries = re.findall(r"\n  ('?[^\n:]+'?):\n((?:    .*\n)*)", sec + "\n")
missing = [name for name, body in entries if "integrity: sha512-" not in body and "tarball:" not in body]
tarballs = [name for name, body in entries if "tarball:" in body or "commit:" in body]
print(f"pnpm-lock.yaml packages={len(entries)} missing_sha512={len(missing)} non-registry(tarball/git)={len(tarballs)} {tarballs[:5]}")
if missing[:5]: print("  missing integrity:", missing[:5])
PY

# ── apps/mobile: npm audit (all + prod-only) ────────────────────────────────
rc_all=0; rc_prod=0
(cd apps/mobile && npm audit --json >"$OUT/npm-audit-mobile.json" 2>"$OUT/npm-audit-mobile.stderr") || rc_all=$?
(cd apps/mobile && npm audit --omit=dev --json >"$OUT/npm-audit-mobile-prod.json" 2>"$OUT/npm-audit-mobile-prod.stderr") || rc_prod=$?
python3 - "$OUT/npm-audit-mobile.json" "$rc_all" "$OUT/npm-audit-mobile-prod.json" "$rc_prod" <<'PY' | tee -a "$OUT/summary.txt"
import json, sys
for label, p, rc in (("npm audit (all)", sys.argv[1], int(sys.argv[2])), ("npm audit --omit=dev", sys.argv[3], int(sys.argv[4]))):
    try:
        d = json.load(open(p))
    except Exception as e:
        print(f"apps/mobile {label} rc={rc} — output not JSON ({e})"); continue
    meta = d.get("metadata", {}).get("vulnerabilities", {})
    print(f"apps/mobile {label} rc={rc} vulnerabilities={meta}")
    for name, v in list(d.get("vulnerabilities", {}).items())[:25]:
        via = [x.get("title") if isinstance(x, dict) else x for x in v.get("via", [])][:2]
        print(f"  [{v.get('severity')}] {name} {v.get('range')} direct={v.get('isDirect')} fixAvailable={bool(v.get('fixAvailable'))} via={via} effects={v.get('effects', [])[:3]}")
PY
if [ "$rc_prod" -ne 0 ]; then broken=1; fi

# ── apps/mobile: lockfile ⇄ package.json sync, without installing ───────────
rc=0
(cd apps/mobile && npm ci --dry-run --no-audit --no-fund --ignore-scripts >"$OUT/npm-ci-dry-run.log" 2>&1) || rc=$?
note "apps/mobile npm ci --dry-run rc=$rc ($( [ $rc -eq 0 ] && echo 'package-lock.json in sync with package.json' || echo 'LOCKFILE OUT OF SYNC'))"
if [ "$rc" -ne 0 ]; then broken=1; grep -i "error" "$OUT/npm-ci-dry-run.log" | head -5 | tee -a "$OUT/summary.txt"; fi
git diff --quiet -- apps/mobile/package-lock.json apps/mobile/package.json || { note "BROKEN: mobile manifest/lockfile modified by dry-run"; broken=1; }

python3 - apps/mobile/package-lock.json <<'PY' | tee -a "$OUT/summary.txt"
import json, sys
l = json.load(open(sys.argv[1])); pk = l["packages"]
missing = [k for k, v in pk.items() if k and not v.get("link") and not v.get("integrity")]
nonreg = [(k, v.get("resolved")) for k, v in pk.items() if v.get("resolved") and not v["resolved"].startswith("https://registry.npmjs.org/")]
insecure = [k for k, v in pk.items() if str(v.get("resolved", "")).startswith("http://")]
print(f"apps/mobile/package-lock.json lockfileVersion={l['lockfileVersion']} packages={len(pk)} missing_integrity={len(missing)} non-registry={len(nonreg)} http={len(insecure)}")
for x in missing[:5]: print("  missing integrity:", x)
for x in nonreg[:5]: print("  non-registry:", x)
PY

# ── python: what do the ml scripts import? (no manifest exists to pip-audit) ─
python3 - <<'PY' | tee -a "$OUT/summary.txt"
import ast, pathlib, sys
stdlib = set(sys.stdlib_module_names)
third = {}
files = [p for p in pathlib.Path("ml").rglob("*.py")]
local = {p.stem for p in files}
for p in files:
    try:
        tree = ast.parse(p.read_text())
    except SyntaxError as e:
        print("  parse error", p, e); continue
    for n in ast.walk(tree):
        names = [a.name for a in n.names] if isinstance(n, ast.Import) else ([n.module] if isinstance(n, ast.ImportFrom) and n.module else [])
        for name in names:
            top = name.split(".")[0]
            if top not in stdlib and top not in local and top != "__future__":
                third.setdefault(top, set()).add(str(p))
mani = [str(p) for pat in ("requirements*.txt", "pyproject.toml", "Pipfile", "setup.py") for p in pathlib.Path(".").rglob(pat) if "node_modules" not in str(p)]
print(f"python ml/ files={len(files)} third-party imports={sorted(third) or 'none (stdlib only)'} manifests={mani or 'none'}")
PY

if [ "$broken" -eq 0 ]; then note "HELD: no prod vulnerabilities reported, both lockfiles in sync and fully integrity-pinned"; else note "BROKEN: see above"; fi
exit "$broken"
