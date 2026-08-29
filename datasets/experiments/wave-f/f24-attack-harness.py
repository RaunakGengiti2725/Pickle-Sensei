#!/usr/bin/env python3
"""F24 provenance red-team attack harness (wave-f, f24-rt-data-provenance).

Regression test for the data-integrity audit tooling. For every attack in
f24-attack-fixtures.json it:

  1. builds a sandbox copy of datasets/ (hardlinks for media; real copies for
     datasets/experiments so audit report writes never touch the repo),
  2. applies the attack ops to the sandbox only (hardlinks are broken by
     remove-then-rewrite; the working tree is never mutated),
  3. runs the audit under test inside the sandbox with --no-urls,
  4. diffs the resulting issues against that audit's clean-sandbox baseline
     and matches the new issues against the attack's `expect` clause.

Audits under test: `e24` (wave-e tooling, documents the pre-f24 misses) and
`f24` (this wave's extension, must catch everything). Exit code is nonzero if
any attack is undetected by the f24 audit.

Run from the repo root:
  python3 datasets/experiments/wave-f/f24-attack-harness.py [--audits e24,f24] [--jobs N]
"""

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
FIXTURES = os.path.join(HERE, "f24-attack-fixtures.json")
OUT = os.path.join(HERE, "f24-attack-results.json")

AUDITS = {
    "e24": {
        "script": "datasets/experiments/wave-e/e24-data-integrity-audit.py",
        "report": "datasets/experiments/wave-e/e24-integrity-report.json",
    },
    "f24": {
        "script": "datasets/experiments/wave-f/f24-provenance-audit.py",
        "report": "datasets/experiments/wave-f/f24-integrity-report.json",
    },
}


def make_sandbox(base_tmp):
    sb = tempfile.mkdtemp(prefix="f24-sandbox-", dir=base_tmp)
    ds_src = os.path.join(ROOT, "datasets")
    ds_dst = os.path.join(sb, "datasets")
    # hardlink the tree (media stays shared, cheap), then replace experiments/
    # with a real copy: audit scripts write their reports there and a write
    # through a hardlink would corrupt the repo artifact.
    subprocess.run(["cp", "-al", ds_src, ds_dst], check=True)
    exp_dst = os.path.join(ds_dst, "experiments")
    shutil.rmtree(exp_dst)
    shutil.copytree(os.path.join(ds_src, "experiments"), exp_dst)
    return sb


def replace_file(path, data: bytes):
    """Rewrite a possibly-hardlinked sandbox file without touching the repo inode."""
    os.remove(path)
    with open(path, "wb") as f:
        f.write(data)


def load_json(path):
    with open(path) as f:
        return json.load(f)


def dump_json_bytes(obj):
    return (json.dumps(obj, indent=2, ensure_ascii=False) + "\n").encode("utf-8")


def apply_op(sandbox, op):
    kind = op["op"]
    if kind == "byte_flip_first_ood_item":
        reg = load_json(os.path.join(sandbox, "datasets/ood/registry.json"))
        rel = reg["items"][0]["path"]
        p = os.path.join(sandbox, rel)
        data = bytearray(open(p, "rb").read())
        data[len(data) // 2] ^= 0xFF
        replace_file(p, bytes(data))
        return
    if kind == "duplicate_first_fresh_candidate_id":
        p = os.path.join(sandbox, "datasets/pickleball/registry.json")
        reg = load_json(p)
        items = reg["freshCandidates"]["items"]
        clone = json.loads(json.dumps(items[0]))
        clone["title"] = "ATTACK FIXTURE duplicate id"
        items.append(clone)
        replace_file(p, dump_json_bytes(reg))
        return

    path = os.path.join(sandbox, op["file"])
    if kind == "file_write_json":
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "wb") as f:
            f.write(dump_json_bytes(op["content"]))
        return
    if kind == "json_string_replace":
        text = open(path, encoding="utf-8").read()
        assert op["find"] in text, f"{op['find']!r} not found in {op['file']}"
        count = 1 if op.get("firstOnly") else -1
        replace_file(path, text.replace(op["find"], op["replace"], count).encode("utf-8"))
        return

    data = load_json(path)
    node = data
    for key in op.get("pointer", [])[:-1] if kind != "json_append" else op.get("pointer", []):
        node = node[key]
    if kind == "json_append":
        target = node if isinstance(node, list) else None
        assert target is not None, f"pointer does not resolve to a list in {op['file']}"
        target.append(op["record"])
    elif kind == "json_edit":
        pointer = op.get("pointer", [])
        target = data
        for key in pointer:
            target = target[key]
        assert isinstance(target, dict), f"json_edit pointer must resolve to a dict in {op['file']}"
        target.update(op["set"])
    elif kind == "json_delete":
        pointer = op["pointer"]
        target = data
        for key in pointer[:-1]:
            target = target[key]
        del target[pointer[-1]]
    else:
        raise ValueError(f"unknown op {kind}")
    replace_file(path, dump_json_bytes(data))


