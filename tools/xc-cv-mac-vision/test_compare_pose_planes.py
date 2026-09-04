#!/usr/bin/env python3
"""Unit tests for the Apple-vs-Linux pose plane comparison harness.

Run: python3 -m unittest discover -s tools/xc-cv-mac-vision -p 'test_*.py'

Fixtures are synthetic; nothing here claims Apple behaviour. The real-artifact
run is documented in README.md.
"""

from __future__ import annotations

import json
import os
import sqlite3
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import compare_pose_planes as cpp  # noqa: E402
import xcresult_sqlite_summary as xcs  # noqa: E402


def _landmarks(shift: float = 0.0, visibility: float = 0.9, zero_head: bool = False):
    marks = []
    for index, name in enumerate(cpp.JOINTS_13):
        if zero_head and name == "head":
            marks.append({"n": name, "x": 0, "y": 0, "v": 0})
        else:
            marks.append({"n": name, "x": 0.3 + 0.02 * index + shift, "y": 0.2 + 0.05 * index, "v": visibility})
    return marks


def _frames(timestamps, dense_index: bool, fps: float, shift: float = 0.0, conf: float = 0.5, zero_head=False):
    frames = []
    for ordinal, t in enumerate(timestamps):
        frames.append(
            {
                "i": ordinal if dense_index else int(round(t * fps / 1000.0)),
                "t": t,
                "c": conf,
                "l": _landmarks(shift=shift, zero_head=zero_head),
            }
        )
    return frames


def _write_plane(directory: str, frames, declared_fps: float, model: str, duration_ms: float, people_per_frame: int = 1):
    os.makedirs(directory, exist_ok=True)
    video = {"w": 608, "h": 1080, "fps": declared_fps}
    with open(os.path.join(directory, "pose.json"), "w", encoding="utf-8") as fh:
        json.dump(
            {
                "schemaVersion": 1,
                "format": "pickle.pose-sequence.v1",
                "coordinateSystem": "normalized_image_top_left",
                "poseModelVersion": model,
                "video": video,
                "frames": frames,
            },
            fh,
        )
    with open(os.path.join(directory, "people.json"), "w", encoding="utf-8") as fh:
        json.dump(
            {
                "schemaVersion": 1,
                "poseModelVersion": model,
                "video": video,
                "frames": [
                    {"t": frame["t"], "p": [{"c": frame["c"], "l": frame["l"]}] * people_per_frame}
                    for frame in frames
                ],
            },
            fh,
        )
    with open(os.path.join(directory, "extract-meta.json"), "w", encoding="utf-8") as fh:
        json.dump({"video": {"durationMs": duration_ms, "fps": declared_fps}}, fh)


