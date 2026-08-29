#!/usr/bin/env python3
"""F24 provenance-integrity audit (wave-f, f24-rt-data-provenance).

Runs the full e24 audit (which itself runs d2-09) as a module — without
overwriting the wave-e report artifact — then layers provenance checks that
the f24 red-team attack corpus proved e24 misses:

  1. Ledger append-only verification (f24-label-ledger.json): every ledgered
     record hash must still resolve in its collection; a missing hash means an
     existing label was edited or deleted in place -> append_only_violation.
     Unledgered additions are allowed (datasets are append-only) and surfaced
     for integrator review.
  2. Annotation-file immutability: a bundle annotation whose bytes changed
     must carry a strictly increased `revision`; silent rewrites ->
     append_only_violation. Legit revision bumps are surfaced, not flagged.
  3. Held-out contamination of additions: any unledgered record whose JSON
     mentions a held-out case id -> held_out_violation (e24 only keyed on the
     `bundle` field and only in some collections; stroke-gold uses `caseId`
     and event-bounds-qa-wave-c was unchecked).
  4. Dangling case references: every stroke-gold `caseId` must be an existing
     paddle-bench bundle dir -> dangling_reference otherwise (e24 only
     resolved the unused `bundle` key).

Read-only over label content; the only write is the report JSON next to this
script. Run from the repo root:

  python3 datasets/experiments/wave-f/f24-provenance-audit.py [--no-urls]
"""

import importlib.util
import json
import os
import sys
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
DS = os.path.join(ROOT, "datasets")
OUT = os.path.join(HERE, "f24-integrity-report.json")
LEDGER = os.path.join(HERE, "f24-label-ledger.json")

HELD_OUT_CASES = {"wm-dink-01", "afn-vic-rally1"}


def load_module(rel, name):
    path = os.path.join(ROOT, rel)
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def run_e24(report, check_urls):
    """Replicates e24's main() orchestration against this report dict so the
    committed wave-e report artifact is never rewritten."""
    e24 = load_module("datasets/experiments/wave-e/e24-data-integrity-audit.py", "e24_audit")
    d2 = e24.d2_09()
    d2.audit_registry(report, check_urls=check_urls)
    accepted = []
    kept = []
    for i in report["issues"]:
        if i["severity"] == "role_violation" and any(
            f"unexpected status {s}" == i["detail"] for s in e24.ACCEPTED_NEW_QUARANTINE_STATUSES
        ):
            accepted.append(i)
        else:
            kept.append(i)
    report["issues"] = kept
    report["registry"]["acceptedNewQuarantineStatuses"] = {
        "statuses": sorted(e24.ACCEPTED_NEW_QUARANTINE_STATUSES),
        "reclassifiedEntries": [i["where"] for i in accepted],
    }
    d2.audit_ood(report, check_urls=check_urls)
    if check_urls:
        e24.reclassify_url_issues(report)
    d2.audit_paddle_bench(report)
    d2.audit_ball_bench(report)
    d2.audit_corpus(report)
    d2.audit_releases(report)
    d2.audit_misc(report)
    e24.audit_data_cards(report)
    e24.audit_label_schema(report)
    e24.audit_sidecar_consistency(report)
    e24.audit_duplicates(report)
    e24.audit_held_out_isolation(report)


