"""Regression tests for tools/e15_download.py (media re-derivation + sha verification).

The script derives its ROOT from its own location, so each test copies it into a
scratch tree (`<scratch>/tools/e15_download.py`) whose `datasets/corpus/*.json`
point at media served by a local HTTP server. No network access is required.

Run: python3 -m unittest tools/test_e15_download.py
"""
import hashlib
import http.server
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, "e15_download.py")
OUT_REL = "datasets/experiments/wave-e/e15-media-rederivation.json"


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


class _QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *_args):
        pass


class Scratch:
    """A throwaway repo tree + HTTP server serving `served/`."""

    def __init__(self):
        self.root = tempfile.mkdtemp(prefix="e15-test-")
        self.served = os.path.join(self.root, "served")
        os.makedirs(self.served)
        os.makedirs(os.path.join(self.root, "tools"))
        os.makedirs(os.path.join(self.root, "datasets/corpus"))
        shutil.copy(SCRIPT, os.path.join(self.root, "tools/e15_download.py"))
        handler = lambda *a, **kw: _QuietHandler(*a, directory=self.served, **kw)  # noqa: E731
        self.httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
        self.port = self.httpd.server_address[1]
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()
        self.recordings = []
        self.sources = []

    def close(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        shutil.rmtree(self.root, ignore_errors=True)

    def add(self, rid: str, remote: bytes, *, expected_sha=None, local=None, url=None):
        """Register a recording. `remote` is what the server serves; `local`, if given,
        is pre-placed on disk; `expected_sha` defaults to sha256(remote)."""
        with open(os.path.join(self.served, f"{rid}.bin"), "wb") as f:
            f.write(remote)
        rel = f"datasets/media/{rid}.mp4"
        if local is not None:
            abs_path = os.path.join(self.root, rel)
            os.makedirs(os.path.dirname(abs_path), exist_ok=True)
            with open(abs_path, "wb") as f:
                f.write(local)
        self.recordings.append(
            {
                "schemaVersion": 1,
                "recordingId": rid,
                "sourceId": f"src-{rid}",
                "path": rel,
                "sha256": expected_sha or sha256_bytes(remote),
            }
        )
        self.sources.append(
            {
                "sourceId": f"src-{rid}",
                "acquisition": {"mediaUrl": url or f"http://127.0.0.1:{self.port}/{rid}.bin"},
            }
        )

    def write_corpus(self):
        with open(os.path.join(self.root, "datasets/corpus/recordings.json"), "w") as f:
            json.dump(self.recordings, f)
        with open(os.path.join(self.root, "datasets/corpus/sources.json"), "w") as f:
            json.dump(self.sources, f)

    def run(self):
        self.write_corpus()
        proc = subprocess.run(
            [sys.executable, os.path.join(self.root, "tools/e15_download.py")],
            capture_output=True,
            text=True,
            timeout=120,
        )
        out_path = os.path.join(self.root, OUT_REL)
        report = json.load(open(out_path)) if os.path.exists(out_path) else None
        return proc, report

    def local_bytes(self, rid: str) -> bytes:
        with open(os.path.join(self.root, f"datasets/media/{rid}.mp4"), "rb") as f:
            return f.read()


def by_id(report):
    return {e["recordingId"]: e for e in report["results"]}


class E15DownloadTest(unittest.TestCase):
    def setUp(self):
        self.scratch = Scratch()
        self.addCleanup(self.scratch.close)

    def test_present_file_with_bad_sha_is_refetched_and_verified(self):
        good = b"GOOD-MEDIA-" * 4096
        self.scratch.add("rec-corrupt", good, local=b"\x00" * len(good))
        self.scratch.add("rec-partial", good, local=good[: len(good) // 3])
        proc, report = self.scratch.run()

        self.assertIsNotNone(report, proc.stderr)
        entries = by_id(report)
        for rid in ("rec-corrupt", "rec-partial"):
            e = entries[rid]
            self.assertNotEqual(e["status"], "already_present", e)
            self.assertTrue(e["shaVerified"], e)
            self.assertEqual(e["sha256"], sha256_bytes(good), e)
            self.assertEqual(self.scratch.local_bytes(rid), good, rid)
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)

    def test_present_file_with_matching_sha_is_left_untouched(self):
        good = b"ALREADY-OK-" * 1024
        self.scratch.add("rec-good", good, local=good)
        path = os.path.join(self.scratch.root, "datasets/media/rec-good.mp4")
        os.utime(path, (1_000_000_000, 1_000_000_000))
        proc, report = self.scratch.run()

        e = by_id(report)["rec-good"]
        self.assertEqual(e["status"], "already_present", e)
        self.assertTrue(e["shaVerified"], e)
        self.assertEqual(os.stat(path).st_mtime, 1_000_000_000, "file must not be rewritten")
        self.assertNotIn("downloading rec-good", proc.stdout)
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)

    def test_exit_nonzero_when_downloaded_sha_mismatches(self):
        served = b"SERVED-BYTES" * 512
        self.scratch.add("rec-good", b"fine" * 256)
        self.scratch.add("rec-shamismatch", served, expected_sha="0" * 64)
        proc, report = self.scratch.run()

        entries = by_id(report)
        self.assertTrue(entries["rec-good"]["shaVerified"])
        self.assertFalse(entries["rec-shamismatch"]["shaVerified"])
        self.assertNotEqual(proc.returncode, 0, "unverified entry must fail the process")
        self.assertIn("rec-shamismatch", proc.stderr)

    def test_exit_nonzero_when_curl_fails(self):
        self.scratch.add("rec-good", b"fine" * 256)
        missing = os.path.join(self.scratch.root, "does-not-exist.bin")
        self.scratch.add("rec-unreachable", b"", url=f"file://{missing}")
        proc, report = self.scratch.run()

        e = by_id(report)["rec-unreachable"]
        self.assertTrue(e["status"].startswith("curl_failed_"), e)
        self.assertFalse(e.get("shaVerified", False), e)
        self.assertNotEqual(proc.returncode, 0, "curl failure must fail the process")

    def test_stale_file_without_media_url_is_reported_unverified(self):
        good = b"NO-URL-" * 1024
        self.scratch.add("rec-nourl", good, local=b"junk" * 64)
        self.scratch.sources[-1]["acquisition"] = {}
        proc, report = self.scratch.run()

        e = by_id(report)["rec-nourl"]
        self.assertEqual(e["status"], "no_media_url", e)
        self.assertFalse(e["shaVerified"], e)
        self.assertNotEqual(proc.returncode, 0, "corrupt file that cannot be re-fetched must fail")

    def test_exit_zero_only_when_every_entry_verified(self):
        self.scratch.add("rec-a", b"A" * 2048)
        self.scratch.add("rec-b", b"B" * 2048, local=b"B" * 2048)
        proc, report = self.scratch.run()

        self.assertTrue(all(e["shaVerified"] for e in report["results"]))
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)


if __name__ == "__main__":
    unittest.main()
