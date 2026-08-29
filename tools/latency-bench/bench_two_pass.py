"""F25 LINUX-CPU promotion benchmark for the adaptive two-pass detector path.

Benchmarks analyzeVideo DEFAULT flags vs `--two-pass` (C08, OFF by default,
never previously given a promotion verdict) over:

  - the two usable committed dev bundle clips (wm-volley-02,
    afn-sasebo-rally1); held-out wm-dink-01 / afn-vic-rally1 are UNTOUCHED;
  - the usable-rights fresh-candidate corpus media present on this machine
    (datasets/pickleball/fresh-candidates, 15 clips, CC BY 3.0 / public
    domain per datasets/pickleball/registry.json). These are the registry's
    LABEL-BLIND holdout pool: this benchmark creates NO labels and tunes NO
    thresholds — it only measures wall-clock and compares the two code
    paths' outputs against each other. Ground-truth accuracy is never
    computed here.

Measures, per (clip, arm):
  - wall-clock of the full tsx child process (p50/p90/min/max over reps);
  - per-stage timings from report.json;
  - OUTPUT EQUIVALENCE between arms on rep-1 artifacts:
      * report.json normalized (timings/outDir/paddleSchedule stripped) —
        deep diff with stated tolerances: fields ending in "Ms" equal
        within one frame interval; confidences within 0.02; everything
        else exact;
      * paddle-dets.json shared-frame check: frames at tMs present in BOTH
        arms must carry byte-equal detection payloads (the schedule changes
        WHICH frames are scanned — by design — but a scanned frame must
        detect identically);
      * ball-candidates.json byte-equal after stripping wall-clock timing;
  - a default-vs-default determinism control (rep1 vs rep2 artifacts of the
    default arm) so comparator failures can be attributed.

HONESTY: LINUX-CPU only (torch 2.13.0+cpu, D-FINE dfine-medium-coco,
MediaPipe LINUX-BENCH pose seeds held constant across arms). Never
extrapolate to Mac/iPhone; pose seeds are latency-bench inputs, not labels.

Usage:
  python3 bench_two_pass.py [--bundle-reps 5] [--fresh-reps 3]
"""

from __future__ import annotations

import argparse
import json
import math
import platform
import shutil
import subprocess
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
SWING_LAB = REPO / "packages/swing-lab"
OUT_ROOT = HERE / "artifacts" / "f25-two-pass"

BUNDLE_CLIPS = ["wm-volley-02", "afn-sasebo-rally1"]
FRESH_DIR = REPO / "datasets/pickleball/fresh-candidates"

ARMS = [("default", []), ("twopass", ["--two-pass"])]

SEED_FILES = ["pose.json", "people.json", "ball.json", "extract-meta.json"]

# artifacts persisted per rep for equivalence comparison
KEEP_FILES = [
    "report.json",
    "paddle-dets.json",
    "paddle-schedule.json",
    "ball-candidates.json",
    "sequence.json",
]

CONFIDENCE_TOLERANCE = 0.02


def clip_paths() -> list[tuple[str, Path, Path]]:
    """(clip_id, video_path, seed_dir) for every benchmark unit."""
    units: list[tuple[str, Path, Path]] = []
    for clip in BUNDLE_CLIPS:
        units.append(
            (
                clip,
                REPO / "datasets/paddle-bench/bundles" / clip / "clip.mp4",
                HERE / "artifacts" / clip,
            )
        )
    for video in sorted(FRESH_DIR.glob("*.mp4")):
        clip = video.stem
        if clip.startswith("va-"):
            # AV1-encoded; OpenCV on this box cannot decode them, so no
            # LINUX-BENCH pose seed exists. Excluded and disclosed.
            continue
        units.append((clip, video, HERE / "artifacts" / "f25-seeds" / clip))
    return units


def nearest_rank(sorted_values: list[float], percentile: float) -> float:
    rank = max(1, math.ceil(percentile / 100.0 * len(sorted_values)))
    return sorted_values[rank - 1]


