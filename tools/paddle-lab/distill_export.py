"""paddle-distill-v1 dataset exporter (D4-06 groundwork).

Exports every COMMITTED D-FINE paddle detection artifact plus the committed
ownership/selection outcomes into a versioned training-example format under
datasets/releases/paddle-distill-v0.1/ (manifest.json + examples.jsonl).

Committed teacher artifacts consumed (read-only, never edited):
  - datasets/experiments/wave-a/H-logs/baseline-rerun-<case>-dets.json
    (full-frame D-FINE dets over the event window; wave-a, pre-C01 clock —
    the one-frame-early ffmpeg seek caveat is recorded per example)
  - datasets/experiments/wave-b/W12-probe/probe-dets.json
    (keyframe multi-strategy dets; only baseline_fullframe is exported as
    teacher output, crop strategies are recorded as auxiliary)
Ownership/selection outcomes consumed:
  - datasets/paddle-bench/ownership-review/ownership-review.json
    (per-frame per-box target/other/reject/ambiguous adjudications)
  - datasets/paddle-bench/bundles/*/annotation/devin-visual-v2-waveC*.json
    (visually-verified target/other paddle center points)

GATES (both must pass for trainingEligible=true):
  1. RIGHTS: the case's source must resolve to a corpus rights record
     (datasets/corpus/sources.json) whose rights.train is "yes" or
     "yes_with_attribution"; a source absent from the corpus rights ledger
     falls back to the license rule (PD-USGov => yes; CC BY => with
     attribution; anything else => not_cleared => quarantined).
  2. CONSENT (C10): examples with a sourceUserId (first-party footage) are
     eligible only with an explicit model_training consent grant exported
     from the consent ledger (--consent-export, the offline mirror of
     services/media-worker/src/trainingConsent.ts::selectTrainingEligibleItems).
     No export supplied or no grant => quarantined, never opt-in by absence.
     All current sources are third-party licensed (sourceUserId=null), so the
     consent gate is wired but vacuous today; the manifest reports the counts.
Additionally, held-out cases (role held_out / test_held_out) are ALWAYS
quarantined from training regardless of rights (split discipline).

Usage:
  python3 distill_export.py [--repo-root ../..] [--consent-export grants.json]
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

FORMAT_VERSION = "paddle-distill-v1"
RELEASE_ID = "paddle-distill-v0.1"

HELD_OUT_ROLES = {"held_out", "test_held_out"}
TRAIN_OK = {"yes", "yes_with_attribution"}
# join tolerance between ownership tMs and teacher-frame tMs: half a frame
# period at the slowest committed fps (25fps -> 40ms/frame -> 20ms)
JOIN_TOLERANCE_MS = 20.0

WAVE_A_CLOCK_CAVEAT = (
    "wave-a artifact predates the C01 timestamp-alignment fix: tMs may sit "
    "one frame (~33ms) early vs absolute CFR indexing"
)


def load_json(path: Path):
    with open(path) as f:
        return json.load(f)


def norm_url(url: str | None) -> str | None:
    if not url:
        return None
    return url.rstrip("/").split("://")[-1].lower()


def build_rights_index(repo: Path) -> tuple[dict, dict, dict]:
    """Return (byUrl, bySourceId, bySourceKeyFallback) rights lookups."""
    corpus_sources = load_json(repo / "datasets/corpus/sources.json")
    by_url = {}
    by_source_id = {}
    for s in corpus_sources:
        u = norm_url(s.get("url"))
        if u:
            by_url[u] = s
        by_source_id[s["sourceId"]] = s
    registry = load_json(repo / "datasets/paddle-bench/registry.json")
    by_source_key = {v["id"]: v for v in registry["videos"]}
    return by_url, by_source_id, by_source_key


def license_rule(license_str: str | None) -> tuple[str, str]:
    """Fallback when no corpus rights record exists. Returns (train, basis)."""
    if not license_str:
        return "not_cleared", "no license recorded"
    lic = license_str.lower()
    if "pd-usgov" in lic or "public domain" in lic:
        return "yes", f"license rule: {license_str} (17 U.S.C. §105)"
    if lic.startswith("cc by ") or lic.startswith("cc-by"):
        return (
            "yes_with_attribution",
            f"license rule: {license_str} permits commercial use incl. adaptation with attribution",
        )
    return "not_cleared", f"license rule: {license_str} not cleared for training"


def resolve_rights(source_key: str, by_url: dict, by_source_id: dict, by_source_key: dict) -> dict:
    reg = by_source_key.get(source_key)
    corpus = None
    if reg is not None:
        corpus = by_url.get(norm_url(reg.get("source")))
    if corpus is None:
        corpus = by_source_id.get(f"src-{source_key}")
    if corpus is not None and "rights" in corpus:
        r = corpus["rights"]
        return {
            "sourceKey": source_key,
            "rightsRecord": corpus["sourceId"],
            "license": corpus.get("license"),
            "train": r.get("train", "not_cleared"),
            "basis": r.get("basis"),
            "restrictions": corpus.get("restrictions", []),
        }
    license_str = reg.get("license") if reg else None
    train, basis = license_rule(license_str)
    return {
        "sourceKey": source_key,
        "rightsRecord": None,
        "license": license_str,
        "train": train,
        "basis": basis,
        "restrictions": (reg or {}).get("restrictions", []),
    }


def load_cases(repo: Path) -> dict:
    cases = {}
    bench = load_json(repo / "datasets/paddle-bench/paddle-bench.json")
    for c in bench["cases"]:
        cases[c["id"]] = {
            "caseId": c["id"],
            "sourceKey": c["sourceKey"],
            "sessionKey": c["sessionKey"],
            "role": c["role"],
        }
    wave_a = load_json(repo / "datasets/paddle-bench/event-bounds-wave-a.json")
    for c in wave_a["cases"]:
        cases.setdefault(
            c["id"],
            {
                "caseId": c["id"],
                "sourceKey": c["sourceKey"],
                "sessionKey": c["sessionKey"],
                "role": "development",
            },
        )
    return cases


def load_teacher_frames(repo: Path) -> dict:
    """caseId -> list of {tMs, detections, artifact, clockCaveat, aux}."""
    frames: dict[str, list] = {}
    h_logs = repo / "datasets/experiments/wave-a/H-logs"
    for path in sorted(h_logs.glob("baseline-rerun-*-dets.json")):
        case_id = path.stem[len("baseline-rerun-") : -len("-dets")]
        data = load_json(path)
        rel = str(path.relative_to(repo))
        for fr in data["frames"]:
            frames.setdefault(case_id, []).append(
                {
                    "tMs": fr["tMs"],
                    "detections": fr["detections"],
                    "artifact": rel,
                    "detector": data["detector"]["version"],
                    "clockCaveat": WAVE_A_CLOCK_CAVEAT,
                    "auxStrategies": None,
                }
            )
    probe_path = repo / "datasets/experiments/wave-b/W12-probe/probe-dets.json"
    probe = load_json(probe_path)
    rel = str(probe_path.relative_to(repo))
    for fr in probe["frames"]:
        baseline = next(
            (r for r in fr["results"] if r["strategy"] == "baseline_fullframe"),
            None,
        )
        if baseline is None:
            continue
        frames.setdefault(fr["case"], []).append(
            {
                "tMs": fr["tMs"],
                "detections": baseline["boxes"],
                "artifact": rel,
                "detector": probe["detector"]["modelId"],
                "clockCaveat": WAVE_A_CLOCK_CAVEAT,
                "auxStrategies": [
                    r["strategy"] for r in fr["results"] if r["strategy"] != "baseline_fullframe"
                ],
            }
        )
    for case_frames in frames.values():
        case_frames.sort(key=lambda f: f["tMs"])
    return frames


def load_ownership(repo: Path) -> dict:
    """caseId -> {tMs -> outcome dict}."""
    review = load_json(repo / "datasets/paddle-bench/ownership-review/ownership-review.json")
    outcomes: dict[str, dict] = {}
    for e in review:
        outcomes.setdefault(e["caseId"], {})[float(e["tMs"])] = {
            "owners": e["owners"],
            "note": e.get("note"),
            "annotator": e.get("annotator"),
            "artifact": "datasets/paddle-bench/ownership-review/ownership-review.json",
            "points": None,
        }
    bundles = repo / "datasets/paddle-bench/bundles"
    for ann_path in sorted(bundles.glob("*/annotation/devin-visual-v2-waveC*.json")):
        ann = load_json(ann_path)
        if "ownership" not in ann_path.name and "waveC.json" not in ann_path.name:
            continue
        case_id = ann["captureBundle"]
        target = {f["tMs"]: f for f in ann.get("paddleFrames", [])}
        other: dict[float, list] = {}
        for f in ann.get("otherPaddleFrames", []):
            other.setdefault(f["tMs"], []).append(f)
        for t_ms in set(target) | set(other):
            case_outcomes = outcomes.setdefault(case_id, {})
            near = next(
                (k for k in case_outcomes if abs(k - float(t_ms)) <= JOIN_TOLERANCE_MS),
                None,
            )
            points = {
                "target": (target.get(t_ms) or {}).get("point"),
                "others": [f["point"] for f in other.get(t_ms, [])],
                "annotator": ann["annotatorId"],
                "artifact": str(ann_path.relative_to(repo)),
            }
            if near is not None:
                case_outcomes[near]["points"] = points
            else:
                case_outcomes[float(t_ms)] = {
                    "owners": None,
                    "note": None,
                    "annotator": ann["annotatorId"],
                    "artifact": str(ann_path.relative_to(repo)),
                    "points": points,
                }
    return outcomes


def load_consent_grants(path: Path | None) -> set:
    if path is None:
        return set()
    data = load_json(path)
    return {item["source_user_id"] for item in data if item.get("consent_version")}


def gate_example(case: dict, rights: dict, source_user_id, consent_grants: set) -> tuple[bool, list]:
    reasons = []
    if case["role"] in HELD_OUT_ROLES:
        reasons.append(f"held_out_case:{case['role']}")
    if rights["train"] not in TRAIN_OK:
        reasons.append(f"rights_not_cleared:{rights['train']}")
    if source_user_id is not None and source_user_id not in consent_grants:
        reasons.append("consent_not_granted")
    return (len(reasons) == 0, reasons)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo-root", default=str(Path(__file__).resolve().parents[2]))
    ap.add_argument(
        "--consent-export",
        default=None,
        help="JSON export of trainingConsent.selectTrainingEligibleItems() rows; "
        "absent => every first-party example is quarantined (absence is never opt-in)",
    )
    args = ap.parse_args()
    repo = Path(args.repo_root).resolve()

    by_url, by_source_id, by_source_key = build_rights_index(repo)
    cases = load_cases(repo)
    teacher = load_teacher_frames(repo)
    ownership = load_ownership(repo)
    consent_grants = load_consent_grants(Path(args.consent_export) if args.consent_export else None)

    examples = []
    for case_id in sorted(set(teacher) | set(ownership)):
        case = cases.get(case_id)
        if case is None:
            raise SystemExit(f"case {case_id} has committed artifacts but no registry entry")
        rights = resolve_rights(case["sourceKey"], by_url, by_source_id, by_source_key)
        clip = repo / "datasets/paddle-bench/bundles" / case_id / "clip.mp4"
        own = dict(ownership.get(case_id, {}))
        for tf in teacher.get(case_id, []):
            matched = next(
                (k for k in own if abs(k - tf["tMs"]) <= JOIN_TOLERANCE_MS),
                None,
            )
            outcome = own.pop(matched, None) if matched is not None else None
            source_user_id = None  # all committed sources are third-party licensed
            eligible, reasons = gate_example(case, rights, source_user_id, consent_grants)
            examples.append(
                {
                    "formatVersion": FORMAT_VERSION,
                    "exampleId": f"{case_id}@{tf['tMs']:.1f}",
                    "kind": "teacher_frame",
                    "caseId": case_id,
                    "sourceKey": case["sourceKey"],
                    "sessionKey": case["sessionKey"],
                    "role": case["role"],
                    "tMs": tf["tMs"],
                    "media": {
                        "bundleClip": str(clip.relative_to(repo)) if clip.exists() else None,
                        "pixelsCommitted": clip.exists(),
                    },
                    "teacher": {
                        "detector": tf["detector"],
                        "artifact": tf["artifact"],
                        "clockCaveat": tf["clockCaveat"],
                        "detections": tf["detections"],
                        "auxStrategies": tf["auxStrategies"],
                    },
                    "ownership": outcome,
                    "rights": rights,
                    "consent": {
                        "sourceUserId": source_user_id,
                        "gate": "third_party_licensed_rights_path"
                        if source_user_id is None
                        else "c10_model_training_ledger",
                    },
                    "trainingEligible": eligible,
                    "quarantineReasons": reasons,
                }
            )
        for t_ms in sorted(own):
            source_user_id = None
            eligible, reasons = gate_example(case, rights, source_user_id, consent_grants)
            examples.append(
                {
                    "formatVersion": FORMAT_VERSION,
                    "exampleId": f"{case_id}@{t_ms:.1f}",
                    "kind": "ownership_frame",
                    "caseId": case_id,
                    "sourceKey": case["sourceKey"],
                    "sessionKey": case["sessionKey"],
                    "role": case["role"],
                    "tMs": t_ms,
                    "media": {
                        "bundleClip": str(clip.relative_to(repo)) if clip.exists() else None,
                        "pixelsCommitted": clip.exists(),
                    },
                    "teacher": None,
                    "ownership": own[t_ms],
                    "rights": rights,
                    "consent": {
                        "sourceUserId": source_user_id,
                        "gate": "third_party_licensed_rights_path",
                    },
                    "trainingEligible": eligible,
                    "quarantineReasons": reasons,
                }
            )

    examples.sort(key=lambda e: (e["caseId"], e["tMs"], e["kind"]))

    out_dir = repo / "datasets/releases" / RELEASE_ID
    out_dir.mkdir(parents=True, exist_ok=True)
    with open(out_dir / "examples.jsonl", "w") as f:
        for e in examples:
            f.write(json.dumps(e, sort_keys=True) + "\n")

    def count(pred):
        return sum(1 for e in examples if pred(e))

    reason_counts: dict[str, int] = {}
    for e in examples:
        for r in e["quarantineReasons"]:
            reason_counts[r] = reason_counts.get(r, 0) + 1
    by_case = {}
    for e in examples:
        c = by_case.setdefault(
            e["caseId"],
            {"total": 0, "trainingEligible": 0, "withTeacher": 0, "withOwnership": 0, "pixelsCommitted": 0},
        )
        c["total"] += 1
        c["trainingEligible"] += int(e["trainingEligible"])
        c["withTeacher"] += int(e["teacher"] is not None)
        c["withOwnership"] += int(e["ownership"] is not None)
        c["pixelsCommitted"] += int(e["media"]["pixelsCommitted"])

    manifest = {
        "formatVersion": FORMAT_VERSION,
        "releaseId": RELEASE_ID,
        "generator": "tools/paddle-lab/distill_export.py",
        "gates": {
            "rights": "corpus rights.train in {yes, yes_with_attribution}; fallback license rule (PD-USGov / CC BY); else quarantined",
            "consent": "C10: sourceUserId!=null requires a model_training grant in the supplied consent export (services/media-worker trainingConsent mirror); absence is never opt-in",
            "splitDiscipline": "role held_out / test_held_out always quarantined from training",
        },
        "counts": {
            "examples": len(examples),
            "trainingEligible": count(lambda e: e["trainingEligible"]),
            "quarantined": count(lambda e: not e["trainingEligible"]),
            "quarantineReasons": reason_counts,
            "firstPartyExamples": count(lambda e: e["consent"]["sourceUserId"] is not None),
            "firstPartyConsentGranted": 0 if not consent_grants else None,
            "withTeacherDetections": count(lambda e: e["teacher"] is not None),
            "withOwnershipOutcome": count(lambda e: e["ownership"] is not None),
            "trainingEligibleWithPixels": count(
                lambda e: e["trainingEligible"] and e["media"]["pixelsCommitted"]
            ),
            "byCase": by_case,
        },
        "attributionObligations": sorted(
            {
                e["rights"]["license"]
                for e in examples
                if e["trainingEligible"] and e["rights"]["train"] == "yes_with_attribution"
            }
        ),
        "splitRule": "by sessionKey (paddle-bench.json splitNote: formal splits by sessionKey begin when training begins)",
        "honestLimits": [
            "wave-a teacher artifacts predate the C01 seek fix; tMs may be one frame (~33ms) early",
            "pixels are committed for 3 bundle clips only; examples without pixelsCommitted are export-only until media is restored",
            "no first-party footage exists yet; the consent gate is wired but exercised by zero examples",
        ],
    }
    with open(out_dir / "manifest.json", "w") as f:
        json.dump(manifest, f, indent=2, sort_keys=True)
        f.write("\n")
    print(json.dumps(manifest["counts"], indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
