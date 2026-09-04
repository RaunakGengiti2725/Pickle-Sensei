#!/usr/bin/env python3
"""Structural probes for native/swing-lab + native/camera-engine (audit pass).

Linux cannot compile Swift or drive AVFoundation, so each probe pins ONE
structural contract by reading the Swift sources at the repo root. A failing
probe is a suspected defect that a Mac-plane test should later reproduce at
runtime; a passing probe is a contract that holds on this revision.

Run from the repo root:
  python3 -m unittest tools/audit/native-swing-lab-camera-engine/test_native_structural_contracts.py -v
"""

from __future__ import annotations

import re
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
SWING_LAB = REPO / "native/swing-lab/Sources/main.swift"
CAMERA_ENGINE = REPO / "native/camera-engine/Sources/CameraEngine.swift"
COORDINATOR = REPO / "native/camera-engine/Sources/SessionCaptureCoordinator.swift"
PODSPEC = REPO / "apps/mobile/ios/LocalPods/PickleNative/PickleNative.podspec"
POD_CORE = REPO / "apps/mobile/ios/LocalPods/PickleNative/Sources/Core"
SCOPE_FILES = [SWING_LAB, CAMERA_ENGINE, COORDINATOR]


def source(path: Path) -> str:
    return path.read_text()


def line_of(path: Path, needle: str, start: int = 0) -> int:
    """1-based line of the first occurrence of `needle` at or after `start` (0 if absent)."""
    text = source(path)
    index = text.find(needle, start)
    if index < 0:
        return 0
    return text.count("\n", 0, index) + 1


def body_of(path: Path, signature: str, after: str | None = None) -> str:
    """Text of the brace-balanced block that starts at `signature` (searched after `after`)."""
    text = source(path)
    start = text.index(signature, text.index(after) if after else 0)
    open_brace = text.index("{", start)
    depth = 0
    for position in range(open_brace, len(text)):
        if text[position] == "{":
            depth += 1
        elif text[position] == "}":
            depth -= 1
            if depth == 0:
                return text[start : position + 1]
    raise AssertionError(f"unbalanced block at {signature!r} in {path}")


class SwingLabExtractMetadata(unittest.TestCase):
    """video.fps / durationMs written by `swing-lab extract`."""

    def test_written_fps_is_measured_from_decoded_frames_not_nominal_frame_rate(self):
        # Contract: the fps that pose.json/people.json carry must describe the
        # frames the extractor actually decoded. `nominalFrameRate` is container
        # metadata AVFoundation reports; on the committed CI clip it is 12 while
        # the decoded cadence is 24 (see check_extract_consistency.py).
        text = source(SWING_LAB)
        prefers_nominal = re.findall(r'"fps":\s*readerBox\.fps\s*>\s*0\s*\?\s*readerBox\.fps\s*:\s*effectiveFps', text)
        self.assertFalse(
            prefers_nominal,
            f"main.swift:{line_of(SWING_LAB, '\"fps\": readerBox.fps > 0 ? readerBox.fps : effectiveFps')} "
            "writes nominalFrameRate whenever it is > 0 and only falls back to the measured cadence when it is 0",
        )

    def test_fallback_fps_is_derived_from_all_decoded_frames_not_pose_frames(self):
        text = source(SWING_LAB)
        # `frames` is the POSE frame array (frames without a pose are skipped), so
        # the fallback under-counts whenever Vision misses frames.
        fallback = re.search(r"effectiveFps = Double\(frames\.count - 1\) \* 1000 / Double\(last - first\)", text)
        self.assertFalse(
            fallback,
            f"main.swift:{line_of(SWING_LAB, 'effectiveFps = Double(frames.count - 1)')} computes effectiveFps from "
            "pose frames (`frames`), not from every decoded frame (`framesSeen`)",
        )

    def test_duration_is_bounded_by_decoded_frames(self):
        # `durationMs` is `asset.load(.duration)`; the last scene segment and
        # extract-meta report it verbatim. It is never reconciled with the last
        # decoded presentation timestamp (121750 vs 60833 ms on the CI clip).
        text = source(SWING_LAB)
        self.assertFalse(
            '"endMs": readerBox.durationMs' in text,
            f"main.swift:{line_of(SWING_LAB, '\"endMs\": readerBox.durationMs')} closes the last scene segment at "
            "the container duration, not at the last decoded frame",
        )


