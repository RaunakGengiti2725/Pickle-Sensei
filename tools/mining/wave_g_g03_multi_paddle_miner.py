#!/usr/bin/env python3
"""Wave G g03-f09-mining: multi-paddle scenario miner (Tier-C, machine-proposed).

Mines EVERY rights-cleared, committed per-frame artifact in the repo for natural
occurrences of six multi-paddle hazard scenarios:

  S1 foreign_paddle_near_target      - a non-target paddle point inside the target's
                                       torso-normalized reach radius
  S2 crossing_paddles                - target and other paddle trajectories cross
                                       between consecutive labeled timestamps
  S3 partner_or_opponent_in_frame    - >=2 paddle observations (detector boxes or
                                       labeled points) co-present in one frame
  S4 idle_wrist_moving_nearby_paddle - presumed-target wrist nearly still while a
                                       nearby non-target paddle moves substantially
  S5 two_paddles_within_reach        - two paddle observations both inside one
                                       torso-normalized reach disc
  S6 occlusion_identity_swap         - two pose tracks overlap/cross with a
                                       confidence dip (identity-swap risk frames)

HELD-OUT POLICY: cases `wm-dink-01` and `afn-vic-rally1` are excluded by ID before
any record is read into the mining state. Nothing from them is inspected, counted,
cropped, or emitted.

TIER POLICY: every emitted candidate is machine-proposed Tier-C. Human ownership
labels are consumed only as *seed coordinates* for geometry; the miner's scenario
assignments are proposals, never Gold. The "presumed target" in pose-only sources
is a machine heuristic (largest torso in frame), explicitly recorded per candidate.

Inputs (all committed, Linux-available):
  - datasets/paddle-bench/ownership-review/queue.json      (machine detector boxes)
  - datasets/paddle-bench/bundles/*/annotation/devin-visual-v2-waveC-ownership.json
                                                           (target/other paddle points)
  - datasets/paddle-bench/runs-wave-a/*/people.json        (multi-person pose tracks)
  - datasets/paddle-bench/bundles/{afn-sasebo-rally1,wm-volley-02}/clip.mp4
                                                           (crop extraction only)

Outputs:
  - datasets/mining/wave-g-g03/candidates.json         (full Tier-C candidate list)
  - datasets/mining/wave-g-g03/annotation-queue.json   (frozen human-review queue)
  - datasets/mining/wave-g-g03/label-schema.json       (label schema for reviewers)
  - datasets/mining/wave-g-g03/frame-packs/            (crops where clips exist)

Usage: python3 tools/mining/wave_g_g03_multi_paddle_miner.py [--no-crops]
"""

import argparse
import glob
import hashlib
import json
import math
import os
import subprocess
import sys

REPO = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
sys.path.insert(0, os.path.join(REPO, "tools", "paddle-lab"))

import frame_clock  # noqa: E402  (stdlib-only; the absolute CFR clock shared with detect_paddle)

OUT_DIR = os.path.join(REPO, "datasets", "mining", "wave-g-g03")

HELD_OUT = {"wm-dink-01", "afn-vic-rally1"}

# Torso-normalized reach: arm span ~ 2.2x torso (shoulder-hip) length; reach disc
# radius = REACH_TORSO_MULT * torso length around the wrist/paddle point.
REACH_TORSO_MULT = 2.2
# Fallback when no pose is available for the case: normalize by detector box
# diagonal (paddle head ~ 0.4 m; reach ~ 1.0 m => ~2.5 diagonals).
REACH_BOX_DIAG_MULT = 2.5
MIN_BOX_SCORE = 0.30
IDLE_WRIST_MAX_NORM_VEL = 0.02   # per-step wrist displacement (frame-normalized)
MOVING_PADDLE_MIN_NORM_VEL = 0.06
NEARBY_NORM_DIST = 0.25
POSE_OVERLAP_IOU = 0.05
CONF_DIP = 0.15


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def load_json(path):
    with open(path) as f:
        return json.load(f)


def dist(a, b):
    return math.hypot(a[0] - b[0], a[1] - b[1])


def seg_intersect(p1, p2, p3, p4):
    def ccw(a, b, c):
        return (c[1] - a[1]) * (b[0] - a[0]) - (b[1] - a[1]) * (c[0] - a[0])

    d1, d2 = ccw(p3, p4, p1), ccw(p3, p4, p2)
    d3, d4 = ccw(p1, p2, p3), ccw(p1, p2, p4)
    return ((d1 > 0) != (d2 > 0)) and ((d3 > 0) != (d4 > 0))


