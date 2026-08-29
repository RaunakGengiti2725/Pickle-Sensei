"""LINUX-BENCH pose artifact generator (MediaPipe PoseLandmarker).

Produces the extraction artifacts analyzeVideo --reuse-extract expects
(pose.json, people.json, ball.json, extract-meta.json) so the ANALYSIS stage
of the pipeline (movement-complete -> result) can be latency-benchmarked on
Linux, where the canonical Apple Vision extractor cannot run.

HONESTY CONTRACT (do not mistake these artifacts for canonical data):
  - Pose is REAL measured pose from MediaPipe PoseLandmarker (full, float16)
    over the real committed clip -- but it is NOT Apple Vision. poseModelVersion
    is stamped "mediapipe-pose-landmarker-full-LINUX-BENCH" in every artifact.
  - These artifacts exist ONLY to hold the pose input constant across latency
    benchmark arms. They must never be used as labels, gold, or accuracy
    evidence, and never written into a canonical runs/ directory.
  - ball.json is an honestly-empty TrajectoryFile: Apple trajectory detection
    does not exist here. The pipeline's python ball-candidate stage still runs
    (that path is Linux-native and is part of the measured latency).

Usage:
  .venv-pose/bin/python linux_pose_extract.py --video clip.mp4 --out outdir
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import cv2
from mediapipe.tasks import python as mp_python
from mediapipe.tasks.python import vision
import mediapipe as mp

POSE_MODEL_VERSION = "mediapipe-pose-landmarker-full-LINUX-BENCH"

# MediaPipe pose landmark indices -> the 13-joint vocabulary used by the
# committed Apple people.json artifacts (left/right are the person's own side
# in both vocabularies).
JOINT_MAP = [
    ("head", 0),
    ("left_shoulder", 11),
    ("right_shoulder", 12),
    ("left_elbow", 13),
    ("right_elbow", 14),
    ("left_wrist", 15),
    ("right_wrist", 16),
    ("left_hip", 23),
    ("right_hip", 24),
    ("left_knee", 25),
    ("right_knee", 26),
    ("left_ankle", 27),
    ("right_ankle", 28),
]

MIN_PERSON_CONFIDENCE = 0.2


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--video", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument(
        "--model",
        default=str(Path(__file__).parent / "pose_landmarker_full.task"),
    )
    parser.add_argument("--num-poses", type=int, default=4)
    args = parser.parse_args()

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    cap = cv2.VideoCapture(args.video)
    if not cap.isOpened():
        raise SystemExit(f"cannot open video: {args.video}")
    fps = cap.get(cv2.CAP_PROP_FPS)
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    frame_count = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    duration_ms = frame_count * 1000.0 / fps

    options = vision.PoseLandmarkerOptions(
        base_options=mp_python.BaseOptions(model_asset_path=args.model),
        running_mode=vision.RunningMode.VIDEO,
        num_poses=args.num_poses,
        min_pose_detection_confidence=0.3,
        min_pose_presence_confidence=0.3,
        min_tracking_confidence=0.3,
    )
    landmarker = vision.PoseLandmarker.create_from_options(options)

    people_frames = []
    pose_frames = []
    frame_idx = 0
    while True:
        ok, frame_bgr = cap.read()
        if not ok:
            break
        t_ms = frame_idx * 1000.0 / fps
        rgb = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2RGB)
        image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
        result = landmarker.detect_for_video(image, int(round(t_ms)))

        persons = []
        for landmarks in result.pose_landmarks:
            joints = []
            vis_sum = 0.0
            for name, mp_idx in JOINT_MAP:
                mark = landmarks[mp_idx]
                visibility = float(mark.visibility)
                vis_sum += visibility
                joints.append(
                    {
                        "n": name,
                        "x": float(mark.x),
                        "y": float(mark.y),
                        "v": visibility,
                    }
                )
            confidence = vis_sum / len(JOINT_MAP)
            if confidence >= MIN_PERSON_CONFIDENCE:
                persons.append({"c": confidence, "l": joints})
        if persons:
            people_frames.append({"t": t_ms, "p": persons})
            best = max(persons, key=lambda person: person["c"])
            pose_frames.append(
                {
                    "i": frame_idx,
                    "t": t_ms,
                    "c": best["c"],
                    "l": best["l"],
                }
            )
        frame_idx += 1
    cap.release()
    landmarker.close()

    video_meta = {"w": width, "h": height, "fps": fps}
    (out_dir / "people.json").write_text(
        json.dumps(
            {
                "schemaVersion": 1,
                "poseModelVersion": POSE_MODEL_VERSION,
                "video": video_meta,
                "frames": people_frames,
            }
        )
    )
    (out_dir / "pose.json").write_text(
        json.dumps(
            {
                "schemaVersion": 1,
                "format": "pickle.pose-sequence.v1",
                "coordinateSystem": "normalized_image_top_left",
                "poseModelVersion": POSE_MODEL_VERSION,
                "video": video_meta,
                "frames": pose_frames,
            }
        )
    )
    (out_dir / "ball.json").write_text(
        json.dumps(
            {
                "source": "unavailable-linux-bench (Apple trajectory detection cannot run here; honestly empty)",
                "cameraAssumption": "static",
                "pointTiming": "frame",
                "trajectories": [],
            }
        )
    )
    (out_dir / "extract-meta.json").write_text(
        json.dumps(
            {
                "extractor": POSE_MODEL_VERSION,
                "video": {
                    "durationMs": duration_ms,
                    "w": width,
                    "h": height,
                    "fps": fps,
                    "frameCount": frame_count,
                },
            }
        )
    )
    print(
        json.dumps(
            {
                "video": args.video,
                "framesDecoded": frame_idx,
                "framesWithPose": len(pose_frames),
                "durationMs": duration_ms,
            }
        )
    )


if __name__ == "__main__":
    main()