class SwingLabErrorHandling(unittest.TestCase):
    def test_trajectory_request_errors_are_not_silenced(self):
        text = source(SWING_LAB)
        self.assertFalse(
            "try? handler.perform([trajectoryRequest])" in text,
            f"main.swift:{line_of(SWING_LAB, 'try? handler.perform([trajectoryRequest])')} discards every "
            "VNDetectTrajectoriesRequest error; a clip whose frames all fail yields an empty ball.json and exit 0",
        )

    def test_trajectory_request_is_fed_only_monotonic_samples(self):
        # The stateful trajectory request is performed BEFORE the monotonic-PTS
        # guard, so a rewinding clip feeds it out-of-order samples (Vision then
        # throws, and the previous probe shows that throw is swallowed).
        perform_line = line_of(SWING_LAB, "handler.perform([trajectoryRequest])")
        guard_line = line_of(SWING_LAB, "guard frame.timestampMs > lastTimestampMs else { continue }")
        self.assertTrue(perform_line and guard_line, "expected both statements in main.swift")
        self.assertGreater(
            perform_line,
            guard_line,
            f"main.swift:{perform_line} performs the trajectory request before the monotonic guard at "
            f"main.swift:{guard_line}",
        )

    def test_output_directory_is_created_only_after_input_is_readable(self):
        create_line = line_of(SWING_LAB, "try FileManager.default.createDirectory(atPath: outDir")
        reader_line = line_of(SWING_LAB, "let readerBox = try await UprightVideoReader(url: videoURL)")
        self.assertTrue(create_line and reader_line, "expected both statements in main.swift")
        self.assertGreater(
            create_line,
            reader_line,
            f"main.swift:{create_line} creates --out before main.swift:{reader_line} validates the input; an "
            "unreadable clip exits 1 and leaves an empty --out directory behind",
        )

    def test_extract_writes_are_all_or_nothing(self):
        # scenes/pose/people/ball/extract-meta are written sequentially; a throw
        # between writes (disk full, encoding failure) leaves a partial bundle.
        body = body_of(SWING_LAB, "func runExtract(")
        writes = re.findall(r'to: "\\\(outDir\)/([a-z-]+\.json)"', body)
        self.assertEqual(
            writes,
            ["scenes.json", "pose.json", "people.json", "ball.json", "extract-meta.json"],
            "runExtract output list drifted from the documented bundle",
        )
        self.assertTrue(
            "do {" in body and "catch" in body and "removeItem" in body,
            "runExtract has no cleanup path: a failure after the first write leaves a partial --out bundle",
        )


class SwingLabDocs(unittest.TestCase):
    def test_no_todo_fixme_hack_markers_in_scope(self):
        for path in SCOPE_FILES:
            self.assertNotRegex(source(path), r"\b(TODO|FIXME|HACK|XXX)\b", str(path))

    def test_scene_detector_string_matches_threshold_constant(self):
        text = source(SWING_LAB)
        detector = re.search(r'"detector":\s*"luma-histogram-chi2-1 \(threshold ([0-9.]+), deterministic\)"', text)
        self.assertIsNotNone(detector, "detector string not found")
        threshold = re.search(r"\b(?:let|var) (?:sceneCutThreshold|cutThreshold|threshold)\b[^\n]*=\s*([0-9.]+)", text)
        literal_uses = set(re.findall(r"(?:>|>=)\s*(0\.35)\b", text))
        self.assertTrue(
            (threshold and threshold.group(1) == detector.group(1)) or detector.group(1) in literal_uses,
            f"detector string claims threshold {detector.group(1)} but no matching threshold is applied",
        )


class CameraEngineContracts(unittest.TestCase):
    def test_discard_active_recording_is_guarded_by_is_recording(self):
        body = body_of(CAMERA_ENGINE, "public func discardActiveRecording()")
        self.assertIn("guard self.movieOutput.isRecording else { return }", body)
        self.assertIn("suppressNextRecordingFinish = true", body)

    def test_recording_delegate_deletes_file_on_every_failure_branch(self):
        body = body_of(CAMERA_ENGINE, "public func fileOutput(", after="didStartRecordingTo")
        self.assertGreaterEqual(
            body.count("try? FileManager.default.removeItem(at: outputFileURL)"),
            3,
            "expected deletion on suppressed / error-without-success-key / no-valid-frames branches",
        )
        self.assertIn("AVErrorRecordingSuccessfullyFinishedKey", body)

    def test_start_recording_reports_session_not_running_and_duplicate(self):
        body = body_of(CAMERA_ENGINE, "public func startContinuousRecording(to url: URL)")
        self.assertIn("EngineError.sessionNotRunning", body)
        self.assertIn("EngineError.recordingAlreadyActive", body)

    def test_stop_timestamp_cleanup_is_owned_by_exactly_one_party(self):
        # stop() defers timestamp cleanup to the recording delegate when a movie
        # was active (AVCaptureMovieFileOutput always delivers didFinishRecordingTo
        # after stopRecording). The delegate must therefore clear the timestamps
        # itself, before any early return.
        stop_body = body_of(CAMERA_ENGINE, "public func stop()")
        self.assertIn("if !wasRecording { self.clearRecordingTimestamps() }", stop_body)
        delegate = body_of(CAMERA_ENGINE, "public func fileOutput(", after="didStartRecordingTo")
        first_clear = delegate.find("recordingFirstFrameTimestampMs = nil")
        first_return = delegate.find("return")
        self.assertGreater(first_clear, 0, "delegate never clears recordingFirstFrameTimestampMs")
        self.assertLess(first_clear, first_return, "delegate returns before clearing recording timestamps")
        self.assertIn("activeRecordingURL = nil", delegate[:first_return])


