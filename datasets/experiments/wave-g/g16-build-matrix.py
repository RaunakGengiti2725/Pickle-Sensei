#!/usr/bin/env python3
"""g16-gen-matrix: build the GENERALIZATION_MATRIX from committed/replayed artifacts.

Inputs (all committed on this branch; Linux replays regenerated at head by this
workstream, Mac artifacts reused as-committed and labeled as such):
  - datasets/ta-bench/results/ta-bench-1787969692752.json (Mac, shipped D-027 variant)
  - datasets/ta-bench/cases.json (slice metadata join)
  - datasets/paddle-bench/results/paddle-bench-1787968828222.json (Mac detector bench)
  - datasets/experiments/wave-g/g16-event-recall-replay.json (Linux replay @ head)
  - datasets/experiments/wave-g/g16-ownership-eval-corrected-replay.json (Linux @ head)
  - datasets/experiments/wave-g/g16-ball-hardslice-replay.json (Linux @ head)
  - datasets/experiments/wave-g/g16-contact-replay.json (Linux @ head)
  - datasets/experiments/wave-g/g16-phase-gold-replay.txt (Linux @ head)
  - datasets/experiments/wave-g/g16-stroke-bench-replay.json (Linux @ head)
  - datasets/experiments/wave-c/c12-envelope-measurements.json (Linux, wave C)
  - datasets/paddle-bench/registry.json (camera/visibility metadata)

HOLD-OUT: wm-dink-01 and afn-vic-rally1 are excluded from every table; no row
derived from them is read or reported. NO percentages without counts.
"""

import json
import re
import subprocess
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
WG = ROOT / "datasets/experiments/wave-g"
HELD_OUT = {"wm-dink-01", "afn-vic-rally1"}

COMMIT = subprocess.run(
    ["git", "rev-parse", "HEAD"], cwd=ROOT, capture_output=True, text=True
).stdout.strip()


def load(p):
    with open(ROOT / p) as f:
        return json.load(f)


def pct(num, den):
    return None if not den else round(num / den, 3)


def slice_row(dimension, name, n, **counts):
    row = {"dimension": dimension, "slice": name, "n": n}
    row.update(counts)
    return row


# Bundle -> session/source metadata, from committed artifacts only:
# paddle-bench.json (wm/afn bundles), g16-contact-replay rows ("session" = source
# grouping) and g16-stroke-bench rows ("group" = corpus sessionKey).
BUNDLE_META = {
    "wm-volley-02": {"source": "wm-pickleball-game", "session": "wm-tournament-2014", "camera": "rear_side_elevated"},
    "afn-sasebo-rally1": {"source": "afn-sasebo-indoor", "session": "afn-sasebo-2025-06", "camera": "front_oblique"},
    "afn-sasebo-rally2": {"source": "afn-sasebo-indoor", "session": "afn-sasebo-2025-06", "camera": "rear"},
    "wavea-944403-dink": {"source": "dvids-944403", "session": "dvids-marne-2024", "camera": None},
    "wavea-944403-smash": {"source": "dvids-944403", "session": "dvids-marne-2024", "camera": None},
    "wavea-faead-feed": {"source": "dvids-faead", "session": "dvids-marne-2024", "camera": None},
    "wavea-faead-rally": {"source": "dvids-faead", "session": "dvids-marne-2024", "camera": None},
    "wavea-marne-dig": {"source": "dvids-marne", "session": "dvids-marne-2024", "camera": None},
    "wavea-marne-serve": {"source": "dvids-marne", "session": "dvids-marne-2024", "camera": None},
    "wavea-sasebo-volleys": {"source": "dvids-sasebo", "session": "afn-sasebo-2025-06", "camera": None},
    "wavea-wgm-wheelchair": {"source": "dvids-wgm", "session": "dvids-warriorgames-2026", "camera": None},
}


def bundle_of(key):
    return key.split("#")[0].split("@")[0]


def agg(rows, keyfn, fields):
    out = defaultdict(lambda: Counter())
    for r in rows:
        k = keyfn(r)
        if k is None:
            continue
        out[k]["n"] += 1
        for f, fn in fields.items():
            if fn(r):
                out[k][f] += 1
    return out


matrix = {"subsystems": {}}