def run_once(video: Path, seed_dir: Path, flags: list[str], keep_dir: Path | None) -> dict:
    out_dir = OUT_ROOT / "tmp-run"
    if out_dir.exists():
        shutil.rmtree(out_dir)
    out_dir.mkdir(parents=True)
    for name in SEED_FILES:
        shutil.copy(seed_dir / name, out_dir / name)
    argv = [
        str(SWING_LAB / "node_modules/.bin/tsx"),
        "src/analyzeVideo.ts",
        str(video),
        "--reuse-extract",
        "--out",
        str(out_dir),
        *flags,
    ]
    started = time.monotonic()
    proc = subprocess.run(argv, cwd=SWING_LAB, capture_output=True, text=True)
    wall_ms = (time.monotonic() - started) * 1000.0
    report_path = out_dir / "report.json"
    report = json.loads(report_path.read_text()) if report_path.exists() else None
    if keep_dir is not None:
        keep_dir.mkdir(parents=True, exist_ok=True)
        for name in KEEP_FILES:
            source = out_dir / name
            if source.exists():
                shutil.copy(source, keep_dir / name)
    shutil.rmtree(out_dir, ignore_errors=True)
    return {
        "wallMs": round(wall_ms, 1),
        "exitCode": proc.returncode,
        "outcome": report["outcome"]["kind"] if report else None,
        "timings": report["timings"] if report else None,
        "stderrTail": proc.stderr[-400:] if proc.returncode != 0 else None,
    }


# ── equivalence comparators ──────────────────────────────────────────────


def strip_report(report: dict) -> dict:
    clone = json.loads(json.dumps(report))
    for key in ["timings", "outDir", "paddleSchedule"]:
        clone.pop(key, None)
    return clone


def deep_diff(a, b, path: str, frame_ms: float, diffs: list[dict]) -> None:
    if type(a) is not type(b):
        diffs.append({"path": path, "kind": "type", "a": describe(a), "b": describe(b)})
        return
    if isinstance(a, dict):
        for key in sorted(set(a) | set(b)):
            if key not in a or key not in b:
                diffs.append(
                    {"path": f"{path}.{key}", "kind": "missing", "a": key in a, "b": key in b}
                )
            else:
                deep_diff(a[key], b[key], f"{path}.{key}", frame_ms, diffs)
    elif isinstance(a, list):
        if len(a) != len(b):
            diffs.append({"path": path, "kind": "length", "a": len(a), "b": len(b)})
            return
        for index, (item_a, item_b) in enumerate(zip(a, b)):
            deep_diff(item_a, item_b, f"{path}[{index}]", frame_ms, diffs)
    elif isinstance(a, (int, float)) and isinstance(b, (int, float)) and not isinstance(a, bool):
        leaf = path.rsplit(".", 1)[-1].split("[")[0]
        if leaf.endswith("Ms"):
            tolerance = frame_ms
        elif "confidence" in leaf.lower() or leaf in ("c", "conf", "score"):
            tolerance = CONFIDENCE_TOLERANCE
        else:
            tolerance = 0.0
        if abs(float(a) - float(b)) > tolerance:
            diffs.append(
                {"path": path, "kind": "number", "a": a, "b": b, "toleranceApplied": tolerance}
            )
    elif a != b:
        diffs.append({"path": path, "kind": "value", "a": describe(a), "b": describe(b)})


def describe(value):
    text = json.dumps(value)
    return text if len(text) <= 200 else text[:200] + "…"


def compare_reports(dir_a: Path, dir_b: Path, frame_ms: float) -> list[dict]:
    report_a = strip_report(json.loads((dir_a / "report.json").read_text()))
    report_b = strip_report(json.loads((dir_b / "report.json").read_text()))
    diffs: list[dict] = []
    deep_diff(
        normalize_numbers(report_a), normalize_numbers(report_b), "report", frame_ms, diffs
    )
    return diffs


