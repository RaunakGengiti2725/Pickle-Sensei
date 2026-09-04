import XCTest
@testable import PickleVisionCore

/// Structural-audit probes for the pure-Swift half of vision-core (detector,
/// readiness, evidence accumulator, trail buffer, motion stream). Every test
/// states the contract the surrounding code and comments promise; a failing
/// probe is a reproduced structural gap, a passing one is a verified
/// invariant. Fixtures mirror `TemporalStrokeDetectorTests` (25 fps, 400 ms
/// ready position, the moderate drive) so the numbers line up with that file.
///
/// Probes that can only be shown by trapping the process (a Swift
/// precondition failure) live in tools/audit/vision-core-trap-probes/ — a
/// crash would take the whole XCTest run down with it.
final class StructuralAuditProbeTests: XCTestCase {
  private let cadenceMs = 40
  private let readyFrames = 11
  /// Speeds 1.5, 2.0, 1.75, 1.5, 1.25, 1.0, 0.75, 0.4, 0.2, 0.1, 0.1 bh/s;
  /// after the ready position: trigger 440, peak 480, closes 840.
  private let driveDeltas: [Double] = [0.06, 0.08, 0.07, 0.06, 0.05, 0.04, 0.03, 0.016, 0.008, 0.004, 0.004]

  // MARK: - TemporalStrokeDetector: input validation

  /// The trail buffer (`PoseMotionTrail.swift`) and the evidence accumulator
  /// (`CaptureEvidenceAccumulator.swift:90-94`) both treat a non-finite
  /// coordinate as "not observed". The detector's contract for a single bad
  /// sample inside an otherwise clean drive is the same as for a dropped
  /// frame: the ≤250 ms gap rule bridges it and the swing still completes.
  /// A NaN wrist must not silently veto a real stroke.
  func testOneNaNWristSampleInsideADriveDoesNotVetoTheStroke() {
    var frames = poses(bodySpan: 0.5, path: ready(then: driveDeltas))
    // Control: the clean drive is one event closing at 840.
    XCTAssertEqual(run(TemporalStrokeDetector(), frames).map(\.tMs), [840])

    // Corrupt exactly one mid-drive sample (t = 520): right wrist x = NaN with
    // full visibility. Every other landmark of that frame is untouched.
    let index = readyFrames + 2
    frames[index] = replacing(frames[index], joint: "right_wrist", x: .nan)

    let events = run(TemporalStrokeDetector(), frames)
    XCTAssertEqual(
      events.map(\.tMs), [840],
      "a single non-finite wrist coordinate must be ignored like a hidden landmark, not poison the path gate"
    )
    XCTAssertEqual(events.first?.event.peakMotionMs, 480, "the corrupt sample must not become the peak")
  }

  /// Same contract for +infinity.
  func testOneInfiniteWristSampleInsideADriveDoesNotVetoTheStroke() {
    var frames = poses(bodySpan: 0.5, path: ready(then: driveDeltas))
    let index = readyFrames + 2
    frames[index] = replacing(frames[index], joint: "right_wrist", x: .infinity)
    let events = run(TemporalStrokeDetector(), frames)
    XCTAssertEqual(events.map(\.tMs), [840])
    XCTAssertEqual(events.first?.event.peakMotionMs, 480, "the corrupt sample must not become the peak")
  }

