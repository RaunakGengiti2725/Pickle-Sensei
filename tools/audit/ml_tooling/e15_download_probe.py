#!/usr/bin/env python3
"""Exercise tools/e15_download.py in an isolated scratch root.

The script has no CLI, runs at import time, and writes to
  <ROOT>/datasets/corpus/media/*            (downloads)
  <ROOT>/datasets/experiments/wave-e/e15-media-rederivation.json
where ROOT is derived from its own file location. This probe copies the script
into a scratch tree with a synthetic datasets/corpus so nothing under the real
repo is touched, then drives it through its failure/edge states OFFLINE:

  sha-mismatch    : media present on disk, sha256 differs from recordings.json
  curl-failure    : media absent, mediaUrl unreachable (127.0.0.1:9 / bogus scheme)
  no-media-url    : media absent, source has no acquisition.mediaUrl
  held-out        : recordingId in HELD_OUT must never be downloaded
  derived         : derivedFrom non-empty must never be downloaded

For each state the probe records the script's exit code, stdout/stderr, whether
a Python traceback escaped, ResourceWarnings (run with -W error::ResourceWarning),
and the status written to the output JSON. A verifier that reports
shaVerified=false or curl_failed_* yet exits 0 is flagged.

With --live it additionally runs the UNMODIFIED script against the real
datasets/corpus/{recordings,sources}.json (media downloaded into the scratch
root, ~2.6 GB) and diffs the produced statuses against the committed
datasets/experiments/wave-e/e15-media-rederivation.json.

Usage: e15_download_probe.py --out-dir DIR [--live]
Exit 0 iff no state produced a traceback and every failing state produced a
non-zero exit code.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
SCRIPT = REPO / "tools/e15_download.py"
OUT_REL = "datasets/experiments/wave-e/e15-media-rederivation.json"


def make_root(root: Path, recordings: list[dict], sources: list[dict]) -> None:
    if root.exists():
        shutil.rmtree(root)
    (root / "tools").mkdir(parents=True)
    (root / "datasets/corpus/media").mkdir(parents=True)
    shutil.copy(SCRIPT, root / "tools/e15_download.py")
    (root / "datasets/corpus/recordings.json").write_text(json.dumps(recordings, indent=1))
    (root / "datasets/corpus/sources.json").write_text(json.dumps(sources, indent=1))


def uncaught_traceback(stderr: str) -> bool:
    """True for a real crash traceback; ignores the 'Exception ignored in:'
    blocks CPython prints for ResourceWarnings raised during finalization."""
    lines = stderr.splitlines()
    for i, line in enumerate(lines):
        if line.startswith("Traceback (most recent call last)"):
            if i == 0 or not lines[i - 1].startswith("Exception ignored in"):
                return True
    return False


def run(root: Path) -> dict:
    proc = subprocess.run(
        [sys.executable, "-W", "error::ResourceWarning", "tools/e15_download.py"],
        cwd=str(root),
        capture_output=True,
        text=True,
        errors="replace",
        timeout=600,
    )
    out_path = root / OUT_REL
    written = json.loads(out_path.read_text()) if out_path.exists() else None
    return {
        "exit": proc.returncode,
        "stdout": proc.stdout[-1500:],
        "stderr": proc.stderr[-1500:],
        "traceback": uncaught_traceback(proc.stderr),
        "resource_warning": "ResourceWarning" in proc.stderr,
        "output_written": written is not None,
        "statuses": [
            {k: r.get(k) for k in ("recordingId", "status", "shaVerified")}
            for r in (written or {}).get("results", [])
        ],
    }


def rec(rid: str, sid: str, path: str, sha: str, derived: list | None = None) -> dict:
    return {
        "schemaVersion": 1,
        "recordingId": rid,
        "sourceId": sid,
        "path": path,
        "sha256": sha,
        "derivedFrom": derived or [],
    }


def src(sid: str, url: str | None) -> dict:
    return {"sourceId": sid, "acquisition": ({"mediaUrl": url} if url else {})}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out-dir", required=True)
    ap.add_argument("--live", action="store_true")
    args = ap.parse_args()
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    report: dict[str, dict] = {}
    problems: list[str] = []

    # --- sha-mismatch: file present, wrong sha -------------------------------
    root = out_dir / "root-sha-mismatch"
    make_root(
        root,
        [rec("rec-aaaaaaaaaaaa", "src-1", "datasets/corpus/media/a.mp4", "0" * 64)],
        [src("src-1", "http://127.0.0.1:9/never")],
    )
    (root / "datasets/corpus/media/a.mp4").write_bytes(b"not the recorded bytes")
    r = run(root)
    report["sha-mismatch"] = r
    st = r["statuses"][0] if r["statuses"] else {}
    if st.get("shaVerified") is not False:
        problems.append("sha-mismatch: shaVerified not reported false")
    if r["exit"] == 0:
        problems.append(
            "sha-mismatch: script exits 0 although shaVerified=false (misleading success)"
        )

    # --- sha-match: file present, correct sha (control) -----------------------
    root = out_dir / "root-sha-match"
    payload = b"recorded bytes"
    make_root(
        root,
        [rec("rec-bbbbbbbbbbbb", "src-1", "datasets/corpus/media/b.mp4", hashlib.sha256(payload).hexdigest())],
        [src("src-1", None)],
    )
    (root / "datasets/corpus/media/b.mp4").write_bytes(payload)
    r = run(root)
    report["sha-match"] = r
    st = r["statuses"][0] if r["statuses"] else {}
    if not (r["exit"] == 0 and st.get("shaVerified") is True and st.get("status") == "already_present"):
        problems.append(f"sha-match control failed: {st} exit={r['exit']}")

    # --- curl-failure: unreachable url ---------------------------------------
    root = out_dir / "root-curl-failure"
    make_root(
        root,
        [rec("rec-cccccccccccc", "src-1", "datasets/corpus/media/c.mp4", "0" * 64)],
        [src("src-1", "http://127.0.0.1:9/unreachable")],
    )
    r = run(root)
    report["curl-failure"] = r
    st = r["statuses"][0] if r["statuses"] else {}
    if not str(st.get("status", "")).startswith("curl_failed_"):
        problems.append(f"curl-failure: status {st.get('status')!r} not curl_failed_*")
    if r["exit"] == 0:
        problems.append("curl-failure: script exits 0 although download failed (misleading success)")
    if (root / "datasets/corpus/media/c.mp4").exists():
        problems.append("curl-failure: partial/empty media file left on disk")

    # --- no-media-url / held-out / derived -----------------------------------
    root = out_dir / "root-skips"
    make_root(
        root,
        [
            rec("rec-dddddddddddd", "src-nourl", "datasets/corpus/media/d.mp4", "0" * 64),
            rec("rec-024decaeb66e", "src-held", "datasets/corpus/media/held.mp4", "0" * 64),
            rec("rec-eeeeeeeeeeee", "src-derived", "datasets/corpus/media/e.mp4", "0" * 64, ["rec-x"]),
        ],
        [src("src-nourl", None), src("src-held", "http://127.0.0.1:9/held"), src("src-derived", "http://127.0.0.1:9/derived")],
    )
    r = run(root)
    report["skips"] = r
    want = {
        "rec-dddddddddddd": "no_media_url",
        "rec-024decaeb66e": "excluded_held_out",
        "rec-eeeeeeeeeeee": "derived_not_redownloadable",
    }
    got = {s["recordingId"]: s["status"] for s in r["statuses"]}
    if got != want:
        problems.append(f"skips: statuses {got} != {want}")
    if "downloading" in r["stdout"]:
        problems.append("skips: script attempted a download for a held-out/derived/no-url recording")

    # --- empty corpus -----------------------------------------------------------
    root = out_dir / "root-empty"
    make_root(root, [], [])
    r = run(root)
    report["empty-corpus"] = r
    if r["exit"] != 0 or r["statuses"] != []:
        problems.append(f"empty-corpus: exit={r['exit']} statuses={r['statuses']}")

    # --- missing recordings.json -----------------------------------------------
    root = out_dir / "root-missing-inputs"
    make_root(root, [], [])
    (root / "datasets/corpus/recordings.json").unlink()
    r = run(root)
    report["missing-recordings"] = r
    if r["exit"] == 0:
        problems.append("missing-recordings: exit 0 with no recordings.json")

    for name, r in report.items():
        if r["traceback"] and name != "missing-recordings":
            problems.append(f"{name}: uncaught traceback")
        if r["resource_warning"]:
            problems.append(f"{name}: ResourceWarning (unclosed file)")

    # --- live ---------------------------------------------------------------------
    if args.live:
        root = out_dir / "root-live"
        make_root(
            root,
            json.loads((REPO / "datasets/corpus/recordings.json").read_text()),
            json.loads((REPO / "datasets/corpus/sources.json").read_text()),
        )
        proc = subprocess.run(
            [sys.executable, "-W", "error::ResourceWarning", "tools/e15_download.py"],
            cwd=str(root),
            capture_output=True,
            text=True,
            errors="replace",
        )
        (out_dir / "live-stdout.log").write_text(proc.stdout)
        (out_dir / "live-stderr.log").write_text(proc.stderr)
        produced = json.loads((root / OUT_REL).read_text())["results"]
        committed = json.loads((REPO / OUT_REL).read_text())["results"]
        key = lambda rs: {r["recordingId"]: (r["status"], r.get("shaVerified")) for r in rs}
        diff = {k: (key(committed).get(k), key(produced).get(k)) for k in set(key(committed)) | set(key(produced)) if key(committed).get(k) != key(produced).get(k)}
        unverified = [r["recordingId"] for r in produced if r.get("shaVerified") is False or str(r["status"]).startswith("curl_failed")]
        report["live"] = {
            "exit": proc.returncode,
            "traceback": uncaught_traceback(proc.stderr),
            "resource_warning": "ResourceWarning" in proc.stderr,
            "downloaded": sum(1 for r in produced if r["status"] == "downloaded"),
            "sha_verified_true": sum(1 for r in produced if r.get("shaVerified") is True),
            "unverified_or_failed": unverified,
            "diff_vs_committed": diff,
        }
        if proc.returncode != 0 or unverified or diff:
            problems.append(f"live: exit={proc.returncode} unverified={unverified} diff={diff}")
        shutil.rmtree(root / "datasets/corpus/media", ignore_errors=True)

    (out_dir / "e15-probe.json").write_text(json.dumps({"report": report, "problems": problems}, indent=1))
    for name, r in report.items():
        print(f"[{name}] exit={r['exit']} traceback={r['traceback']} statuses={r.get('statuses', r)}")
    print("\nPROBLEMS:" if problems else "\nno problems")
    for p in problems:
        print(" -", p)
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
