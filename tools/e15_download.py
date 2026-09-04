#!/usr/bin/env python3
"""e15: re-derive gitignored corpus media from recorded acquisition.mediaUrl and sha-verify.

A file already on disk counts as present only when its sha256 matches the recording;
otherwise it is re-fetched. Downloads land in `<path>.part` and are promoted to `<path>`
only after the checksum matches, so a corrupt/partial fetch never sits at the recorded
path. Exit status is non-zero when any entry ends unverified (sha mismatch or curl failure).
"""
import hashlib
import json
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_REL = "datasets/experiments/wave-e/e15-media-rederivation.json"
HELD_OUT = {"rec-024decaeb66e", "rec-7d396a6d6566"}  # afn-vic-rally1, wm-dink-nearplayer (untouchable)
USER_AGENT = "PickleSenseiDataEngine/0.2 (e15 envelope validation; provenance-recorded)"


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def fetch(url, dest):
    return subprocess.run(
        ["curl", "-sS", "-L", "--fail", "--retry", "3", "--retry-delay", "2",
         "-A", USER_AGENT, "-o", dest, url]).returncode


def process_recording(r, srcs, root):
    rid = r["recordingId"]
    path = os.path.join(root, r["path"])
    entry = {"recordingId": rid, "path": r["path"], "sourceId": r["sourceId"]}
    if rid in HELD_OUT:
        entry["status"] = "excluded_held_out"
        return entry
    if r.get("derivedFrom"):
        entry["status"] = "derived_not_redownloadable"
        return entry

    if os.path.exists(path):
        digest = sha256_file(path)
        if digest == r["sha256"]:
            entry.update(status="already_present", sha256=digest, shaVerified=True)
            print(f"{rid}: already_present shaVerified=True", flush=True)
            return entry
        entry["previousSha256"] = digest
        entry["previousBytes"] = os.path.getsize(path)
        print(f"{rid}: on-disk sha mismatch ({entry['previousBytes']} bytes), re-fetching", flush=True)
        status = "refetched"
    else:
        status = "downloaded"

    url = srcs.get(r["sourceId"], {}).get("acquisition", {}).get("mediaUrl")
    if not url:
        entry["status"] = "no_media_url"
        if status == "refetched":
            entry["shaVerified"] = False
        return entry

    os.makedirs(os.path.dirname(path), exist_ok=True)
    part = path + ".part"
    if os.path.exists(part):
        os.remove(part)
    print(f"downloading {rid} <- {url}", flush=True)
    rc = fetch(url, part)
    if rc != 0:
        entry["status"] = f"curl_failed_{rc}"
        if os.path.exists(part):
            os.remove(part)
        return entry

    digest = sha256_file(part)
    entry.update(status=status, sha256=digest, shaVerified=digest == r["sha256"])
    if entry["shaVerified"]:
        os.replace(part, path)
    else:
        os.remove(part)
    print(f"{rid}: shaVerified={entry['shaVerified']}", flush=True)
    return entry


def is_unverified(entry):
    return entry["status"].startswith("curl_failed_") or entry.get("shaVerified") is False


def main(root=ROOT):
    recs = json.load(open(os.path.join(root, "datasets/corpus/recordings.json")))
    srcs = {s["sourceId"]: s for s in json.load(open(os.path.join(root, "datasets/corpus/sources.json")))}

    results = [process_recording(r, srcs, root) for r in recs]
    unverified = [e["recordingId"] for e in results if is_unverified(e)]

    out = os.path.join(root, OUT_REL)
    os.makedirs(os.path.dirname(out), exist_ok=True)
    json.dump({"note": "media files themselves are gitignored; this records re-derivation provenance",
               "verified": not unverified,
               "unverified": unverified,
               "results": results}, open(out, "w"), indent=2)
    print("wrote", out)
    if unverified:
        print(f"e15_download: {len(unverified)}/{len(results)} entries unverified: {', '.join(unverified)}",
              file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