# ---------------------------------------------------------------- TARGET
ta_res = load("datasets/ta-bench/results/ta-bench-1787969692752.json")
ta_cases = {c["caseId"]: c for c in load("datasets/ta-bench/cases.json")["cases"]}
rows = [r for r in ta_res["results"] if ta_cases[r["caseId"]]["caseId"] not in HELD_OUT]
fields = {
    "locked": lambda r: r["outcome"] == "locked",
    "lockCorrect": lambda r: r.get("lockCorrect") is True,
    "silentFailure_lockedWrong": lambda r: r["outcome"] == "locked" and not r.get("lockCorrect"),
    "abstained_noLock": lambda r: r["outcome"] != "locked",
}
slices = []
for dim, keyfn in [
    ("session", lambda r: ta_cases[r["caseId"]]["sessionKey"]),
    ("situation", None),
]:
    if dim == "situation":
        grouped = defaultdict(list)
        for r in rows:
            for s in r.get("situation") or ["none"]:
                grouped[s].append(r)
        for s, rs in sorted(grouped.items()):
            a = agg(rs, lambda r: s, fields)[s]
            slices.append(slice_row(dim, s, a["n"], success=a["lockCorrect"], coverage=a["locked"], abstention=a["abstained_noLock"], silentFailure=a["silentFailure_lockedWrong"]))
    else:
        for k, a in sorted(agg(rows, keyfn, fields).items()):
            slices.append(slice_row(dim, k, a["n"], success=a["lockCorrect"], coverage=a["locked"], abstention=a["abstained_noLock"], silentFailure=a["silentFailure_lockedWrong"]))
overall = agg(rows, lambda r: "all", fields)["all"]
meaningful = [s for s in slices if s["n"] >= 3]
worst = min(meaningful, key=lambda s: (s["success"] / s["n"]))
matrix["subsystems"]["TARGET"] = {
    "provenance": "COMMITTED Mac ta-bench replay (ta-bench-1787969692752.json, shipped D-027 variant, 2026-08-29); NOT re-run on Linux (run dirs absent — f16 TARGET coverage proof).",
    "harness": "ta-replay-2, scope: 54 verified dev cases (locked_test excluded by the bench; held-out bundles not part of ta-bench)",
    "grouping": "independent unit = recordingId/sessionKey; slices join datasets/ta-bench/cases.json",
    "overall": {"n": overall["n"], "success_lockCorrect": overall["lockCorrect"], "coverage_locked": overall["locked"], "abstention_noLock": overall["abstained_noLock"], "silentFailure_lockedWrong": overall["silentFailure_lockedWrong"]},
    "calibration": "TA ECE .121 (n=12, agreement proxy, wave-c/c11-coverage-risk.json — proxy, not true-label calibration)",
    "slices": slices,
    "worstMeaningfulSlice": worst,
}

# ---------------------------------------------------------------- EVENT
ev = load("datasets/experiments/wave-g/g16-event-recall-replay.json")
ev_rows = [r for r in ev["eventRows"] if bundle_of(r["eventKey"]) not in HELD_OUT]
fields = {
    "proposedOk": lambda r: r["outcome"] == "PROPOSED_OK",
    "misBounded": lambda r: r["outcome"] == "MIS_BOUNDED",
    "missed": lambda r: r["outcome"] == "MISSED",
}
slices = []
for dim, keyfn in [
    ("bundle", lambda r: bundle_of(r["eventKey"])),
    ("session", lambda r: BUNDLE_META[bundle_of(r["eventKey"])]["session"]),
    ("source", lambda r: BUNDLE_META[bundle_of(r["eventKey"])]["source"]),
]:
    for k, a in sorted(agg(ev_rows, keyfn, fields).items()):
        slices.append(slice_row(dim, k, a["n"], success=a["proposedOk"], silentFailure_misBounded=a["misBounded"], missed=a["missed"]))
overall = agg(ev_rows, lambda r: "all", fields)["all"]
meaningful = [s for s in slices if s["n"] >= 3]
worst = min(meaningful, key=lambda s: s["success"] / s["n"])
matrix["subsystems"]["EVENT"] = {
    "provenance": "Linux replay at HEAD (" + COMMIT[:7] + "), eventRecallBench.ts (e01/f06 harness) — g16-event-recall-replay.json",
    "harness": "proposal recall on committed dev gold event spans; false-proposal check over explicit non-event spans",
    "grouping": "independent unit = bundle -> source/session (BUNDLE_META from committed artifacts)",
    "overall": {"n": overall["n"], "success_proposedOk": overall["proposedOk"], "silentFailure_misBounded": overall["misBounded"], "missed": overall["missed"], "falseProposalsInNonEventSpans": ev["summary"]["falseInNonEvent"], "nonEventSpans": ev["summary"]["nonEventSpans"]},
    "calibration": "not applicable (proposals carry no calibrated confidence)",
    "slices": slices,
    "worstMeaningfulSlice": worst,
}

