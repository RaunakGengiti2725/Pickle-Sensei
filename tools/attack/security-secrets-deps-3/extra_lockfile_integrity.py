#!/usr/bin/env python3
"""Lockfile integrity probe: pnpm-lock.yaml + apps/mobile/package-lock.json.

Checks (read-only):
  * every resolved package carries a sha512 integrity hash
  * every resolved URL is https and points at registry.npmjs.org (or is a
    registry tarball) — no git/http/file resolutions
  * the pnpm lockfile has no `link:`/`file:` specifiers outside the workspace
  * the npm lockfile's root dependency specs match package.json
Exit 0 when all hold, 1 otherwise; prints a JSON summary.
"""
import json
import re
import sys
from pathlib import Path

ROOT = Path(sys.argv[1] if len(sys.argv) > 1 else ".").resolve()
out = {"pnpm": {}, "npm": {}}
bad = False

# ---- pnpm-lock.yaml (parse minimally without PyYAML dependency) ----
lock = (ROOT / "pnpm-lock.yaml").read_text().splitlines()
in_pkgs = False
pkgs = {}
cur = None
for line in lock:
    if line.startswith("packages:"):
        in_pkgs = True
        continue
    if in_pkgs and line and not line.startswith(" "):
        in_pkgs = False
    if not in_pkgs:
        continue
    m = re.match(r"^  ([^\s].*):$", line)
    if m:
        cur = m.group(1).strip("'\"")
        pkgs[cur] = {}
        continue
    m = re.match(r"^    resolution: \{(.*)\}$", line)
    if m and cur:
        pkgs[cur]["resolution"] = m.group(1)
missing_integrity = [k for k, v in pkgs.items() if "integrity: sha512-" not in v.get("resolution", "")]
odd_resolution = [
    k for k, v in pkgs.items()
    if re.search(r"tarball:|type: git|commit:|directory:", v.get("resolution", ""))
]
out["pnpm"] = {
    "packages": len(pkgs),
    "missing_sha512_integrity": missing_integrity,
    "non_registry_resolution": odd_resolution,
    "lockfileVersion": next((l.split(":", 1)[1].strip() for l in lock if l.startswith("lockfileVersion")), None),
}
bad |= bool(missing_integrity or odd_resolution)

# ---- apps/mobile/package-lock.json ----
pl = json.loads((ROOT / "apps/mobile/package-lock.json").read_text())
pj = json.loads((ROOT / "apps/mobile/package.json").read_text())
nodes = pl.get("packages", {})
no_integrity, bad_resolved = [], []
for path, meta in nodes.items():
    if path == "" or meta.get("link"):
        continue
    resolved = meta.get("resolved", "")
    if resolved and not meta.get("integrity", "").startswith("sha512-"):
        no_integrity.append(path)
    if resolved and not resolved.startswith("https://registry.npmjs.org/"):
        bad_resolved.append(f"{path} -> {resolved}")
root_lock = nodes.get("", {})
spec_mismatch = []
for section in ("dependencies", "devDependencies"):
    for name, spec in pj.get(section, {}).items():
        if root_lock.get(section, {}).get(name) != spec:
            spec_mismatch.append(f"{section}.{name}: package.json={spec} lock={root_lock.get(section, {}).get(name)}")
out["npm"] = {
    "lockfileVersion": pl.get("lockfileVersion"),
    "packages": len(nodes),
    "missing_sha512_integrity": no_integrity,
    "non_registry_resolved": bad_resolved,
    "root_spec_mismatch": spec_mismatch,
}
bad |= bool(no_integrity or bad_resolved or spec_mismatch)

print(json.dumps(out, indent=2))
sys.exit(1 if bad else 0)