class SessionCaptureCoordinatorContracts(unittest.TestCase):
    def test_start_observes_engine_session_events(self):
        text = source(COORDINATOR)
        self.assertTrue(
            "engine.onSessionEvent" in text,
            f"SessionCaptureCoordinator.swift:{line_of(COORDINATOR, 'func start() async throws')} never assigns "
            "engine.onSessionEvent, so .failed / .interrupted from CameraEngine are invisible to the caller",
        )

    def test_start_handles_recording_start_failure(self):
        body = body_of(COORDINATOR, "func start() async throws")
        self.assertTrue(
            ".failure" in body,
            f"SessionCaptureCoordinator.swift:{line_of(COORDINATOR, 'engine.onRecordingFinished = { result in')} "
            "handles only .success; sessionNotRunning / recordingAlreadyActive / recordingFailed are dropped",
        )

    def test_recording_url_is_invalidated_or_restarted_when_the_movie_finishes(self):
        # movieOutput.maxRecordedDuration = maximumSessionSeconds (1800 s). When
        # it fires the delegate deletes the movie, yet recordingURL stays set and
        # handleFrame keeps streaming motion samples, so every later extract()
        # polls a deleted file for coverageTimeoutMs and fails windowNotCovered.
        body = body_of(COORDINATOR, "engine.onRecordingFinished = { result in")
        self.assertTrue(
            "recordingURL" in body or "startContinuousRecording" in body,
            f"SessionCaptureCoordinator.swift:{line_of(COORDINATOR, 'engine.onRecordingFinished = { result in')} "
            "neither clears recordingURL nor restarts the rolling recording after the movie finalizes",
        )

    def test_header_doc_mentions_the_session_length_cap(self):
        header = source(COORDINATOR).split("final class SessionCaptureCoordinator")[0]
        self.assertTrue(
            re.search(r"1[_ ,]?800|30 ?min|maximumSessionSeconds", header),
            "header promises a continuous rolling recording but never mentions the 1800 s maxRecordedDuration cap",
        )

    def test_coverage_polling_does_not_block_the_serial_extraction_queue(self):
        body = body_of(COORDINATOR, "private func awaitCoverageAndExport(")
        self.assertFalse(
            "Thread.sleep(forTimeInterval: Double(Self.coveragePollMs) / 1_000)" in body,
            f"SessionCaptureCoordinator.swift:{line_of(COORDINATOR, 'Thread.sleep(forTimeInterval: Double(Self.coveragePollMs)')} "
            "sleeps on the serial extractionQueue; concurrent extract() calls serialize behind up to coverageTimeoutMs each",
        )

    def test_truthful_failure_paths_exist(self):
        body = body_of(COORDINATOR, "func extract(")
        for case in ("alreadyStopped", "recordingNotStarted", "invalidBounds"):
            self.assertIn(f"CoordinatorError.{case}", body)
        self.assertIn("windowNotCovered", source(COORDINATOR))

    def test_pose_and_evidence_retention_are_bounded(self):
        text = source(COORDINATOR)
        self.assertIn("poseHistoryWindowMs = 15_000", text)
        self.assertIn("evidenceRetentionMs = 15_000", text)
        self.assertIn("poseHistory.removeFirst(firstKept)", text)


class PodCoupling(unittest.TestCase):
    def test_pod_core_symlinks_match_podspec_and_resolve_into_native(self):
        podspec = source(PODSPEC)
        listed = set(re.findall(r'"Sources/Core/([A-Za-z]+\.swift)"', podspec))
        on_disk = {p.name for p in POD_CORE.iterdir()}
        self.assertEqual(listed, on_disk, "podspec Sources/Core list and symlinks on disk differ")
        for entry in POD_CORE.iterdir():
            self.assertTrue(entry.is_symlink(), f"{entry} is not a symlink")
            target = entry.resolve()
            self.assertTrue(target.is_file(), f"{entry} -> {target} does not resolve")
            self.assertEqual(target.parts[-4], "native", f"{entry} does not point into native/: {target}")

    def test_native_scope_has_no_network_or_persistence_imports(self):
        for path in SCOPE_FILES:
            self.assertNotRegex(
                source(path),
                r"import (Network|Security|SQLite3?|CoreData)|URLSession|Keychain|Supabase|RevenueCat",
                str(path),
            )


if __name__ == "__main__":
    unittest.main()