class AnalyzePlaneTests(unittest.TestCase):
    def test_declared_fps_inconsistent_with_timestamps_is_flagged(self):
        with tempfile.TemporaryDirectory() as tmp:
            # 24 fps cadence (41.67 ms) but the writer declared 12 fps — the
            # exact shape seen in the M4 artifact for the AV1 clip.
            timestamps = [round(1000 + i * 1000 / 24) for i in range(50)]
            _write_plane(tmp, _frames(timestamps, True, 24), 12, "apple-vision-bodypose-1", 121750)
            plane = cpp.analyze_plane("apple", tmp)
            self.assertEqual(plane["poseCount"], 50)
            self.assertTrue(plane["frameIndexSemantics"]["isDenseCounterFromZero"])
            self.assertFalse(plane["fpsConsistency"]["consistent"])
            self.assertAlmostEqual(plane["fpsConsistency"]["ratioDeclaredOverImplied"], 0.5, places=1)

    def test_consistent_fps_and_sparse_index(self):
        with tempfile.TemporaryDirectory() as tmp:
            timestamps = [i * 1000 / 24 for i in range(60) if i % 7 != 0]
            _write_plane(tmp, _frames(timestamps, False, 24), 24.0, "mediapipe-LINUX-BENCH", 2500)
            plane = cpp.analyze_plane("linux", tmp)
            self.assertTrue(plane["fpsConsistency"]["consistent"])
            self.assertFalse(plane["frameIndexSemantics"]["isDenseCounterFromZero"])
            self.assertEqual(plane["frameIndexSemantics"]["fractionMatchingRoundedTimestampTimesFps"], 1.0)
            self.assertGreater(len(plane["cadence"]["gapsOverOneFrame"]), 0)

    def test_zeroed_landmarks_are_counted_per_joint(self):
        with tempfile.TemporaryDirectory() as tmp:
            timestamps = [i * 1000 / 24 for i in range(10)]
            _write_plane(tmp, _frames(timestamps, True, 24, zero_head=True), 24.0, "m", 400)
            plane = cpp.analyze_plane("x", tmp)
            self.assertEqual(plane["perJoint"]["head"]["zeroedFraction"], 1.0)
            self.assertEqual(plane["perJoint"]["head"]["visibleFraction"], 0.0)
            self.assertEqual(plane["perJoint"]["left_hip"]["visibleFraction"], 1.0)
            self.assertEqual(plane["fullBodyFrameFraction"], 1.0)  # head is not a core joint

    def test_confidence_histogram_and_distribution(self):
        hist = cpp._histogram([0.05, 0.15, 0.95, 1.0], cpp.CONFIDENCE_BINS)
        self.assertEqual(sum(b["count"] for b in hist), 4)
        self.assertEqual(hist[-1]["count"], 2)
        dist = cpp._distribution([1.0, 2.0, 3.0, 4.0])
        self.assertEqual(dist["percentiles"]["p50"], 2.5)
        self.assertEqual(dist["min"], 1.0)
        self.assertEqual(cpp._distribution([])["count"], 0)


class AlignmentTests(unittest.TestCase):
    def test_confusion_matrix_and_position_deltas(self):
        fps = 24.0
        apple_ts = [i * 1000 / fps for i in range(0, 20)]  # frames 0..19
        linux_ts = [i * 1000 / fps for i in range(5, 25)]  # frames 5..24
        apple = _frames(apple_ts, True, fps, shift=0.0)
        linux = _frames(linux_ts, False, fps, shift=0.01)
        align = cpp.align_planes(apple, linux, fps, 30, tolerance_ms=21)
        cm = align["confusionMatrix"]
        self.assertEqual(cm, {"bothPose": 15, "appleOnly": 5, "linuxOnly": 5, "neither": 5})
        self.assertEqual(align["appleOnlyRuns"], [{"fromFrame": 0, "toFrame": 4, "length": 5}])
        self.assertEqual(align["linuxOnlyRuns"], [{"fromFrame": 20, "toFrame": 24, "length": 5}])
        self.assertEqual(align["neitherRuns"], [{"fromFrame": 25, "toFrame": 29, "length": 5}])
        delta = align["perJointPositionDeltaNormalized"]["left_wrist"]
        self.assertEqual(delta["count"], 15)
        self.assertAlmostEqual(delta["percentiles"]["p50"], 0.01, places=6)
        self.assertEqual(align["torsoMidWithin0_10Fraction"], 1.0)
        self.assertEqual(align["perJointVisibilityAgreement"]["head"], {"apple=1,linux=1": 15})

    def test_different_subject_is_not_counted_as_same(self):
        fps = 24.0
        ts = [i * 1000 / fps for i in range(10)]
        align = cpp.align_planes(_frames(ts, True, fps), _frames(ts, False, fps, shift=0.4), fps, 10, 21)
        self.assertEqual(align["confusionMatrix"]["bothPose"], 10)
        self.assertEqual(align["torsoMidWithin0_10Fraction"], 0.0)

    def test_off_grid_timestamps_are_not_matched(self):
        fps = 24.0
        apple = _frames([0.0, 41.667], True, fps)
        linux = _frames([20.0, 62.0], False, fps)  # ~half a frame off the grid
        align = cpp.align_planes(apple, linux, fps, 3, tolerance_ms=5)
        self.assertEqual(align["confusionMatrix"]["bothPose"], 0)
        self.assertEqual(align["confusionMatrix"]["appleOnly"], 2)


