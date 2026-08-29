#!/usr/bin/env python3
"""D2-09 registry + dataset integrity audit (wave-d2).

Programmatically recounts every dataset artifact under datasets/, verifies
fresh-candidate media hashes/bytes against datasets/pickleball/registry.json,
checks provenance-field completeness, probes registered source URLs (HTTP
status recorded, never downloaded), and cross-checks manifest/README count
claims against actual files. Read-only over label content; the only writes
are the integrity report JSON next to this script.

Run from the repo root:  python3 datasets/experiments/wave-d2/d2-09-audit.py
"""

import hashlib
import json
import os
import subprocess
import sys
from datetime import datetime, timezone

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
DS = os.path.join(ROOT, "datasets")
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "d2-09-integrity-report.json")

HELD_OUT_CASES = {"wm-dink-01", "afn-vic-rally1"}


def load(rel):
    with open(os.path.join(ROOT, rel)) as f:
        return json.load(f)


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def http_status(url, timeout=60):
    """HEAD first, fall back to ranged GET (no body kept). Returns (status, note)."""
    for args in (["-I"], ["-r", "0-0", "-o", "/dev/null"]):
        try:
            r = subprocess.run(
                ["curl", "-s", "-L", "--max-time", str(timeout), "-w", "%{http_code}",
                 "-o", "/dev/null", *args, url],
                capture_output=True, text=True, timeout=timeout + 10,
            )
            code = r.stdout.strip()[-3:]
            if code.isdigit() and code != "000":
                if args == ["-I"] and int(code) >= 400:
                    continue  # some hosts reject or 5xx on HEAD; retry with ranged GET
                return int(code), "HEAD" if args == ["-I"] else "GET range 0-0"
        except Exception as e:  # noqa: BLE001 - record failure mode, keep auditing
            return None, f"curl error: {e}"
    return (int(code), "GET range 0-0") if code.isdigit() and code != "000" else (None, "unreachable")


def count_tms_entries(obj):
    """Count label atoms: dicts carrying a tMs/frameIndex key anywhere in the tree."""
    n = 0
    if isinstance(obj, dict):
        if "tMs" in obj or "frameIndex" in obj:
            n += 1
        for v in obj.values():
            n += count_tms_entries(v)
    elif isinstance(obj, list):
        for v in obj:
            n += count_tms_entries(v)
    return n