  /// `ingest` guards `pose.timestampMs > previous.tMs` before measuring a
  /// speed, i.e. a regressed timestamp is meant to contribute nothing. Yet the
  /// regressed frame still overwrites `lastPoints` and can move `peakSpeedMs`
  /// while `elapsed = timestampMs - triggerMs` goes negative. Whatever the
  /// detector emits afterwards must at least be a well-formed window:
  /// startMs ≤ peakMotionMs ≤ endMs.
  func testEmittedWindowStaysOrderedWhenATimestampRegressesMidCandidate() {
    let detector = TemporalStrokeDetector()
    let bodySpan = 0.5
    // Ready position 0…400, then the first two drive samples (440, 480):
    // candidate opens with trigger 400, peak 480.
    var offset = 0.0
    for tMs in stride(from: 0, through: 400, by: cadenceMs) {
      XCTAssertNil(detector.ingest(pose: fullBodyPose(at: tMs, bodySpan: bodySpan), paddle: nil))
    }
    for (step, delta) in driveDeltas.prefix(2).enumerated() {
      offset += delta
      XCTAssertNil(detector.ingest(pose: fullBodyPose(at: 440 + step * cadenceMs, bodySpan: bodySpan, wristOffset: offset), paddle: nil))
    }
    // Clock jumps BACK to 100 ms (same wrist position), then one fast sample
    // at 140 (0.2 bh in 40 ms = 5 bh/s), then stillness through 700.
    XCTAssertNil(detector.ingest(pose: fullBodyPose(at: 100, bodySpan: bodySpan, wristOffset: offset), paddle: nil))
    offset += 0.2
    var events: [(tMs: Int, event: StrokeEvent)] = []
    for tMs in stride(from: 140, through: 700, by: cadenceMs) {
      if let event = detector.ingest(pose: fullBodyPose(at: tMs, bodySpan: bodySpan, wristOffset: offset), paddle: nil) {
        events.append((tMs, event))
      }
    }
    for (tMs, event) in events {
      XCTAssertLessThanOrEqual(event.startMs, event.endMs, "event emitted at \(tMs)")
      if let peak = event.peakMotionMs {
        XCTAssertGreaterThanOrEqual(peak, event.startMs, "peakMotionMs precedes startMs in event emitted at \(tMs): \(event)")
        XCTAssertLessThanOrEqual(peak, event.endMs, "peakMotionMs follows endMs in event emitted at \(tMs): \(event)")
      }
    }
  }

  // MARK: - TemporalStrokeDetector: verified invariants

  /// A duplicated frame (same timestamp twice — a re-delivered buffer) yields
  /// no speed and does not disturb the drive around it.
  func testDuplicateTimestampFrameIsInertInsideADrive() {
    var frames = poses(bodySpan: 0.5, path: ready(then: driveDeltas))
    frames.insert(frames[readyFrames + 2], at: readyFrames + 3)
    XCTAssertEqual(run(TemporalStrokeDetector(), frames).map(\.tMs), [840])
  }

  /// `paddle?.confidence > 0.5` is strict: exactly 0.5 is not a validated
  /// paddle and the wrists stay the tracked points.
  func testPaddleAtExactlyHalfConfidenceIsNotValidatedSoWristsAreTracked() {
    let detector = TemporalStrokeDetector()
    let bodySpan = 0.5
    var events: [Int] = []
    for (index, offset) in ready(then: driveDeltas).enumerated() {
      let tMs = index * cadenceMs
      let paddle = PaddleFrame(
        timestampMs: tMs, bbox: nil, handleEnd: nil, throat: nil,
        center: CGPoint(x: 0.7, y: 0.5), tip: nil, confidence: 0.5
      )
      if detector.ingest(pose: fullBodyPose(at: tMs, bodySpan: bodySpan, wristOffset: offset), paddle: paddle) != nil {
        events.append(tMs)
      }
    }
    XCTAssertEqual(events, [840])
  }

  /// `strongestEvent` is documented pure: running it must not touch the live
  /// detector's quiet run, body scale or refractory.
  func testStrongestEventLeavesTheLiveDetectorUntouched() {
    let live = TemporalStrokeDetector()
    let frames = poses(bodySpan: 0.5, path: ready(then: driveDeltas))
    for frame in frames.prefix(readyFrames) {
      XCTAssertNil(live.ingest(pose: frame, paddle: nil))
    }
    let scaleBefore = live.lastBodyScale
    XCTAssertNotNil(TemporalStrokeDetector.strongestEvent(in: poses(bodySpan: 0.3, path: ready(then: driveDeltas))))
    XCTAssertEqual(live.lastBodyScale, scaleBefore)
    var emitted: [Int] = []
    for frame in frames.dropFirst(readyFrames) {
      if live.ingest(pose: frame, paddle: nil) != nil { emitted.append(frame.timestampMs) }
    }
    XCTAssertEqual(emitted, [840], "the live detector's quiet run must have survived the offline pass")
  }

