"""Adjudication repro: tools/e15_download.py integrity semantics.

Runs an unmodified copy of e15_download.py inside a scratch repo root whose
recordings.json / sources.json point at local file:// media, covering:
  A. pre-existing CORRUPT file (sha mismatch)      -> expected: re-fetch or fail loudly
  B. pre-existing PARTIAL file (truncated download) -> expected: resume/re-fetch, not "already_present"
  C. unreachable mediaUrl (curl failure)           -> expected: non-zero exit / clear failure
  D. fresh download whose sha mismatches the record -> expected: non-zero exit
  E. a good download                                -> expected: shaVerified true

Then asserts the process exit code is non-zero when ANY recording is not
sha-verified. Exit 0 iff the tool behaves; 1 otherwise.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
SCRIPT = REPO_ROOT / "tools/e15_download.py"


def sha(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def main() -> int:
    root = Path(tempfile.mkdtemp(prefix="adj-e15-"))
    (root / "tools").mkdir()
    shutil.copy(SCRIPT, root / "tools" / "e15_download.py")
    media_src = root / "remote"
    media_src.mkdir()
    (root / "datasets/corpus").mkdir(parents=True)

    good = b"GOOD" * 4096
    (media_src / "good.bin").write_bytes(good)
    (media_src / "other.bin").write_bytes(b"OTHER" * 4096)

    sources = []
    recs = []

    def add(rid: str, src: str, url: str | None, sha256: str, pre_existing: bytes | None):
        sources.append({"sourceId": src, "acquisition": {"mediaUrl": url}})
        rel = f"datasets/corpus/media/{rid}.bin"
        recs.append({"recordingId": rid, "sourceId": src, "path": rel, "sha256": sha256})
        if pre_existing is not None:
            p = root / rel
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_bytes(pre_existing)

    file_url = f"file://{media_src}/good.bin"
    add("rec-corrupt", "src-a", file_url, sha(good), b"CORRUPT" * 100)
    add("rec-partial", "src-b", file_url, sha(good), good[: len(good) // 3])
    add("rec-unreachable", "src-c", f"file://{media_src}/missing.bin", sha(good), None)
    add("rec-shamismatch", "src-d", f"file://{media_src}/other.bin", sha(good), None)
    add("rec-good", "src-e", file_url, sha(good), None)

    (root / "datasets/corpus/recordings.json").write_text(json.dumps(recs))
    (root / "datasets/corpus/sources.json").write_text(json.dumps(sources))

    proc = subprocess.run([sys.executable, str(root / "tools/e15_download.py")], capture_output=True, text=True, cwd=root)
    out_path = root / "datasets/experiments/wave-e/e15-media-rederivation.json"
    results = {r["recordingId"]: r for r in json.loads(out_path.read_text())["results"]} if out_path.exists() else {}

    report = {"exitCode": proc.returncode, "stdout": proc.stdout.strip().splitlines(), "stderr": proc.stderr.strip()[-500:],
              "results": results, "checks": {}}
    checks = report["checks"]
    checks["corrupt_pre_existing_not_accepted_as_present"] = results.get("rec-corrupt", {}).get("status") != "already_present"
    checks["partial_pre_existing_resumed_or_refetched"] = results.get("rec-partial", {}).get("shaVerified") is True
    checks["unreachable_reported"] = str(results.get("rec-unreachable", {}).get("status", "")).startswith("curl_failed")
    checks["good_verified"] = results.get("rec-good", {}).get("shaVerified") is True
    any_bad = any(not r.get("shaVerified", False) for r in results.values())
    checks["nonzero_exit_when_any_unverified"] = (proc.returncode != 0) if any_bad else True
    ok = all(checks.values())
    print(json.dumps(report, indent=2))
    print("RESULT:", "OK" if ok else "DEFECTS")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