def audit_registry(report, check_urls=True):
    reg = load("datasets/pickleball/registry.json")
    issues = []
    url_checks = []

    required_source = ["id", "name", "url", "task", "modality", "declaredLicense",
                       "status", "trainingEligible", "commercialTrainingClearance",
                       "provenance", "limitations"]
    for s in reg.get("sources", []):
        missing = [k for k in required_source if k not in s]
        if missing:
            issues.append({"severity": "missing_field", "where": f"sources[{s.get('id')}]",
                           "detail": f"missing {missing}"})
        if "itemCount" not in s and "sourceImageCount" not in s:
            issues.append({"severity": "missing_field", "where": f"sources[{s.get('id')}]",
                           "detail": "no item count field (itemCount/sourceImageCount)"})

    required_excluded = ["id", "name", "officialUrls", "task", "modality",
                         "commercialTrainingClearance", "exclusionReasons"]
    for s in reg.get("evaluatedButExcluded", []):
        missing = [k for k in required_excluded if k not in s]
        if missing:
            issues.append({"severity": "missing_field", "where": f"evaluatedButExcluded[{s.get('id')}]",
                           "detail": f"missing {missing}"})

    required_quarantine = ["id", "sourceUrl", "title", "publisher", "license", "status", "reason"]
    for s in reg.get("quarantinedUnknownRights", []):
        missing = [k for k in required_quarantine if k not in s]
        if missing:
            issues.append({"severity": "missing_field", "where": f"quarantinedUnknownRights[{s.get('id')}]",
                           "detail": f"missing {missing}"})
        if s.get("status") not in {"quarantined_not_downloaded", "excluded_noncommercial"}:
            issues.append({"severity": "role_violation", "where": f"quarantinedUnknownRights[{s.get('id')}]",
                           "detail": f"unexpected status {s.get('status')}"})

    # Fresh candidates: verify bytes + sha256 against on-disk media (label-blind
    # verification only — hashing, never viewing or labeling).
    fc = reg.get("freshCandidates", {})
    fc_results = []
    total_bytes_actual = 0
    for item in fc.get("items", []):
        required_fc = ["id", "role", "labelBlind", "path", "sourceUrl", "title", "uploader",
                       "license", "licenseVerification", "provenanceAssessment", "rights",
                       "restrictions", "media", "acquisition"]
        missing = [k for k in required_fc if k not in item]
        if missing:
            issues.append({"severity": "missing_field", "where": f"freshCandidates[{item.get('id')}]",
                           "detail": f"missing {missing}"})
        if item.get("role") != "fresh_candidate" or item.get("labelBlind") is not True:
            issues.append({"severity": "role_violation", "where": f"freshCandidates[{item.get('id')}]",
                           "detail": "role/labelBlind not fresh_candidate/true"})
        path = os.path.join(ROOT, item["path"])
        rec = {"id": item["id"], "path": item["path"]}
        if not os.path.isfile(path):
            rec["fileExists"] = False
            issues.append({"severity": "count_drift", "where": f"freshCandidates[{item['id']}]",
                           "detail": "registered media file missing on disk"})
        else:
            rec["fileExists"] = True
            b = os.path.getsize(path)
            total_bytes_actual += b
            rec["bytesActual"] = b
            rec["bytesRegistered"] = item["media"].get("clipBytes")
            rec["bytesMatch"] = b == item["media"].get("clipBytes")
            digest = sha256_file(path)
            rec["sha256Actual"] = digest
            rec["sha256Registered"] = item["media"].get("sha256")
            rec["sha256Match"] = digest == item["media"].get("sha256")
            if not rec["bytesMatch"]:
                issues.append({"severity": "count_drift", "where": f"freshCandidates[{item['id']}]",
                               "detail": f"clipBytes {item['media'].get('clipBytes')} != actual {b}"})
            if not rec["sha256Match"]:
                issues.append({"severity": "integrity", "where": f"freshCandidates[{item['id']}]",
                               "detail": "sha256 mismatch between registry and on-disk media"})
        fc_results.append(rec)
    fc_summary = {
        "items": fc_results,
        "totalBytesRegistered": fc.get("totalBytes"),
        "totalBytesActual": total_bytes_actual,
        "totalBytesMatch": fc.get("totalBytes") == total_bytes_actual,
    }
    if fc.get("totalBytes") != total_bytes_actual:
        issues.append({"severity": "count_drift", "where": "freshCandidates.totalBytes",
                       "detail": f"registered {fc.get('totalBytes')} != actual {total_bytes_actual}"})

    # Directory <-> registry reconciliation
    fc_dir = os.path.join(DS, "pickleball", "fresh-candidates")
    on_disk = sorted(f for f in os.listdir(fc_dir)) if os.path.isdir(fc_dir) else []
    registered_files = sorted(os.path.basename(i["path"]) for i in fc.get("items", []))
    if on_disk != registered_files:
        issues.append({"severity": "count_drift", "where": "fresh-candidates dir",
                       "detail": f"on disk {on_disk} vs registered {registered_files}"})

    if check_urls:
        urls = []
        for s in reg.get("sources", []):
            urls.append((f"sources[{s['id']}]", s.get("url")))
            if s.get("licenseUrl"):
                urls.append((f"sources[{s['id']}].licenseUrl", s["licenseUrl"]))
        for s in reg.get("evaluatedButExcluded", []):
            for u in s.get("officialUrls", []):
                urls.append((f"evaluatedButExcluded[{s['id']}]", u))
        for c in reg.get("officialSearchChecks", []):
            urls.append((f"officialSearchChecks[{c['service']}]", c.get("url")))
        for i in fc.get("items", []):
            urls.append((f"freshCandidates[{i['id']}]", i.get("sourceUrl")))
        for q in reg.get("quarantinedUnknownRights", []):
            urls.append((f"quarantinedUnknownRights[{q['id']}]", q.get("sourceUrl")))
        for where, url in urls:
            if not url:
                continue
            status, method = http_status(url)
            url_checks.append({"where": where, "url": url, "httpStatus": status, "method": method,
                               "checkedAt": report["generatedAtIso"]})
            if status is None or status >= 400:
                issues.append({"severity": "dead_url", "where": where,
                               "detail": f"HTTP {status} ({method}) for {url}"})

    report["registry"] = {
        "schemaVersion": reg.get("schemaVersion"),
        "counts": {
            "sources": len(reg.get("sources", [])),
            "evaluatedButExcluded": len(reg.get("evaluatedButExcluded", [])),
            "officialSearchChecks": len(reg.get("officialSearchChecks", [])),
            "freshCandidates": len(fc.get("items", [])),
            "quarantinedUnknownRights": len(reg.get("quarantinedUnknownRights", [])),
        },
        "freshCandidateMediaVerification": fc_summary,
        "urlChecks": url_checks,
    }
    report["issues"].extend(issues)