def normalize_numbers(value):
    """int→float everywhere: the two-pass merged file is written by
    JSON.stringify (4280, 367) while the one-shot file is written by python
    json (4280.0, 367.0); numerically-equal payloads must compare equal."""
    if isinstance(value, bool):
        return value
    if isinstance(value, int):
        return float(value)
    if isinstance(value, list):
        return [normalize_numbers(item) for item in value]
    if isinstance(value, dict):
        return {key: normalize_numbers(item) for key, item in value.items()}
    return value


def compare_shared_paddle_frames(dir_a: Path, dir_b: Path) -> dict:
    present_a = (dir_a / "paddle-dets.json").exists()
    present_b = (dir_b / "paddle-dets.json").exists()
    if not (present_a and present_b):
        return {"fileA": present_a, "fileB": present_b, "note": "paddle stage did not run"}
    dets_a = json.loads((dir_a / "paddle-dets.json").read_text())
    dets_b = json.loads((dir_b / "paddle-dets.json").read_text())
    frames_a = {float(frame["tMs"]): normalize_numbers(frame) for frame in dets_a["frames"]}
    frames_b = {float(frame["tMs"]): normalize_numbers(frame) for frame in dets_b["frames"]}
    shared = sorted(set(frames_a) & set(frames_b))
    mismatched = [
        t for t in shared if json.dumps(frames_a[t], sort_keys=True) != json.dumps(frames_b[t], sort_keys=True)
    ]
    return {
        "framesA": len(frames_a),
        "framesB": len(frames_b),
        "sharedFrames": len(shared),
        "sharedFramesByteEqual": len(shared) - len(mismatched),
        "mismatchedTMs": mismatched[:20],
    }


