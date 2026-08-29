#!/usr/bin/env python3
"""E24 data-integrity audit (wave-e) — extends d2-09 after the D/D2/D3/D4 merges.

Runs the full d2-09 audit (registry JSON validation, fresh-candidate/ood media
hash+byte verification, corpus lineage/split reconciliation, release manifest
verification, count recounts) by importing it as a module, then layers the
wave-e checks on top:

  1. Data cards vs actual files: every dataset dir has a DATA_CARD.md and every
     repo path referenced inside a data card exists on disk.
  2. Label-schema conformance: every bundle annotation JSON carries the
     required envelope (schemaVersion, captureBundle, annotatorId,
     createdAtIso, revision), captureBundle matches its directory, and
     annotatorId matches the filename stem.
  3. Sidecar/bundle consistency: paddle-bench registry videos <-> bundle dirs,
     and every labels/annotation path referenced by paddle-bench.json,
     ball-bench.json, stroke-gold.json and event-bounds files resolves.
  4. Duplicate detection: duplicate ids within every id-bearing collection and
     duplicate sha256 across all registered committed media.
  5. Held-out isolation: wm-dink-01 / afn-vic-rally1 bundles contain only the
     baseline devin-visual-v1.json annotation, no gold/label collection
     (stroke-gold, ta-bench cases, event-bounds) contains held-out entries,
     and release annotation copies of the held-out baselines are compared
     against the live bundle baseline (drift reported with revisions). All
     other textual references (bench case listings, run artifacts, QA records,
     exclusion notes) are classified and listed, not flagged as violations.

Read-only over label content; the only write is the report JSON next to this
script. Run from the repo root:

  python3 datasets/experiments/wave-e/e24-data-integrity-audit.py [--no-urls]
"""

import importlib.util
import json
import os
import re
import subprocess
import sys
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
DS = os.path.join(ROOT, "datasets")
OUT = os.path.join(HERE, "e24-integrity-report.json")

HELD_OUT_CASES = {"wm-dink-01", "afn-vic-rally1"}
HELD_OUT_BASELINE_ANNOTATION = "devin-visual-v1.json"

# Quarantine statuses added after d2-09 froze its vocabulary (d2-03 VOA
# entries); accepted here as vocabulary extensions, not role violations.
ACCEPTED_NEW_QUARANTINE_STATUSES = {
    "excluded_not_downloaded_into_corpus",
    "not_downloaded_duplicate",
}

REQUIRED_ANNOTATION_ENVELOPE = ["schemaVersion", "captureBundle", "annotatorId", "createdAtIso", "revision"]

URL_RE = re.compile(r"https?://\S+")


def reclassify_url_issues(report):
    """d2-09 probes registry 'url' fields with HEAD/ranged GET only. Some
    officialSearchChecks entries are prose descriptions or templates (not
    probeable), and some hosts (dvidshub, voanews) reject ranged requests but
    serve plain GET. Re-probe dead_url findings with plain GET and reclassify."""
    kept = []
    for i in report["issues"]:
        if i["severity"] != "dead_url":
            kept.append(i)
            continue
        urls = [u.rstrip(").,;") for u in URL_RE.findall(i["detail"])]
        if not urls or any("<" in u for u in urls):
            i["severity"] = "not_probeable_search_description"
            kept.append(i)
            continue
        statuses = []
        for u in urls:
            r = subprocess.run(
                ["curl", "-s", "-g", "-o", "/dev/null", "-L", "--max-time", "60",
                 "-w", "%{http_code}", u],
                capture_output=True, text=True, timeout=90,
            )
            statuses.append(r.stdout.strip())
        if all(s.isdigit() and 200 <= int(s) < 300 for s in statuses):
            i["severity"] = "url_ok_on_plain_get"
            i["detail"] += f" — plain GET returned {statuses}"
        elif any(s == "403" for s in statuses):
            i["severity"] = "url_bot_blocked_403"
            i["detail"] += " — 403 to non-browser clients (bot challenge), not confirmed dead"
        kept.append(i)
    report["issues"] = kept


