"""Wave-A workstream H: full-pipeline comparison of the D-032 shortlist
(paddle detector stride 3 + target ROI) against the canonical stride-1
full-frame baseline, on the 3 DEV cases only.

Reads (read-only): canonical run dirs (datasets/paddle-bench/runs/<case>),
gold annotations (dev cases), candidate sandbox dirs
(datasets/experiments/wave-a/H-runs/<case>), and baseline timing re-runs
(/tmp/h-baseline/<case>.json when present).

Writes: datasets/experiments/wave-a/H-downstream.json and H-timing.json.

Conventions:
  - S0/S5 scoring uses the paddle-waterfall convention (hit radius 0.08
    normalized, label match tolerance +/-40ms) so numbers line up with
    EXP-2026-08-28-paddle-waterfall.json.
  - The D-032 grid convention (radius 0.05, stride-aware reach: a label with
    no detector frame within half a stride interval counts as a miss) is
    ALSO reported for S0 so numbers line up with the shortlist experiment.
  - Cascade stage criteria replicate packages/swing-lab/src/cascadeWaterfall.ts
    verbatim (TARGET/EVENT/PADDLE/BALL/CONTACT/PHASE/STROKE).

Usage: .venv/bin/python h_fullpipe_compare.py
"""

from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PB = ROOT / "datasets/paddle-bench"
HRUNS = ROOT / "datasets/experiments/wave-a/H-runs"
OUT_DIR = ROOT / "datasets/experiments/wave-a"
BASELINE_TIMING_DIR = Path("/tmp/h-baseline")

DEV_CASES = ["wm-volley-02", "afn-sasebo-rally1", "afn-sasebo-rally2"]

HIT_RADIUS = 0.08          # paddle-waterfall convention
MATCH_TOLERANCE_MS = 40    # paddle-waterfall convention
GRID_HIT_RADIUS = 0.05     # D-032 grid convention


def load(path: Path):
    return json.loads(path.read_text())


def dets_centers(dets: dict) -> list[dict]:
    width, height = dets["video"]["width"], dets["video"]["height"]
    out = []
    for frame in dets["frames"]:
        for det in frame["detections"]:
            out.append({
                "tMs": frame["tMs"],
                "x": (det["box"][0] + det["box"][2]) / 2 / width,
                "y": (det["box"][1] + det["box"][3]) / 2 / height,
            })
    return out


def debug_paddle_centers(debug: dict) -> list[dict]:
    paddle = debug.get("paddle")
    if not paddle:
        return []
    return [
        {"tMs": o["t"], "x": o["x"] + o["w"] / 2, "y": o["y"] + o["h"] / 2}
        for o in paddle.get("observations", [])
    ]


def score_stage(labels: list[dict], centers: list[dict]) -> dict:
    """paddleWaterfall.ts score(): P/R over visible labels, radius 0.08, ±40ms."""
    hits = visible = claims = 0
    for label in labels:
        near = [c for c in centers if abs(c["tMs"] - label["tMs"]) <= MATCH_TOLERANCE_MS]
        if label["visibility"] == "visible" and label.get("point"):
            visible += 1
            if near:
                claims += 1
                best = min(
                    ((c["x"] - label["point"]["x"]) ** 2 + (c["y"] - label["point"]["y"]) ** 2) ** 0.5
                    for c in near
                )
                if best <= HIT_RADIUS:
                    hits += 1
        elif near:
            claims += 1
    return {
        "hits": hits,
        "visible": visible,
        "claims": claims,
        "recall": round(hits / visible, 3) if visible else None,
        "precision": round(hits / claims, 3) if claims else None,
    }


def score_s0_grid_convention(dets: dict, labels: list[dict], stride: int, fps: float) -> dict:
    """roi_keyframe_grid.py score_cell(): radius 0.05, stride-aware reach."""
    width, height = dets["video"]["width"], dets["video"]["height"]
    frames = dets["frames"]
    visible = [f for f in labels if f["visibility"] == "visible" and f.get("point")]
    reach_ms = (stride / fps) * 1000 / 2 + 1
    hits = 0
    reachable = 0
    for label in visible:
        nearest = min(frames, key=lambda fr: abs(fr["tMs"] - label["tMs"]), default=None)
        if nearest is None or abs(nearest["tMs"] - label["tMs"]) > reach_ms:
            continue
        reachable += 1
        for det in nearest["detections"]:
            cx = (det["box"][0] + det["box"][2]) / 2 / width
            cy = (det["box"][1] + det["box"][3]) / 2 / height
            d = ((cx - label["point"]["x"]) ** 2 + (cy - label["point"]["y"]) ** 2) ** 0.5
            if d <= GRID_HIT_RADIUS:
                hits += 1
                break
    return {
        "labeledVisible": len(visible),
        "labelsWithDetectorFrame": reachable,
        "hits": hits,
        "recallVsAllLabels": round(hits / len(visible), 3) if visible else None,
    }


