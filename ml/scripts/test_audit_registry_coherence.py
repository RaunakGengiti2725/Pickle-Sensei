#!/usr/bin/env python3
"""Structural audit: datasets/pickleball/registry.json internal coherence and doc drift.

registry.json is validated by no schema and pinned only by the TypeScript
e08FreshHoldoutGuard (ids/roles/hashes/directory contents). These checks cover
what that guard does not: declared totals vs item bytes, quarantine
`resolvedBy` pointers, intake records vs pool membership, producer overlap
across roles, and whether the human-facing DATA_CARD.md / per-clip data cards
still describe the registry they claim to have "recounted programmatically".

Stdlib only. Run from the repository root:
  python3 -m unittest discover -s ml/scripts -p 'test_audit_registry_coherence.py' -v
"""
import hashlib
import json
import re
import unittest
from collections import Counter, defaultdict
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
DS = REPO / "datasets" / "pickleball"
REGISTRY = json.loads((DS / "registry.json").read_text(encoding="utf-8"))
FRESH = REGISTRY["freshCandidates"]["items"]
DEV = REGISTRY["devPool"]["items"]
QUARANTINED = REGISTRY["quarantinedUnknownRights"]
POOLED = FRESH + DEV


def sha256_of(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


class RegistryInternalCoherenceTest(unittest.TestCase):
    def test_declared_total_bytes_equal_sum_of_item_bytes(self):
        for pool in ("freshCandidates", "devPool"):
            block = REGISTRY[pool]
            self.assertEqual(block["totalBytes"], sum(i["media"]["clipBytes"] for i in block["items"]), pool)

    def test_media_on_disk_matches_bytes_and_sha256(self):
        for item in POOLED:
            path = REPO / item["path"]
            with self.subTest(id=item["id"]):
                self.assertTrue(path.is_file(), path)
                self.assertEqual(path.stat().st_size, item["media"]["clipBytes"])
                self.assertEqual(sha256_of(path), item["media"]["sha256"])

    def test_pool_directories_hold_exactly_registered_media(self):
        for pool, folder in (("freshCandidates", "fresh-candidates"), ("devPool", "dev-pool")):
            registered = {Path(i["path"]).name for i in REGISTRY[pool]["items"]}
            on_disk = {p.name for p in (DS / folder).iterdir() if not p.name.startswith(".")}
            self.assertEqual(on_disk, registered, pool)

    def test_ids_unique_and_roles_consistent(self):
        counts = Counter(i["id"] for i in POOLED + QUARANTINED)
        self.assertEqual([i for i, c in counts.items() if c > 1], [])
        for item in FRESH:
            self.assertEqual((item["role"], item["labelBlind"]), ("fresh_candidate", True), item["id"])
        for item in DEV:
            self.assertEqual((item["role"], item["labelBlind"]), ("dev_label_eligible", False), item["id"])

    def test_quarantine_resolutions_point_at_registered_pool_items(self):
        pooled_ids = {i["id"] for i in POOLED}
        for q in QUARANTINED:
            resolved = q.get("resolvedBy")
            if not resolved:
                continue
            target = resolved.split(" ")[0]
            with self.subTest(id=q["id"]):
                self.assertIn(target, pooled_ids, f"{q['id']} resolvedBy {target!r} is not a registered clip")
                same_video = [i for i in POOLED if i["id"] == target][0]
                self.assertEqual(same_video["sourceUrl"], q["sourceUrl"], "resolution must be the same source video")

    def test_quarantined_source_urls_are_not_pooled_unless_resolved(self):
        pooled_urls = {i["sourceUrl"]: i["id"] for i in POOLED}
        for q in QUARANTINED:
            if q["sourceUrl"] in pooled_urls:
                self.assertTrue(q.get("resolvedBy"), f"{q['id']} is quarantined AND pooled as {pooled_urls[q['sourceUrl']]}")

    def test_no_non_null_uploader_channel_is_split_across_roles(self):
        by_channel = defaultdict(set)
        for item in POOLED:
            if item.get("uploaderChannelId"):
                by_channel[item["uploaderChannelId"]].add(item["role"])
        split = {c: r for c, r in by_channel.items() if len(r) > 1}
        self.assertEqual(split, {}, "same uploader channel in both fresh (holdout) and dev pools")

    def test_producer_overlap_across_roles_is_declared_in_intake_authority(self):
        # Same-producer clips in holdout vs dev is a documented caveat; make sure it is
        # actually documented for every producer that straddles the two pools.
        by_uploader = defaultdict(set)
        for item in POOLED:
            by_uploader[item["uploader"]].add(item["role"])
        straddling = sorted(u for u, roles in by_uploader.items() if len(roles) > 1)
        authority = REGISTRY["intakeRecords"]["authority"]
        for uploader in straddling:
            self.assertIn("same-producer caveat", authority, uploader)
        self.assertLessEqual(len(straddling), 1, straddling)

    def test_every_dev_pool_item_has_an_intake_record_and_records_are_registered(self):
        intake_ids = {r["clipId"] for r in REGISTRY["intakeRecords"]["records"]}
        pooled_ids = {i["id"] for i in POOLED}
        for item in DEV:
            self.assertIn(item["id"], intake_ids, f"dev clip {item['id']} without intake record")
        self.assertEqual(intake_ids - pooled_ids, set(), "intake records for unregistered clips")


class DataCardDriftTest(unittest.TestCase):
    """DATA_CARD.md states its counts were 'recounted programmatically'; check they still are."""

    CARD = (DS / "DATA_CARD.md").read_text(encoding="utf-8")

    def _int(self, pattern: str) -> int:
        m = re.search(pattern, self.CARD)
        self.assertIsNotNone(m, pattern)
        return int(m.group(1).replace(",", ""))

    def test_registry_counts_in_data_card_match_registry(self):
        self.assertEqual(self._int(r"(\d+) registered-not-downloaded sources"), len(REGISTRY["sources"]))
        self.assertEqual(self._int(r"(\d+) evaluated-but-excluded"), len(REGISTRY["evaluatedButExcluded"]))
        self.assertEqual(self._int(r"(\d+) official search check"), len(REGISTRY["officialSearchChecks"]))
        self.assertEqual(self._int(r"(\d+) fresh candidates"), len(FRESH))
        self.assertEqual(self._int(r"(\d+) quarantined/excluded"), len(QUARANTINED))

    def test_fresh_candidate_bytes_in_data_card_match_registry(self):
        self.assertEqual(self._int(r"fresh-candidates/`: (\d+) mp4 clips"), len(FRESH))
        self.assertEqual(self._int(r"([\d,]+) bytes total"), REGISTRY["freshCandidates"]["totalBytes"])

    def test_data_card_describes_dev_pool_role(self):
        self.assertGreater(len(DEV), 0)
        self.assertIn("dev-pool", self.CARD, "registry has a devPool; DATA_CARD.md never mentions it")
        self.assertIn("dev_label_eligible", self.CARD)

    def test_per_clip_cards_match_registry_path_and_bytes(self):
        cards = {p.stem: p.read_text(encoding="utf-8") for p in (DS / "data-cards").glob("*.md")}
        self.assertTrue(cards)
        by_id = {i["id"]: i for i in POOLED}
        for clip_id, text in cards.items():
            with self.subTest(clip=clip_id):
                self.assertIn(clip_id, by_id)
                self.assertIn(f"`{by_id[clip_id]['path']}`", text, "card path must match registry path/role")
                m = re.search(r"Bytes: ([\d,]+)", text)
                self.assertIsNotNone(m)
                self.assertEqual(int(m.group(1).replace(",", "")), by_id[clip_id]["media"]["clipBytes"])


if __name__ == "__main__":
    unittest.main()
