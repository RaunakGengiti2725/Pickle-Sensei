"""S2 — ml/scripts/validate_annotations.py fed non-regular-file paths and hostile bytes.

The CLI contract (module docstring) is: exit 0 = all valid, exit 1 = any
invalid with an `INVALID <path>: unreadable (...)` line per unreadable input.
It must never hang and must never abort the run on one bad input.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from attack_common import ARTIFACT_DIR, VALIDATOR, py

sys.path.insert(0, str(VALIDATOR.parent))
from test_validate_annotations import valid_doc  # noqa: E402  (reuse the repo's own fixture)


class ValidatorPathAttackTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="validator-attack-"))

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _write(self, name: str, data: bytes) -> Path:
        p = self.tmp / name
        p.write_bytes(data)
        return p

    def test_directory_path_is_unreadable_not_traceback(self) -> None:
        r = py(VALIDATOR, str(self.tmp), timeout=15)
        r.record("s2_validator_directory")
        self.assertFalse(r.timed_out)
        self.assertEqual(r.returncode, 1, r)
        self.assertIn("unreadable", r.stdout)
        self.assertNotIn("Traceback", r.stderr)

    def test_fifo_path_reports_unreadable_instead_of_hanging(self) -> None:
        """FINDING on 4d812e1a: `Path.read_text()` on a FIFO with no writer blocks
        forever; the CLI hangs (killed by the harness timeout) with no output."""
        fifo = self.tmp / "annotation.json"
        os.mkfifo(fifo)
        r = py(VALIDATOR, str(fifo), timeout=10)
        r.record("s2_validator_fifo")
        self.assertFalse(r.timed_out, "validator hung on a FIFO path (no writer)")
        self.assertEqual(r.returncode, 1, r)
        self.assertIn("unreadable", r.stdout)

    def test_permission_denied_and_symlink_loop_are_unreadable(self) -> None:
        noperm = self._write("noperm.json", b"{}")
        noperm.chmod(0)
        loop = self.tmp / "loop.json"
        loop.symlink_to(loop)
        r = py(VALIDATOR, str(noperm), str(loop), timeout=15)
        r.record("s2_validator_perm_symlink")
        self.assertFalse(r.timed_out)
        self.assertEqual(r.returncode, 1, r)
        self.assertEqual(r.stdout.count("unreadable"), 2, r.stdout)
        self.assertNotIn("Traceback", r.stderr)

    def test_invalid_utf8_is_unreadable_and_does_not_abort_the_batch(self) -> None:
        """FINDING on 4d812e1a: bytes that are not UTF-8 raise UnicodeDecodeError,
        which is a ValueError (not OSError / JSONDecodeError) -> uncaught traceback,
        and every file after it on the command line is never validated."""
        bad = self._write("bad-utf8.json", b"\xff\xfe{}")
        good = self._write("good.json", json.dumps(valid_doc()).encode())
        r = py(VALIDATOR, str(bad), str(good), timeout=15)
        r.record("s2_validator_invalid_utf8")
        self.assertFalse(r.timed_out)
        self.assertNotIn("Traceback", r.stderr, r)
        self.assertIn("unreadable", r.stdout, r)
        self.assertIn("ok good.json", r.stdout, "the batch must continue past an unreadable file")
        self.assertEqual(r.returncode, 1)

    def test_utf8_bom_is_rejected_cleanly(self) -> None:
        bom = self._write("bom.json", b"\xef\xbb\xbf" + json.dumps(valid_doc()).encode())
        r = py(VALIDATOR, str(bom), timeout=15)
        r.record("s2_validator_bom")
        self.assertFalse(r.timed_out)
        self.assertNotIn("Traceback", r.stderr, r)
        self.assertEqual(r.returncode, 1, r)

    def test_unbounded_device_input_is_capped(self) -> None:
        """FINDING on 4d812e1a: the validator slurps the whole input with read_text();
        an endless stream (/dev/zero) grows until MemoryError/OOM. Run under a 1 GiB
        address-space cap so the harness box survives; expect a clean 'unreadable'."""
        r = subprocess.run(
            ["bash", "-c", f"ulimit -v 1000000; exec {sys.executable} {VALIDATOR} /dev/zero"],
            capture_output=True, text=True, errors="replace", timeout=60,
        )
        (ARTIFACT_DIR / "s2_validator_dev_zero.json").write_text(json.dumps({
            "returncode": r.returncode, "stdout": r.stdout[-4000:], "stderr": r.stderr[-4000:]}, indent=2))
        self.assertNotIn("MemoryError", r.stderr, "validator read an unbounded stream into memory")
        self.assertNotIn("Traceback", r.stderr)
        self.assertEqual(r.returncode, 1)

    def test_unicode_paths_and_names_roundtrip(self) -> None:
        doc = valid_doc()
        doc["clip_id"] = "clip-\u00fc\u00f1\u00ee\u00e7\u00f8d\u00e9-\U0001f3d3"
        doc["annotator"] = "rev-\u65e5\u672c"
        p = self.tmp / "\u30af\u30ea\u30c3\u30d7 \u00e9.json"
        p.write_text(json.dumps(doc, ensure_ascii=False), encoding="utf-8")
        r = py(VALIDATOR, str(p), timeout=15)
        r.record("s2_validator_unicode")
        self.assertEqual(r.returncode, 0, r)
        self.assertIn("ok", r.stdout)

    def test_label_case_and_whitespace_variants_are_rejected(self) -> None:
        """Unicode/case attacks on the label field: 'Drive_Forehand', 'drive_forehand ',
        full-width letters and a Cyrillic look-alike 'а' must all be INVALID."""
        variants = ["Drive_Forehand", "drive_forehand ", "drive\u005fforehand\u200b",
                    "\uff44rive_forehand", "drive_forehаnd"]
        self.assertEqual(valid_doc()["technique"], "drive_forehand", "fixture drifted; attack needs drive_forehand")
        paths = []
        for i, v in enumerate(variants):
            doc = valid_doc()
            doc["technique"] = v
            paths.append(self._write(f"variant{i}.json", json.dumps(doc, ensure_ascii=False).encode("utf-8")))
        r = py(VALIDATOR, *[str(p) for p in paths], timeout=15)
        r.record("s2_validator_label_variants")
        self.assertEqual(r.returncode, 1, r)
        for i in range(len(variants)):
            self.assertIn(f"INVALID variant{i}.json: unknown canonical technique", r.stdout, r.stdout)
        self.assertNotIn("ok variant", r.stdout, r.stdout)
        self.assertNotIn("Traceback", r.stderr)

    def test_duplicate_paths_and_thousands_of_files_are_linear(self) -> None:
        docs = []
        for i in range(2000):
            p = self.tmp / f"a{i:04d}.json"
            p.write_text(json.dumps(valid_doc()))
            docs.append(str(p))
        r = py(VALIDATOR, *docs, *docs[:10], timeout=120)
        r.record("s2_validator_2000_files")
        self.assertFalse(r.timed_out)
        self.assertEqual(r.returncode, 0, r.stdout[-500:])
        self.assertEqual(r.stdout.count("ok "), 2010)


if __name__ == "__main__":
    unittest.main()