# ---------------------------------------------------------------- PADDLE (detector, Mac committed)
pb = load("datasets/paddle-bench/results/paddle-bench-1787968828222.json")
p_rows = [r for r in pb["results"] if r["caseId"] not in HELD_OUT]
slices = []
for r in p_rows:
    meta = BUNDLE_META.get(r["caseId"], {})
    slices.append({
        "dimension": "bundle", "slice": r["caseId"], "session": meta.get("session"),
        "n_labeledFrames": r["labeledFrames"], "n_visibleFrames": r["visibleFrames"],
        "success_hits": r["hits"], "misses": r["misses"],
        "silentFailure_wrongLocation": r["wrongLocation"], "falsePositives": r["falsePositives"],
    })
tot = Counter()
for r in p_rows:
    for k in ("labeledFrames", "visibleFrames", "hits", "misses", "wrongLocation", "falsePositives"):
        tot[k] += r[k]
worst = min([s for s in slices if s["n_visibleFrames"] >= 3], key=lambda s: s["success_hits"] / s["n_visibleFrames"])
matrix["subsystems"]["PADDLE"] = {
    "provenance": "COMMITTED Mac paddle-bench result (paddle-bench-1787968828222.json); paddle detection NOT replayable on Linux (runs/ gitignored, Mac-only — f16 forensics). Held-out rows present in the committed file were EXCLUDED unread beyond caseId.",
    "harness": "paddle-bench frame-level detector scoring on human center-point gold",
    "grouping": "independent unit = bundle (5 dev bundles from 2 sources)",
    "overall": {"n_labeledFrames": tot["labeledFrames"], "n_visibleFrames": tot["visibleFrames"], "success_hits": tot["hits"], "misses": tot["misses"], "silentFailure_wrongLocation": tot["wrongLocation"], "falsePositives": tot["falsePositives"]},
    "calibration": "not available in this artifact",
    "slices": slices,
    "worstMeaningfulSlice": worst,
    "ownershipProxy": None,  # filled below
}

own = load("datasets/experiments/wave-g/g16-ownership-eval-corrected-replay.json")
inc = own["methods"][0]
inc_pose = own["poseSubsetMethods"][0]
own_slices = []
for dim, table in [("difficultyBucket", inc["byBucket"]), ("sessionGroup", inc["byGroup"])]:
    for k, v in sorted(table.items()):
        own_slices.append(slice_row(dim, k, v["n"], success=v["correct"], abstention=v["abstained"], silentFailure_wrongAnswer=v["n"] - v["correct"] - v["abstained"]))
worst_own = min([s for s in own_slices if s["n"] >= 3 and (s["n"] - s["abstention"]) > 0], key=lambda s: s["success"] / s["n"])
matrix["subsystems"]["PADDLE"]["ownershipProxy"] = {
    "provenance": "Linux replay at HEAD, ownershipBench.ts --apply-corrections (g16-ownership-eval-corrected-replay.json)",
    "method": inc["method"],
    "overall": {"n": inc["scoredFrames"], "success": inc["correct"], "abstention": inc["abstained"], "silentFailure_wrongAnswer": inc["scoredFrames"] - inc["correct"] - inc["abstained"]},
    "poseSubset": {"n": inc_pose["scoredFrames"], "success": inc_pose["correct"], "abstention": inc_pose["abstained"]},
    "calibration": "ownership ECE .098 (n=31, agreement proxy, wave-c/c11-coverage-risk.json)",
    "slices": own_slices,
    "worstMeaningfulSlice": worst_own,
}

# ---------------------------------------------------------------- BALL
ball = load("datasets/experiments/wave-g/g16-ball-hardslice-replay.json")
slices = []
for b in ball["aggregate"]:
    n_scored = b["hits"] + b["misses"] + b["wrongLocation"] + b["abstained"]
    slices.append(slice_row("occlusionBucket", b["bucket"], b["n"], success=b["hits"], missed=b["misses"], silentFailure_wrongLocation=b["wrongLocation"], abstention=b["abstained"], violations=b["violations"]))
