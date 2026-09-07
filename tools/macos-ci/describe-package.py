#!/usr/bin/env python3
"""Print a one-screen summary of a SwiftPM package from `swift package describe --type json` (stdin)."""
import json
import sys

d = json.load(sys.stdin)
platforms = ", ".join(f"{p.get('name')} {p.get('version')}" for p in d.get("platforms", []))
print(f"package: {d.get('name')}  platforms: {platforms or '(any)'}  tools-version: {d.get('tools_version', '?')}")
for t in d.get("targets", []):
    sources = t.get("sources") or []
    print(f"  target {t.get('name')}  type={t.get('type')}  sources={len(sources)}  path={t.get('path')}")
for p in d.get("products", []):
    print(f"  product {p.get('name')}  type={list((p.get('type') or {}).keys())}")