def landmark(person, name):
    for lm in person["l"]:
        if lm["n"] == name:
            return lm
    return None


def torso_len(person):
    pts = []
    for a, b in (("left_shoulder", "left_hip"), ("right_shoulder", "right_hip")):
        la, lb = landmark(person, a), landmark(person, b)
        if la and lb and la["v"] > 0.2 and lb["v"] > 0.2:
            pts.append(dist((la["x"], la["y"]), (lb["x"], lb["y"])))
    return sum(pts) / len(pts) if pts else None


def person_bbox(person, min_v=0.2):
    xs = [lm["x"] for lm in person["l"] if lm["v"] > min_v]
    ys = [lm["y"] for lm in person["l"] if lm["v"] > min_v]
    if not xs:
        return None
    return (min(xs), min(ys), max(xs), max(ys))


def iou(a, b):
    ix = max(0.0, min(a[2], b[2]) - max(a[0], b[0]))
    iy = max(0.0, min(a[3], b[3]) - max(a[1], b[1]))
    inter = ix * iy
    if inter <= 0:
        return 0.0
    ua = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / ua if ua > 0 else 0.0


def make_candidate(scenario, case_id, t_ms, source, evidence, score):
    return {
        "tier": "C",
        "scenario": scenario,
        "caseId": case_id,
        "tMs": round(t_ms, 2),
        "source": source,
        "evidence": evidence,
        "minerScore": round(score, 4),
    }


def mine_detector_boxes(candidates, provenance):
    path = os.path.join(REPO, "datasets", "paddle-bench", "ownership-review", "queue.json")
    q = load_json(path)
    kept = skipped_held_out = 0
    for fr in q["frames"]:
        cid = fr["caseId"]
        if cid in HELD_OUT:
            skipped_held_out += 1
            continue
        kept += 1
        boxes = [b for b in fr.get("boxes", []) if b.get("score", 0) >= MIN_BOX_SCORE]
        if len(boxes) < 2:
            continue
        t = float(fr["tMs"])
        w = fr["videoSize"]["width"]
        h = fr["videoSize"]["height"]
        centers = []
        for b in boxes:
            x0, y0, x1, y1 = b["boxPx"]
            centers.append(
                {
                    "index": b["index"],
                    "cx": (x0 + x1) / 2 / w,
                    "cy": (y0 + y1) / 2 / h,
                    "diagNorm": math.hypot((x1 - x0) / w, (y1 - y0) / h),
                    "boxPx": b["boxPx"],
                    "score": b["score"],
                }
            )
        candidates.append(
            make_candidate(
                "partner_or_opponent_in_frame",
                cid,
                t,
                "detector-boxes:ownership-review/queue.json",
                {"numBoxes": len(boxes), "boxes": [c["boxPx"] for c in centers], "scores": [c["score"] for c in centers]},
                min(c["score"] for c in centers),
            )
        )
        for i in range(len(centers)):
            for j in range(i + 1, len(centers)):
                a, b = centers[i], centers[j]
                d = dist((a["cx"], a["cy"]), (b["cx"], b["cy"]))
                reach = REACH_BOX_DIAG_MULT * max(a["diagNorm"], b["diagNorm"])
                if d <= reach:
                    candidates.append(
                        make_candidate(
                            "two_paddles_within_reach",
                            cid,
                            t,
                            "detector-boxes:ownership-review/queue.json",
                            {
                                "boxIndices": [a["index"], b["index"]],
                                "centerDistNorm": round(d, 4),
                                "reachNorm": round(reach, 4),
                                "normalization": "box-diagonal fallback (no pose for this case)",
                                "boxesPx": [a["boxPx"], b["boxPx"]],
                            },
                            1.0 - d / reach,
                        )
                    )
                bi = (
                    min(a["boxPx"][0], b["boxPx"][0]) <= max(a["boxPx"][0], b["boxPx"][0])
                    and iou(a["boxPx"], b["boxPx"]) > 0.0
                )
                if bi:
                    candidates.append(
                        make_candidate(
                            "occlusion_identity_swap",
                            cid,
                            t,
                            "detector-boxes:ownership-review/queue.json",
                            {
                                "boxIndices": [a["index"], b["index"]],
                                "iou": round(iou(a["boxPx"], b["boxPx"]), 4),
                                "note": "overlapping paddle detections: identity/ownership swap risk",
                            },
                            iou(a["boxPx"], b["boxPx"]),
                        )
                    )
    provenance.append(
        {
            "input": os.path.relpath(path, REPO),
            "sha256": sha256(path),
            "framesUsed": kept,
            "framesSkippedHeldOut": skipped_held_out,
        }
    )


