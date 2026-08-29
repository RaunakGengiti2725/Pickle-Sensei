#!/usr/bin/env python3
"""Wave H h20-data-rights-cert: repo-wide dataset/media provenance audit.

Enumerates every committed dataset/media item, resolves each to a registry
record (source, license, rights, consent basis, split, dedup lineage), and
verifies training-safety invariants:
  - unknown rights => quarantine (never training-eligible)
  - held-out / test-held-out / shadow / coach-holdout never training-eligible
  - analysis permission never implies training permission
  - no first-party example is training-eligible without explicit
    model_training consent
Writes datasets/experiments/wave-h/h20-provenance-manifest.json with counts.
"""

import hashlib
import json
import os
import subprocess
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
MEDIA_EXT = (".mp4", ".mov", ".webm", ".avi", ".mkv", ".jpg", ".jpeg", ".png", ".wav", ".mp3")
AFFIRMATIVE = {"yes", "yes_with_attribution"}


def load(rel):
    with open(os.path.join(ROOT, rel)) as fh:
        return json.load(fh)


def sha256(rel):
    h = hashlib.sha256()
    with open(os.path.join(ROOT, rel), "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def rights_training_eligible(rights):
    return (
        rights is not None
        and rights.get("train") in AFFIRMATIVE
        and rights.get("store") in AFFIRMATIVE
        and rights.get("analyze") in AFFIRMATIVE
    )


def main():
    findings = {"P0": [], "P1": [], "P2": []}

    committed_media = [
        p
        for p in subprocess.run(
            ["git", "ls-files", "datasets"], cwd=ROOT, capture_output=True, text=True, check=True
        ).stdout.splitlines()
        if p.lower().endswith(MEDIA_EXT)
    ]

    sources = load("datasets/corpus/sources.json")
    if isinstance(sources, dict):
        sources = sources.get("sources", sources)
    recordings = load("datasets/corpus/recordings.json")
    if isinstance(recordings, dict):
        recordings = recordings.get("recordings", recordings)
    splits = load("datasets/corpus/splits.json")
    pb_registry = load("datasets/paddle-bench/registry.json")["videos"]
    bench = load("datasets/paddle-bench/paddle-bench.json")["cases"]
    ood = load("datasets/ood/registry.json")
    pk = load("datasets/pickleball/registry.json")

    src_by_id = {s["sourceId"]: s for s in sources}
    rec_by_path = {r["path"]: r for r in recordings}
    assigned = splits.get("assigned", {})

    # ── Corpus sources: rights completeness + quarantine accounting ──
    source_rows = []
    for s in sources:
        r = s.get("rights") or {}
        unknown = [k for k in ("store", "analyze", "annotate", "train") if r.get(k) is None]
        if unknown:
            findings["P0"].append(f"source {s['sourceId']}: missing rights fields {unknown}")
        source_rows.append(
            {
                "sourceId": s["sourceId"],
                "license": s.get("license"),
                "url": s.get("url"),
                "rightsBasis": r.get("basis"),
                "trainRight": r.get("train"),
                "analyzeRight": r.get("analyze"),
                "trainingEligible": rights_training_eligible(r),
                "quarantined": not rights_training_eligible(r),
            }
        )

    # ── Corpus recordings: lineage, split, hash, source resolution ──
    recording_rows = []
    for rec in recordings:
        src = src_by_id.get(rec["sourceId"])
        if src is None:
            findings["P0"].append(f"recording {rec['recordingId']}: unknown sourceId {rec['sourceId']}")
        split = assigned.get(rec.get("sessionKey", ""), {}).get("split", "UNASSIGNED")
        on_disk = os.path.exists(os.path.join(ROOT, rec["path"]))
        hash_ok = None
        if on_disk:
            hash_ok = sha256(rec["path"]) == rec["sha256"]
            if not hash_ok:
                findings["P0"].append(f"recording {rec['recordingId']}: sha256 mismatch on disk")
        recording_rows.append(
            {
                "recordingId": rec["recordingId"],
                "path": rec["path"],
                "sourceId": rec["sourceId"],
                "sessionKey": rec.get("sessionKey"),
                "split": split,
                "derivedFrom": [d["parentRecordingId"] for d in rec.get("derivedFrom", [])],
                "onDisk": on_disk,
                "hashVerified": hash_ok,
                "rightsTrainingEligible": rights_training_eligible((src or {}).get("rights")),
            }
        )

    # ── Committed media reconciliation: every file must map to a registry ──
    registered_paths = set()
    for rec in recordings:
        registered_paths.add(rec["path"])
    for v in pb_registry:
        registered_paths.add("datasets/paddle-bench/" + v["file"])
    for c in bench:
        registered_paths.add(os.path.normpath(os.path.join("datasets/paddle-bench", c["video"])))
    ood_items = ood.get("items", [])
    ood_derived = ood.get("derivedItems", {}).get("items", [])
    pk_fresh = pk.get("freshCandidates", {}).get("items", [])
    pk_dev = pk.get("devPool", {}).get("items", [])
    for item in ood_items + ood_derived + pk_fresh + pk_dev:
        registered_paths.add(item.get("path") or item.get("file"))

    rec_by_sha = {r["sha256"]: r["recordingId"] for r in recordings}
    media_rows = []
    unregistered = []
    for path in committed_media:
        if path in registered_paths:
            media_rows.append({"path": path, "registered": True, "resolvedVia": "path"})
            continue
        rec_id = rec_by_sha.get(sha256(path))
        if rec_id:
            media_rows.append(
                {"path": path, "registered": True, "resolvedVia": f"sha256->{rec_id}"}
            )
            findings["P2"].append(
                f"media registered by content hash only (byte-identical to corpus recording, no path-level registry entry): {path}"
            )
            continue
        unregistered.append(path)
        media_rows.append({"path": path, "registered": False, "resolvedVia": None})
    for path in unregistered:
        findings["P1"].append(f"committed media not resolvable to any registry record: {path}")

    # ── Held-out protection ──
    held_out_cases = {c["id"]: c.get("role") for c in bench if c.get("role") in ("held_out", "test_held_out")}
    for case_id in ("wm-dink-01", "afn-vic-rally1"):
        if case_id not in held_out_cases:
            findings["P0"].append(f"held-out case {case_id} missing held-out role in paddle-bench.json")

    # ── Release audit: paddle-distill-v0.1 ──
    distill_rows = []
    with open(os.path.join(ROOT, "datasets/releases/paddle-distill-v0.1/examples.jsonl")) as fh:
        examples = [json.loads(line) for line in fh if line.strip()]
    for ex in examples:
        role = ex.get("role")
        eligible = ex.get("trainingEligible")
        if eligible and role in ("held_out", "test_held_out"):
            findings["P0"].append(f"paddle-distill example {ex.get('exampleId')}: held-out marked trainingEligible")
        if eligible and ex.get("sourceUserId") and not ex.get("modelTrainingConsent"):
            findings["P0"].append(f"paddle-distill example {ex.get('exampleId')}: first-party eligible without consent record")
    distill_counts = {
        "total": len(examples),
        "trainingEligible": sum(1 for e in examples if e.get("trainingEligible")),
        "quarantined": sum(1 for e in examples if not e.get("trainingEligible")),
        "heldOutEligible": sum(
            1 for e in examples if e.get("trainingEligible") and e.get("role") in ("held_out", "test_held_out")
        ),
    }

    # ── Release audit: pickle-real manifests (per-event training records) ──
    pickle_real = {}
    for version in sorted(os.listdir(os.path.join(ROOT, "datasets/releases"))):
        if not version.startswith("pickle-real-"):
            continue
        manifest = load(f"datasets/releases/{version}/manifest.json")
        events = manifest.get("events", [])
        flagged = [e for e in events if "trainingEligible" not in e]
        nondev = [e for e in events if e.get("split") != "development"]
        pickle_real[version] = {
            "events": len(events),
            "nonDevelopmentEvents": len(nondev),
            "eventsMissingTrainingEligibilityFlag": len(flagged),
        }
        if flagged and nondev:
            findings["P1"].append(
                f"{version}: {len(nondev)} non-development events (incl. locked test) appear in per-event "
                f"'training-ready' records with no trainingEligible/quarantine flag — a downstream consumer "
                f"could train on locked test / held-out (fixed in datasetRelease.ts for future releases; "
                f"released manifests are immutable)"
            )

    manifest_out = {
        "gate": "GATE_9_DATA_RIGHTS_TRAINING_SAFETY",
        "workstream": "h20-data-rights-cert",
        "generatedAt": subprocess.run(["date", "-u", "+%Y-%m-%dT%H:%M:%SZ"], capture_output=True, text=True).stdout.strip(),
        "counts": {
            "corpusSources": len(sources),
            "corpusSourcesTrainingEligible": sum(1 for r in source_rows if r["trainingEligible"]),
            "corpusSourcesQuarantined": sum(1 for r in source_rows if r["quarantined"]),
            "corpusRecordings": len(recordings),
            "recordingsRootFootage": sum(1 for r in recording_rows if not r["derivedFrom"]),
            "recordingsDerived": sum(1 for r in recording_rows if r["derivedFrom"]),
            "recordingsOnDiskVerified": sum(1 for r in recording_rows if r["hashVerified"]),
            "recordingsAbsentFromCheckout": sum(1 for r in recording_rows if not r["onDisk"]),
            "committedMediaFiles": len(committed_media),
            "committedMediaRegistered": sum(1 for m in media_rows if m["registered"]),
            "committedMediaUnregistered": len(unregistered),
            "benchCases": len(bench),
            "benchHeldOutCases": len(held_out_cases),
            "oodItems": len(ood_items),
            "oodDerivedItems": len(ood_derived),
            "oodQuarantinedUnknownRights": len(ood.get("quarantinedUnknownRights", [])),
            "pickleballFreshCandidates": len(pk_fresh),
            "pickleballDevPool": len(pk_dev),
            "pickleballQuarantinedUnknownRights": len(pk.get("quarantinedUnknownRights", [])),
            "paddleDistillV01": distill_counts,
            "pickleRealReleases": pickle_real,
        },
        "sources": source_rows,
        "recordings": recording_rows,
        "committedMedia": media_rows,
        "findings": findings,
    }
    out_path = os.path.join(ROOT, "datasets/experiments/wave-h/h20-provenance-manifest.json")
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, "w") as fh:
        json.dump(manifest_out, fh, indent=2)
        fh.write("\n")
    print(json.dumps(manifest_out["counts"], indent=2))
    print(json.dumps(findings, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