def audit_ledger(report):
    ledger_mod = load_module("datasets/experiments/wave-f/f24-label-ledger.py", "f24_ledger")
    with open(LEDGER) as f:
        ledger = json.load(f)
    issues = []
    additions = []
    summary = {}

    for name, entry in sorted(ledger["collections"].items()):
        try:
            records = ledger_mod.resolve_records(ROOT, entry["file"], entry["pointer"])
        except (OSError, json.JSONDecodeError) as e:
            issues.append(
                {
                    "severity": "append_only_violation",
                    "where": entry["file"],
                    "detail": f"ledgered collection unreadable: {e}",
                }
            )
            continue
        current = {}
        for r in records:
            h = ledger_mod.canonical_record_sha(r)
            current.setdefault(h, []).append(r)
        missing = []
        for h, count in entry["recordSha256Counts"].items():
            have = len(current.get(h, []))
            if have < count:
                missing.append(h)
                issues.append(
                    {
                        "severity": "append_only_violation",
                        "where": f"{name} ({entry['file']})",
                        "detail": f"ledgered record {h[:16]}… no longer present "
                        f"({have}/{count} copies) — an existing label was edited or deleted in place",
                    }
                )
        new_records = []
        for h, rs in current.items():
            extra = len(rs) - entry["recordSha256Counts"].get(h, 0)
            new_records.extend(rs[:extra] if extra > 0 else [])
        for r in new_records:
            blob = json.dumps(r, sort_keys=True)
            hits = sorted(c for c in HELD_OUT_CASES if c in blob)
            for hcase in hits:
                issues.append(
                    {
                        "severity": "held_out_violation",
                        "where": f"{name} ({entry['file']})",
                        "detail": f"unledgered addition references held-out case {hcase}: {blob[:200]}",
                    }
                )
            additions.append({"collection": name, "recordSha256": ledger_mod.canonical_record_sha(r)})
        summary[name] = {
            "ledgered": entry["recordCount"],
            "current": len(records),
            "missingLedgeredHashes": len(missing),
            "unledgeredAdditions": len(new_records),
        }

    revised = []
    for rel, entry in sorted(ledger["annotationFiles"].items()):
        p = os.path.join(ROOT, rel)
        if not os.path.isfile(p):
            issues.append(
                {
                    "severity": "append_only_violation",
                    "where": rel,
                    "detail": "ledgered annotation file deleted",
                }
            )
            continue
        actual = ledger_mod.sha256_file(p)
        if actual == entry["sha256"]:
            continue
        try:
            revision = json.load(open(p)).get("revision")
        except json.JSONDecodeError:
            revision = None
        old_rev = entry["revision"]
        if isinstance(revision, int) and isinstance(old_rev, int) and revision > old_rev:
            revised.append({"file": rel, "revision": {"ledgered": old_rev, "current": revision}})
        else:
            issues.append(
                {
                    "severity": "append_only_violation",
                    "where": rel,
                    "detail": f"annotation bytes changed without a strictly increased revision "
                    f"(ledgered rev {old_rev!r}, current rev {revision!r}) — silent label rewrite",
                }
            )

    report["ledger"] = {
        "ledgerFile": os.path.relpath(LEDGER, ROOT),
        "collections": summary,
        "unledgeredAdditions": additions,
        "revisedAnnotations": revised,
        "annotationFilesLedgered": len(ledger["annotationFiles"]),
    }
    report["issues"].extend(issues)


def audit_case_references(report):
    issues = []
    bundles_dir = os.path.join(DS, "paddle-bench", "bundles")
    bundle_dirs = {b for b in os.listdir(bundles_dir) if os.path.isdir(os.path.join(bundles_dir, b))}
    with open(os.path.join(DS, "paddle-bench", "stroke-gold.json")) as f:
        sg = json.load(f)
    unknown = sorted({lbl.get("caseId") for lbl in sg.get("labels", [])} - bundle_dirs - {None})
    for c in unknown:
        issues.append(
            {
                "severity": "dangling_reference",
                "where": "paddle-bench/stroke-gold.json",
                "detail": f"label caseId {c} is not an existing bundle dir",
            }
        )
    report["caseReferences"] = {
        "strokeGoldCaseIds": sorted({lbl.get("caseId") for lbl in sg.get("labels", [])}),
        "bundleDirs": len(bundle_dirs),
        "unknownCaseIds": unknown,
    }
    report["issues"].extend(issues)


def main():
    check_urls = "--no-urls" not in sys.argv
    report = {
        "schemaVersion": 1,
        "workstream": "wave-f/f24-rt-data-provenance",
        "annotatorId": "devin-audit-v1-waveF",
        "extends": "datasets/experiments/wave-e/e24-data-integrity-audit.py",
        "generatedAtIso": datetime.now(timezone.utc).isoformat(),
        "heldOutCasesUntouched": sorted(HELD_OUT_CASES),
        "issues": [],
    }
    run_e24(report, check_urls)
    audit_ledger(report)
    audit_case_references(report)

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
