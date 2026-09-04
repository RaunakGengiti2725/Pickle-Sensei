"""S1 — tools/e15_download.py with a corrupt file pre-placed at a corpus media path.

Scratch tree = copy of the script + datasets/corpus/{recordings,sources}.json.
Network is blocked two ways: a `curl` shim first on PATH that logs every
invocation and exits 6 (CURLE_COULDNT_RESOLVE_HOST), and — when the kernel
allows it — the whole run is wrapped in `unshare -rn` (no network namespace).
"""
from __future__ import annotations

import hashlib
import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from attack_common import ARTIFACT_DIR, E15_DOWNLOAD, REPO_ROOT, run

CURL_SHIM = """#!/bin/sh
printf '%s\\n' "$*" >> "$CURL_SHIM_LOG"
echo "curl: (6) Could not resolve host (network blocked by attack harness)" >&2
exit 6
"""


def unshare_works() -> bool:
    try:
        return subprocess.run(["unshare", "-rn", "true"], capture_output=True, timeout=10).returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        return False


class E15CorruptPresentTest(unittest.TestCase):
    def setUp(self) -> None:
        self.scratch = Path(tempfile.mkdtemp(prefix="e15-attack-"))
        (self.scratch / "tools").mkdir()
        (self.scratch / "datasets/corpus").mkdir(parents=True)
        shutil.copy(E15_DOWNLOAD, self.scratch / "tools/e15_download.py")
        for name in ("recordings.json", "sources.json"):
            shutil.copy(REPO_ROOT / "datasets/corpus" / name, self.scratch / "datasets/corpus" / name)
        self.recordings = json.loads((self.scratch / "datasets/corpus/recordings.json").read_text())
        sources = {s["sourceId"]: s for s in json.loads((self.scratch / "datasets/corpus/sources.json").read_text())}
        # A re-downloadable recording (not held out, not derived, has a mediaUrl).
        held_out = {"rec-024decaeb66e", "rec-7d396a6d6566"}
        self.target = next(
            r for r in self.recordings
            if r["recordingId"] not in held_out and not r.get("derivedFrom")
            and sources.get(r["sourceId"], {}).get("acquisition", {}).get("mediaUrl")
        )
        self.corrupt_path = self.scratch / self.target["path"]
        self.corrupt_path.parent.mkdir(parents=True, exist_ok=True)
        self.corrupt_bytes = b"\x00\x00\x00\x18ftypisom CORRUPT " + os.urandom(2048)
        self.corrupt_path.write_bytes(self.corrupt_bytes)
        assert hashlib.sha256(self.corrupt_bytes).hexdigest() != self.target["sha256"]

        bindir = self.scratch / "bin"
        bindir.mkdir()
        shim = bindir / "curl"
        shim.write_text(CURL_SHIM)
        shim.chmod(shim.stat().st_mode | stat.S_IEXEC)
        self.curl_log = self.scratch / "curl-invocations.log"
        self.env = {**os.environ, "PATH": f"{bindir}:{os.environ['PATH']}", "CURL_SHIM_LOG": str(self.curl_log)}

    def tearDown(self) -> None:
        shutil.rmtree(self.scratch, ignore_errors=True)

    def _run(self, name: str = "s1_e15_corrupt_present"):
        cmd = [sys.executable, str(self.scratch / "tools/e15_download.py")]
        if unshare_works():
            cmd = ["unshare", "-rn", *cmd]
        result = run(cmd, timeout=120, cwd=self.scratch, env=self.env)
        report_path = self.scratch / "datasets/experiments/wave-e/e15-media-rederivation.json"
        report = json.loads(report_path.read_text()) if report_path.exists() else None
        curl_calls = self.curl_log.read_text().splitlines() if self.curl_log.exists() else []
        artifact = result.record(
            name,
            target=self.target["recordingId"],
            corruptPath=self.target["path"],
            report=report,
            curlInvocations=curl_calls,
            networkNamespace=cmd[0] == "unshare",
        )
        shutil.copy(artifact, ARTIFACT_DIR / f"{name}.latest.json")
        return result, report, curl_calls

    def test_corrupt_present_file_is_reported_and_retained(self) -> None:
        """Scenario contract: already_present + shaVerified false + corrupt bytes retained."""
        result, report, curl_calls = self._run()
        self.assertFalse(result.timed_out, result)
        self.assertIsNotNone(report, f"no report written: {result}")
        entry = next(e for e in report["results"] if e["recordingId"] == self.target["recordingId"])
        self.assertEqual(entry["status"], "already_present", entry)
        self.assertIs(entry["shaVerified"], False, entry)
        self.assertEqual(entry["sha256"], hashlib.sha256(self.corrupt_bytes).hexdigest())
        self.assertEqual(self.corrupt_path.read_bytes(), self.corrupt_bytes, "corrupt file must be retained untouched")
        self.assertFalse(
            any(self.target["path"] in call for call in curl_calls),
            f"already-present file must not be re-fetched; curl calls: {curl_calls}",
        )
        # Every OTHER re-downloadable recording hit the blocked network and is
        # reported as curl_failed_6, never as downloaded/verified.
        for e in report["results"]:
            if e["status"].startswith("curl_failed"):
                self.assertEqual(e["status"], "curl_failed_6", e)
            self.assertNotEqual(e["status"], "downloaded", e)

    def test_sha_mismatch_makes_exit_nonzero(self) -> None:
        """A provenance tool that finds a sha mismatch must not exit 0.

        FINDING on 4d812e1a: the script exits 0 with shaVerified=false in the
        report and no summary line — a corrupt corpus file is only discoverable
        by opening the JSON. `-C -` (resume) on the curl line is unreachable for
        present files, so a truncated/corrupt file is never repaired either.
        """
        result, report, _ = self._run()
        self.assertFalse(result.timed_out, result)
        mismatches = [e for e in report["results"] if e.get("shaVerified") is False]
        self.assertTrue(mismatches, "precondition: the corrupt file produced a sha mismatch")
        self.assertNotEqual(result.returncode, 0, f"sha mismatch present but exit={result.returncode}: {result}")

    def test_partial_download_is_not_promoted_to_already_present(self) -> None:
        """A transfer that dies mid-way (curl 18 PARTIAL_FILE) leaves bytes at the
        target path. The NEXT run must not classify that stub as already_present
        and stop trying (the `-C -` resume flag only ever runs for absent files).

        FINDING on 4d812e1a: run 1 -> curl_failed_18 with a 4 KiB stub on disk;
        run 2 -> already_present / shaVerified=false, no retry, exit 0.
        """
        # Shim variant: write a stub to the -o target, then fail with 18.
        shim = self.scratch / "bin/curl"
        shim.write_text(
            "#!/bin/sh\n"
            "printf '%s\\n' \"$*\" >> \"$CURL_SHIM_LOG\"\n"
            "out=''; prev=''\n"
            "for a in \"$@\"; do if [ \"$prev\" = '-o' ]; then out=\"$a\"; fi; prev=\"$a\"; done\n"
            "head -c 4096 /dev/zero > \"$out\"\n"
            "echo 'curl: (18) transfer closed with outstanding read data remaining' >&2\n"
            "exit 18\n"
        )
        self.corrupt_path.unlink()  # make the target absent so run 1 actually 'downloads'
        result1, report1, _ = self._run("s1b_e15_partial_run1")
        entry1 = next(e for e in report1["results"] if e["recordingId"] == self.target["recordingId"])
        self.assertEqual(entry1["status"], "curl_failed_18", entry1)
        self.assertTrue(self.corrupt_path.exists() and self.corrupt_path.stat().st_size == 4096)

        result2, report2, _ = self._run("s1b_e15_partial_run2")
        entry2 = next(e for e in report2["results"] if e["recordingId"] == self.target["recordingId"])
        self.assertFalse(result2.timed_out)
        self.assertNotEqual(
            entry2["status"], "already_present",
            f"4 KiB stub from a failed transfer was promoted to already_present: {entry2}",
        )


if __name__ == "__main__":
    unittest.main()
