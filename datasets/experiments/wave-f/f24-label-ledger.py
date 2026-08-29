#!/usr/bin/env python3
"""F24 label ledger generator (wave-f, f24-rt-data-provenance).

Builds an append-only ledger over every committed label/gold collection and
bundle annotation file. The ledger records, per protected collection, the
sha256 of each record's canonical JSON (a multiset), and per annotation file
its sha256 + revision. The f24 provenance audit verifies the working tree
against this ledger:

  * a ledgered record hash that no longer resolves  -> append_only_violation
    (an existing label was edited or deleted in place)
  * an annotation file whose bytes changed without a strictly increased
    revision                                          -> append_only_violation
  * unledgered additions are allowed (datasets are append-only) but are
    surfaced, and any addition referencing a held-out case id is flagged as
    held_out_violation.

Regenerating the ledger is an integrator action performed after reviewing the
surfaced additions; this script is deterministic given the working tree.

Run from the repo root:
  python3 datasets/experiments/wave-f/f24-label-ledger.py
"""

import hashlib
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
DS = os.path.join(ROOT, "datasets")
OUT = os.path.join(HERE, "f24-label-ledger.json")

# (ledger key, repo-relative file, JSON pointer to the record list)
PROTECTED_COLLECTIONS = [
    ("stroke-gold labels", "datasets/paddle-bench/stroke-gold.json", ["labels"]),
    ("event-bounds-qa-wave-c events", "datasets/paddle-bench/event-bounds-qa-wave-c.json", ["events"]),
    ("event-bounds-qa-wave-c corrections", "datasets/paddle-bench/event-bounds-qa-wave-c.json", ["corrections"]),
    ("event-bounds-wave-a cases", "datasets/paddle-bench/event-bounds-wave-a.json", ["cases"]),
    ("event-bounds-wave-a rejectedCandidates", "datasets/paddle-bench/event-bounds-wave-a.json", ["rejectedCandidates"]),
    ("ta-bench cases", "datasets/ta-bench/cases.json", ["cases"]),
    ("corpus recordings", "datasets/corpus/recordings.json", []),
    ("corpus sources", "datasets/corpus/sources.json", []),
    ("paddle-bench registry videos", "datasets/paddle-bench/registry.json", ["videos"]),
    ("paddle-bench cases", "datasets/paddle-bench/paddle-bench.json", ["cases"]),
    ("ball-bench cases", "datasets/ball-bench/ball-bench.json", ["cases"]),
    ("pickleball registry sources", "datasets/pickleball/registry.json", ["sources"]),
    ("pickleball registry freshCandidates", "datasets/pickleball/registry.json", ["freshCandidates", "items"]),
    ("ood registry items", "datasets/ood/registry.json", ["items"]),
]


def canonical_record_sha(record):
    blob = json.dumps(record, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def resolve_records(root_dir, rel, pointer):
    with open(os.path.join(root_dir, rel)) as f:
        data = json.load(f)
    for key in pointer:
        data = data.get(key, []) if isinstance(data, dict) else []
    return data if isinstance(data, list) else []


def build_ledger(root_dir):
    collections = {}
    for name, rel, pointer in PROTECTED_COLLECTIONS:
        records = resolve_records(root_dir, rel, pointer)
        hashes = {}
        for r in records:
            h = canonical_record_sha(r)
            hashes[h] = hashes.get(h, 0) + 1
        collections[name] = {
            "file": rel,
            "pointer": pointer,
            "recordCount": len(records),
            "recordSha256Counts": hashes,
        }

    annotations = {}
    bundles_dir = os.path.join(root_dir, "datasets", "paddle-bench", "bundles")
    for b in sorted(os.listdir(bundles_dir)):
        ad = os.path.join(bundles_dir, b, "annotation")
        if not os.path.isdir(ad):
            continue
        for f in sorted(os.listdir(ad)):
            if not f.endswith(".json"):
                continue
            p = os.path.join(ad, f)
            rel = f"datasets/paddle-bench/bundles/{b}/annotation/{f}"
            try:
                revision = json.load(open(p)).get("revision")
            except json.JSONDecodeError:
                revision = None
            annotations[rel] = {"sha256": sha256_file(p), "revision": revision}

    return {
        "schemaVersion": 1,
        "workstream": "wave-f/f24-rt-data-provenance",
        "note": "append-only ledger over label/gold collections and bundle annotations; "
        "verified by f24-provenance-audit.py; regenerate only after reviewing "
        "surfaced unledgered additions",
        "collections": collections,
        "annotationFiles": annotations,
    }


def main():
    ledger = build_ledger(ROOT)
    with open(OUT, "w") as f:
        json.dump(ledger, f, indent=2, sort_keys=True)
        f.write("\n")
    print(f"wrote {OUT}")
    print(
        json.dumps(
            {
                "collections": {k: v["recordCount"] for k, v in ledger["collections"].items()},
                "annotationFiles": len(ledger["annotationFiles"]),
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