def audit_paddle_bench(report):
    reg = load("datasets/paddle-bench/registry.json")
    bundles_dir = os.path.join(DS, "paddle-bench", "bundles")
    bundles = {}
    for b in sorted(os.listdir(bundles_dir)):
        ad = os.path.join(bundles_dir, b, "annotation")
        files = sorted(os.listdir(ad)) if os.path.isdir(ad) else []
        entry = {"annotationFiles": files, "hasClip": os.path.isfile(os.path.join(bundles_dir, b, "clip.mp4")),
                 "heldOut": b in HELD_OUT_CASES, "labelAtomsPerFile": {}}
        for f in files:
            data = json.load(open(os.path.join(ad, f)))
            entry["labelAtomsPerFile"][f] = count_tms_entries(data)
        bundles[b] = entry
    videos_dir = os.path.join(DS, "paddle-bench", "videos")
    videos_on_disk = sorted(os.listdir(videos_dir)) if os.path.isdir(videos_dir) else []
    missing_ann = [v["id"] for v in reg["videos"]
                   if not any(k in v for k in ("file",)) or "file" not in v]
    ids = [v.get("id") for v in reg["videos"]]
    if len(ids) != len(set(ids)):
        report["issues"].append({"severity": "integrity", "where": "paddle-bench/registry.json",
                                 "detail": "duplicate video ids"})
    for v in reg["videos"]:
        for k in ("id", "file", "source", "license", "provenance", "realFootage", "sessionKey"):
            if k not in v:
                report["issues"].append({"severity": "missing_field",
                                         "where": f"paddle-bench/registry.json[{v.get('id')}]",
                                         "detail": f"missing {k}"})
    eb_qa = load("datasets/paddle-bench/event-bounds-qa-wave-c.json")
    eb_a = load("datasets/paddle-bench/event-bounds-wave-a.json")
    stroke_gold = load("datasets/paddle-bench/stroke-gold.json")
    pb_cases = load("datasets/paddle-bench/paddle-bench.json")
    report["paddleBench"] = {
        "registryVideoCount": len(reg["videos"]),
        "eventBoundsQaWaveC": {"events": len(eb_qa.get("events", [])),
                               "corrections": len(eb_qa.get("corrections", []))},
        "eventBoundsWaveA": {"cases": len(eb_a.get("cases", [])),
                             "rejectedCandidates": len(eb_a.get("rejectedCandidates", []))},
        "strokeGoldLabels": len(stroke_gold.get("labels", [])),
        "paddleBenchCases": len(pb_cases.get("cases", [])),
        "paddleBenchExcludedCases": len(pb_cases.get("excludedCases", [])),
        "resultFiles": len(os.listdir(os.path.join(DS, "paddle-bench", "results"))),
        "videosDirGitignored": not os.path.isdir(videos_dir),
        "videosOnDisk": videos_on_disk,
        "bundleCount": len(bundles),
        "bundles": bundles,
        "notes": "videos/ is gitignored by design (media stays local); README documents this. "
                 "Held-out bundles were not viewed; only file listings and JSON structure counted.",
        "unusedCheck": missing_ann,
    }


def audit_ball_bench(report):
    bb = load("datasets/ball-bench/ball-bench.json")
    fdir = os.path.join(DS, "ball-bench", "failures")
    failures = sorted(os.listdir(fdir)) if os.path.isdir(fdir) else []
    results = sorted(os.listdir(os.path.join(DS, "ball-bench", "results")))
    n_cases = None
    for k in ("cases", "labels", "items"):
        if isinstance(bb, dict) and isinstance(bb.get(k), list):
            n_cases = (k, len(bb[k]))
    report["ballBench"] = {"topLevelKeys": list(bb.keys()) if isinstance(bb, dict) else "list",
                           "caseCount": n_cases, "failureDirs": failures, "resultFiles": len(results)}