def load_people(bundle):
    path = os.path.join(REPO, "datasets", "paddle-bench", "runs-wave-a", bundle, "people.json")
    if not os.path.exists(path):
        return None, None
    return load_json(path), path


def nearest_frame(people, t_ms):
    frames = people["frames"]
    best = min(frames, key=lambda fr: abs(fr["t"] - t_ms))
    return best if abs(best["t"] - t_ms) <= 60 else None


def presumed_target(frame):
    """Machine heuristic: largest torso (closest to camera) = presumed target."""
    best, best_len = None, 0.0
    for idx, person in enumerate(frame["p"]):
        tl = torso_len(person)
        if tl and tl > best_len:
            best, best_len = idx, tl
    return best, best_len


def mine_ownership_points(candidates, provenance):
    pattern = os.path.join(
        REPO, "datasets", "paddle-bench", "bundles", "*", "annotation", "devin-visual-v2-waveC-ownership.json"
    )
    for ann_path in sorted(glob.glob(pattern)):
        bundle = ann_path.split(os.sep)[-3]
        if bundle in HELD_OUT:
            continue
        ann = load_json(ann_path)
        target = [p for p in ann.get("paddleFrames", []) if p.get("visibility") == "visible"]
        other = [p for p in ann.get("otherPaddleFrames", []) if p.get("visibility") == "visible"]
        if not other:
            continue
        people, people_path = load_people(bundle)
        prov = {
            "input": os.path.relpath(ann_path, REPO),
            "sha256": sha256(ann_path),
            "targetPoints": len(target),
            "otherPoints": len(other),
        }
        if people_path:
            prov["poseInput"] = os.path.relpath(people_path, REPO)
        provenance.append(prov)

        by_t = {}
        for p in target:
            by_t.setdefault(round(p["tMs"], 2), {"target": [], "other": []})["target"].append(p)
        for p in other:
            by_t.setdefault(round(p["tMs"], 2), {"target": [], "other": []})["other"].append(p)

        for t, grp in sorted(by_t.items()):
            pts = grp["target"] + grp["other"]
            if len(pts) >= 2:
                candidates.append(
                    make_candidate(
                        "partner_or_opponent_in_frame",
                        bundle,
                        t,
                        "ownership-points:devin-visual-v2-waveC-ownership",
                        {
                            "numTargetPoints": len(grp["target"]),
                            "numOtherPoints": len(grp["other"]),
                            "points": [{"x": p["point"]["x"], "y": p["point"]["y"]} for p in pts],
                        },
                        1.0,
                    )
                )
            torso = None
            if people:
                fr = nearest_frame(people, t)
                if fr and grp["target"]:
                    tp = grp["target"][0]["point"]
                    best_person, best_d = None, 1e9
                    for person in fr["p"]:
                        for wname in ("left_wrist", "right_wrist"):
                            wl = landmark(person, wname)
                            if wl and wl["v"] > 0.2:
                                d = dist((wl["x"], wl["y"]), (tp["x"], tp["y"]))
                                if d < best_d:
                                    best_person, best_d = person, d
                    if best_person is not None:
                        torso = torso_len(best_person)
            reach = REACH_TORSO_MULT * torso if torso else NEARBY_NORM_DIST
            norm_kind = "torso-normalized" if torso else "frame-normalized fallback (no matched pose)"
            for tp in grp["target"]:
                for op in grp["other"]:
                    d = dist((tp["point"]["x"], tp["point"]["y"]), (op["point"]["x"], op["point"]["y"]))
                    if d <= reach:
                        candidates.append(
                            make_candidate(
                                "foreign_paddle_near_target",
                                bundle,
                                t,
                                "ownership-points:devin-visual-v2-waveC-ownership",
                                {
                                    "targetPoint": tp["point"],
                                    "otherPoint": op["point"],
                                    "distNorm": round(d, 4),
                                    "reachNorm": round(reach, 4),
                                    "normalization": norm_kind,
                                },
                                1.0 - d / reach if reach else 0.0,
                            )
                        )
                        candidates.append(
                            make_candidate(
                                "two_paddles_within_reach",
                                bundle,
                                t,
                                "ownership-points:devin-visual-v2-waveC-ownership",
                                {
                                    "pointA": tp["point"],
                                    "pointB": op["point"],
                                    "distNorm": round(d, 4),
                                    "reachNorm": round(reach, 4),
                                    "normalization": norm_kind,
                                },
                                1.0 - d / reach if reach else 0.0,
                            )
                        )

        ts = sorted(by_t)
        for k in range(len(ts) - 1):
            t0, t1 = ts[k], ts[k + 1]
            g0, g1 = by_t[t0], by_t[t1]
            if g0["target"] and g1["target"]:
                tp0 = g0["target"][0]["point"]
                tp1 = g1["target"][0]["point"]
                for o0 in g0["other"]:
                    best_o1, best_d = None, 1e9
                    for o1 in g1["other"]:
                        d = dist(
                            (o0["point"]["x"], o0["point"]["y"]), (o1["point"]["x"], o1["point"]["y"])
                        )
                        if d < best_d:
                            best_o1, best_d = o1, d
                    if best_o1 is None:
                        continue
                    if seg_intersect(
                        (tp0["x"], tp0["y"]),
                        (tp1["x"], tp1["y"]),
                        (o0["point"]["x"], o0["point"]["y"]),
                        (best_o1["point"]["x"], best_o1["point"]["y"]),
                    ):
                        candidates.append(
                            make_candidate(
                                "crossing_paddles",
                                bundle,
                                (t0 + t1) / 2,
                                "ownership-points:devin-visual-v2-waveC-ownership",
                                {
                                    "intervalMs": [t0, t1],
                                    "targetSegment": [tp0, tp1],
                                    "otherSegment": [o0["point"], best_o1["point"]],
                                    "note": "labeled-point trajectories intersect between consecutive labeled frames",
                                },
                                0.5,
                            )
                        )
                    target_step = dist((tp0["x"], tp0["y"]), (tp1["x"], tp1["y"]))
                    other_step = best_d
                    prox = dist((tp0["x"], tp0["y"]), (o0["point"]["x"], o0["point"]["y"]))
                    if (
                        target_step <= IDLE_WRIST_MAX_NORM_VEL * ((t1 - t0) / 100.0)
                        and other_step >= MOVING_PADDLE_MIN_NORM_VEL * ((t1 - t0) / 100.0) * 0.5
                        and prox <= NEARBY_NORM_DIST
                    ):
                        candidates.append(
                            make_candidate(
                                "idle_wrist_moving_nearby_paddle",
                                bundle,
                                (t0 + t1) / 2,
                                "ownership-points:devin-visual-v2-waveC-ownership",
                                {
                                    "intervalMs": [t0, t1],
                                    "targetStepNorm": round(target_step, 4),
                                    "otherStepNorm": round(other_step, 4),
                                    "proximityNorm": round(prox, 4),
                                    "note": "target paddle point ~static while nearby other paddle moves",
                                },
                                min(1.0, other_step / max(target_step, 1e-4) / 20.0),
                            )
                        )