  /// A collapsed detection (shoulder→ankle span < 0.05) is not a standing body
  /// and must not seed or move the body scale.
  func testCollapsedBodySpanIsIgnoredForScale() {
    let detector = TemporalStrokeDetector()
    _ = detector.ingest(pose: fullBodyPose(at: 0, bodySpan: 0.04), paddle: nil)
    XCTAssertNil(detector.lastBodyScale)
    _ = detector.ingest(pose: fullBodyPose(at: 40, bodySpan: 0.5), paddle: nil)
    XCTAssertEqual(detector.lastBodyScale ?? -1, 0.5, accuracy: 1e-9)
    _ = detector.ingest(pose: fullBodyPose(at: 80, bodySpan: 0.04), paddle: nil)
    XCTAssertEqual(detector.lastBodyScale ?? -1, 0.5, accuracy: 1e-9)
  }

  /// Duplicate landmark names are a `PoseFrame` the contract does not forbid;
  /// the detector, trail buffer, accumulator and motion stream must all accept
  /// one without trapping. (The readiness evaluator is probed separately in
  /// tools/audit/vision-core-trap-probes/ because it does trap.)
  func testDuplicateLandmarkNamesDoNotTrapDetectorTrailAccumulatorOrStream() {
    let frame = fullBodyPose(at: 0, bodySpan: 0.5)
    let duplicated = PoseFrame(
      timestampMs: 0,
      landmarks: frame.landmarks + [PoseLandmark(name: "right_wrist", x: 0.6, y: 0.5, visibility: 0.9)],
      confidence: 0.95
    )
    XCTAssertNil(TemporalStrokeDetector().ingest(pose: duplicated, paddle: nil))
    var trails = PoseMotionTrailBuffer()
    trails.ingest(landmarks: duplicated.landmarks, timestampMs: 0)
    let accumulator = CaptureEvidenceAccumulator()
    accumulator.ingest(pose: duplicated)
    XCTAssertNotNil(
      accumulator.summary(startMs: 0, endMs: 0, poseSource: "s", poseModelVersion: "m", triggerAlgorithmVersion: "t")
    )
    XCTAssertNil(SessionMotionStream().ingest(pose: duplicated))
  }

  // MARK: - PoseReadinessEvaluator: framing branches

  func testTooSmallBodyAsksToMoveCloserAndClearsStability() {
    let evaluator = PoseReadinessEvaluator()
    _ = evaluator.ingest(pose: readinessPose(at: 0))
    _ = evaluator.ingest(pose: readinessPose(at: 225))
    XCTAssertEqual(evaluator.ingest(pose: readinessPose(at: 450)).state, .ready)
    // Shoulders→ankles 0.30 of the frame (< 0.32).
    let far = evaluator.ingest(pose: readinessPose(at: 500, scale: 0.30 / 0.65))
    XCTAssertEqual(far.state, .moveCloser)
    XCTAssertEqual(far.stableForMs, 0)
    // Back to a good size: the window restarts from scratch.
    XCTAssertEqual(evaluator.ingest(pose: readinessPose(at: 550)).state, .holdStill)
    XCTAssertEqual(evaluator.ingest(pose: readinessPose(at: 999)).state, .holdStill)
    XCTAssertEqual(evaluator.ingest(pose: readinessPose(at: 1_000)).state, .ready)
  }

  func testTooLargeBodyAsksToMoveFartherAndClearsStability() {
    let evaluator = PoseReadinessEvaluator()
    _ = evaluator.ingest(pose: readinessPose(at: 0))
    _ = evaluator.ingest(pose: readinessPose(at: 225))
    XCTAssertEqual(evaluator.ingest(pose: readinessPose(at: 450)).state, .ready)
    // Height 0.90 (> 0.88) centred vertically, so every joint stays inside
    // the 0.025 frame margin (0.05 … 0.95) and only the size gate fails.
    let near = evaluator.ingest(pose: readinessPose(at: 500, yOffset: 0.5 - 0.575, scale: 0.90 / 0.65))
    XCTAssertEqual(near.state, .moveFarther)
    XCTAssertEqual(near.stableForMs, 0)
  }

  func testBodyTouchingTheFrameEdgeIsFullBodyRequiredAndClearsStability() {
    let evaluator = PoseReadinessEvaluator()
    _ = evaluator.ingest(pose: readinessPose(at: 0))
    _ = evaluator.ingest(pose: readinessPose(at: 225))
    XCTAssertEqual(evaluator.ingest(pose: readinessPose(at: 450)).state, .ready)
    // Whole body shifted so the left wrist sits at x = 0.02 (< margin 0.025).
    let clipped = evaluator.ingest(pose: readinessPose(at: 500, xOffset: 0.02 - 0.36))
    XCTAssertEqual(clipped.state, .fullBodyRequired)
    XCTAssertEqual(clipped.stableForMs, 0)
    XCTAssertTrue(clipped.missingJoints.isEmpty, "every joint is visible; only the margin failed")
  }