def run_audit(sandbox, audit):
    script = os.path.join(sandbox, AUDITS[audit]["script"])
    t0 = time.time()
    r = subprocess.run(
        [sys.executable, script, "--no-urls"],
        capture_output=True,
        text=True,
        timeout=1800,
    )
    report_path = os.path.join(sandbox, AUDITS[audit]["report"])
    issues = []
    crashed = r.returncode != 0 or not os.path.isfile(report_path)
    if not crashed:
        issues = load_json(report_path).get("issues", [])
    return {
        "crashed": crashed,
        "stderrTail": r.stderr[-2000:] if crashed else "",
        "issues": issues,
        "seconds": round(time.time() - t0, 1),
    }


def issue_key(i):
    return (i.get("severity"), i.get("where"), i.get("detail"))


def new_issues(baseline, attacked):
    base = {}
    for i in baseline:
        base[issue_key(i)] = base.get(issue_key(i), 0) + 1
    out = []
    for i in attacked:
        k = issue_key(i)
        if base.get(k, 0) > 0:
            base[k] -= 1
        else:
            out.append(i)
    return out


def matches(expect, issue):
    if issue.get("severity") != expect["severity"]:
        return False
    if "where" in expect and expect["where"] not in (issue.get("where") or ""):
        return False
    if "detail" in expect and expect["detail"] not in (issue.get("detail") or ""):
        return False
    return True


def run_attack(base_tmp, attack, audit, baseline_issues):
    sandbox = make_sandbox(base_tmp)
    try:
        for op in attack["ops"]:
            apply_op(sandbox, op)
        result = run_audit(sandbox, audit)
        fresh = new_issues(baseline_issues, result["issues"])
        detected = [i for i in fresh if matches(attack["expect"], i)]
        return {
            "attack": attack["id"],
            "audit": audit,
            "crashed": result["crashed"],
            "stderrTail": result["stderrTail"],
            "detected": bool(detected),
            "matchingNewIssues": detected,
            "otherNewIssues": [i for i in fresh if not matches(attack["expect"], i)],
            "auditSeconds": result["seconds"],
        }
    finally:
        shutil.rmtree(sandbox, ignore_errors=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--audits", default="e24,f24")
    ap.add_argument("--jobs", type=int, default=4)
    args = ap.parse_args()
    audits = [a.strip() for a in args.audits.split(",") if a.strip()]

    fixtures = load_json(FIXTURES)
    attacks = fixtures["attacks"]
    # sandboxes must live on the same filesystem as the repo so cp -al can hardlink media
    base_tmp = tempfile.mkdtemp(prefix="f24-harness-", dir=os.path.dirname(ROOT))
    results = {"schemaVersion": 1, "workstream": "wave-f/f24-rt-data-provenance",
               "fixtures": os.path.relpath(FIXTURES, ROOT), "baselines": {}, "results": []}
    try:
        baselines = {}
        for audit in audits:
            sb = make_sandbox(base_tmp)
            try:
                b = run_audit(sb, audit)
            finally:
                shutil.rmtree(sb, ignore_errors=True)
            assert not b["crashed"], f"baseline {audit} audit crashed: {b['stderrTail']}"
            baselines[audit] = b["issues"]
            counts = {}
            for i in b["issues"]:
                counts[i["severity"]] = counts.get(i["severity"], 0) + 1
            results["baselines"][audit] = {"issueCounts": counts, "seconds": b["seconds"]}
            print(f"[baseline:{audit}] {counts} in {b['seconds']}s", flush=True)

        with ThreadPoolExecutor(max_workers=args.jobs) as ex:
            futures = [
                ex.submit(run_attack, base_tmp, attack, audit, baselines[audit])
                for audit in audits
                for attack in attacks
            ]
            for fut in futures:
                r = fut.result()
                results["results"].append(r)
                status = "CAUGHT" if r["detected"] else ("CRASH" if r["crashed"] else "MISSED")
                print(f"[{r['audit']}] {r['attack']}: {status} ({r['auditSeconds']}s)", flush=True)
    finally:
        shutil.rmtree(base_tmp, ignore_errors=True)

    results["results"].sort(key=lambda r: (r["audit"], r["attack"]))
    summary = {
        audit: {
            "caught": sorted(r["attack"] for r in results["results"] if r["audit"] == audit and r["detected"]),
            "missed": sorted(r["attack"] for r in results["results"] if r["audit"] == audit and not r["detected"]),
        }
        for audit in audits
    }
    results["summary"] = summary
    with open(OUT, "w") as f:
        json.dump(results, f, indent=2)
        f.write("\n")
    print(f"wrote {OUT}")
    print(json.dumps(summary, indent=2))
    if "f24" in audits and summary["f24"]["missed"]:
        print("FAIL: f24 audit missed attacks", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