def mine_pose_tracks(candidates, provenance):
    pattern = os.path.join(REPO, "datasets", "paddle-bench", "runs-wave-a", "*", "people.json")
    for path in sorted(glob.glob(pattern)):
        bundle = path.split(os.sep)[-2]
        if bundle in HELD_OUT:
            continue
        people = load_json(path)
        provenance.append(
            {
                "input": os.path.relpath(path, REPO),
                "sha256": sha256(path),
                "frames": len(people["frames"]),
            }
        )
        prev_bboxes = None
        for fr in people["frames"]:
            bboxes = []
            for idx, person in enumerate(fr["p"]):
                bb = person_bbox(person)
                if bb:
                    bboxes.append((idx, bb, person["c"]))
            for i in range(len(bboxes)):
                for j in range(i + 1, len(bboxes)):
                    ov = iou(bboxes[i][1], bboxes[j][1])
                    if ov >= POSE_OVERLAP_IOU:
                        conf_dip = False
                        if prev_bboxes is not None:
                            prev_by_idx = {b[0]: b for b in prev_bboxes}
                            for idx, _, c in (bboxes[i], bboxes[j]):
                                if idx in prev_by_idx and prev_by_idx[idx][2] - c >= CONF_DIP:
                                    conf_dip = True
                        candidates.append(
                            make_candidate(
                                "occlusion_identity_swap",
                                bundle,
                                float(fr["t"]),
                                "pose-tracks:runs-wave-a/people.json",
                                {
                                    "personIndices": [bboxes[i][0], bboxes[j][0]],
                                    "bboxIoU": round(ov, 4),
                                    "confidenceDip": conf_dip,
                                    "confidences": [round(bboxes[i][2], 3), round(bboxes[j][2], 3)],
                                    "note": "pose bboxes overlap: association ambiguity / swap risk",
                                },
                                ov + (0.25 if conf_dip else 0.0),
                            )
                        )
            prev_bboxes = bboxes


