"""Audit: tools/e15_download.py media re-derivation lifecycle.

The script is a top-level program keyed off its own file location (ROOT), so
each scenario copies it verbatim into a scratch tree with a one-recording
corpus and a file:// mediaUrl that curl can fetch. Nothing under the real
datasets/ tree is read or written.

Contract under test (the script's purpose: "re-derive gitignored corpus media
... and sha-verify"):
  - a file already on disk whose sha256 does NOT match the recording must not
    be silently kept as the canonical media (re-fetch, quarantine, or fail);
  - a failed verification must be visible to the caller (non-zero exit),
    not only as `shaVerified: false` inside a JSON report the run "wrote";
  - a truncated/partial download (the very case `curl -C -` exists for) must
    be resumed on the next run rather than short-circuited by `already_present`.

Run: python3 -m unittest tools/audit/ml_tooling_datasets_structural1/test_e15_download_lifecycle.py
Requires: curl on PATH.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from _support import REPO_ROOT

SCRIPT = REPO_ROOT / "tools" / "e15_download.py"
GOOD = b"GOOD-MEDIA-BYTES" * 4096
CORRUPT = b"CORRUPT" * 100


def sha(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


class Scratch:
    def __init__(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        (self.root / "tools").mkdir()
        shutil.copy(SCRIPT, self.root / "tools" / "e15_download.py")
        (self.root / "datasets" / "corpus").mkdir(parents=True)
        self.remote = self.root / "remote.mp4"
        self.remote.write_bytes(GOOD)
        self.media_rel = "datasets/paddle-bench/videos/scratch.mp4"
        (self.root / "datasets" / "corpus" / "sources.json").write_text(json.dumps([{
            "sourceId": "src-1", "acquisition": {"mediaUrl": self.remote.as_uri()},
        }]))
        (self.root / "datasets" / "corpus" / "recordings.json").write_text(json.dumps([{
            "recordingId": "rec-1", "sourceId": "src-1", "path": self.media_rel, "sha256": sha(GOOD),
        }]))

    @property
    def media(self) -> Path:
        return self.root / self.media_rel

    def run(self) -> tuple[int, dict, str]:
        proc = subprocess.run([sys.executable, str(self.root / "tools" / "e15_download.py")],
                              capture_output=True, text=True, cwd=str(self.root))
        report_path = self.root / "datasets/experiments/wave-e/e15-media-rederivation.json"
        report = json.loads(report_path.read_text()) if report_path.exists() else {}
        return proc.returncode, report, proc.stdout + proc.stderr

    def cleanup(self):
        self.tmp.cleanup()


class E15DownloadLifecycle(unittest.TestCase):
    def setUp(self):
        self.s = Scratch()
        self.addCleanup(self.s.cleanup)

    def test_fresh_download_verifies_and_exits_zero(self):
        rc, report, log = self.s.run()
        self.assertEqual(rc, 0, log)
        entry = report["results"][0]
        self.assertEqual(entry["status"], "downloaded")
        self.assertTrue(entry["shaVerified"])
        self.assertEqual(sha(self.s.media.read_bytes()), sha(GOOD))

    def test_corrupt_existing_file_is_not_kept_as_canonical_media(self):
        self.s.media.parent.mkdir(parents=True)
        self.s.media.write_bytes(CORRUPT)
        rc, report, log = self.s.run()
        entry = report["results"][0]
        on_disk = self.s.media.read_bytes() if self.s.media.exists() else None
        self.assertFalse(
            on_disk == CORRUPT and rc == 0,
            f"corrupt pre-existing media survived the run unchanged and the run exited 0 "
            f"(status={entry.get('status')}, shaVerified={entry.get('shaVerified')}); "
            f"expected re-fetch from mediaUrl, quarantine, or a non-zero exit",
        )

    def test_sha_mismatch_is_a_nonzero_exit(self):
        self.s.media.parent.mkdir(parents=True)
        self.s.media.write_bytes(CORRUPT)
        rc, report, log = self.s.run()
        self.assertFalse(report["results"][0]["shaVerified"])
        self.assertNotEqual(rc, 0, "shaVerified=false but the process exited 0")

    def test_partial_download_is_resumed_on_next_run(self):
        # Simulate an interrupted earlier run: first half of the media on disk.
        self.s.media.parent.mkdir(parents=True)
        self.s.media.write_bytes(GOOD[: len(GOOD) // 2])
        rc, report, log = self.s.run()
        self.assertEqual(
            sha(self.s.media.read_bytes()), sha(GOOD),
            f"partial file was not completed (status={report['results'][0].get('status')}, "
            f"shaVerified={report['results'][0].get('shaVerified')}, exit={rc}); "
            f"`curl -C -` is only reached when the file is absent",
        )


if __name__ == "__main__":
    unittest.main()
