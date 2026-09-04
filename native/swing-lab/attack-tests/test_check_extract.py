#!/usr/bin/env python3
"""Linux-executable proof that check_extract.py catches each attack outcome.

`swing-lab extract` itself cannot run on Linux (AVFoundation/Vision), so this
suite feeds the checker synthetic five-file output sets that MODEL the CLI's
wire format (main.swift `poseWire` / `peopleWire` / `sceneWire` / `ballWire` /
`meta`) and asserts that:

  * a faithful, healthy output set passes every default check, and
  * each scenario's specific failure mode flips exactly the check that the
    Mac driver (run_mac_attacks.sh) relies on to classify it BROKEN.

It also runs the checker against the real same-SHA Mac artifact when it is
present (SWING_LAB_MAC_EXTRACT_DIR or the default `gh run download` layout) so
the baseline observation is reproduced, not remembered.

    python3 -m unittest native/swing-lab/attack-tests/test_check_extract.py -v
"""

from __future__ import annotations

import argparse
import copy
import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from typing import Any

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import check_extract  # noqa: E402

JOINTS = [
    "head", "left_shoulder", "right_shoulder", "left_elbow", "right_elbow",
    "left_wrist", "right_wrist", "left_hip", "right_hip", "left_knee",
    "right_knee", "left_ankle", "right_ankle",
]


def landmarks(seed: int) -> list[dict[str, Any]]:
    out = []
    for i, name in enumerate(JOINTS):
        x = 0.30 + 0.02 * i + 0.001 * (seed % 7)
        y = 0.20 + 0.04 * i
        out.append({"n": name, "x": round(x, 6), "y": round(y, 6), "v": 0.9})
    return out


def healthy_outputs(
    *,
    w: int = 608,
    h: int = 1080,
    fps: float = 24.0,
    nominal_fps: float = 24.0,
    frames: int = 96,
    pose_every: int = 1,
    cuts: list[int] | None = None,
    duration_ms: int | None = None,
    video_path: str = "fixtures/flat.mp4",
) -> dict[str, dict[str, Any]]:
    interval = 1000.0 / fps
    ts = [int(round(i * interval)) for i in range(frames)]
    duration = duration_ms if duration_ms is not None else int(round(frames * interval))
    cuts = list(cuts or [])
    scores = []
    for i in range(1, frames):
        scores.append({"t": ts[i], "d": 1.5 if ts[i] in cuts else 0.02})
    segments, start = [], 0
    for c in cuts:
        segments.append({"startMs": start, "endMs": c})
        start = c
    segments.append({"startMs": start, "endMs": duration})
    pose_frames = [
        {"i": n, "t": ts[i], "c": 0.8, "l": landmarks(i)}
        for n, i in enumerate(i for i in range(frames) if i % pose_every == 0)
    ]
    people_frames = [{"t": f["t"], "p": [{"c": f["c"], "l": f["l"]}]} for f in pose_frames]
    video = {"w": w, "h": h, "fps": nominal_fps if nominal_fps > 0 else fps}
    return {
        "scenes.json": {
            "schemaVersion": 1,
            "detector": "luma-histogram-chi2-1 (threshold 0.35, deterministic)",
            "scores": scores,
            "cuts": cuts,
            "segments": segments,
        },
        "pose.json": {
            "schemaVersion": 1,
            "format": "pickle.pose-sequence.v1",
            "coordinateSystem": "normalized_image_top_left",
            "poseModelVersion": "apple-vision-bodypose-1",
            "video": video,
            "frames": pose_frames,
        },
        "people.json": {
            "schemaVersion": 1,
            "poseModelVersion": "apple-vision-bodypose-1",
            "video": video,
            "frames": people_frames,
        },
        "ball.json": {
            "cameraAssumption": "stationary",
            "pointTiming": "linear_over_time_range",
            "source": "apple-vision-trajectories-1",
            "trajectories": [
                {"id": "t0", "startMs": 100, "endMs": 400, "points": [
                    {"t": 100, "x": 0.1, "y": 0.5}, {"t": 250, "x": 0.5, "y": 0.4}, {"t": 400, "x": 0.9, "y": 0.5}
                ]}
            ],
        },
        "extract-meta.json": {
            "framesSeen": frames,
            "framesWithPose": len(pose_frames),
            "poseMisses": frames - len(pose_frames),
            "poseModelVersion": "apple-vision-bodypose-1",
            "trajectoryCount": 1,
            "video": {"path": video_path, "w": w, "h": h, "durationMs": duration, "nominalFps": nominal_fps},
            "wallTimeMs": 1234,
        },
    }