def dedupe_and_rank(candidates):
    """Collapse per-scenario candidates within 150 ms per case; keep max score."""
    out = {}
    for c in sorted(candidates, key=lambda c: (-c["minerScore"], c["tMs"])):
        key = (c["scenario"], c["caseId"], round(c["tMs"] / 150.0))
        if key not in out:
            out[key] = c
    result = sorted(out.values(), key=lambda c: (c["scenario"], c["caseId"], c["tMs"]))
    for i, c in enumerate(result):
        c["candidateId"] = f"g03-{c['scenario'][:14]}-{i:04d}"
    return result


def extract_crops(candidates, no_crops):
    """Extract crops for cases with a committed clip.mp4 (held-out never included).

    Candidate tMs values come from detector / label artifacts on the absolute
    CFR clock (start_time + k/fps), so the frame to render is
    k = round((tMs - start_time) * fps / 1000) and the seek targets frame k's
    own pts (frame_clock) — not `-ss tMs/1000`, which on a clip with a nonzero
    container start_time (afn-sasebo-rally1: 33.367 ms) lands one frame late.
    frameIndexHint records k. ffmpeg failures raise instead of silently
    leaving cropPath null.
    """
    packs = []
    clip_map = {}
    clip_meta = {}
    for clip in sorted(glob.glob(os.path.join(REPO, "datasets", "paddle-bench", "bundles", "*", "clip.mp4"))):
        bundle = clip.split(os.sep)[-2]
        if bundle in HELD_OUT:
            continue
        clip_map[bundle] = clip
        clip_meta[bundle] = frame_clock.probe_stream(clip)
    for c in candidates:
        cid = c["caseId"]
        entry = {
            "candidateId": c["candidateId"],
            "caseId": cid,
            "tMs": c["tMs"],
            "frameIndexHint": None,
            "cropPath": None,
        }
        if cid in clip_map:
            meta = clip_meta[cid]
            frame_index = frame_clock.frame_index_for_t_ms(float(c["tMs"]), meta.fps, meta.start_time_ms)
            entry["frameIndexHint"] = frame_index
        if cid in clip_map and not no_crops:
            out_png = os.path.join(OUT_DIR, "frame-packs", cid, f"{c['candidateId']}.png")
            os.makedirs(os.path.dirname(out_png), exist_ok=True)
            cmd = [
                "ffmpeg", "-y", "-loglevel", "error",
                "-ss", f"{frame_clock.seek_sec_for_frame_index(frame_index, meta.fps):.3f}",
                "-i", clip_map[cid],
                "-frames:v", "1",
                out_png,
            ]
            r = subprocess.run(cmd, capture_output=True)
            if r.returncode != 0 or not os.path.exists(out_png):
                raise RuntimeError(
                    f"ffmpeg failed to render frame {frame_index} (tMs {c['tMs']}) of {cid} for "
                    f"{c['candidateId']} (exit {r.returncode}): {r.stderr.decode('utf-8', 'replace').strip()[-400:]}"
                )
            entry["cropPath"] = os.path.relpath(out_png, REPO)
        packs.append(entry)
    return packs