class MainTests(unittest.TestCase):
    def test_end_to_end_writes_json_and_markdown_with_flags(self):
        with tempfile.TemporaryDirectory() as tmp:
            apple_dir = os.path.join(tmp, "apple")
            linux_dir = os.path.join(tmp, "linux")
            out = os.path.join(tmp, "out")
            ts = [round(i * 1000 / 24) for i in range(48)]
            _write_plane(apple_dir, _frames(ts, True, 24, conf=0.4), 12, "apple-vision-bodypose-1", 4000, people_per_frame=2)
            _write_plane(linux_dir, _frames(ts[4:], False, 24, conf=0.8), 24.0, "mediapipe-LINUX-BENCH", 2000)
            linux_report = os.path.join(tmp, "linux-report.json")
            with open(linux_report, "w", encoding="utf-8") as fh:
                json.dump({"outcome": {"kind": "not_analyzable"}, "quality": {}, "player": {}, "contact": {}}, fh)
            code = cpp.main(
                [
                    "--apple", apple_dir,
                    "--linux", linux_dir,
                    "--out", out,
                    "--source-fps", "24",
                    "--source-frames", "48",
                    "--source-duration-ms", "2000",
                    "--linux-report", linux_report,
                ]
            )
            self.assertEqual(code, 0)
            with open(os.path.join(out, "comparison.json"), encoding="utf-8") as fh:
                result = json.load(fh)
            flags = "\n".join(result["divergenceFlags"])
            self.assertIn("apple: declared video.fps=12.0", flags)
            self.assertIn("extract-meta durationMs=4000 vs source 2000", flags)
            self.assertIn("frameIndex `i` semantics differ", flags)
            self.assertIn("linux: no scenes.json", flags)
            self.assertEqual(result["alignment"]["confusionMatrix"]["appleOnly"], 4)
            self.assertEqual(result["apple"]["people"]["peoplePerFrame"]["mean"], 2.0)
            self.assertTrue(os.path.isfile(os.path.join(out, "comparison.md")))

    def test_missing_inputs_exit_2(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.assertEqual(cpp.main(["--apple", tmp, "--linux", tmp, "--out", tmp, "--source-fps", "24", "--source-frames", "1"]), 2)


def _make_xcresult(path: str, results):
    os.makedirs(path, exist_ok=True)
    con = sqlite3.connect(os.path.join(path, "database.sqlite3"))
    con.executescript(
        """
        CREATE TABLE TestSuites (summary TEXT, name TEXT, parentSuite_fk INTEGER, testable_fk INTEGER, identifier TEXT, orderInParent INTEGER, identifierURL TEXT);
        CREATE TABLE TestCases (summary TEXT, orderInTestSuite INTEGER, testSuite_fk INTEGER NOT NULL, name TEXT, identifier TEXT, identifierURL TEXT);
        CREATE TABLE TestCaseRuns (duration REAL, result TEXT, skipNotice_fk INTEGER, testCase_fk INTEGER NOT NULL, dynamicTestParameters_fk INTEGER, repetitionPolicy_fk INTEGER, testSuiteRun_fk INTEGER NOT NULL, orderInTestSuiteRun INTEGER);
        CREATE TABLE Devices (modelUTI TEXT, operatingSystemVersionWithBuildNumber TEXT, modelName TEXT, cpuSpeedInMHz INTEGER, name TEXT, nativeArchitecture TEXT, busSpeedInMHz INTEGER, ramSizeInMegabytes INTEGER, isConcreteDevice INTEGER, operatingSystemVersion TEXT, modelCode TEXT, identifier TEXT, cpuKind TEXT, logicalCPUCoresPerPackage INTEGER, cpuCount INTEGER, isWireless INTEGER, platform_fk INTEGER, physicalCPUCoresPerPackage INTEGER);
        CREATE TABLE SDKs (name TEXT, identifier TEXT, isInternal INTEGER, operatingSystemVersion TEXT);
        CREATE TABLE Actions (started REAL, finished REAL, runDestination_fk INTEGER, diagnosticsRef TEXT, invocation_fk INTEGER NOT NULL, name TEXT, orderInInvocation INTEGER, testPlan_fk INTEGER NOT NULL, host_fk INTEGER, developerTools_fk INTEGER);
        """
    )
    con.execute("INSERT INTO TestSuites (name) VALUES ('SuiteA')")
    con.execute("INSERT INTO Devices (name, modelName, operatingSystemVersionWithBuildNumber, nativeArchitecture, cpuKind, isConcreteDevice) VALUES ('My Mac','MacBook Pro','26.6','arm64e','Apple M4',1)")
    con.execute("INSERT INTO SDKs (name, identifier) VALUES ('macOS 26.4','macosx26.4')")
    con.execute("INSERT INTO Actions (started, finished, invocation_fk, name, testPlan_fk) VALUES (0, 7.5, 1, 'Test', 1)")
    for index, (name, result, duration) in enumerate(results):
        con.execute("INSERT INTO TestCases (orderInTestSuite, testSuite_fk, name) VALUES (?, 1, ?)", (index, name))
        con.execute(
            "INSERT INTO TestCaseRuns (duration, result, testCase_fk, testSuiteRun_fk, orderInTestSuiteRun) VALUES (?, ?, ?, 1, ?)",
            (duration, result, index + 1, index),
        )
    con.commit()
    con.close()


class XcresultSummaryTests(unittest.TestCase):
    def test_all_success_exit_0(self):
        with tempfile.TemporaryDirectory() as tmp:
            bundle = os.path.join(tmp, "ok.xcresult")
            _make_xcresult(bundle, [("testA()", "Success", 0.01), ("testB()", "Success", 0.02)])
            out = os.path.join(tmp, "summary.json")
            self.assertEqual(xcs.main(["--out", out, bundle]), 0)
            with open(out, encoding="utf-8") as fh:
                data = json.load(fh)["bundles"][0]
            self.assertEqual(data["resultCounts"], {"Success": 2})
            self.assertEqual(data["suites"], {"SuiteA": {"Success": 2}})
            self.assertEqual(data["devices"][0]["cpu"], "Apple M4")
            self.assertEqual(data["actions"][0]["seconds"], 7.5)

    def test_failure_exit_1(self):
        with tempfile.TemporaryDirectory() as tmp:
            bundle = os.path.join(tmp, "bad.xcresult")
            _make_xcresult(bundle, [("testA()", "Success", 0.01), ("testB()", "Failure", 0.02), ("testC()", "Skipped", 0)])
            out = os.path.join(tmp, "summary.json")
            self.assertEqual(xcs.main(["--out", out, bundle]), 1)
            with open(out, encoding="utf-8") as fh:
                data = json.load(fh)["bundles"][0]
            self.assertEqual(len(data["nonSuccess"]), 2)

    def test_build_only_bundle_is_unreadable_not_pass(self):
        with tempfile.TemporaryDirectory() as tmp:
            bundle = os.path.join(tmp, "build.xcresult")
            os.makedirs(bundle)
            sqlite3.connect(os.path.join(bundle, "database.sqlite3")).close()
            out = os.path.join(tmp, "summary.json")
            self.assertEqual(xcs.main(["--out", out, bundle]), 2)
            missing = os.path.join(tmp, "missing.xcresult")
            os.makedirs(missing)
            self.assertEqual(xcs.main(["--out", out, missing]), 2)


if __name__ == "__main__":
    unittest.main()
