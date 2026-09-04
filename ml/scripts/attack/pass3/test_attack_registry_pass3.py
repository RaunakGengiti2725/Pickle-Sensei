#!/usr/bin/env python3
"""Adversarial pass 3 / tester #4 — datasets/pickleball/registry.json integrity and split hygiene.

The registry is the provenance ledger for every committed clip under
datasets/pickleball/{dev-pool,fresh-candidates}. Nothing in ml/ or CI verifies
it executably (the unittest suite only covers the annotation validator), so this
module recomputes the evidence:

* every registered media path exists, its byte size and SHA-256 match the ledger;
* every file on disk is registered (no orphan media that could be labelled);
* dev_label_eligible and fresh_candidate ids / source URLs / uploader channels are disjoint
  (the label-blind holdout pool must not leak into the dev pool);
* declared totalBytes equal the sum of the items;
* quarantined ids never reappear in an eligible pool.

Run from the repository root:
  python3 -m unittest ml/scripts/attack/pass3/test_attack_registry_pass3.py -v
Hashing ~715 MB takes a few seconds.
"""

from __future__ import annotations

import hashlib
import json
import os
import unittest
from pathlib import Path

from attack_support import EVIDENCE_DIR, REGISTRY_PATH, REPO_ROOT

REGISTRY = json.loads(REGISTRY_PATH.read_text(encoding="utf-8"))
DEV_ITEMS = REGISTRY["devPool"]["items"]
FRESH_ITEMS = REGISTRY["freshCandidates"]["items"]
ALL_ITEMS = DEV_ITEMS + FRESH_ITEMS


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


class RegistryMediaProvenance(unittest.TestCase):
    def test_HELD_every_registered_clip_exists_with_matching_bytes_and_sha256(self):
        rows = []
        for item in ALL_ITEMS:
            path = REPO_ROOT / item["path"]
            with self.subTest(clip=item["id"]):
                self.assertTrue(path.is_file(), f"missing {item['path']}")
                size = path.stat().st_size
                digest = _sha256(path)
                rows.append({"id": item["id"], "path": item["path"], "bytes": size, "sha256": digest,
                             "ledger_bytes": item["media"]["clipBytes"], "ledger_sha256": item["media"]["sha256"]})
                self.assertEqual(size, item["media"]["clipBytes"])
                self.assertEqual(digest, item["media"]["sha256"])
        EVIDENCE_DIR.mkdir(parents=True, exist_ok=True)
        (EVIDENCE_DIR / "registry_sha256_table.json").write_text(json.dumps(rows, indent=2), encoding="utf-8")

    def test_HELD_no_unregistered_media_on_disk(self):
        on_disk = {
            f"datasets/pickleball/{sub}/{name}"
            for sub in ("dev-pool", "fresh-candidates")
            for name in os.listdir(REPO_ROOT / "datasets" / "pickleball" / sub)
        }
        registered = {item["path"] for item in ALL_ITEMS}
        self.assertEqual(on_disk - registered, set())
        self.assertEqual(registered - on_disk, set())

    def test_HELD_declared_totalBytes_match_items(self):
        self.assertEqual(REGISTRY["devPool"]["totalBytes"], sum(i["media"]["clipBytes"] for i in DEV_ITEMS))
        self.assertEqual(REGISTRY["freshCandidates"]["totalBytes"], sum(i["media"]["clipBytes"] for i in FRESH_ITEMS))


class RegistrySplitHygiene(unittest.TestCase):
    def test_HELD_dev_pool_and_fresh_candidates_are_disjoint(self):
        dev_ids = {i["id"] for i in DEV_ITEMS}
        fresh_ids = {i["id"] for i in FRESH_ITEMS}
        self.assertEqual(dev_ids & fresh_ids, set())
        self.assertEqual({i["sourceUrl"] for i in DEV_ITEMS} & {i["sourceUrl"] for i in FRESH_ITEMS}, set())
        dev_channels = {i["uploaderChannelId"] for i in DEV_ITEMS if i.get("uploaderChannelId")}
        fresh_channels = {i["uploaderChannelId"] for i in FRESH_ITEMS if i.get("uploaderChannelId")}
        self.assertEqual(dev_channels & fresh_channels, set())
        self.assertEqual(len({i["media"]["sha256"] for i in ALL_ITEMS}), len(ALL_ITEMS), "duplicate media digests")
        self.assertEqual(len({i["path"] for i in ALL_ITEMS}), len(ALL_ITEMS), "duplicate media paths")

    def test_HELD_roles_and_label_blindness_are_consistent_per_pool(self):
        self.assertEqual({i["role"] for i in DEV_ITEMS}, {"dev_label_eligible"})
        self.assertEqual({i["labelBlind"] for i in DEV_ITEMS}, {False})
        self.assertEqual({i["role"] for i in FRESH_ITEMS}, {"fresh_candidate"})
        self.assertEqual({i["labelBlind"] for i in FRESH_ITEMS}, {True})

    def test_HELD_quarantined_ids_do_not_reappear_in_an_eligible_pool(self):
        quarantined = {q.get("id") for q in REGISTRY["quarantinedUnknownRights"]} - {None}
        self.assertEqual(quarantined & {i["id"] for i in ALL_ITEMS}, set())

    def test_DESIGN_intake_records_use_a_different_role_vocabulary_than_items(self):
        """Observation (P3 candidate): intakeRecords.records[].assignedRole says
        'fresh_holdout_candidate' while the same clips' items carry role 'fresh_candidate'. Both
        mean label-blind holdout; any tooling filtering on one string misses the other. The
        dev_label_eligible role string is identical in both places."""
        by_id = {i["id"]: i for i in ALL_ITEMS}
        mismatches = []
        for rec in REGISTRY["intakeRecords"]["records"]:
            item = by_id[rec["clipId"]]
            self.assertEqual(rec["labelBlind"], item["labelBlind"], rec["clipId"])
            if rec["assignedRole"] != item["role"]:
                mismatches.append((rec["clipId"], rec["assignedRole"], item["role"]))
        EVIDENCE_DIR.mkdir(parents=True, exist_ok=True)
        (EVIDENCE_DIR / "registry_role_vocabulary.json").write_text(json.dumps(mismatches, indent=2), encoding="utf-8")
        # Documented as-is: the vocabulary split exists today for the 4 fresh clips.
        self.assertEqual(
            mismatches,
            [(cid, "fresh_holdout_candidate", "fresh_candidate")
             for cid in ("yt-n-QrBfQVK_w", "yt-9ru97zKV8mk", "yt-6r4fOxRuKmM", "va-O1dLhGGPErc")],
        )


if __name__ == "__main__":
    unittest.main()