LABEL_SCHEMA = {
    "schemaVersion": 1,
    "name": "wave-g-g03 multi-paddle scenario labels",
    "tierPolicy": "All queue entries are machine-proposed Tier-C. A human review recording a decision below produces a Gold label; until then nothing in this queue is truth.",
    "perCandidateLabels": {
        "scenarioConfirmed": {
            "type": "enum",
            "values": ["confirmed", "rejected", "uncertain", "frame_unusable"],
            "description": "Does the named scenario actually occur at this frame/interval?",
        },
        "paddleOwners": {
            "type": "list",
            "itemSchema": {
                "point_or_box": "normalized point {x,y} or pixel box [x0,y0,x1,y1]",
                "owner": ["target", "partner", "opponent", "ambiguous", "not_a_paddle"],
            },
            "description": "Ownership of every paddle observation the reviewer can certify in the frame.",
        },
        "identitySwapObserved": {
            "type": "enum",
            "values": ["yes", "no", "cannot_tell"],
            "description": "Only for occlusion_identity_swap candidates: did tracker/pose identity actually swap across the occlusion?",
        },
        "notes": {"type": "string"},
        "reviewerId": {"type": "string"},
        "reviewedAtIso": {"type": "string"},
    },
}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--no-crops", action="store_true")
    args = ap.parse_args()

    os.makedirs(OUT_DIR, exist_ok=True)
    candidates, provenance = [], []
    mine_detector_boxes(candidates, provenance)
    mine_ownership_points(candidates, provenance)
    mine_pose_tracks(candidates, provenance)
    candidates = dedupe_and_rank(candidates)

    for c in candidates:
        if c["caseId"] in HELD_OUT:
            print("FATAL: held-out case leaked into candidates", file=sys.stderr)
            sys.exit(1)

    packs = extract_crops(candidates, args.no_crops)

    counts = {}
    for c in candidates:
        counts.setdefault(c["scenario"], {"candidates": 0, "cases": set()})
        counts[c["scenario"]]["candidates"] += 1
        counts[c["scenario"]]["cases"].add(c["caseId"])
    counts_out = {
        k: {"candidates": v["candidates"], "distinctCases": sorted(v["cases"])} for k, v in sorted(counts.items())
    }

    meta = {
        "schemaVersion": 1,
        "generator": "tools/mining/wave_g_g03_multi_paddle_miner.py",
        "workstream": "g03-f09-mining",
        "tier": "C (machine-proposed; NOT Gold)",
        "heldOutExcluded": sorted(HELD_OUT),
        "heldOutStatement": "wm-dink-01 and afn-vic-rally1 were excluded by ID before any of their records were read into mining state; no frame, box, crop, or count from them appears in any output.",
        "config": {
            "REACH_TORSO_MULT": REACH_TORSO_MULT,
            "REACH_BOX_DIAG_MULT": REACH_BOX_DIAG_MULT,
            "MIN_BOX_SCORE": MIN_BOX_SCORE,
            "IDLE_WRIST_MAX_NORM_VEL": IDLE_WRIST_MAX_NORM_VEL,
            "MOVING_PADDLE_MIN_NORM_VEL": MOVING_PADDLE_MIN_NORM_VEL,
            "NEARBY_NORM_DIST": NEARBY_NORM_DIST,
            "POSE_OVERLAP_IOU": POSE_OVERLAP_IOU,
            "CONF_DIP": CONF_DIP,
        },
        "provenance": provenance,
        "countsPerScenario": counts_out,
        "totalCandidates": len(candidates),
    }

    with open(os.path.join(OUT_DIR, "candidates.json"), "w") as f:
        json.dump({"meta": meta, "candidates": candidates}, f, indent=1)
        f.write("\n")

    queue = {
        "schemaVersion": 1,
        "frozen": True,
        "frozenStatement": "Queue order is fixed at generation time (scenario, then miner score descending). Future human review must not reorder, drop, or append entries; corrections go in a new queue version.",
        "workstream": "g03-f09-mining",
        "tier": "C (machine-proposed; NOT Gold)",
        "labelSchema": "datasets/mining/wave-g-g03/label-schema.json",
        "countsPerScenario": counts_out,
        "entries": [
            {
                "rank": i,
                "candidateId": c["candidateId"],
                "scenario": c["scenario"],
                "caseId": c["caseId"],
                "tMs": c["tMs"],
                "minerScore": c["minerScore"],
                "source": c["source"],
                "cropPath": next((p["cropPath"] for p in packs if p["candidateId"] == c["candidateId"]), None),
                "review": None,
            }
            for i, c in enumerate(
                sorted(candidates, key=lambda c: (c["scenario"], -c["minerScore"], c["caseId"], c["tMs"]))
            )
        ],
    }
    with open(os.path.join(OUT_DIR, "annotation-queue.json"), "w") as f:
        json.dump(queue, f, indent=1)
        f.write("\n")

    with open(os.path.join(OUT_DIR, "label-schema.json"), "w") as f:
        json.dump(LABEL_SCHEMA, f, indent=1)
        f.write("\n")

    print(json.dumps({"countsPerScenario": counts_out, "totalCandidates": len(candidates)}, indent=1))


if __name__ == "__main__":
    main()