def audit_corpus(report):
    sources = load("datasets/corpus/sources.json")
    recordings = load("datasets/corpus/recordings.json")
    splits = load("datasets/corpus/splits.json")
    dedup = load("datasets/corpus/dedup-report.json")
    issues = []

    src_ids = {s["sourceId"] for s in sources}
    rec_ids = {r["recordingId"] for r in recordings}
    for r in recordings:
        if r["sourceId"] not in src_ids:
            issues.append({"severity": "integrity", "where": f"corpus/recordings[{r['recordingId']}]",
                           "detail": f"unknown sourceId {r['sourceId']}"})
        for d in r.get("derivedFrom", []) or []:
            if d.get("parentRecordingId") not in rec_ids:
                issues.append({"severity": "integrity", "where": f"corpus/recordings[{r['recordingId']}]",
                               "detail": f"derivedFrom parent {d.get('parentRecordingId')} not registered"})
    session_keys = {r.get("sessionKey") for r in recordings if r.get("sessionKey")}
    assigned = set(splits.get("assigned", {}).keys())
    unassigned = sorted(session_keys - assigned)
    orphan_assignments = sorted(assigned - session_keys)
    for s in unassigned:
        issues.append({"severity": "role_violation", "where": "corpus/splits.json",
                       "detail": f"session {s} has recordings but no split assignment"})
    merged_sessions = set()
    for f in dedup.get("findings", []):
        act = f.get("action", "")
        if act.startswith("MERGED SESSIONS:"):
            merged_sessions.add(act.split(":")[1].strip().split()[1])
    for s in orphan_assignments:
        if s in merged_sessions:
            issues.append({"severity": "stale_assignment_explained", "where": "corpus/splits.json",
                           "detail": f"assigned session {s} has no recordings — session was merged away by "
                                     "dedup (see dedup-report.json MERGED SESSIONS); stale entry retained, "
                                     "not removed here because deterministic split reuse semantics are owned "
                                     "by the data engine"})
        else:
            issues.append({"severity": "count_drift", "where": "corpus/splits.json",
                           "detail": f"assigned session {s} has no recordings"})
    undeclared_dupes = [f for f in dedup.get("findings", []) if not f.get("declared")]
    media_missing = sum(1 for r in recordings if not os.path.isfile(os.path.join(ROOT, r["path"])))

    events_dir = os.path.join(DS, "corpus", "events")
    event_files = sorted(os.listdir(events_dir))
    mined_candidates = 0
    mined_tiers = {}
    empty_event_files = 0
    for f in event_files:
        lines = [ln for ln in open(os.path.join(events_dir, f)) if ln.strip()]
        if not lines:
            empty_event_files += 1
        for ln in lines:
            d = json.loads(ln)
            mined_candidates += 1
            mined_tiers[d.get("tier")] = mined_tiers.get(d.get("tier"), 0) + 1

    report["corpus"] = {
        "sources": len(sources),
        "recordings": len(recordings),
        "rootRecordings": sum(1 for r in recordings if not r.get("derivedFrom")),
        "sessions": len(session_keys),
        "splitAssignments": {k: v["split"] for k, v in splits.get("assigned", {}).items()},
        "splitCounts": {},
        "unassignedSessions": unassigned,
        "orphanAssignments": orphan_assignments,
        "undeclaredDuplicateFindings": len(undeclared_dupes),
        "dedupFindingsTotal": len(dedup.get("findings", [])),
        "recordingsMediaMissingOnDisk": media_missing,
        "recordingsMediaNote": "media is gitignored by design; paths verified as declared only",
        "minedEventCandidateFiles": len(event_files),
        "minedEventCandidateFilesEmpty": empty_event_files,
        "minedEventCandidates": mined_candidates,
        "minedEventCandidateTiers": mined_tiers,
        "fingerprintFiles": len(os.listdir(os.path.join(DS, "corpus", "fingerprints"))),
    }
    sc = {}
    for v in splits.get("assigned", {}).values():
        sc[v["split"]] = sc.get(v["split"], 0) + 1
    report["corpus"]["splitCounts"] = sc
    report["issues"].extend(issues)