  /// A pose under the confidence floor is a miss and clears the window, the
  /// same as no pose at all.
  func testLowConfidencePoseClearsTheStabilityWindow() {
    let evaluator = PoseReadinessEvaluator()
    _ = evaluator.ingest(pose: readinessPose(at: 0))
    _ = evaluator.ingest(pose: readinessPose(at: 225))
    XCTAssertEqual(evaluator.ingest(pose: readinessPose(at: 450)).state, .ready)
    XCTAssertEqual(evaluator.ingest(pose: readinessPose(at: 500, confidence: 0.49)).state, .noPerson)
    XCTAssertEqual(evaluator.ingest(pose: readinessPose(at: 550)).state, .holdStill)
  }

  // MARK: - CaptureEvidenceAccumulator / SessionMotionStream

  /// Retention is a window behind the LATEST timestamp: an attempt older than
  /// `retentionMs` is dropped as soon as a newer one arrives, and the summary
  /// of the old window becomes nil.
  func testAccumulatorRetentionDropsAttemptsOlderThanTheWindow() {
    let accumulator = CaptureEvidenceAccumulator(retentionMs: 1_000)
    accumulator.ingest(pose: accumulatorPose(at: 0))
    XCTAssertNotNil(accumulator.summary(startMs: 0, endMs: 0, poseSource: "s", poseModelVersion: "m", triggerAlgorithmVersion: "t"))
    accumulator.ingest(pose: accumulatorPose(at: 1_000))
    XCTAssertNotNil(accumulator.summary(startMs: 0, endMs: 0, poseSource: "s", poseModelVersion: "m", triggerAlgorithmVersion: "t"))
    accumulator.ingestMissing(timestampMs: 1_001)
    XCTAssertNil(accumulator.summary(startMs: 0, endMs: 0, poseSource: "s", poseModelVersion: "m", triggerAlgorithmVersion: "t"))
  }

  /// The accumulator rejects out-of-range and non-finite coordinates per
  /// landmark, so a corrupt joint reads as not observed rather than as motion.
  func testAccumulatorTreatsNonFiniteOrOutOfRangeJointAsUnobserved() throws {
    let accumulator = CaptureEvidenceAccumulator()
    accumulator.ingest(pose: accumulatorPose(at: 0))
    accumulator.ingest(pose: replacing(accumulatorPose(at: 50), joint: "right_wrist", x: .nan))
    accumulator.ingest(pose: replacing(accumulatorPose(at: 100), joint: "right_wrist", x: 1.5))
    accumulator.ingest(pose: accumulatorPose(at: 150))
    let summary = try XCTUnwrap(
      accumulator.summary(startMs: 0, endMs: 150, poseSource: "s", poseModelVersion: "m", triggerAlgorithmVersion: "t")
    )
    XCTAssertEqual(summary.poseFrameCount, 4)
    XCTAssertNil(summary.jointMotion.first { $0.joint == "right_wrist" })
    XCTAssertEqual(summary.fullBodyVisibleFrameCount, 2)
  }

  /// A regressed or repeated timestamp yields no sample from the motion stream.
  func testMotionStreamRegressedTimestampYieldsNothing() {
    let stream = SessionMotionStream()
    XCTAssertNil(stream.ingest(pose: wristPose(at: 100, rightWristX: 0.5)))
    XCTAssertNil(stream.ingest(pose: wristPose(at: 100, rightWristX: 0.9)))
    XCTAssertNil(stream.ingest(pose: wristPose(at: 90, rightWristX: 0.1)))
  }

  // MARK: - Fixtures

  private func run(_ detector: TemporalStrokeDetector, _ frames: [PoseFrame]) -> [(tMs: Int, event: StrokeEvent)] {
    var events: [(tMs: Int, event: StrokeEvent)] = []
    for frame in frames {
      if let event = detector.ingest(pose: frame, paddle: nil) {
        events.append((frame.timestampMs, event))
      }
    }
    return events
  }

