#!/usr/bin/env python3
"""Adversarial-tester registry integrity check for datasets/pickleball/registry.json.

Standard library only. Exit 0 = every invariant holds; exit 1 = at least one
violation (each printed as `VIOLATION <rule>: <detail>`). Nothing is repaired.

Invariants (beyond what packages/swing-lab/test/e08FreshHoldoutGuard.test.ts pins):
  bytes.total          <pool>.totalBytes == sum(items[].media.clipBytes)
  bytes.item           items[].media.clipBytes == on-disk size
  media.sha256         on-disk sha256 == items[].media.sha256
  media.path           items[].path lives under the pool directory and exists
  pool.channel_disjoint  no uploaderChannelId appears in BOTH pools
  (WARNING only)         same `uploader` string in both pools when uploaderChannelId is absent
  fresh.no_labeled_ref   no fresh-candidate id appears in any labeled artifact
                         (datasets/**/annotations/**, datasets/**/annotation/**,
                          datasets/ta-bench/cases.json, datasets/corpus/{sources,recordings,splits}.json)

Usage: python3 tools/attack/ml-tooling-datasets/registry_integrity.py [repo-root]
"""
from __future__ import annotations

import hashlib
import json
import os
import sys
from pathlib import Path

POOLS = {
    "freshCandidates": "datasets/pickleball/fresh-candidates",
    "devPool": "datasets/pickleball/dev-pool",
}
LABELED_FIXED = [
    "datasets/ta-bench/cases.json",
    "datasets/corpus/sources.json",
    "datasets/corpus/recordings.json",
    "datasets/corpus/splits.json",
]


def sha256_of(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def labeled_artifacts(root: Path) -> list[Path]:
    found: list[Path] = []
    for rel in LABELED_FIXED:
        candidate = root / rel
        if candidate.is_file():
            found.append(candidate)
    for dirpath, dirnames, filenames in os.walk(root / "datasets"):
        parts = Path(dirpath).parts
        if "annotations" in parts or "annotation" in parts:
            for name in filenames:
                if name.endswith((".json", ".jsonl", ".csv", ".md")):
                    found.append(Path(dirpath) / name)
    return sorted(set(found))


def check(root: Path) -> list[str]:
    violations: list[str] = []
    registry = json.loads((root / "datasets/pickleball/registry.json").read_text(encoding="utf-8"))
    channels: dict[str, set[str]] = {}
    uploaders: dict[str, set[str]] = {}
    warnings: list[str] = []
    for pool, pool_dir in POOLS.items():
        section = registry.get(pool)
        if not isinstance(section, dict):
            violations.append(f"pool.missing: registry has no {pool!r} section")
            continue
        items = section.get("items", [])
        declared_total = section.get("totalBytes")
        clip_sum = 0
        for item in items:
            media = item.get("media", {})
            clip_bytes = media.get("clipBytes")
            path = root / item["path"]
            if not item["path"].startswith(pool_dir + "/"):
                violations.append(f"media.path: {item['id']} path {item['path']} is outside {pool_dir}/")
            if not path.is_file():
                violations.append(f"media.path: {item['id']} missing on disk at {item['path']}")
                continue
            size = path.stat().st_size
            if clip_bytes != size:
                violations.append(f"bytes.item: {item['id']} clipBytes={clip_bytes} disk={size}")
            clip_sum += size
            digest = sha256_of(path)
            if digest != media.get("sha256"):
                violations.append(f"media.sha256: {item['id']} registry={media.get('sha256')} disk={digest}")
            channel = item.get("uploaderChannelId")
            if channel:
                channels.setdefault(channel, set()).add(pool)
            elif item.get("uploader"):
                uploaders.setdefault(item["uploader"], set()).add(pool)
        if declared_total != clip_sum:
            violations.append(f"bytes.total: {pool}.totalBytes={declared_total} but sum(clipBytes on disk)={clip_sum}")
    for channel, pools in sorted(channels.items()):
        if len(pools) > 1:
            violations.append(f"pool.channel_disjoint: channel {channel!r} appears in {sorted(pools)}")
    for uploader, pools in sorted(uploaders.items()):
        if len(pools) > 1:
            warnings.append(f"same-producer (no channel id) {uploader!r} appears in {sorted(pools)}")
    for warning in warnings:
        print(f"WARNING {warning}")
    fresh_ids = [item["id"] for item in registry.get("freshCandidates", {}).get("items", [])]
    for artifact in labeled_artifacts(root):
        text = artifact.read_text(encoding="utf-8", errors="replace")
        for fresh_id in fresh_ids:
            if fresh_id in text:
                violations.append(
                    f"fresh.no_labeled_ref: {fresh_id} referenced by labeled artifact {artifact.relative_to(root)}"
                )
    return violations


def main(argv: list[str]) -> int:
    root = Path(argv[1]).resolve() if len(argv) > 1 else Path(__file__).resolve().parents[3]
    violations = check(root)
    for violation in violations:
        print(f"VIOLATION {violation}")
    print(f"registry-integrity: {len(violations)} violation(s) under {root}")
    return 1 if violations else 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
