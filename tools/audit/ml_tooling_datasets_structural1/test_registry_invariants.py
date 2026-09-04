"""Audit: datasets/pickleball/registry.json structural invariants not pinned by any repo test.

e08FreshHoldoutGuard.test.ts pins id-disjointness and per-file sha256. This
file pins the remaining declared invariants directly against the JSON and the
on-disk media so drift is caught by an executable check rather than prose:

  - declared totalBytes == sum(media.clipBytes) == sum(on-disk sizes), per pool;
  - every fresh candidate is role fresh_candidate + labelBlind true; every
    dev-pool item is dev_label_eligible + labelBlind false;
  - the intakeRecords authority statement "No uploaderChannelId is split
    across roles" holds (no channel appears in both pools);
  - every quarantined item is not downloaded (no path on disk);
  - DATA_CARD.md "Contents" counts agree with registry.json.

Run: python3 -m unittest tools/audit/ml_tooling_datasets_structural1/test_registry_invariants.py
"""

from __future__ import annotations

import json
import re
import unittest

from _support import REPO_ROOT

PICKLEBALL = REPO_ROOT / "datasets" / "pickleball"
REGISTRY = json.loads((PICKLEBALL / "registry.json").read_text())
DATA_CARD = (PICKLEBALL / "DATA_CARD.md").read_text()


class RegistryInvariants(unittest.TestCase):
    def pool_items(self, pool: str) -> list[dict]:
        return REGISTRY[pool]["items"]

    def assert_bytes_coherent(self, pool: str):
        items = self.pool_items(pool)
        declared = REGISTRY[pool]["totalBytes"]
        registered = sum(i["media"]["clipBytes"] for i in items)
        on_disk = sum((REPO_ROOT / i["path"]).stat().st_size for i in items)
        self.assertEqual(declared, registered, f"{pool}.totalBytes != sum(clipBytes)")
        self.assertEqual(registered, on_disk, f"{pool}: registered clipBytes != on-disk sizes")

    def test_fresh_candidates_bytes_coherent(self):
        self.assert_bytes_coherent("freshCandidates")

    def test_dev_pool_bytes_coherent(self):
        self.assert_bytes_coherent("devPool")

    def test_roles_and_label_blindness_by_pool(self):
        for item in self.pool_items("freshCandidates"):
            self.assertEqual(item["role"], "fresh_candidate", item["id"])
            self.assertIs(item["labelBlind"], True, item["id"])
        for item in self.pool_items("devPool"):
            self.assertEqual(item["role"], "dev_label_eligible", item["id"])
            self.assertIs(item["labelBlind"], False, item["id"])

    def test_uploader_channel_not_split_across_roles(self):
        fresh = {i["uploaderChannelId"] for i in self.pool_items("freshCandidates") if i.get("uploaderChannelId")}
        dev = {i["uploaderChannelId"] for i in self.pool_items("devPool") if i.get("uploaderChannelId")}
        self.assertEqual(fresh & dev, set(), "uploaderChannelId shared between fresh candidates and dev pool")

    def test_quarantined_items_have_no_media_on_disk(self):
        for item in REGISTRY["quarantinedUnknownRights"]:
            self.assertNotIn(item["status"], ("downloaded", "dev_label_eligible", "fresh_candidate"), item.get("id"))
            path = item.get("path")
            if path:
                self.assertFalse((REPO_ROOT / path).exists(), f"quarantined item {item.get('id')} has media on disk")

    def test_data_card_counts_match_registry(self):
        m = re.search(r"(\d+) fresh candidates · (\d+) quarantined", DATA_CARD)
        self.assertIsNotNone(m, "DATA_CARD Contents line not found")
        card_fresh, card_quarantined = int(m.group(1)), int(m.group(2))
        m2 = re.search(r"`fresh-candidates/`: (\d+) mp4 clips, ([\d,]+) bytes total", DATA_CARD)
        self.assertIsNotNone(m2)
        card_clips, card_bytes = int(m2.group(1)), int(m2.group(2).replace(",", ""))
        reg_fresh = len(self.pool_items("freshCandidates"))
        reg_quarantined = len(REGISTRY["quarantinedUnknownRights"])
        reg_bytes = REGISTRY["freshCandidates"]["totalBytes"]
        self.assertEqual(
            (card_fresh, card_quarantined, card_clips, card_bytes),
            (reg_fresh, reg_quarantined, reg_fresh, reg_bytes),
            "DATA_CARD.md Contents (fresh, quarantined, clips, bytes) disagree with registry.json",
        )


if __name__ == "__main__":
    unittest.main()