for s in ball["slices"]:
    slices.append(slice_row("hardSliceType", s["slice"], s["n"], success=s["hits"], missed=s["misses"], silentFailure_wrongLocation=s["wrongLocation"], abstention=s["abstained"], violations=s["violations"], excluded=s["excluded"]))
for bundle in ("wm-volley-02", "afn-sasebo-rally2", "wavea-wgm-wheelchair", "wavea-sasebo-volleys"):
    bd = ball[bundle]
    t = Counter()
    for b in bd["buckets"]:
        for k in ("n", "hits", "misses", "wrongLocation", "abstained"):
            t[k] += b[k]
    slices.append(slice_row("bundle", bundle, t["n"], success=t["hits"], missed=t["misses"], silentFailure_wrongLocation=t["wrongLocation"], abstention=t["abstained"], violations=len(bd["violations"])))
overall = Counter()
for b in ball["aggregate"]:
    for k in ("n", "hits", "misses", "wrongLocation", "abstained", "violations"):
        overall[k] += b[k]
meaningful = [s for s in slices if s["n"] >= 3 and s["slice"] not in ("UNCERTAIN_EXCLUDED",)]
worst = min(meaningful, key=lambda s: s["success"] / s["n"])
matrix["subsystems"]["BALL"] = {
    "provenance": "Linux replay at HEAD, ballHardSliceEval.ts over committed Linux-regenerated motion candidates, D2-06 hard-slice gold (g16-ball-hardslice-replay.json)",
    "harness": "real tracker on hard-slice gold ONLY (43 labels); NOT the full 103-frame ball gold (most bundles lack committed motion candidates on Linux)",
    "grouping": "independent unit = bundle (4 bundles, 3 sources)",
    "overall": {"n": overall["n"], "success_hits": overall["hits"], "missed": overall["misses"], "silentFailure_wrongLocation": overall["wrongLocation"], "abstention": overall["abstained"], "abstentionViolations": overall["violations"]},
    "calibration": "not available (tracker observations carry no calibrated confidence in this harness)",
    "slices": slices,
    "worstMeaningfulSlice": worst,
}

# ---------------------------------------------------------------- CONTACT
con = load("datasets/experiments/wave-g/g16-contact-replay.json")
c_rows = [r for r in con["rows"] if r["bundle"] not in HELD_OUT]
ACCEPTABLE_MS = 132  # harness's acceptable-hit bound (f16/e02 convention)
fields = {
    "estimated": lambda r: r["status"] == "estimated",
    "abstained": lambda r: r["status"] != "estimated",
    "acceptable": lambda r: r["status"] == "estimated" and r["errorMs"] is not None and r["errorMs"] <= ACCEPTABLE_MS,
    "silentFailure_wrongMarker": lambda r: r["status"] == "estimated" and r["errorMs"] is not None and r["errorMs"] > ACCEPTABLE_MS,
}
slices = []
for dim, keyfn in [
    ("source", lambda r: r["session"]),
    ("bundle", lambda r: r["bundle"]),
    ("owner", lambda r: r["owner"]),
    ("strokeFamily", lambda r: r["family"]),
]:
    for k, a in sorted(agg(c_rows, keyfn, fields).items()):
        slices.append(slice_row(dim, k, a["n"], success=a["acceptable"], coverage=a["estimated"], abstention=a["abstained"], silentFailure=a["silentFailure_wrongMarker"]))
overall = agg(c_rows, lambda r: "all", fields)["all"]
errs = sorted(r["errorMs"] for r in c_rows if r["status"] == "estimated" and r["errorMs"] is not None)
conf_rows = [r for r in c_rows if r["status"] == "estimated" and r.get("confidence") is not None]
calib = []
for lo, hi in [(0.0, 0.55), (0.55, 0.7), (0.7, 1.01)]:
    bucket = [r for r in conf_rows if lo <= r["confidence"] < hi]
    calib.append({"confidenceBin": f"[{lo},{hi})", "n": len(bucket), "acceptable": sum(1 for r in bucket if r["errorMs"] <= ACCEPTABLE_MS)})
