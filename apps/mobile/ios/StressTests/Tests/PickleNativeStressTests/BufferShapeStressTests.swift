import Foundation
import XCTest
@testable import PickleNativeStressCore
@testable import PickleNativeStressKit

/// Empty / one-frame / huge / corrupt inputs through the Foundation-only
/// bridge core (the same production files the LocalPod compiles).
final class BufferShapeStressTests: XCTestCase {
  func testEmptyAndSingleFrameNeverProduceEvidenceOrEvents() {
    let outcomes = StressCampaign.assertHeld(.emptyAndSingleFrame)
    XCTAssertEqual(outcomes.count, StressCampaign.iterations)
  }

  func testCorruptLandmarksNeverLeakIntoSummariesOrOverlays() {
    let outcomes = StressCampaign.assertHeld(.hugeAndCorruptInputs)
    let corrupted = outcomes.reduce(0.0) { $0 + ($1.metrics["corruptedFrames"] ?? 0) }
    XCTAssertGreaterThan(corrupted, 0, "campaign did not inject any corruption")
  }

  func testEveryCorruptionKindIsSurvivedByEveryConsumerExceptDuplicateNames() {
    var rng = StressRNG(seed: 0xC0FFEE)
    for corruption in PoseSynth.nonDuplicatingCorruptions {
      for _ in 0 ..< 20 {
        let athlete = PoseSynth.Athlete.readyFraming(&rng)
        let clean = PoseSynth.frame(athlete, arm: .still, timestampMs: rng.int(in: 0 ... 1_000_000), rng: &rng)
        let frame = PoseSynth.corrupt(clean, with: corruption, rng: &rng)
        let detector = TemporalStrokeDetector()
        XCTAssertNil(detector.ingest(pose: frame, paddle: nil), "\(corruption) produced a stroke from one frame")
        let snapshot = PoseReadinessEvaluator().ingest(pose: frame)
        XCTAssertFalse(snapshot.isReady, "\(corruption): ready from one frame")
        XCTAssert((0 ... 1).contains(snapshot.jointCoverage), "\(corruption): coverage \(snapshot.jointCoverage)")
        let evidence = CaptureEvidenceAccumulator()
        evidence.ingest(pose: frame)
        if let summary = evidence.summary(startMs: frame.timestampMs, endMs: frame.timestampMs, poseSource: "s", poseModelVersion: "m", triggerAlgorithmVersion: "a") {
          XCTAssert((0 ... 1).contains(summary.meanCanonicalJointVisibility), "\(corruption): visibility \(summary.meanCanonicalJointVisibility)")
        }
        var trail = PoseMotionTrailBuffer()
        trail.ingest(landmarks: frame.landmarks, timestampMs: frame.timestampMs)
        XCTAssertLessThanOrEqual(trail.storedSampleCount, 8, "\(corruption): trail stored \(trail.storedSampleCount)")
        XCTAssertNil(SessionMotionStream().ingest(pose: frame), "\(corruption): motion sample from one frame")
      }
    }
  }

  func testHugeLandmarkListsStayLinearInTime() {
    var rng = StressRNG(seed: 42)
    let athlete = PoseSynth.Athlete.readyFraming(&rng)
    let detector = TemporalStrokeDetector()
    let readiness = PoseReadinessEvaluator()
    let evidence = CaptureEvidenceAccumulator()
    var t = 0
    let started = Date()
    for _ in 0 ..< 200 {
      t += 16
      let frame = PoseSynth.corrupt(
        PoseSynth.frame(athlete, arm: .still, timestampMs: t, rng: &rng),
        with: .hugeLandmarkList,
        rng: &rng
      )
      XCTAssertGreaterThanOrEqual(frame.landmarks.count, 1_000)
      _ = detector.ingest(pose: frame, paddle: nil)
      _ = readiness.ingest(pose: frame)
      evidence.ingest(pose: frame)
    }
    // 200 frames × ≥1000 ghost joints: well under a second even in debug.
    XCTAssertLessThan(Date().timeIntervalSince(started), 10)
  }

  func testNonFiniteWristCoordinateNeverReachesTheCompletionPayload() {
    // Minimal repro (2 frames) of `hugeAndCorruptInputs` seed 14: an infinite
    // wrist coordinate becomes an infinite speed sample (SessionMotionStream
    // has no finiteness guard) that lands in StrokeCompletionMonitor telemetry
    // and its payload — the clip's `completion` telemetry then carries a
    // number JSON cannot represent. Reachability from Apple Vision is
    // UNVERIFIED-on-Linux (Vision emits normalized CGPoints).
    var rng = StressRNG(seed: 7)
    let athlete = PoseSynth.Athlete.readyFraming(&rng)
    let monitor = StrokeCompletionMonitor()
    let stream = SessionMotionStream()
    let clean = PoseSynth.frame(athlete, arm: .still, timestampMs: 1_000, rng: &rng)
    monitor.ingest(pose: clean)
    _ = stream.ingest(pose: clean)
    let marks = clean.landmarks.map { landmark -> PoseLandmark in
      landmark.name == "right_wrist"
        ? PoseLandmark(name: landmark.name, x: .infinity, y: landmark.y, visibility: landmark.visibility)
        : landmark
    }
    let corrupt = PoseFrame(timestampMs: 1_016, landmarks: marks, confidence: 0.9)
    let sample = stream.ingest(pose: corrupt)
    XCTAssertTrue(sample?.value.isFinite ?? true, "SessionMotionStream forwarded speed \(sample?.value ?? 0)")
    monitor.ingest(pose: corrupt)
    let telemetry = monitor.telemetry(strategy: .fixed, finalizeMs: 1_016)
    XCTAssertTrue(telemetry.peakMotionValue.isFinite, "peakMotionValue \(telemetry.peakMotionValue)")
    let payload = StrokeCompletionMonitor.payload(for: telemetry, rebasedTo: 0)
    XCTAssertTrue(JSONSerialization.isValidJSONObject(payload), "completion payload carries a non-finite number")
  }

  func testPoseSidecarDocumentIsRefusedByJSONSerializationForNonFiniteLandmarks() {
    // ClipMediaStore.writePoseSequenceSidecar maps every retained landmark to
    // ["n","x","y","v"] and hands the document to JSONSerialization.data; a
    // throw there is caught by the clip finalizer, which deletes the clip.
    // This pins the mechanism: exactly the corruptions that carry a
    // non-finite number make the document un-serializable, so a single such
    // landmark in the retained history costs the clip. Whether Apple Vision
    // can emit one is UNVERIFIED-on-Linux.
    var rng = StressRNG(seed: 21)
    let athlete = PoseSynth.Athlete.readyFraming(&rng)
    for corruption in PoseSynth.Corruption.allCases {
      let frame = PoseSynth.corrupt(
        PoseSynth.frame(athlete, arm: .swing(phase: 0.5, amplitude: 0.3), timestampMs: 1_000, rng: &rng), with: corruption, rng: &rng
      )
      let landmarks: [[String: Any]] = frame.landmarks.map { ["n": $0.name, "x": $0.x, "y": $0.y, "v": $0.visibility] }
      let document: [String: Any] = ["frames": [["i": 0, "t": 0, "c": frame.confidence, "l": landmarks]]]
      let serializable = JSONSerialization.isValidJSONObject(document)
      let hasNonFinite = frame.landmarks.contains { !$0.x.isFinite || !$0.y.isFinite || !$0.visibility.isFinite } || !frame.confidence.isFinite
      XCTAssertEqual(
        serializable, !hasNonFinite,
        "\(corruption): serializable=\(serializable) nonFinite=\(hasNonFinite)"
      )
    }
  }
}
