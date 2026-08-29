#!/usr/bin/env python3
"""e15: re-derive gitignored corpus media from recorded acquisition.mediaUrl and sha-verify."""
import hashlib
import json
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
recs = json.load(open(os.path.join(ROOT, "datasets/corpus/recordings.json")))
srcs = {s["sourceId"]: s for s in json.load(open(os.path.join(ROOT, "datasets/corpus/sources.json")))}

HELD_OUT = {"rec-024decaeb66e", "rec-7d396a6d6566"}  # afn-vic-rally1, wm-dink-nearplayer (untouchable)

results = []
for r in recs:
    rid = r["recordingId"]
    path = os.path.join(ROOT, r["path"])
    entry = {"recordingId": rid, "path": r["path"], "sourceId": r["sourceId"]}
    if rid in HELD_OUT:
        entry["status"] = "excluded_held_out"
        results.append(entry)
        continue
    if r.get("derivedFrom"):
        entry["status"] = "derived_not_redownloadable"
        results.append(entry)
        continue
    src = srcs.get(r["sourceId"], {})
    url = src.get("acquisition", {}).get("mediaUrl")
    if os.path.exists(path):
        entry["status"] = "already_present"
    elif not url:
        entry["status"] = "no_media_url"
        results.append(entry)
        continue
    else:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        print(f"downloading {rid} <- {url}", flush=True)
        rc = subprocess.run(
            ["curl", "-sS", "-L", "--fail", "--retry", "3", "--retry-delay", "2", "-C", "-",
             "-A", "PickleSenseiDataEngine/0.2 (e15 envelope validation; provenance-recorded)",
             "-o", path, url]).returncode
        entry["status"] = "downloaded" if rc == 0 else f"curl_failed_{rc}"
        if rc != 0:
            results.append(entry)
            continue
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    entry["sha256"] = h.hexdigest()
    entry["shaVerified"] = h.hexdigest() == r["sha256"]
    results.append(entry)
    print(f"{rid}: shaVerified={entry['shaVerified']}", flush=True)

out = os.path.join(ROOT, "datasets/experiments/wave-e/e15-media-rederivation.json")
os.makedirs(os.path.dirname(out), exist_ok=True)
json.dump({"note": "media files themselves are gitignored; this records re-derivation provenance",
           "results": results}, open(out, "w"), indent=2)
print("wrote", out)