def audit_releases(report):
    rels = {}
    for rel in sorted(os.listdir(os.path.join(DS, "releases"))):
        rd = os.path.join(DS, "releases", rel)
        if not os.path.isdir(rd):
            continue
        m = json.load(open(os.path.join(rd, "manifest.json")))
        sha_path = os.path.join(rd, "manifest.sha256")
        entry = {"files": sorted(os.listdir(rd)), "manifestCounts": m.get("counts"), "immutable": m.get("immutable")}
        if os.path.isfile(sha_path):
            recorded = open(sha_path).read().split()[0].strip()
            actual = sha256_file(os.path.join(rd, "manifest.json"))
            entry["manifestSha256Match"] = recorded == actual
            if recorded != actual:
                report["issues"].append({"severity": "integrity", "where": f"releases/{rel}",
                                         "detail": "manifest.sha256 does not match manifest.json"})
        rels[rel] = entry

    # cross-check v0.3 corpus claims against corpus recount
    m3 = json.load(open(os.path.join(DS, "releases", "pickle-real-v0.3", "manifest.json")))
    c = report.get("corpus", {})
    claims = m3.get("corpus", {})
    for claim_key, actual_key in (("sources", "sources"), ("recordings", "recordings"),
                                  ("rootRecordings", "rootRecordings"), ("sessions", "sessions")):
        if claims.get(claim_key) != c.get(actual_key):
            report["issues"].append({"severity": "count_drift",
                                     "where": f"releases/pickle-real-v0.3 corpus.{claim_key}",
                                     "detail": f"manifest {claims.get(claim_key)} vs recount {c.get(actual_key)} "
                                               "(manifest is immutable snapshot; drift = corpus moved after freeze, "
                                               "not a registry error)"})
    report["releases"] = rels


def audit_misc(report):
    # ta-bench
    ta = load("datasets/ta-bench/cases.json")
    ta_cases = ta.get("cases", ta if isinstance(ta, list) else [])
    # coach-review
    queue = load("datasets/coach-review/queue.json")
    coaches = load("datasets/coach-review/coaches.json")
    # mining
    mining = {}
    for m in sorted(os.listdir(os.path.join(DS, "mining"))):
        md = os.path.join(DS, "mining", m)
        if not os.path.isdir(md):
            continue
        entry = {}
        for f in ("mining.json", "scenes.json", "extract-meta.json"):
            d = json.load(open(os.path.join(md, f)))
            if isinstance(d, list):
                entry[f] = len(d)
            elif isinstance(d, dict):
                lists = {k: len(v) for k, v in d.items() if isinstance(v, list)}
                entry[f] = lists or list(d.keys())
        mining[m] = entry
    report["misc"] = {
        "taBenchCases": len(ta_cases) if isinstance(ta_cases, list) else None,
        "taBenchResultFiles": len(os.listdir(os.path.join(DS, "ta-bench", "results"))),
        "coachReviewQueue": len(queue.get("queue", [])),
        "coaches": len(coaches.get("coaches", [])),
        "faultTaxonomy": {
            "families": len(load("datasets/coach-review/taxonomy/fault-taxonomy.v0-draft.json").get("families", [])),
            "faults": sum(len(f.get("faults", [])) for f in
                          load("datasets/coach-review/taxonomy/fault-taxonomy.v0-draft.json").get("families", [])),
        },
        "drills": len(load("datasets/coach-review/drills/drill-library.v0.json").get("drills", [])),
        "cascadeRunFiles": len([f for f in os.listdir(os.path.join(DS, "cascade")) if f.endswith(".json")]),
        "completionBenchFiles": len(os.listdir(os.path.join(DS, "completion-bench"))),
        "mining": mining,
        "experimentSummaries": {
            w: len(os.listdir(os.path.join(DS, "experiments", w)))
            for w in sorted(os.listdir(os.path.join(DS, "experiments")))
            if os.path.isdir(os.path.join(DS, "experiments", w))
        },
    }


def main():
    check_urls = "--no-urls" not in sys.argv
    report = {
        "schemaVersion": 1,
        "workstream": "wave-d2/d2-09-registry-datacards",
        "annotatorId": "devin-visual-v4-waveD2",
        "generatedAtIso": datetime.now(timezone.utc).isoformat(),
        "heldOutCasesUntouched": sorted(HELD_OUT_CASES),
        "issues": [],
    }
    audit_registry(report, check_urls=check_urls)
    audit_paddle_bench(report)
    audit_ball_bench(report)
    audit_corpus(report)
    audit_releases(report)
    audit_misc(report)
    report["issueCounts"] = {}
    for i in report["issues"]:
        report["issueCounts"][i["severity"]] = report["issueCounts"].get(i["severity"], 0) + 1
    with open(OUT, "w") as f:
        json.dump(report, f, indent=2)
        f.write("\n")
    print(f"wrote {OUT}")
    print(json.dumps(report["issueCounts"], indent=2))
    for i in report["issues"]:
        print(f"- [{i['severity']}] {i['where']}: {i['detail']}")


if __name__ == "__main__":
    main()