  private func ready(then deltas: [Double]) -> [Double] {
    var offset = 0.0
    return Array(repeating: 0.0, count: readyFrames) + deltas.map { delta in
      offset += delta
      return offset
    }
  }

  private func poses(bodySpan: Double, path: [Double]) -> [PoseFrame] {
    path.enumerated().map { index, offset in
      fullBodyPose(at: index * cadenceMs, bodySpan: bodySpan, wristOffset: offset)
    }
  }

  /// Same template as `TemporalStrokeDetectorTests.fullBodyPose`.
  private func fullBodyPose(at timestampMs: Int, bodySpan: Double, wristOffset: Double = 0) -> PoseFrame {
    let template: [(name: String, x: Double, y: Double)] = [
      ("left_shoulder", -0.12, 0.0), ("right_shoulder", 0.12, 0.0),
      ("left_elbow", -0.16, 0.22), ("right_elbow", 0.16, 0.22),
      ("left_wrist", -0.18, 0.42), ("right_wrist", 0.18 - wristOffset, 0.42),
      ("left_hip", -0.08, 0.42), ("right_hip", 0.08, 0.42),
      ("left_knee", -0.08, 0.72), ("right_knee", 0.08, 0.72),
      ("left_ankle", -0.09, 1.0), ("right_ankle", 0.09, 1.0),
    ]
    let shoulderY = 0.5 - bodySpan / 2
    return PoseFrame(
      timestampMs: timestampMs,
      landmarks: template.map { name, x, y in
        PoseLandmark(name: name, x: 0.5 + x * bodySpan, y: shoulderY + y * bodySpan, visibility: 0.95)
      },
      confidence: 0.95
    )
  }

  private func replacing(_ frame: PoseFrame, joint: String, x: Double) -> PoseFrame {
    PoseFrame(
      timestampMs: frame.timestampMs,
      landmarks: frame.landmarks.map {
        $0.name == joint ? PoseLandmark(name: $0.name, x: x, y: $0.y, visibility: $0.visibility) : $0
      },
      confidence: frame.confidence
    )
  }

  /// Same template as `PoseReadinessEvaluatorTests.pose` (shoulders 0.25 →
  /// ankles 0.90: height 0.65, width 0.28), scaled about the body's own centre
  /// (0.5, 0.575) and then translated.
  private func readinessPose(
    at timestampMs: Int,
    xOffset: Double = 0,
    yOffset: Double = 0,
    scale: Double = 1,
    confidence: Double = 0.95
  ) -> PoseFrame {
    let points: [(String, Double, Double)] = [
      ("left_shoulder", 0.43, 0.25), ("right_shoulder", 0.57, 0.25),
      ("left_elbow", 0.39, 0.38), ("right_elbow", 0.61, 0.38),
      ("left_wrist", 0.36, 0.50), ("right_wrist", 0.64, 0.50),
      ("left_hip", 0.45, 0.52), ("right_hip", 0.55, 0.52),
      ("left_knee", 0.45, 0.70), ("right_knee", 0.55, 0.70),
      ("left_ankle", 0.44, 0.90), ("right_ankle", 0.56, 0.90),
    ]
    return PoseFrame(
      timestampMs: timestampMs,
      landmarks: points.map { name, x, y in
        PoseLandmark(
          name: name,
          x: 0.5 + (x - 0.5) * scale + xOffset,
          y: 0.575 + (y - 0.575) * scale + yOffset,
          visibility: 0.95
        )
      },
      confidence: confidence
    )
  }

  private func accumulatorPose(at timestampMs: Int) -> PoseFrame {
    let landmarks = CaptureEvidenceAccumulator.canonicalJoints.enumerated().map { index, name in
      PoseLandmark(
        name: name,
        x: 0.20 + Double(index % 4) * 0.15,
        y: 0.20 + Double(index / 4) * 0.25,
        visibility: 1
      )
    }
    return PoseFrame(timestampMs: timestampMs, landmarks: landmarks, confidence: 0.95)
  }

  private func wristPose(at timestampMs: Int, rightWristX: Double) -> PoseFrame {
    PoseFrame(
      timestampMs: timestampMs,
      landmarks: [
        PoseLandmark(name: "right_wrist", x: rightWristX, y: 0.5, visibility: 0.9),
        PoseLandmark(name: "left_wrist", x: 0.3, y: 0.5, visibility: 0.9),
      ],
      confidence: 0.9
    )
  }
}