def d2_09():
    path = os.path.join(DS, "experiments", "wave-d2", "d2-09-audit.py")
    spec = importlib.util.spec_from_file_location("d2_09_audit", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def load(rel):
    with open(os.path.join(ROOT, rel)) as f:
        return json.load(f)


def audit_data_cards(report):
    issues = []
    cards = {}
    dataset_dirs = sorted(
        d for d in os.listdir(DS) if os.path.isdir(os.path.join(DS, d)) and d != "experiments"
    )
    # paths referenced inline in data cards, e.g. `datasets/foo/bar.json`
    path_re = re.compile(r"`(datasets/[A-Za-z0-9_./-]+)`")
    for d in dataset_dirs:
        card = os.path.join(DS, d, "DATA_CARD.md")
        entry = {"dataCardExists": os.path.isfile(card)}
        if not entry["dataCardExists"]:
            issues.append(
                {
                    "severity": "missing_data_card",
                    "where": f"datasets/{d}",
                    "detail": "no DATA_CARD.md",
                }
            )
            cards[d] = entry
            continue
        text = open(card).read()
        refs = sorted(set(path_re.findall(text)))
        missing = []
        for r in refs:
            p = os.path.join(ROOT, r.rstrip("/"))
            if not os.path.exists(p) and not os.path.exists(p + "/"):
                # gitignored media dirs are documented as absent by design
                if "/videos" in r or "/media" in r or "/runs" in r:
                    continue
                missing.append(r)
        entry["referencedPaths"] = len(refs)
        entry["missingReferencedPaths"] = missing
        for m in missing:
            issues.append(
                {
                    "severity": "data_card_drift",
                    "where": f"datasets/{d}/DATA_CARD.md",
                    "detail": f"references non-existent path {m}",
                }
            )
        cards[d] = entry
    report["dataCards"] = cards
    report["issues"].extend(issues)


def audit_label_schema(report):
    issues = []
    bundles_dir = os.path.join(DS, "paddle-bench", "bundles")
    files_checked = 0
    for b in sorted(os.listdir(bundles_dir)):
        ad = os.path.join(bundles_dir, b, "annotation")
        if not os.path.isdir(ad):
            issues.append(
                {
                    "severity": "sidecar_inconsistency",
                    "where": f"paddle-bench/bundles/{b}",
                    "detail": "bundle has no annotation/ dir",
                }
            )
            continue
        for f in sorted(os.listdir(ad)):
            if not f.endswith(".json"):
                continue
            files_checked += 1
            rel = f"paddle-bench/bundles/{b}/annotation/{f}"
            try:
                data = json.load(open(os.path.join(ad, f)))
            except json.JSONDecodeError as e:
                issues.append(
                    {"severity": "schema_violation", "where": rel, "detail": f"invalid JSON: {e}"}
                )
                continue
            missing = [k for k in REQUIRED_ANNOTATION_ENVELOPE if k not in data]
            if missing:
                issues.append(
                    {
                        "severity": "schema_violation",
                        "where": rel,
                        "detail": f"missing envelope fields {missing}",
                    }
                )
            if data.get("captureBundle") != b:
                issues.append(
                    {
                        "severity": "schema_violation",
                        "where": rel,
                        "detail": f"captureBundle {data.get('captureBundle')!r} != bundle dir {b!r}",
                    }
                )
            annotator = data.get("annotatorId", "")
            stem = f[: -len(".json")]
            if annotator and not stem.startswith(annotator):
                issues.append(
                    {
                        "severity": "schema_violation",
                        "where": rel,
                        "detail": f"annotatorId {annotator!r} does not prefix filename {stem!r}",
                    }
                )
            if data.get("schemaVersion") != 1:
                issues.append(
                    {
                        "severity": "schema_violation",
                        "where": rel,
                        "detail": f"unexpected schemaVersion {data.get('schemaVersion')!r}",
                    }
                )
            created = data.get("createdAtIso")
            if created:
                try:
                    datetime.fromisoformat(str(created).replace("Z", "+00:00"))
                except ValueError:
                    issues.append(
                        {
                            "severity": "schema_violation",
                            "where": rel,
                            "detail": f"createdAtIso not ISO-8601: {created!r}",
                        }
                    )
            rev = data.get("revision")
            if "revision" in data and (not isinstance(rev, int) or rev < 1):
                issues.append(
                    {
                        "severity": "schema_violation",
                        "where": rel,
                        "detail": f"revision not a positive int: {rev!r}",
                    }
                )
    report["labelSchema"] = {
        "annotationFilesChecked": files_checked,
        "requiredEnvelope": REQUIRED_ANNOTATION_ENVELOPE,
    }
    report["issues"].extend(issues)


def audit_sidecar_consistency(report):
    issues = []
    bundles_dir = os.path.join(DS, "paddle-bench", "bundles")
    bundle_dirs = {b for b in os.listdir(bundles_dir) if os.path.isdir(os.path.join(bundles_dir, b))}

    # Registry lists SOURCE videos; bundles are per-case. Cross-check that
    # every paddle-bench.json case video maps to a registered source file and
    # that every non-excluded case has a bundle dir; then verify every bundle
    # dir is referenced by at least one committed dataset (no orphans).
    reg = load("datasets/paddle-bench/registry.json")
    reg_files = {os.path.basename(v["file"]) for v in reg["videos"]}

    def check_path(rel_base, rel_path, where, media_ok=False):
        p = os.path.normpath(os.path.join(ROOT, rel_base, rel_path))
        if os.path.exists(p):
            return True
        segments = set(rel_path.split("/"))
        if media_ok and segments & {"videos", "runs", "media"}:
            return True  # gitignored media/run dirs, absent by design
        issues.append(
            {
                "severity": "sidecar_inconsistency",
                "where": where,
                "detail": f"referenced path {rel_path} missing",
            }
        )
        return False

    pb = load("datasets/paddle-bench/paddle-bench.json")
    for case in pb.get("cases", []) + pb.get("excludedCases", []):
        for key in ("labels", "video", "runDir"):
            if case.get(key):
                check_path(
                    "datasets/paddle-bench",
                    case[key],
                    f"paddle-bench/paddle-bench.json[{case.get('id')}].{key}",
                    media_ok=True,
                )
        if case.get("video") and os.path.basename(case["video"]) not in reg_files:
            issues.append(
                {
                    "severity": "sidecar_inconsistency",
                    "where": f"paddle-bench/paddle-bench.json[{case.get('id')}]",
                    "detail": f"case video {case['video']} not in registry files",
                }
            )
    for case in pb.get("cases", []):
        if case["id"] not in bundle_dirs:
            issues.append(
                {
                    "severity": "sidecar_inconsistency",
                    "where": f"paddle-bench/paddle-bench.json[{case['id']}]",
                    "detail": "active case has no bundles/ dir",
                }
            )

    bb = load("datasets/ball-bench/ball-bench.json")
    for case in bb.get("cases", []) + bb.get("excludedCases", []):
        for key in ("labels", "video", "runDir"):
            if case.get(key):
                check_path(
                    "datasets/ball-bench",
                    case[key],
                    f"ball-bench/ball-bench.json[{case.get('id')}].{key}",
                    media_ok=True,
                )

    sg = load("datasets/paddle-bench/stroke-gold.json")
    for lbl in sg.get("labels", []):
        b = lbl.get("bundle") or lbl.get("captureBundle")
        if b and b not in bundle_dirs:
            issues.append(
                {
                    "severity": "sidecar_inconsistency",
                    "where": f"paddle-bench/stroke-gold.json[{lbl.get('labelId', b)}]",
                    "detail": f"references unknown bundle {b}",
                }
            )

    eb = load("datasets/paddle-bench/event-bounds-qa-wave-c.json")
    for ev in eb.get("events", []):
        b = ev.get("bundle")
        if b and b not in bundle_dirs:
            issues.append(
                {
                    "severity": "sidecar_inconsistency",
                    "where": "paddle-bench/event-bounds-qa-wave-c.json",
                    "detail": f"event references unknown bundle {b}",
                }
            )

    # orphan bundles: not referenced by any committed dataset
    referenced = {c["id"] for c in pb.get("cases", [])}
    referenced |= {lbl.get("bundle") for lbl in sg.get("labels", [])}
    referenced |= {e.get("bundle") for e in eb.get("events", [])}
    eb_a = load("datasets/paddle-bench/event-bounds-wave-a.json")
    referenced |= {c.get("bundle") for c in eb_a.get("cases", [])}
    bb_text = open(os.path.join(DS, "ball-bench", "ball-bench.json")).read()
    orphans = sorted(b for b in bundle_dirs if b not in referenced and b not in bb_text)
    for orphan in orphans:
        issues.append(
            {
                "severity": "sidecar_inconsistency",
                "where": f"paddle-bench/bundles/{orphan}",
                "detail": "bundle dir referenced by no committed dataset",
            }
        )

    report["sidecarConsistency"] = {
        "registrySourceVideos": len(reg["videos"]),
        "bundleDirs": len(bundle_dirs),
        "activeCasesWithBundles": sorted(c["id"] for c in pb.get("cases", []) if c["id"] in bundle_dirs),
        "orphanBundles": orphans,
    }
    report["issues"].extend(issues)


def audit_duplicates(report):
    issues = []

    def dupes(seq):
        seen, out = set(), set()
        for x in seq:
            if x in seen:
                out.add(x)
            seen.add(x)
        return sorted(out)

    collections = {}

    reg = load("datasets/pickleball/registry.json")
    all_reg_ids = (
        [s.get("id") for s in reg.get("sources", [])]
        + [s.get("id") for s in reg.get("evaluatedButExcluded", [])]
        + [i.get("id") for i in reg.get("freshCandidates", {}).get("items", [])]
        + [q.get("id") for q in reg.get("quarantinedUnknownRights", [])]
    )
    collections["pickleball/registry ids (all sections)"] = all_reg_ids

    pb_reg = load("datasets/paddle-bench/registry.json")
    collections["paddle-bench/registry video ids"] = [v.get("id") for v in pb_reg["videos"]]

    sg = load("datasets/paddle-bench/stroke-gold.json")
    collections["paddle-bench/stroke-gold labelIds"] = [
        lbl.get("labelId") for lbl in sg.get("labels", []) if lbl.get("labelId")
    ]
    collections["paddle-bench/stroke-gold (bundle,eventStartMs)"] = [
        (lbl.get("bundle"), lbl.get("eventStartMs")) for lbl in sg.get("labels", [])
    ]

    eb = load("datasets/paddle-bench/event-bounds-qa-wave-c.json")
    collections["paddle-bench/event-bounds-qa (bundle,idx)"] = [
        (e.get("bundle"), e.get("idx")) for e in eb.get("events", [])
    ]

    ta = load("datasets/ta-bench/cases.json")
    collections["ta-bench caseIds"] = [c.get("caseId") for c in ta.get("cases", [])]

    recs = load("datasets/corpus/recordings.json")
    collections["corpus recordingIds"] = [r.get("recordingId") for r in recs]
    srcs = load("datasets/corpus/sources.json")
    collections["corpus sourceIds"] = [s.get("sourceId") for s in srcs]

    dup_report = {}
    for name, ids in collections.items():
        d = dupes(ids)
        dup_report[name] = {"count": len(ids), "duplicates": [str(x) for x in d]}
        for x in d:
            issues.append(
                {"severity": "duplicate_id", "where": name, "detail": f"duplicate id {x}"}
            )

    # sha256 duplicates across all registered committed media
    sha_index = {}
    for i in reg.get("freshCandidates", {}).get("items", []):
        sha = i.get("media", {}).get("sha256")
        if sha:
            sha_index.setdefault(sha, []).append(f"pickleball/freshCandidates[{i['id']}]")
    ood_path = os.path.join(DS, "ood", "registry.json")
    if os.path.isfile(ood_path):
        ood = load("datasets/ood/registry.json")
        for i in ood.get("items", []):
            if i.get("sha256"):
                sha_index.setdefault(i["sha256"], []).append(f"ood/items[{i['id']}]")
    for r in recs:
        for key in ("sha256", "mediaSha256"):
            if r.get(key):
                sha_index.setdefault(r[key], []).append(f"corpus/recordings[{r['recordingId']}]")
    sha_dupes = {k: v for k, v in sha_index.items() if len(v) > 1}
    for sha, wheres in sorted(sha_dupes.items()):
        declared = any("corpus" in w for w in wheres) and len({w.split("/")[0] for w in wheres}) == 1
        issues.append(
            {
                "severity": "duplicate_media" if not declared else "duplicate_media_declared",
                "where": " + ".join(wheres),
                "detail": f"identical sha256 {sha[:16]}…",
            }
        )
    report["duplicates"] = {
        "collections": dup_report,
        "registeredMediaSha256Checked": len(sha_index),
        "sha256Duplicates": {k[:16]: v for k, v in sha_dupes.items()},
    }
    report["issues"].extend(issues)


def audit_held_out_isolation(report):
    issues = []
    bundles_dir = os.path.join(DS, "paddle-bench", "bundles")
    per_case = {}
    for case in sorted(HELD_OUT_CASES):
        ad = os.path.join(bundles_dir, case, "annotation")
        files = sorted(os.listdir(ad)) if os.path.isdir(ad) else []
        extra = [f for f in files if f != HELD_OUT_BASELINE_ANNOTATION]
        per_case[case] = {"annotationFiles": files, "nonBaselineAnnotations": extra}
        for f in extra:
            issues.append(
                {
                    "severity": "held_out_violation",
                    "where": f"paddle-bench/bundles/{case}/annotation/{f}",
                    "detail": "non-baseline annotation added to a held-out bundle",
                }
            )

    # Gold/label collections must not contain held-out label entries.
    gold_checks = {}
    sg = load("datasets/paddle-bench/stroke-gold.json")
    gold_checks["stroke-gold labels"] = sorted(
        {lbl.get("bundle") for lbl in sg.get("labels", [])} & HELD_OUT_CASES
    )
    ta = load("datasets/ta-bench/cases.json")
    gold_checks["ta-bench cases"] = sorted(
        {c for case in ta.get("cases", []) for c in HELD_OUT_CASES if c in json.dumps(case)}
    )
    eb_a = load("datasets/paddle-bench/event-bounds-wave-a.json")
    gold_checks["event-bounds-wave-a cases"] = sorted(
        {c.get("bundle") for c in eb_a.get("cases", [])} & HELD_OUT_CASES
    )
    for name, hits in gold_checks.items():
        for h in hits:
            issues.append(
                {
                    "severity": "held_out_violation",
                    "where": name,
                    "detail": f"gold/label collection contains held-out case {h}",
                }
            )

    # Release annotation copies of held-out baselines vs the live baseline.
    release_drift = []
    rel_ann_dir = os.path.join(DS, "releases", "pickle-real-v0.3", "annotations")
    for case in sorted(HELD_OUT_CASES):
        rel_path = os.path.join(rel_ann_dir, f"{case}.json")
        base_path = os.path.join(bundles_dir, case, "annotation", HELD_OUT_BASELINE_ANNOTATION)
        if not (os.path.isfile(rel_path) and os.path.isfile(base_path)):
            continue
        same = open(rel_path, "rb").read() == open(base_path, "rb").read()
        rel_rev = json.load(open(rel_path)).get("revision")
        base_rev = json.load(open(base_path)).get("revision")
        release_drift.append(
            {
                "case": case,
                "byteIdentical": same,
                "releaseRevision": rel_rev,
                "bundleRevision": base_rev,
            }
        )
        if not same:
            issues.append(
                {
                    "severity": "held_out_baseline_drift",
                    "where": f"releases/pickle-real-v0.3/annotations/{case}.json",
                    "detail": f"release copy (rev {rel_rev}) != live baseline (rev {base_rev}); "
                    "release is an immutable snapshot — baseline was revised after the "
                    "freeze; needs adjudication on when/why the held-out baseline moved",
                }
            )

    # Classify every other textual reference to held-out case ids: bench case
    # listings, run artifacts, QA records and exclusion notes are expected;
    # they are recorded (not flagged) so reviewers can audit the full set.
    references = []
    for dirpath, dirnames, filenames in os.walk(DS):
        rel_dir = os.path.relpath(dirpath, ROOT)
        if any(c in rel_dir for c in HELD_OUT_CASES):
            continue
        for f in filenames:
            if not (f.endswith(".json") or f.endswith(".jsonl") or f.endswith(".md")):
                continue
            rel = os.path.join(rel_dir, f)
            try:
                text = open(os.path.join(ROOT, rel), errors="replace").read()
            except OSError:
                continue
            hits = sorted(c for c in HELD_OUT_CASES if c in text)
            if hits:
                references.append({"file": rel, "cases": hits})

    report["heldOutIsolation"] = {
        "cases": per_case,
        "goldCollectionChecks": gold_checks,
        "releaseBaselineComparison": release_drift,
        "textualReferences": references,
        "textualReferenceNote": "references are id mentions in bench case listings, run "
        "artifacts, QA records, registries and exclusion notes — recorded for review, "
        "not isolation violations; no held-out label content was viewed",
    }
    report["issues"].extend(issues)


def main():
    check_urls = "--no-urls" not in sys.argv
    mod = d2_09()
    report = {
        "schemaVersion": 1,
        "workstream": "wave-e/e24-data-integrity",
        "annotatorId": "devin-audit-v1-waveE",
        "extends": "datasets/experiments/wave-d2/d2-09-audit.py",
        "generatedAtIso": datetime.now(timezone.utc).isoformat(),
        "heldOutCasesUntouched": sorted(HELD_OUT_CASES),
        "issues": [],
    }
    # d2-09 baseline checks (registry, ood, paddle/ball bench recounts, corpus,
    # releases, misc counts)
    mod.audit_registry(report, check_urls=check_urls)
    # d2-03 extended the quarantine status vocabulary after d2-09 froze its
    # whitelist; reclassify those from role_violation to an accepted extension.
    accepted = []
    kept = []
    for i in report["issues"]:
        if i["severity"] == "role_violation" and any(
            f"unexpected status {s}" == i["detail"] for s in ACCEPTED_NEW_QUARANTINE_STATUSES
        ):
            accepted.append(i)
        else:
            kept.append(i)
    report["issues"] = kept
    report["registry"]["acceptedNewQuarantineStatuses"] = {
        "statuses": sorted(ACCEPTED_NEW_QUARANTINE_STATUSES),
        "reclassifiedEntries": [i["where"] for i in accepted],
    }
    mod.audit_ood(report, check_urls=check_urls)
    if check_urls:
        reclassify_url_issues(report)
    mod.audit_paddle_bench(report)
    mod.audit_ball_bench(report)
    mod.audit_corpus(report)
    mod.audit_releases(report)
    mod.audit_misc(report)
    # wave-e extensions
    audit_data_cards(report)
    audit_label_schema(report)
    audit_sidecar_consistency(report)
    audit_duplicates(report)
    audit_held_out_isolation(report)

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
