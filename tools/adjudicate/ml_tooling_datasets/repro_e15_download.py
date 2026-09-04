#!/usr/bin/env python3
"""Adjudication repro for ml-tooling-datasets::MLT-5 (tools/e15_download.py).

Builds a scratch repo tree with five recordings served by a local HTTP server:

  rec-good         correct bytes already on disk           -> already_present, shaVerified
  rec-corrupt      wrong bytes already on disk             -> must be re-fetched and verified
  rec-partial      truncated bytes already on disk         -> must be re-fetched and verified
  rec-shamismatch  absent; server bytes != recorded sha    -> shaVerified=false
  rec-unreachable  absent; mediaUrl cannot be fetched      -> curl_failed_*

then copies tools/e15_download.py into `<scratch>/tools/` (the script resolves
ROOT from its own location) and runs it. Exit 0 iff all five checks hold:

  1. rec-corrupt re-fetched: shaVerified true, bytes on disk == served bytes
  2. rec-partial re-fetched: shaVerified true, bytes on disk == served bytes
  3. rec-good untouched: status already_present, shaVerified true, mtime unchanged
  4. rec-shamismatch shaVerified false and rec-unreachable curl_failed_*
  5. process exit code non-zero (3/5 entries are unverified)

Usage: python tools/adjudicate/ml_tooling_datasets/repro_e15_download.py
Fails (exit 1) on 4d812e1a; passes once the defect is fixed.
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

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
SCRIPT = os.path.join(ROOT, "tools/e15_download.py")
OUT_REL = "datasets/experiments/wave-e/e15-media-rederivation.json"
OLD_MTIME = 1_000_000_000


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *_args):
        pass


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def main() -> int:
    scratch = tempfile.mkdtemp(prefix="e15-repro-")
    served = os.path.join(scratch, "served")
    os.makedirs(served)
    os.makedirs(os.path.join(scratch, "tools"))
    os.makedirs(os.path.join(scratch, "datasets/corpus"))
    os.makedirs(os.path.join(scratch, "datasets/media"))
    shutil.copy(SCRIPT, os.path.join(scratch, "tools/e15_download.py"))

    httpd = http.server.ThreadingHTTPServer(
        ("127.0.0.1", 0), lambda *a, **kw: QuietHandler(*a, directory=served, **kw)
    )
    port = httpd.server_address[1]
    threading.Thread(target=httpd.serve_forever, daemon=True).start()

    good = b"GOOD-MEDIA-BYTES-" * 8192
    other = b"DIFFERENT-BYTES-" * 8192
    missing_url = "file://" + os.path.join(scratch, "no-such-file.bin")

    recs, srcs = [], []

    def add(rid, remote, *, expected_sha, local=None, url=None):
        with open(os.path.join(served, f"{rid}.bin"), "wb") as f:
            f.write(remote)
        rel = f"datasets/media/{rid}.mp4"
        if local is not None:
            with open(os.path.join(scratch, rel), "wb") as f:
                f.write(local)
        recs.append({"schemaVersion": 1, "recordingId": rid, "sourceId": f"src-{rid}", "path": rel, "sha256": expected_sha})
        srcs.append({"sourceId": f"src-{rid}", "acquisition": {"mediaUrl": url or f"http://127.0.0.1:{port}/{rid}.bin"}})

    add("rec-good", good, expected_sha=sha(good), local=good)
    add("rec-corrupt", good, expected_sha=sha(good), local=b"\x00" * len(good))
    add("rec-partial", good, expected_sha=sha(good), local=good[: len(good) // 4])
    add("rec-shamismatch", other, expected_sha=sha(good))
    add("rec-unreachable", good, expected_sha=sha(good), url=missing_url)
    json.dump(recs, open(os.path.join(scratch, "datasets/corpus/recordings.json"), "w"))
    json.dump(srcs, open(os.path.join(scratch, "datasets/corpus/sources.json"), "w"))

    good_path = os.path.join(scratch, "datasets/media/rec-good.mp4")
    os.utime(good_path, (OLD_MTIME, OLD_MTIME))

    proc = subprocess.run(
        [sys.executable, os.path.join(scratch, "tools/e15_download.py")],
        capture_output=True, text=True, timeout=180,
    )
    httpd.shutdown()
    httpd.server_close()
    print("--- e15_download.py stdout ---")
    print(proc.stdout.rstrip())
    print("--- e15_download.py stderr ---")
    print(proc.stderr.rstrip())
    print(f"--- exit code: {proc.returncode}")

    out_path = os.path.join(scratch, OUT_REL)
    if not os.path.exists(out_path):
        print("FAIL: report not written:", out_path)
        return 1
    entries = {e["recordingId"]: e for e in json.load(open(out_path))["results"]}
    for rid, e in entries.items():
        print(f"{rid}: {json.dumps(e, sort_keys=True)}")

    def disk(rid):
        p = os.path.join(scratch, f"datasets/media/{rid}.mp4")
        return open(p, "rb").read() if os.path.exists(p) else None

    def refetched_ok(rid):
        e = entries[rid]
        return e["status"] != "already_present" and e.get("shaVerified") is True and disk(rid) == good

    checks = {
        "corrupt_refetched_verified": refetched_ok("rec-corrupt"),
        "partial_refetched_verified": refetched_ok("rec-partial"),
        "good_already_present_untouched": (
            entries["rec-good"]["status"] == "already_present"
            and entries["rec-good"].get("shaVerified") is True
            and os.stat(good_path).st_mtime == OLD_MTIME
        ),
        "mismatch_and_unreachable_reported_unverified": (
            entries["rec-shamismatch"].get("shaVerified") is False
            and entries["rec-unreachable"]["status"].startswith("curl_failed_")
            and not entries["rec-unreachable"].get("shaVerified", False)
        ),
        "process_exit_nonzero_with_unverified_entries": proc.returncode != 0,
    }
    print("--- checks ---")
    for name, ok in checks.items():
        print(f"{name}: {ok}")
    shutil.rmtree(scratch, ignore_errors=True)
    if all(checks.values()):
        print("PASS: all five checks True")
        return 0
    print("FAIL: MLT-5 reproduced")
    return 1


if __name__ == "__main__":
    sys.exit(main())
