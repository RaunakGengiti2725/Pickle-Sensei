#!/usr/bin/env python3
"""Structural audit: e15_download.py checksum handling.

The script's contract (module docstring) is "re-derive gitignored corpus media
... and sha-verify". It runs at import time against hard-coded repository
paths, so each test copies it into a throwaway repo skeleton with fixture
recordings/sources and a fake `curl` on PATH. Nothing under datasets/ is read
or written.

Run from the repository root:
  python3 -m unittest tools/test_audit_e15_download.py -v
"""
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
SCRIPT = REPO / "tools" / "e15_download.py"

GOOD = b"good media bytes"
GOOD_SHA = hashlib.sha256(GOOD).hexdigest()
CORRUPT = b"truncated or bit-rotted media"

FAKE_CURL = """#!/bin/sh
# records every invocation; writes PAYLOAD_FILE contents to the -o target
echo "$@" >> "$CURL_LOG"
out=""
while [ $# -gt 0 ]; do
  if [ "$1" = "-o" ]; then out="$2"; shift; fi
  shift
done
cat "$CURL_PAYLOAD" > "$out"
exit 0
"""


class E15Sandbox:
    def __init__(self, tmp: Path):
        self.root = tmp / "repo"
        (self.root / "tools").mkdir(parents=True)
        (self.root / "datasets" / "corpus").mkdir(parents=True)
        shutil.copy(SCRIPT, self.root / "tools" / "e15_download.py")
        self.bin = tmp / "bin"
        self.bin.mkdir()
        curl = self.bin / "curl"
        curl.write_text(FAKE_CURL)
        curl.chmod(0o755)
        self.curl_log = tmp / "curl.log"
        self.payload = tmp / "payload.bin"
        self.media_rel = "datasets/corpus/media/rec-fixture.mp4"
        (self.root / "datasets/corpus/recordings.json").write_text(json.dumps([
            {"recordingId": "rec-fixture", "path": self.media_rel, "sourceId": "src-fixture",
             "sha256": GOOD_SHA},
        ]))
        (self.root / "datasets/corpus/sources.json").write_text(json.dumps([
            {"sourceId": "src-fixture", "acquisition": {"mediaUrl": "https://example.invalid/media.mp4"}},
        ]))

    @property
    def media(self) -> Path:
        return self.root / self.media_rel

    def run(self, payload: bytes) -> tuple[subprocess.CompletedProcess, dict]:
        self.payload.write_bytes(payload)
        env = dict(os.environ, PATH=f"{self.bin}:{os.environ['PATH']}",
                   CURL_LOG=str(self.curl_log), CURL_PAYLOAD=str(self.payload))
        proc = subprocess.run([sys.executable, str(self.root / "tools/e15_download.py")],
                              capture_output=True, text=True, env=env, cwd=self.root)
        report_path = self.root / "datasets/experiments/wave-e/e15-media-rederivation.json"
        report = json.loads(report_path.read_text()) if report_path.exists() else {}
        return proc, report

    def curl_calls(self) -> int:
        return len(self.curl_log.read_text().splitlines()) if self.curl_log.exists() else 0


class E15ChecksumHandlingTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.box = E15Sandbox(Path(self.tmp.name))

    def tearDown(self):
        self.tmp.cleanup()

    def test_control_fresh_download_with_matching_sha_is_verified(self):
        proc, report = self.box.run(GOOD)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        entry = report["results"][0]
        self.assertEqual(entry["status"], "downloaded")
        self.assertTrue(entry["shaVerified"])
        self.assertEqual(self.box.curl_calls(), 1)

    def test_existing_corrupt_file_is_refetched_or_rejected(self):
        self.box.media.parent.mkdir(parents=True)
        self.box.media.write_bytes(CORRUPT)
        proc, report = self.box.run(GOOD)  # network copy is good; local copy is corrupt
        entry = report["results"][0]
        self.assertFalse(entry["shaVerified"], "control: corrupt local file must not verify")
        recovered = self.box.media.read_bytes() == GOOD
        self.assertTrue(
            recovered or proc.returncode != 0,
            "corrupt already-present media was neither re-fetched "
            f"(curl calls={self.box.curl_calls()}, bytes still corrupt={not recovered}) "
            f"nor reported via a non-zero exit (rc={proc.returncode}); status={entry['status']!r}",
        )

    def test_downloaded_file_with_sha_mismatch_is_not_kept_silently(self):
        proc, report = self.box.run(CORRUPT)  # network hands back wrong bytes
        entry = report["results"][0]
        self.assertEqual(entry["status"], "downloaded")
        self.assertFalse(entry["shaVerified"])
        self.assertTrue(
            not self.box.media.exists() or proc.returncode != 0,
            "sha-mismatched download left on disk at the canonical corpus path with exit code 0 — "
            "the next run will classify it 'already_present' and never re-fetch",
        )

    def test_second_run_after_bad_download_does_not_trust_already_present(self):
        self.box.run(CORRUPT)
        calls_after_first = self.box.curl_calls()
        proc, report = self.box.run(GOOD)
        entry = report["results"][0]
        self.assertTrue(
            entry["shaVerified"] or proc.returncode != 0,
            f"second run status={entry['status']!r} shaVerified={entry['shaVerified']} rc={proc.returncode}; "
            f"curl calls first={calls_after_first} total={self.box.curl_calls()}",
        )


if __name__ == "__main__":
    unittest.main()