def cascade_stages(report: dict, gold_event: dict | None, gold_stroke: str | None) -> dict:
    """Replicates cascadeWaterfall.ts stage criteria verbatim."""
    stages: dict[str, dict] = {}
    player = report.get("player")
    stages["TARGET"] = {
        "pass": bool(player) and (player.get("targetCoverage") or 0) >= 0.5,
        "detail": f"coverage {(player.get('targetCoverage') or 0):.2f}" if player else "no player identity",
    }
    te = report.get("targetEvent") or {}
    selected = te.get("event")
    if gold_event and te.get("status") == "selected" and selected:
        overlap = max(0, min(selected["endMs"], gold_event["eventEndMs"]) - max(selected["startMs"], gold_event["eventStartMs"]))
        gold_span = gold_event["eventEndMs"] - gold_event["eventStartMs"]
        contact_inside = gold_event.get("contactMs") is not None and selected["startMs"] <= gold_event["contactMs"] <= selected["endMs"]
        stages["EVENT"] = {
            "pass": overlap / gold_span >= 0.5 or contact_inside,
            "detail": f"selected {round(selected['startMs'])}-{round(selected['endMs'])} vs gold {gold_event['eventStartMs']}-{gold_event['eventEndMs']} (overlap {overlap / gold_span * 100:.0f}%{', contact inside' if contact_inside else ''})",
        }
    else:
        stages["EVENT"] = {"pass": False, "detail": f"targetEvent status {te.get('status', 'missing')}"}
    paddle = report.get("paddle") or {}
    stages["PADDLE"] = {
        "pass": paddle.get("status") == "tracked" and (paddle.get("windowCoverage") or 0) >= 0.3,
        "detail": f"status {paddle.get('status', 'missing')} · coverage {(paddle.get('windowCoverage') or 0):.2f}",
    }
    ball = report.get("ballStage") or {}
    stages["BALL"] = {"pass": ball.get("status") == "tracked", "detail": f"status {ball.get('status', 'missing')}"}
    contact = report.get("contact") or {}
    gold_contact = gold_event.get("contactMs") if gold_event else None
    if contact.get("status") == "estimated" and contact.get("estimatedContactMs") is not None and gold_contact is not None:
        error = abs(contact["estimatedContactMs"] - gold_contact)
        stages["CONTACT"] = {"pass": error <= 66, "detail": f"error {round(error)}ms (est {round(contact['estimatedContactMs'])} vs gold {gold_contact})"}
    else:
        stages["CONTACT"] = {"pass": False, "detail": f"status {contact.get('status', 'missing')}"}
    phases = report.get("temporalPhasesV2") or {}
    if phases.get("status") == "segmented":
        b = phases.get("boundaries") or {}
        ordering = b.get("followThroughEndMs") is None or b.get("contactMs") is None or b["followThroughEndMs"] > b["contactMs"]
        stages["PHASE"] = {"pass": ordering, "detail": "segmented, ordering valid" if ordering else "followEnd <= contact"}
    else:
        stages["PHASE"] = {"pass": False, "detail": f"status {phases.get('status', 'missing')}"}
    predicted = (report.get("strokePrediction") or {}).get("label")
    if gold_stroke and predicted:
        side = lambda s: "BACKHAND" if "BACKHAND" in s else ("FOREHAND" if "FOREHAND" in s else s)
        stages["STROKE"] = {"pass": side(predicted) == side(gold_stroke), "detail": f"predicted {predicted} vs gold {gold_stroke}"}
    else:
        stages["STROKE"] = {"pass": False, "detail": f"predicted {predicted or 'none'} vs gold {gold_stroke or 'unlabeled'}"}
    order = ["TARGET", "EVENT", "PADDLE", "BALL", "CONTACT", "PHASE", "STROKE"]
    reached = "COMPLETE"
    for name in order:
        if not stages[name]["pass"]:
            reached = f"LOST AT {name}"
            break
    return {"stages": stages, "conditionalReached": reached}


def event_proposals(report: dict) -> list[dict]:
    events = (report.get("events") or {}).get("proposals") or []
    return [
        {"eventId": e["eventId"], "startMs": round(e["startMs"], 1), "endMs": round(e["endMs"], 1),
         "peakMs": round(e["peakMs"], 1), "source": e.get("source")}
        for e in events
    ]