def compare_ball_candidates(dir_a: Path, dir_b: Path) -> dict:
    present_a = (dir_a / "ball-candidates.json").exists()
    present_b = (dir_b / "ball-candidates.json").exists()
    if not (present_a and present_b):
        return {"fileA": present_a, "fileB": present_b, "note": "ball stage did not run"}
    raw_a = (dir_a / "ball-candidates.json").read_text()
    raw_b = (dir_b / "ball-candidates.json").read_text()
    if raw_a == raw_b:
        return {"byteEqual": True, "timingStrippedEqual": True}
    data_a = json.loads(raw_a)
    data_b = json.loads(raw_b)
    for data in (data_a, data_b):
        data.pop("timing", None)
    return {
        "byteEqual": False,
        "timingStrippedEqual": json.dumps(data_a, sort_keys=True)
        == json.dumps(data_b, sort_keys=True),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--bundle-reps", type=int, default=5)
    parser.add_argument("--fresh-reps", type=int, default=3)
    parser.add_argument("--out", default=str(OUT_ROOT / "bench-results.json"))
    args = parser.parse_args()

    OUT_ROOT.mkdir(parents=True, exist_ok=True)
    units = clip_paths()
    previous: dict = {}
    if Path(args.out).exists():
        previous = json.loads(Path(args.out).read_text()).get("clips", {})
    results: dict = {
        "id": "f25-two-pass-verdict",
        "platformLabel": "LINUX-CPU",
        "environment": {
            "platform": platform.platform(),
            "node": subprocess.run(
                ["node", "--version"], capture_output=True, text=True
            ).stdout.strip(),
            "commit": subprocess.run(
                ["git", "rev-parse", "HEAD"], cwd=REPO, capture_output=True, text=True
            ).stdout.strip(),
        },
        "arms": {name: flags for name, flags in ARMS},
        "clips": {},
    }

    for clip, video, seed_dir in units:
        is_bundle = clip in BUNDLE_CLIPS
        reps = args.bundle_reps if is_bundle else args.fresh_reps
        resumed = clip in previous and "arms" in previous[clip] and previous[clip]["arms"]
        meta = json.loads((seed_dir / "extract-meta.json").read_text())["video"]
        frame_ms = 1000.0 / meta["fps"]
        clip_result: dict = {
            "kind": "bundle_clip" if is_bundle else "fresh_candidate",
            "durationMs": meta["durationMs"],
            "fps": meta["fps"],
            "frameIntervalMsTolerance": round(frame_ms, 2),
            "repsMeasured": reps,
            "arms": {},
        }
        if resumed:
            print(f"=== {clip} === (resumed timing from previous results)", flush=True)
            clip_result["arms"] = previous[clip]["arms"]
        else:
            # Interleave arms per repetition (alternating order per rep) so
            # box-level wall-clock drift hits both arms symmetrically.
            print(f"=== {clip} ===", flush=True)
            arm_runs: dict[str, list[dict]] = {name: [] for name, _ in ARMS}
            for arm_name, flags in ARMS:
                run_once(video, seed_dir, flags, None)  # warm-up, discarded
            for rep in range(reps):
                order = ARMS if rep % 2 == 0 else list(reversed(ARMS))
                for arm_name, flags in order:
                    keep = (
                        OUT_ROOT / "outputs" / clip / arm_name / f"rep{rep + 1}"
                        if rep < 2
                        else None
                    )
                    run = run_once(video, seed_dir, flags, keep)
                    arm_runs[arm_name].append(run)
                    print(
                        f"  rep{rep + 1} {arm_name}: {run['wallMs']}ms {run['outcome']}",
                        flush=True,
                    )
            for arm_name, _flags in ARMS:
                runs = arm_runs[arm_name]
                walls = sorted(run["wallMs"] for run in runs)
                stage_medians: dict[str, float] = {}
                timing_keys = sorted(
                    {key for run in runs if run["timings"] for key in run["timings"]}
                )
                for key in timing_keys:
                    values = sorted(run["timings"][key] for run in runs if run["timings"])
                    stage_medians[key] = nearest_rank(values, 50)
                clip_result["arms"][arm_name] = {
                    "runs": runs,
                    "wallMs": {
                        "p50": nearest_rank(walls, 50),
                        "p90": nearest_rank(walls, 90),
                        "min": walls[0],
                        "max": walls[-1],
                        "mean": round(sum(walls) / len(walls), 1),
                    },
                    "stageMedianMs": stage_medians,
                }
        default_rep1 = OUT_ROOT / "outputs" / clip / "default" / "rep1"
        default_rep2 = OUT_ROOT / "outputs" / clip / "default" / "rep2"
        twopass_rep1 = OUT_ROOT / "outputs" / clip / "twopass" / "rep1"
        clip_result["equivalence"] = {
            "toleranceStatement": (
                f"*Ms fields within one frame interval ({frame_ms:.2f}ms), "
                f"confidence/score fields within {CONFIDENCE_TOLERANCE}, all else exact; "
                "report normalized by dropping timings/outDir/paddleSchedule"
            ),
            "defaultVsTwopass": {
                "reportDiffs": compare_reports(default_rep1, twopass_rep1, frame_ms),
                "paddleDetsSharedFrames": compare_shared_paddle_frames(
                    default_rep1, twopass_rep1
                ),
                "ballCandidates": compare_ball_candidates(default_rep1, twopass_rep1),
            },
            "determinismControlDefaultRep1VsRep2": {
                "reportDiffs": compare_reports(default_rep1, default_rep2, frame_ms),
                "paddleDetsSharedFrames": compare_shared_paddle_frames(
                    default_rep1, default_rep2
                ),
                "ballCandidates": compare_ball_candidates(default_rep1, default_rep2),
            },
        }
        results["clips"][clip] = clip_result
        Path(args.out).write_text(json.dumps(results, indent=2))
        print(f"  wrote {args.out}", flush=True)


if __name__ == "__main__":
    main()