def write_outputs(directory: str, outputs: dict[str, dict[str, Any]]) -> None:
    os.makedirs(directory, exist_ok=True)
    for name, payload in outputs.items():
        with open(os.path.join(directory, name), "w", encoding="utf-8") as handle:
            json.dump(payload, handle)


def run_checker(directory: str, **kwargs: Any) -> check_extract.Report:
    parser_defaults = {
        "out_dir": directory,
        "expect_w": None, "expect_h": None, "expect_fps": None, "fps_tolerance": 0.15,
        "expect_duration_ms": None, "expect_cut_period_ms": None, "expect_cut_count": None,
        "expect_video_path": None, "expect_people_empty": False, "min_pose_frames": None,
        "not_before": None, "report": None, "quiet": True,
    }
    parser_defaults.update(kwargs)
    return check_extract.run(argparse.Namespace(**parser_defaults))


def failed_names(report: check_extract.Report) -> list[str]:
    return [c.id for c in report.checks if not c.ok]


class CheckerCatchesEachAttack(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = os.path.join(self.tmp.name, "out")

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_healthy_output_passes_every_default_check(self) -> None:
        write_outputs(self.dir, healthy_outputs(cuts=[500, 1000]))
        report = run_checker(self.dir, expect_w=608, expect_h=1080, expect_cut_period_ms=500,
                             expect_cut_count=2, expect_duration_ms=4000, min_pose_frames=90)
        self.assertEqual(failed_names(report), [])
        self.assertGreaterEqual(len(report.checks), 18)

    # S1 — rotation: encoded-size leak or landmark overflow
    def test_rotated_encoded_size_leak_is_caught(self) -> None:
        write_outputs(self.dir, healthy_outputs(w=1080, h=608))
        report = run_checker(self.dir, expect_w=608, expect_h=1080)
        self.assertIn("video.dimensions.upright", failed_names(report))

    def test_landmark_outside_unit_square_is_caught(self) -> None:
        outputs = healthy_outputs()
        outputs["pose.json"]["frames"][3]["l"][0]["x"] = 1.0001
        outputs["people.json"]["frames"][7]["p"][0]["l"][2]["y"] = -0.01
        write_outputs(self.dir, outputs)
        self.assertIn("pose.landmarks.normalized", failed_names(run_checker(self.dir)))

    # S2 — VFR fallback: fps from pose frames when half the frames have no person
    def test_pose_cadence_fallback_under_reports_fps_by_half(self) -> None:
        outputs = healthy_outputs(nominal_fps=0, frames=96, pose_every=2)
        # main.swift: fps = nominal > 0 ? nominal : effectiveFps(pose frames) → 12 here
        outputs["pose.json"]["video"]["fps"] = 12.0
        outputs["people.json"]["video"]["fps"] = 12.0
        write_outputs(self.dir, outputs)
        report = run_checker(self.dir)
        self.assertIn("video.fps.matches_decoded_cadence", failed_names(report))
        detail = next(c.detail for c in report.checks if c.id == "video.fps.matches_decoded_cadence")
        self.assertRegex(detail, r"ratio=0\.(49|50)")

    def test_fps_matching_decoded_cadence_passes_even_with_sparse_pose(self) -> None:
        outputs = healthy_outputs(nominal_fps=24, frames=96, pose_every=2)
        write_outputs(self.dir, outputs)
        self.assertNotIn("video.fps.matches_decoded_cadence", failed_names(run_checker(self.dir)))

    # S3 — PTS rewind: non-increasing or remapped timestamps
    def test_rewound_pose_timestamp_is_caught(self) -> None:
        outputs = healthy_outputs()
        outputs["pose.json"]["frames"][40]["t"] = outputs["pose.json"]["frames"][20]["t"]
        write_outputs(self.dir, outputs)
        self.assertIn("pose.timestamps.strictly_increasing", failed_names(run_checker(self.dir)))

    def test_remapped_pose_timestamp_is_caught(self) -> None:
        outputs = healthy_outputs()
        # strictly increasing but NOT a decoded PTS: remapped instead of omitted
        outputs["pose.json"]["frames"][40]["t"] += 7
        write_outputs(self.dir, outputs)
        self.assertIn("pose.timestamps.are_decoded_pts", failed_names(run_checker(self.dir)))

    def test_rewound_scene_score_timestamp_is_caught(self) -> None:
        outputs = healthy_outputs()
        outputs["scenes.json"]["scores"][50]["t"] = outputs["scenes.json"]["scores"][10]["t"]
        write_outputs(self.dir, outputs)
        self.assertIn("scenes.scores.strictly_increasing", failed_names(run_checker(self.dir)))

    # S4 — hard cuts: partition and grid
    def test_segment_partition_gap_is_caught(self) -> None:
        outputs = healthy_outputs(cuts=[500, 1000, 1500])
        outputs["scenes.json"]["segments"][-1]["endMs"] = 3990
        write_outputs(self.dir, outputs)
        self.assertIn("scenes.segments.partition_exact", failed_names(run_checker(self.dir)))

    def test_non_monotonic_cuts_are_caught(self) -> None:
        outputs = healthy_outputs(cuts=[500, 1000, 1500])
        outputs["scenes.json"]["cuts"] = [500, 1500, 1000]
        write_outputs(self.dir, outputs)
        self.assertIn("scenes.cuts.strictly_increasing_in_range", failed_names(run_checker(self.dir)))

    def test_missing_cut_or_off_grid_cut_is_caught(self) -> None:
        outputs = healthy_outputs(cuts=[500, 1000, 1500, 2000, 2500, 3000, 3500])
        write_outputs(self.dir, outputs)
        self.assertEqual(failed_names(run_checker(self.dir, expect_cut_period_ms=500, expect_cut_count=7)), [])
        outputs["scenes.json"]["cuts"][3] = 2083  # a 2-frame late detection at 24 fps
        outputs["scenes.json"]["segments"][3]["endMs"] = 2083
        outputs["scenes.json"]["segments"][4]["startMs"] = 2083
        write_outputs(self.dir, outputs)
        self.assertIn("scenes.cuts.expected_grid", failed_names(run_checker(self.dir, expect_cut_period_ms=500, expect_cut_count=7)))

    # S5 — panning: silent relabel of the camera assumption
    def test_camera_assumption_relabel_is_caught(self) -> None:
        for relabel in ("panning", "Stationary", "stationary ", None):
            outputs = healthy_outputs()
            outputs["ball.json"]["cameraAssumption"] = relabel
            write_outputs(self.dir, outputs)
            self.assertIn("ball.cameraAssumption.verbatim_stationary", failed_names(run_checker(self.dir)), relabel)

    # S7 — overwrite: stale sibling files from an earlier run
    def test_stale_people_json_from_previous_run_is_caught(self) -> None:
        run1 = healthy_outputs(video_path="a.mp4")
        write_outputs(self.dir, run1)
        stale_time = time.time() - 120
        for name in ("people.json",):
            os.utime(os.path.join(self.dir, name), (stale_time, stale_time))
        run2 = healthy_outputs(video_path="b.mp4", pose_every=1)
        del run2["people.json"]  # simulate run 2 never rewriting it
        not_before = time.time() - 60
        write_outputs(self.dir, run2)
        report = run_checker(self.dir, not_before=not_before, expect_video_path="b.mp4")
        self.assertIn("files.rewritten_after", failed_names(report))

    def test_people_json_with_frames_when_second_run_saw_nobody_is_caught(self) -> None:
        outputs = healthy_outputs(cuts=[500])
        write_outputs(self.dir, outputs)  # people.json still has frames → stale
        self.assertIn("people.frames.empty", failed_names(run_checker(self.dir, expect_people_empty=True)))

    def test_missing_output_file_is_caught(self) -> None:
        outputs = healthy_outputs()
        del outputs["ball.json"]
        write_outputs(self.dir, outputs)
        self.assertIn("files.present", failed_names(run_checker(self.dir)))

    # Baseline: meta.durationMs vs decoded media (the observation on run 33841813597)
    def test_asset_duration_double_of_decoded_media_is_caught(self) -> None:
        outputs = healthy_outputs(frames=96, duration_ms=8000)
        write_outputs(self.dir, outputs)
        self.assertIn("video.duration.matches_decoded_media", failed_names(run_checker(self.dir)))


class BaselineMacArtifact(unittest.TestCase):
    """Reproduce the checker's result on the real same-SHA Mac artifact.

    The artifact is Apple truth (`gh run download 33841813597 -n mac-full-verify-3`).
    When present, the checker MUST reproduce exactly the two baseline
    observations (fps and duration) and nothing else; when absent this test
    fails loudly instead of passing vacuously — set SWING_LAB_MAC_EXTRACT_DIR
    or SWING_LAB_ALLOW_MISSING_MAC_ARTIFACT=1 to acknowledge the gap.
    """

    CANDIDATES = [
        os.environ.get("SWING_LAB_MAC_EXTRACT_DIR", ""),
        os.path.expanduser("~/mac-artifacts/run-33841813597/mac-full-verify-3/swing-lab-extract"),
        os.path.join(HERE, "..", "..", "..", "artifacts", "mac-full-verify-3", "swing-lab-extract"),
    ]

    def test_reproduces_baseline_fps_and_duration_observations(self) -> None:
        directory = next((c for c in self.CANDIDATES if c and os.path.isdir(c)), None)
        if directory is None:
            if os.environ.get("SWING_LAB_ALLOW_MISSING_MAC_ARTIFACT") == "1":
                self.skipTest("same-SHA Mac artifact not present (acknowledged via env)")
            self.fail("same-SHA Mac artifact missing: gh run download 33841813597 -n mac-full-verify-3 "
                      "and set SWING_LAB_MAC_EXTRACT_DIR")
        report = run_checker(directory, expect_video_path="datasets/pickleball/fresh-candidates/va-O1dLhGGPErc.mp4",
                             min_pose_frames=1)
        failed = failed_names(report)
        self.assertEqual(
            sorted(failed),
            ["video.duration.matches_decoded_media", "video.fps.matches_decoded_cadence"],
            f"unexpected checker result on {directory}: {failed}",
        )
        fps_detail = next(c.detail for c in report.checks if c.id == "video.fps.matches_decoded_cadence")
        self.assertIn("pose.video.fps=12", fps_detail)
        self.assertIn("ratio=0.5", fps_detail)


class FixtureGeneratorContract(unittest.TestCase):
    """make_fixtures.sh must self-verify; run it when ffmpeg is available."""

    def test_fixtures_generate_and_self_verify(self) -> None:
        if not (subprocess.run(["which", "ffmpeg"], capture_output=True).returncode == 0):
            self.fail("ffmpeg missing — fixtures cannot be generated (install ffmpeg; a skip is not a pass)")
        with tempfile.TemporaryDirectory() as tmp:
            proc = subprocess.run(["bash", os.path.join(HERE, "fixtures", "make_fixtures.sh"), tmp],
                                  capture_output=True, text=True)
            self.assertEqual(proc.returncode, 0, proc.stdout[-2000:] + proc.stderr[-2000:])
            with open(os.path.join(tmp, "manifest.json"), encoding="utf-8") as handle:
                manifest = json.load(handle)
            self.assertEqual(manifest["seed"], 20260904)
            for name in ("rotated90.mp4", "vfr-half-visible.mp4", "vfr-alternate-frames.mp4",
                         "pts-rewind-elst.mp4", "pts-rewind-ctts.mp4", "hardcuts-500ms.mp4",
                         "panning.mp4", "audio-only.m4a", "one-frame.mp4", "corrupt-seeded.mp4", "empty.mp4"):
                self.assertIn(name, manifest["fixtures"])
                self.assertTrue(os.path.exists(os.path.join(tmp, name)), name)
            rotated = manifest["fixtures"]["rotated90.mp4"]["ffprobe"]["streams"][0]
            self.assertEqual((rotated["width"], rotated["height"]), (1080, 608))
            audio = manifest["fixtures"]["audio-only.m4a"]["ffprobe"]["streams"]
            self.assertEqual([s["codec_type"] for s in audio], ["audio"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