def summarize_report(report: dict, gold_contact: int | None) -> dict:
    paddle = report.get("paddle") or {}
    contact = report.get("contact") or {}
    te = report.get("targetEvent") or {}
    contact_ms = contact.get("estimatedContactMs") if contact.get("status") == "estimated" else None
    return {
        "outcome": (report.get("outcome") or {}).get("kind"),
        "detectSpan": report.get("detectSpan"),
        "paddle": {
            "status": paddle.get("status"),
            "reason": paddle.get("reason"),
            "trackId": paddle.get("trackId"),
            "observationCount": paddle.get("observationCount"),
            "windowCoverage": paddle.get("windowCoverage"),
            "meanDetectorScore": paddle.get("meanDetectorScore"),
            "meanWristDistance": paddle.get("meanWristDistance"),
            "candidateTracks": paddle.get("candidateTracks"),
        },
        "ballStage": {k: (report.get("ballStage") or {}).get(k) for k in ("status", "reason", "observationCount", "windowOverlapMs")},
        "contact": {
            "status": contact.get("status"),
            "estimatedContactMs": contact_ms,
            "confidence": contact.get("confidence"),
            "ballConfirmed": contact.get("ballConfirmed"),
            "paddleConfirmed": contact.get("paddleConfirmed"),
            "reason": contact.get("reason"),
            "errorVsGoldMs": (round(abs(contact_ms - gold_contact), 1) if (contact_ms is not None and gold_contact is not None) else None),
        },
        "targetEvent": {
            "status": te.get("status"),
            "eventId": (te.get("event") or {}).get("eventId"),
            "reason": te.get("reason"),
        },
        "temporalPhasesV2": {"status": (report.get("temporalPhasesV2") or {}).get("status"),
                              "reason": (report.get("temporalPhasesV2") or {}).get("reason")},
        "strokePrediction": {
            "label": (report.get("strokePrediction") or {}).get("label"),
            "confidence": (report.get("strokePrediction") or {}).get("confidence"),
        } if report.get("strokePrediction") else None,
        "eventProposals": event_proposals(report),
    }


def main() -> None:
    downstream = {}
    timing = {}
    for case in DEV_CASES:
        canon_dir = PB / "runs" / case
        cand_dir = HRUNS / case
        annotation = load(PB / "bundles" / case / "annotation" / "devin-visual-v1.json")
        labels = annotation.get("paddleFrames", [])
        gold_event = next((e for e in annotation.get("eventLabels", []) if e.get("owner") == "target"), None)
        gold_stroke = annotation.get("annotatedStrokeV3")
        gold_contact = gold_event.get("contactMs") if gold_event else None

        canon_report = load(canon_dir / "report.json")
        cand_report = load(cand_dir / "report.json")
        canon_dets = load(canon_dir / "paddle-dets.json")
        cand_dets = load(cand_dir / "paddle-dets.json")
        canon_debug = load(canon_dir / "debug.json")
        cand_debug = load(cand_dir / "debug.json")
        fps = canon_dets["video"]["fps"]

        base_events = event_proposals(canon_report)
        cand_events = event_proposals(cand_report)
        bounds = lambda evs: [(e["eventId"], e["startMs"], e["endMs"]) for e in evs]
        peaks = lambda evs: {e["eventId"]: e["peakMs"] for e in evs}
        peak_deltas = {
            eid: round(peaks(cand_events)[eid] - peaks(base_events)[eid], 1)
            for eid in peaks(base_events)
            if eid in peaks(cand_events) and peaks(cand_events)[eid] != peaks(base_events)[eid]
        }

        downstream[case] = {
            "goldContactMs": gold_contact,
            "goldStroke": gold_stroke,
            "labels": {"paddleFrames": len(labels),
                        "visible": sum(1 for l in labels if l["visibility"] == "visible" and l.get("point"))},
            "baseline": summarize_report(canon_report, gold_contact),
            "candidate": summarize_report(cand_report, gold_contact),
            "eventSetComparison": {
                "identicalBounds": bounds(base_events) == bounds(cand_events),
                "identicalIncludingPeaks": base_events == cand_events,
                "peakDeltasMs": peak_deltas,
            },
            "waterfall": {
                "S0_rawDetector": {
                    "baseline": score_stage(labels, dets_centers(canon_dets)),
                    "candidate": score_stage(labels, dets_centers(cand_dets)),
                },
                "S5_finalPaddleTrack": {
                    "baseline": score_stage(labels, debug_paddle_centers(canon_debug)),
                    "candidate": score_stage(labels, debug_paddle_centers(cand_debug)),
                },
                "S0_gridConvention": {
                    "baseline": score_s0_grid_convention(canon_dets, labels, canon_dets["detector"].get("stride", 1), fps),
                    "candidate": score_s0_grid_convention(cand_dets, labels, cand_dets["detector"].get("stride", 1), fps),
                },
            },
            "cascade": {
                "baseline": cascade_stages(canon_report, gold_event, gold_stroke),
                "candidate": cascade_stages(cand_report, gold_event, gold_stroke),
            },
        }

        entry = {
            "window": cand_dets["window"],
            "roiNorm": cand_dets["detector"].get("roiNorm"),
            "stride": cand_dets["detector"].get("stride"),
            "canonicalRecorded_stride1_full": canon_dets["timing"],
            "candidate_stride3_roi": cand_dets["timing"],
        }
        baseline_rerun = BASELINE_TIMING_DIR / f"{case}.json"
        if baseline_rerun.exists():
            entry["baselineRerun_stride1_full"] = load(baseline_rerun)["timing"]
            entry["baselineRerunS0Waterfall"] = score_stage(labels, dets_centers(load(baseline_rerun)))
        timing[case] = entry

    (OUT_DIR / "H-downstream.json").write_text(json.dumps(downstream, indent=2))
    (OUT_DIR / "H-timing.json").write_text(json.dumps(timing, indent=2))
    print(json.dumps({"downstream": downstream, "timing": timing}, indent=2))


if __name__ == "__main__":
    main()
