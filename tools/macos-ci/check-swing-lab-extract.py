#!/usr/bin/env python3
"""Assert that a `swing-lab extract` run actually exercised the Apple Vision pipeline.

Usage: check-swing-lab-extract.py <out dir>

Checks that extract-meta.json / pose.json exist, that the pose wire schema is
`pickle.pose-sequence.v1`, and that at least one frame carried a detected pose.
Prints a one-line summary suitable for $GITHUB_STEP_SUMMARY on stdout.
"""
import json
import os
import sys

out = sys.argv[1]
meta_path = os.path.join(out, "extract-meta.json")
pose_path = os.path.join(out, "pose.json")
for path in (meta_path, pose_path):
    if not os.path.isfile(path):
        sys.exit(f"::error::swing-lab extract did not write {path}")

with open(meta_path) as fh:
    meta = json.load(fh)
with open(pose_path) as fh:
    pose = json.load(fh)

frames_with_pose = int(meta.get("framesWithPose", 0))
frames_seen = int(meta.get("framesSeen", 0))
schema = pose.get("format")
pose_frames = len(pose.get("frames", []))

print(
    f"swing-lab Apple Vision extract: {frames_with_pose}/{frames_seen} frames with pose, "
    f"{meta.get('trajectoryCount', 0)} ball trajectories, model {meta.get('poseModelVersion')}, "
    f"{meta.get('wallTimeMs')} ms wall; pose.json format={schema} frames={pose_frames}"
)

if frames_seen <= 0:
    sys.exit("::error::the video reader produced no frames")
if frames_with_pose <= 0 or pose_frames <= 0:
    sys.exit("::error::Apple Vision produced zero frames with a detected pose")
if schema != "pickle.pose-sequence.v1":
    sys.exit(f"::error::unexpected pose.json format {schema!r}")