meaningful = [s for s in slices if s["n"] >= 3]
worst = min(meaningful, key=lambda s: s["success"] / s["n"])
matrix["subsystems"]["CONTACT"] = {
    "provenance": "Linux replay at HEAD, e02 contactGoldReplay via assertion-free wrapper (g16-contact-replay.json); estimator " + con["estimatorVersion"],
    "harness": "committed windowed pose + ORACLE gold ball, paddle=null (production also sees paddle track) — NOT canonical cascade",
    "grouping": "independent unit = bundle -> source ('session' field in rows is the source grouping)",
    "overall": {"n": overall["n"], "success_acceptable<=132ms": overall["acceptable"], "coverage_estimated": overall["estimated"], "abstention": overall["abstained"], "silentFailure_wrongMarker>132ms": overall["silentFailure_wrongMarker"], "medianErrorMsOfEstimated": errs[len(errs) // 2] if errs else None},
    "calibration": {"note": "confidence-bin acceptable counts over estimated rows (tiny n — indicative only)", "bins": calib},
    "slices": slices,
    "worstMeaningfulSlice": worst,
}

# ---------------------------------------------------------------- PHASE
phase_lines = (WG / "g16-phase-gold-replay.txt").read_text().splitlines()
p_rows = []
for ln in phase_lines:
    m = re.match(r"^(\S+)@(\d+) (anchored|anchor-free): (segmented|abstained)(.*)$", ln)
    if m and m.group(1) not in HELD_OUT:
        p_rows.append({"bundle": m.group(1), "tMs": int(m.group(2)), "mode": m.group(3), "result": m.group(4), "reason": m.group(5).strip()})
slices = []
for mode in ("anchored", "anchor-free"):
    mrows = [r for r in p_rows if r["mode"] == mode]
    fields = {"segmented": lambda r: r["result"] == "segmented", "abstained": lambda r: r["result"] == "abstained"}
    for dim, keyfn in [("bundle", lambda r: r["bundle"]), ("session", lambda r: BUNDLE_META[r["bundle"]]["session"])]:
        for k, a in sorted(agg(mrows, keyfn, fields).items()):
            slices.append(slice_row(f"{mode}/{dim}", k, a["n"], coverage_segmented=a["segmented"], abstention=a["abstained"]))
    overall = agg(mrows, lambda r: "all", fields)["all"]
    slices.append(slice_row(f"{mode}/overall", "all", overall["n"], coverage_segmented=overall["segmented"], abstention=overall["abstained"]))
meaningful = [s for s in slices if s["n"] >= 3 and s["slice"] != "all"]
worst = min(meaningful, key=lambda s: s["coverage_segmented"] / s["n"])
matrix["subsystems"]["PHASE"] = {
    "provenance": "Linux replay at HEAD, d3-05-measure-gold.ts unmodified (g16-phase-gold-replay.txt)",
    "harness": "anchored + anchor-free segmentation over committed wave-a gold phase events",
    "grouping": "independent unit = bundle -> session",
    "overall": "see anchored/overall and anchor-free/overall slice rows (segmentation coverage only — per-boundary correctness vs gold is NOT scored by this harness, so success/silent-failure are NOT measurable here; disclosed)",
    "calibration": "not applicable",
    "slices": slices,
    "worstMeaningfulSlice": worst,
}

# ---------------------------------------------------------------- STROKE
st = load("datasets/experiments/wave-g/g16-stroke-bench-replay.json")


def stroke_slice(dim, k, v):
    return slice_row(dim, k, v["n"], success_l1=v["l1Correct"], wrong_l1=v["l1Wrong"], abstention_l1=v["l1Abstained"], goldUnknown_l1=v["l1GoldUnknown"], silentFailure_confidentlyWrong=v["confidentlyWrong"], success_l2=v["l2Correct"], wrong_l2=v["l2Wrong"])


slices = []
for dim, table in [("sessionGroup", st["byGroup"]), ("owner", st["byOwner"]), ("goldStrokeFamily", st["byGoldFamily"]), ("case", st["byCase"])]:
    for k, v in sorted(table.items()):
        slices.append(stroke_slice(dim, k, v))
o = st["overall"]
meaningful = [s for s in slices if s["n"] >= 3 and s["dimension"] in ("sessionGroup", "owner", "goldStrokeFamily")]
worst = min(meaningful, key=lambda s: s["success_l1"] / s["n"])
matrix["subsystems"]["STROKE"] = {
    "provenance": "Linux replay at HEAD (stroke-heuristic-6 at " + COMMIT[:7] + "), strokeHeuristicBench (g16-stroke-bench-replay.json). NOTE: differs from f16 (heuristic-4): L1 correct 9->5, abstained 8->12, confidentlyWrong 3->2 — the post-Wave-F abstention gates' coverage cost, measured.",
    "harness": "committed stroke gold (29 labels / evaluable " + str(st["evaluableLabels"]) + " on this box); L1 = OVERHEAD-vs-SWING claimable class",
    "grouping": "independent unit = corpus sessionKey (all dvids-marne recordings share one group — harness disclosure)",
    "overall": {"n": o["n"], "success_l1": o["l1Correct"], "wrong_l1": o["l1Wrong"], "abstention_l1": o["l1Abstained"], "goldUnknown_l1": o["l1GoldUnknown"], "silentFailure_confidentlyWrong": o["confidentlyWrong"], "success_l2": o["l2Correct"], "wrong_l2": o["l2Wrong"]},
    "calibration": "not available (bench rows carry labels, not calibrated probabilities)",
    "slices": slices,
    "worstMeaningfulSlice": worst,
}

# ---------------------------------------------------------------- CAPTURE ENVELOPE
env = load("datasets/experiments/wave-c/c12-envelope-measurements.json")
env_rows = [p for p in env["perClip"] if p["caseId"] not in HELD_OUT]
slices = []
for p in env_rows:
    dims = p["verdict"]["dimensions"]
    slices.append({
        "dimension": "clip", "slice": p["caseId"],
        "n_dimensionsChecked": len(dims),
        "supported": sum(1 for d in dims if d["status"] == "SUPPORTED"),
        "unsupported": sum(1 for d in dims if d["status"] not in ("SUPPORTED", "NOT_MEASURED")),
        "notMeasured": sum(1 for d in dims if d["status"] == "NOT_MEASURED"),
    })
matrix["subsystems"]["CAPTURE_ENVELOPE"] = {
    "provenance": "COMMITTED wave-c c12-envelope-measurements.json (Linux, ffprobe/ffmpeg proxies); thresholds capture-envelope-thresholds-v0.1-provisional",
    "harness": "envelope checker over committed bundle clips — only " + str(len(env_rows)) + " non-held-out clip(s) have committed media; 10 bundles have annotations only",
    "grouping": "independent unit = clip",
    "overall": {"n_clipsMeasurable": len(env_rows), "n_bundlesWithoutCommittedMedia": len(env["missingClips"])},
    "calibration": "NOT VALID: threshold validation failed twice (e15, f18 — preserved scientific negatives); f22 pinned 8 KNOWN-GAP bypasses. Verdict columns are v0.1-provisional hypotheses, not truth.",
    "slices": slices,
    "worstMeaningfulSlice": {"note": "no meaningful slice: n=" + str(len(env_rows)) + " clips with no validated ground truth — the envelope subsystem's generalization is UNMEASURED; this row is a coverage gap, not a pass"},
}

# ---------------------------------------------------------------- AUTO DETECT
matrix["subsystems"]["AUTO_DETECT"] = {
    "provenance": "wave-a D-summary.json / wave-b W4 (fixture-level); no replayable per-slice measured dataset exists on this box",
    "harness": "NONE REPLAYABLE: AUTO DETECT (declaredStroke=null routing) is validated by fixture tests only; end-to-end runs require Mac run dirs",
    "grouping": "n/a",
    "overall": {"n": 0},
    "calibration": "not applicable",
    "slices": [],
    "worstMeaningfulSlice": {"note": "N=0 measured slices — AUTO DETECT generalization is UNMEASURED on existing labeled/replayable data. This is the honest answer, not a pass."},
}

# ---------------------------------------------------------------- meta
matrix_meta = {
    "workstreamId": "g16-gen-matrix",
    "title": "GENERALIZATION_MATRIX: subsystem x slice coverage/success/abstention/silent-failure with counts",
    "commit": COMMIT,
    "generatedBy": "datasets/experiments/wave-g/g16-build-matrix.py",
    "environment": "Linux Ubuntu, Node 20.18.1, pnpm 10.15.1, LINUX-CPU (no Apple Vision, no Mac, no iPhone)",
    "holdoutStatement": "Held-out cases wm-dink-01 and afn-vic-rally1 were never read; every row derived from them (in committed Mac artifacts and c12) was excluded by caseId before any metric was computed. The fresh-candidate pool was untouched.",
    "measurementBoundary": "TARGET and PADDLE(detector) tables reuse COMMITTED Mac artifacts (not re-run); EVENT/OWNERSHIP/BALL/CONTACT/PHASE/STROKE were re-replayed on Linux at this commit; CAPTURE_ENVELOPE reuses committed wave-c measurements; AUTO_DETECT has no replayable measured data. Nothing here is the canonical Mac strict cascade; cross-stage survival conditioning is NOT measured.",
    "sliceDimensionsAvailable": ["source", "session", "bundle/case", "owner (target vs other player attribution)", "stroke family (contact/stroke gold)", "occlusion bucket (ball)", "hard-slice type (ball)", "difficulty bucket (ownership: clean/dark_on_dark/blur/net_post_occlusion/multi_paddle/edge_on)", "situation tags (TA: multi_player, ...)", "camera position (registry-backed bundles only)"],
    "sliceDimensionsNotAvailable": {"player identity": "no cross-bundle player IDs exist; 'owner' (target/other) is the only player-level split", "player apparent scale": "pose-derived pixel height is Mac-only (c12 reports it NOT_MEASURED); free-text registry descriptions were not converted into invented categories", "lighting": "only free-text registry/annotation descriptions; no committed categorical labels", "number of players": "free-text only", "paddle visibility / ball visibility as capture-level slices": "free-text registry descriptions only; frame-level visibility IS covered via ball occlusion buckets and paddle visibleFrames counts"},
    "noPercentagesWithoutCounts": "every rate in this artifact is accompanied by its numerator and denominator counts",
}

out = {"meta": matrix_meta, **matrix}
with open(WG / "g16-generalization-matrix.json", "w") as f:
    json.dump(out, f, indent=2)
    f.write("\n")

# ---------------------------------------------------------------- markdown
def fmt_slice_table(sub):
    rows = sub["slices"]
    if not rows:
        return "_no measurable slices_\n"
    keys = []
    for r in rows:
        for k in r:
            if k not in keys:
                keys.append(k)
    md = "| " + " | ".join(keys) + " |\n|" + "---|" * len(keys) + "\n"
    for r in rows:
        md += "| " + " | ".join(str(r.get(k, "")) for k in keys) + " |\n"
    return md


md = ["# g16 GENERALIZATION_MATRIX (Wave G, Linux, commit " + COMMIT[:7] + ")\n",
      "Machine-readable version: `g16-generalization-matrix.json` (same directory).\n",
      "**Hold-out:** " + matrix_meta["holdoutStatement"] + "\n",
      "**Boundary:** " + matrix_meta["measurementBoundary"] + "\n",
      "**Slices not available (honest gaps):** " + "; ".join(f"{k} — {v}" for k, v in matrix_meta["sliceDimensionsNotAvailable"].items()) + "\n"]
for name, sub in matrix["subsystems"].items():
    md.append(f"\n## {name}\n")
    md.append(f"- provenance: {sub['provenance']}")
    md.append(f"- harness: {sub['harness']}")
    md.append(f"- grouping: {sub['grouping']}")
    md.append(f"- overall: `{json.dumps(sub['overall'])}`")
    md.append(f"- calibration: {json.dumps(sub['calibration']) if not isinstance(sub['calibration'], str) else sub['calibration']}")
    md.append(f"- **worst meaningful slice**: `{json.dumps(sub['worstMeaningfulSlice'])}`\n")
    md.append(fmt_slice_table(sub))
    if name == "PADDLE" and sub.get("ownershipProxy"):
        op = sub["ownershipProxy"]
        md.append("\n### PADDLE ownership proxy (Linux replay)\n")
        md.append(f"- overall: `{json.dumps(op['overall'])}` · pose subset: `{json.dumps(op['poseSubset'])}`")
        md.append(f"- calibration: {op['calibration']}")
        md.append(f"- **worst meaningful slice**: `{json.dumps(op['worstMeaningfulSlice'])}`\n")
        md.append(fmt_slice_table(op))
(WG / "g16-generalization-matrix.md").write_text("\n".join(md) + "\n")
print("written: g16-generalization-matrix.json + .md")
for name, sub in matrix["subsystems"].items():
    print(name, "worst:", json.dumps(sub["worstMeaningfulSlice"])[:160])
