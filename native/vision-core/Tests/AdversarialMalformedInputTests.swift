import XCTest
@testable import PickleVisionCore

/// Adversarial pass 3 (native-vision-core, attack branch
/// `devin/attack-native-vision-core-1`): malformed-input and state-integrity
/// probes for the pure-Swift analysis stages. Every test here is expected to
/// COMPLETE WITHOUT A TRAP on the commit under test (4d812e1a); the probe that
/// does trap today (duplicate visible landmark names into
/// `PoseReadinessEvaluator.ingest`) lives in
/// `AdversarialDuplicateLandmarkTrapTests.swift` so it cannot take this suite
/// down with it.
///
/// Scenario ids (S02…S07) are the coordinator's; S08+ are additions. Fixtures
/// mirror `TemporalStrokeDetectorTests` exactly (40 ms cadence, 11-frame ready
/// position, the same full-body template and drive deltas) so every expected
/// timestamp below is derivable from that file's documentation.
final class AdversarialMalformedInputTests: XCTestCase {
  private let cadenceMs = 40
  private let readyFrames = 11
  private let bodySpan = 0.4
  /// Same drive as `TemporalStrokeDetectorTests.driveDeltas`: after a ready
  /// position ending at t, trigger t+40, peak t+80, closes t+440.
  private let driveDeltas: [Double] = [0.06, 0.08, 0.07, 0.06, 0.05, 0.04, 0.03, 0.016, 0.008, 0.004, 0.004]

  // MARK: - S02 — NaN wrist coordinate while idle

  /// Ready position, one frame whose right wrist x is NaN, stillness, then a
  /// clean drive. The NaN frame must not open a candidate and must not poison
  /// `lastPoints` beyond the single interval it touches: the later drive has
  /// to emit exactly the event the same sequence emits with the NaN frame
  /// replaced by a still one.
  func testS02NaNWristWhileIdleDoesNotOpenACandidateOrPoisonTheNextDrive() {
    let stillAfter = 12 // 480 … 920: a fresh ≥ 350 ms quiet run either way
    var attacked: [PoseFrame] = []
    var control: [PoseFrame] = []
    var path = stillPath(readyFrames)
    path = hold(path, for: 1 + stillAfter)
    path = move(path, by: driveDeltas)
    path = hold(path, for: 5)
    for (index, offset) in path.enumerated() {
      let tMs = index * cadenceMs
      control.append(fullBodyPose(at: tMs, wristOffset: offset))
      if index == readyFrames {
        attacked.append(fullBodyPose(at: tMs, wristOffset: offset, rightWristX: .nan))
      } else {
        attacked.append(fullBodyPose(at: tMs, wristOffset: offset))
      }
    }
    XCTAssertTrue(attacked[readyFrames].landmarks.first { $0.name == "right_wrist" }!.x.isNaN)

    let attackedEvents = run(TemporalStrokeDetector(), attacked)
    let controlEvents = run(TemporalStrokeDetector(), control)

    // Nothing fires during the NaN frame or the stillness that follows it.
    let driveStartMs = (readyFrames + 1 + stillAfter) * cadenceMs
    XCTAssertTrue(attackedEvents.allSatisfy { $0.tMs > driveStartMs }, "\(attackedEvents)")
    XCTAssertEqual(attackedEvents.count, 1)
    XCTAssertEqual(controlEvents.count, 1)
    guard let attackedEvent = attackedEvents.first?.event, let controlEvent = controlEvents.first?.event else { return }
    assertFinite(attackedEvent)
    XCTAssertEqual(attackedEvent.startMs, controlEvent.startMs)
    XCTAssertEqual(attackedEvent.endMs, controlEvent.endMs)
    XCTAssertEqual(attackedEvent.peakMotionMs, controlEvent.peakMotionMs)
    XCTAssertEqual(attackedEvent.confidence, controlEvent.confidence, accuracy: 1e-12)
    // Pinned so a future change to the quiet-onset bookkeeping is visible.
    XCTAssertEqual(attackedEvent.startMs, driveStartMs - cadenceMs)
    XCTAssertEqual(attackedEvent.peakMotionMs, driveStartMs + cadenceMs)
    XCTAssertEqual(attackedEvent.endMs, driveStartMs + 10 * cadenceMs)
  }

  /// Same attack with the LEFT wrist hidden, so the NaN sample is the only
  /// sample on its frame and becomes `fastest` (with both wrists visible the
  /// still left wrist wins `max(by:)` because every comparison against NaN is
  /// false). The quiet run is broken by the NaN interval, but the ≥ 350 ms of
  /// stillness afterwards re-arms the detector and the drive still fires.
  func testS02NaNOnTheOnlyVisibleWristStillLeavesTheDetectorArmable() {
    let stillAfter = 12
    var frames: [PoseFrame] = []
    var path = stillPath(readyFrames)
    path = hold(path, for: 1 + stillAfter)
    path = move(path, by: driveDeltas)
    path = hold(path, for: 5)
    for (index, offset) in path.enumerated() {
      let tMs = index * cadenceMs
      frames.append(fullBodyPose(
        at: tMs,
        wristOffset: offset,
        rightWristX: index == readyFrames ? .nan : nil,
        removing: ["left_wrist"]
      ))
    }
    let events = run(TemporalStrokeDetector(), frames)
    XCTAssertEqual(events.count, 1)
    guard let event = events.first?.event else { return }
    assertFinite(event)
    let driveStartMs = (readyFrames + 1 + stillAfter) * cadenceMs
    XCTAssertEqual(event.startMs, driveStartMs - cadenceMs)
    XCTAssertEqual(event.endMs, driveStartMs + 10 * cadenceMs)
  }

  /// A NaN frame INSIDE the ready position (before any quiet run qualified)
  /// must not leave a NaN speed that later reads as "fast": the stroke that
  /// follows a full ready position is still detected normally.
  func testS02NaNInsideTheReadyPositionIsAbsorbed() {
    var frames: [PoseFrame] = []
    // 11 ready frames, NaN on frame 3, then 11 more still frames (a full
    // quiet run after the corrupt interval), then the drive.
    var path = stillPath(readyFrames)
    path = hold(path, for: readyFrames)
    path = move(path, by: driveDeltas)
    path = hold(path, for: 5)
    for (index, offset) in path.enumerated() {
      frames.append(fullBodyPose(at: index * cadenceMs, wristOffset: offset, rightWristX: index == 3 ? .nan : nil))
    }
    let events = run(TemporalStrokeDetector(), frames)
    XCTAssertEqual(events.count, 1)
    events.forEach { assertFinite($0.event) }
    XCTAssertEqual(events.first?.event.startMs, (2 * readyFrames - 1) * cadenceMs)
  }

  // MARK: - S03 — infinite wrist coordinate inside a candidate

  /// Candidate open (ready + three drive samples), then a frame whose right
  /// wrist x is +∞, then stillness. The candidate must either be dropped or
  /// close with a StrokeEvent whose every field is finite — never NaN.
  func testS03InfiniteWristInsideACandidateNeverEmitsANonFiniteEvent() {
    var frames: [PoseFrame] = []
    var path = stillPath(readyFrames)
    path = move(path, by: Array(driveDeltas.prefix(3))) // 440, 480, 520: candidate opens at 440
    path = hold(path, for: 1) // 560: the corrupt frame
    path = hold(path, for: 12) // 600 … 1040: settled
    for (index, offset) in path.enumerated() {
      frames.append(fullBodyPose(
        at: index * cadenceMs,
        wristOffset: offset,
        rightWristX: index == readyFrames + 3 ? .infinity : nil
      ))
    }
    XCTAssertTrue(frames[readyFrames + 3].landmarks.first { $0.name == "right_wrist" }!.x.isInfinite)

    let detector = TemporalStrokeDetector()
    let events = run(detector, frames)
    XCTAssertLessThanOrEqual(events.count, 1, "\(events)")
    for (_, event) in events {
      assertFinite(event)
      XCTAssertEqual(event.startMs, (readyFrames - 1) * cadenceMs)
      XCTAssertGreaterThan(event.endMs, event.startMs)
      XCTAssertLessThanOrEqual(event.confidence, 0.95)
      XCTAssertGreaterThanOrEqual(event.confidence, 0.5)
    }
    // Whatever happened to that candidate, the detector is still usable: a
    // fresh ready position and drive afterwards yields one finite event.
    let resumeStart = frames.count * cadenceMs + 1_000 // > refractory, > sample gap
    var resume = stillPath(readyFrames)
    resume = move(resume, by: driveDeltas)
    resume = hold(resume, for: 5)
    let resumeFrames = resume.enumerated().map { index, offset in
      fullBodyPose(at: resumeStart + index * cadenceMs, wristOffset: offset)
    }
    let later = run(detector, resumeFrames)
    XCTAssertEqual(later.count, 1)
    later.forEach { assertFinite($0.event) }
    XCTAssertEqual(later.first?.event.startMs, resumeStart + (readyFrames - 1) * cadenceMs)
  }

  /// Same shape with -∞ and with NaN in the candidate (S08): NaN poisons the
  /// path sum of the swinging wrist, so the candidate is dropped by the path
  /// gate or closes finite — either way no NaN escapes.
  func testS08NonFiniteVariantsInsideACandidateNeverEmitANonFiniteEvent() {
    for corrupt in [-Double.infinity, Double.nan] {
      var frames: [PoseFrame] = []
      var path = stillPath(readyFrames)
      path = move(path, by: Array(driveDeltas.prefix(3)))
      path = hold(path, for: 13)
      for (index, offset) in path.enumerated() {
        frames.append(fullBodyPose(
          at: index * cadenceMs,
          wristOffset: offset,
          rightWristX: index == readyFrames + 3 ? corrupt : nil
        ))
      }
      let events = run(TemporalStrokeDetector(), frames)
      XCTAssertLessThanOrEqual(events.count, 1, "corrupt=\(corrupt) \(events)")
      events.forEach { assertFinite($0.event, "corrupt=\(corrupt)") }
    }
  }

  /// The offline pass runs the same detector over recorded history; a
  /// corrupt frame there must not produce a non-finite "strongest" event.
  func testS08StrongestEventSurvivesNonFiniteCoordinates() {
    for corrupt in [Double.nan, Double.infinity, -Double.infinity] {
      var path = stillPath(readyFrames)
      path = move(path, by: driveDeltas)
      path = hold(path, for: 5)
      let frames = path.enumerated().map { index, offset in
        fullBodyPose(at: index * cadenceMs, wristOffset: offset, rightWristX: index == readyFrames + 2 ? corrupt : nil)
      }
      if let event = TemporalStrokeDetector.strongestEvent(in: frames) {
        assertFinite(event, "corrupt=\(corrupt)")
      }
    }
  }

  // MARK: - S04 — CaptureEvidenceAccumulator range boundary

  /// x = 1.0000001 is outside `0...1` and must drop that joint from coverage;
  /// y = -0.0 compares equal to 0 and must stay inside.
  func testS04OutOfRangeXIsExcludedWhileNegativeZeroYIsIncluded() {
    let accumulator = CaptureEvidenceAccumulator()
    var landmarks = CaptureEvidenceAccumulator.canonicalJoints.map { name in
      PoseLandmark(name: name, x: 0.5, y: 0.5, visibility: 0.95)
    }
    // right_wrist just past the right edge; left_wrist on the top edge at -0.0.
    landmarks[5] = PoseLandmark(name: "right_wrist", x: 1.000_000_1, y: 0.5, visibility: 0.95)
    landmarks[4] = PoseLandmark(name: "left_wrist", x: 0.5, y: -0.0, visibility: 0.95)
    XCTAssertTrue(landmarks[4].y.sign == .minus)
    accumulator.ingest(pose: PoseFrame(timestampMs: 1_000, landmarks: landmarks, confidence: 0.95))

    let summary = accumulator.summary(
      startMs: 1_000, endMs: 1_000, poseSource: "test", poseModelVersion: "t", triggerAlgorithmVersion: "t"
    )
    XCTAssertNotNil(summary)
    XCTAssertEqual(summary?.poseFrameCount, 1)
    // 11 of 12 canonical joints visible: only the out-of-range wrist is gone.
    XCTAssertEqual(summary?.meanJointCoverage ?? 0, 11.0 / 12.0, accuracy: 1e-12)
    XCTAssertEqual(summary?.minimumJointCoverage ?? 0, 11.0 / 12.0, accuracy: 1e-12)
    XCTAssertEqual(summary?.fullBodyVisibleFrameCount, 0)
    XCTAssertEqual(summary?.meanCanonicalJointVisibility ?? 0, 11 * 0.95 / 12, accuracy: 1e-12)

    // Exact boundaries are inside; one ulp beyond either edge is outside.
    let boundary = CaptureEvidenceAccumulator()
    var edge = CaptureEvidenceAccumulator.canonicalJoints.map { name in
      PoseLandmark(name: name, x: 0.5, y: 0.5, visibility: 0.95)
    }
    edge[0] = PoseLandmark(name: "left_shoulder", x: 0.0, y: 1.0, visibility: 0.95)
    edge[1] = PoseLandmark(name: "right_shoulder", x: 1.0, y: 0.0, visibility: 0.95)
    edge[2] = PoseLandmark(name: "left_elbow", x: -Double.leastNonzeroMagnitude, y: 0.5, visibility: 0.95)
    edge[3] = PoseLandmark(name: "right_elbow", x: 0.5, y: 1.0.nextUp, visibility: 0.95)
    boundary.ingest(pose: PoseFrame(timestampMs: 0, landmarks: edge, confidence: 0.95))
    let edgeSummary = boundary.summary(
      startMs: 0, endMs: 0, poseSource: "test", poseModelVersion: "t", triggerAlgorithmVersion: "t"
    )
    XCTAssertEqual(edgeSummary?.meanJointCoverage ?? 0, 10.0 / 12.0, accuracy: 1e-12)
  }

  /// Non-finite coordinates and visibilities never reach the motion series.
  func testS04NonFiniteJointsAreExcludedFromCoverageAndMotion() {
    let accumulator = CaptureEvidenceAccumulator()
    for (index, tMs) in stride(from: 0, through: 200, by: 40).enumerated() {
      var landmarks = CaptureEvidenceAccumulator.canonicalJoints.map { name in
        PoseLandmark(name: name, x: 0.5 + 0.01 * Double(index), y: 0.5, visibility: 0.95)
      }
      landmarks[5] = PoseLandmark(name: "right_wrist", x: index % 2 == 0 ? .nan : 0.5, y: 0.5, visibility: 0.95)
      landmarks[4] = PoseLandmark(name: "left_wrist", x: 0.5, y: 0.5, visibility: index % 2 == 0 ? .infinity : .nan)
      landmarks[6] = PoseLandmark(name: "left_hip", x: .infinity, y: 0.5, visibility: 0.95)
      accumulator.ingest(pose: PoseFrame(timestampMs: tMs, landmarks: landmarks, confidence: 0.95))
    }
    guard let summary = accumulator.summary(
      startMs: 0, endMs: 200, poseSource: "test", poseModelVersion: "t", triggerAlgorithmVersion: "t"
    ) else { return XCTFail("expected a summary") }
    XCTAssertTrue(summary.meanCanonicalJointVisibility.isFinite)
    XCTAssertTrue(summary.meanJointCoverage.isFinite)
    for motion in summary.jointMotion {
      XCTAssertTrue(motion.meanNormalizedPerSecond.isFinite, motion.joint)
      XCTAssertTrue(motion.peakNormalizedPerSecond.isFinite, motion.joint)
      XCTAssertNotEqual(motion.joint, "left_wrist")
      XCTAssertNotEqual(motion.joint, "left_hip")
    }
    // right_wrist alternates NaN / valid so consecutive valid samples never
    // touch: no motion sample for it either.
    XCTAssertFalse(summary.jointMotion.contains { $0.joint == "right_wrist" })
  }

  // MARK: - S05 — PoseMotionTrailBuffer NaN visibility

  /// `NaN >= 0.35` is false, so the joint is invisible on that frame and its
  /// trail breaks; the next observation starts a new trail — no interpolation
  /// across the gap and no trap.
  func testS05NaNVisibilityIsInvisibleAndBreaksContinuity() {
    var trails = PoseMotionTrailBuffer(config: .init(trackedJoints: ["left_wrist", "right_wrist"]))
    trails.ingest(landmarks: [wrist("left_wrist", 0.20), wrist("right_wrist", 0.80)], timestampMs: 0)
    trails.ingest(landmarks: [wrist("left_wrist", 0.30), wrist("right_wrist", 0.70)], timestampMs: 40)
    XCTAssertEqual(trails.segments(at: 40).count, 2)
    XCTAssertEqual(trails.storedSampleCount, 4)

    trails.ingest(
      landmarks: [wrist("left_wrist", 0.40, visibility: .nan), wrist("right_wrist", 0.60)],
      timestampMs: 80
    )
    // The left trail is gone entirely (not just un-extended).
    XCTAssertTrue(trails.segments(at: 80).filter { $0.joint == "left_wrist" }.isEmpty)
    XCTAssertEqual(trails.segments(at: 80).filter { $0.joint == "right_wrist" }.count, 2)
    XCTAssertEqual(trails.storedSampleCount, 3)

    trails.ingest(landmarks: [wrist("left_wrist", 0.50), wrist("right_wrist", 0.50)], timestampMs: 120)
    // Reappearance: one sample, zero segments for the left wrist — the 0.30 →
    // 0.50 jump across the NaN frame is never turned into a speed.
    XCTAssertTrue(trails.segments(at: 120).filter { $0.joint == "left_wrist" }.isEmpty)
    trails.ingest(landmarks: [wrist("left_wrist", 0.55), wrist("right_wrist", 0.45)], timestampMs: 160)
    let leftSegments = trails.segments(at: 160).filter { $0.joint == "left_wrist" }
    XCTAssertEqual(leftSegments.count, 1)
    XCTAssertEqual(leftSegments.first?.startX ?? 0, 0.50, accuracy: 1e-12)
    XCTAssertEqual(leftSegments.first?.normalizedSpeedPerSecond ?? 0, 0.05 / 0.04, accuracy: 1e-9)
    for segment in trails.segments(at: 160) {
      XCTAssertTrue(segment.normalizedSpeedPerSecond.isFinite)
      XCTAssertTrue(segment.ageFraction.isFinite)
    }
  }

  /// ±∞ visibility: +∞ passes the threshold (the coordinates are what is
  /// stored, so this is harmless), -∞ fails it. NaN/∞ coordinates are always
  /// rejected regardless of visibility.
  func testS05NonFiniteVisibilityAndCoordinateCombinations() {
    var trails = PoseMotionTrailBuffer(config: .init(trackedJoints: ["left_wrist"]))
    trails.ingest(landmarks: [wrist("left_wrist", 0.2, visibility: .infinity)], timestampMs: 0)
    XCTAssertEqual(trails.storedSampleCount, 1)
    trails.ingest(landmarks: [wrist("left_wrist", 0.3, visibility: -.infinity)], timestampMs: 40)
    XCTAssertEqual(trails.storedSampleCount, 0)
    trails.ingest(landmarks: [PoseLandmark(name: "left_wrist", x: .nan, y: 0.4, visibility: 0.95)], timestampMs: 80)
    trails.ingest(landmarks: [PoseLandmark(name: "left_wrist", x: 0.4, y: .infinity, visibility: 0.95)], timestampMs: 120)
    XCTAssertEqual(trails.storedSampleCount, 0)
    XCTAssertTrue(trails.segments(at: 120).isEmpty)
  }

  // MARK: - S06 / S07 — paddle preference boundary

  /// PaddleFrame with `center == nil` and confidence 0.9 while the wrist
  /// swings: the wrists must drive detection exactly as with no paddle.
  func testS06NilPaddleCentreFallsThroughToTheWrists() {
    var path = stillPath(readyFrames)
    path = move(path, by: driveDeltas)
    path = hold(path, for: 5)
    let frames = path.enumerated().map { index, offset in fullBodyPose(at: index * cadenceMs, wristOffset: offset) }

    let control = run(TemporalStrokeDetector(), frames)
    let detector = TemporalStrokeDetector()
    var events: [(tMs: Int, event: StrokeEvent)] = []
    for frame in frames {
      let paddle = PaddleFrame(
        timestampMs: frame.timestampMs, bbox: nil, handleEnd: nil, throat: nil, center: nil, tip: nil, confidence: 0.9
      )
      if let event = detector.ingest(pose: frame, paddle: paddle) { events.append((frame.timestampMs, event)) }
    }
    XCTAssertEqual(control.count, 1)
    XCTAssertEqual(events.count, 1)
    XCTAssertEqual(events.first?.event.startMs, control.first?.event.startMs)
    XCTAssertEqual(events.first?.event.endMs, control.first?.event.endMs)
    XCTAssertEqual(events.first?.event.peakMotionMs, control.first?.event.peakMotionMs)
    XCTAssertEqual(events.first?.event.confidence ?? -1, control.first?.event.confidence ?? -2, accuracy: 1e-12)
    XCTAssertEqual(events.first?.event.startMs, (readyFrames - 1) * cadenceMs)
    XCTAssertEqual(events.first?.event.endMs, (readyFrames - 1) * cadenceMs + 440)
  }

  /// A paddle with confidence EXACTLY 0.5 and a centre performing the drive
  /// while both wrists stay still: the strict `> 0.5` test rejects it, so the
  /// wrists (still) drive detection and NOTHING fires. Then the reverse: the
  /// paddle stays still at 0.5 while the wrist drives — the wrist event fires.
  func testS07PaddleAtExactlyHalfConfidenceIsNotPreferred() {
    var path = stillPath(readyFrames)
    path = move(path, by: driveDeltas)
    path = hold(path, for: 5)

    let paddleDrives = TemporalStrokeDetector()
    for (index, offset) in path.enumerated() {
      let tMs = index * cadenceMs
      let event = paddleDrives.ingest(
        pose: fullBodyPose(at: tMs),
        paddle: paddleFrame(at: tMs, offset: offset, confidence: 0.5)
      )
      XCTAssertNil(event, "paddle motion at confidence 0.5 must not be tracked (t=\(tMs))")
    }

    let wristDrives = TemporalStrokeDetector()
    var events: [(tMs: Int, event: StrokeEvent)] = []
    for (index, offset) in path.enumerated() {
      let tMs = index * cadenceMs
      if let event = wristDrives.ingest(
        pose: fullBodyPose(at: tMs, wristOffset: offset),
        paddle: paddleFrame(at: tMs, offset: 0, confidence: 0.5)
      ) { events.append((tMs, event)) }
    }
    XCTAssertEqual(events.count, 1)
    XCTAssertEqual(events.first?.event.startMs, (readyFrames - 1) * cadenceMs)
    XCTAssertEqual(events.first?.event.endMs, (readyFrames - 1) * cadenceMs + 440)

    // One ulp above 0.5 flips the preference: the paddle IS tracked.
    let justAbove = TemporalStrokeDetector()
    var paddleEvents = 0
    for (index, offset) in path.enumerated() {
      let tMs = index * cadenceMs
      if justAbove.ingest(pose: fullBodyPose(at: tMs), paddle: paddleFrame(at: tMs, offset: offset, confidence: 0.5.nextUp)) != nil {
        paddleEvents += 1
      }
    }
    XCTAssertEqual(paddleEvents, 1)
  }

  /// Paddle confidence itself malformed: NaN never prefers the paddle
  /// (`NaN > 0.5` is false); +∞ does. A paddle centre with a NaN coordinate
  /// at high confidence IS preferred (no finite check on the centre) but must
  /// not surface a non-finite event.
  func testS07MalformedPaddleConfidenceAndCentre() {
    var path = stillPath(readyFrames)
    path = move(path, by: driveDeltas)
    path = hold(path, for: 5)

    let nanConfidence = TemporalStrokeDetector()
    var wristEvents = 0
    for (index, offset) in path.enumerated() {
      let tMs = index * cadenceMs
      if nanConfidence.ingest(
        pose: fullBodyPose(at: tMs, wristOffset: offset),
        paddle: paddleFrame(at: tMs, offset: 0, confidence: .nan)
      ) != nil { wristEvents += 1 }
    }
    XCTAssertEqual(wristEvents, 1, "NaN paddle confidence must fall through to the wrists")

    let infiniteConfidence = TemporalStrokeDetector()
    var paddleEvents = 0
    for (index, offset) in path.enumerated() {
      let tMs = index * cadenceMs
      if infiniteConfidence.ingest(
        pose: fullBodyPose(at: tMs),
        paddle: paddleFrame(at: tMs, offset: offset, confidence: .infinity)
      ) != nil { paddleEvents += 1 }
    }
    XCTAssertEqual(paddleEvents, 1)

    let nanCentre = TemporalStrokeDetector()
    for (index, offset) in path.enumerated() {
      let tMs = index * cadenceMs
      var paddle = paddleFrame(at: tMs, offset: offset, confidence: 0.9)
      if index == readyFrames + 2 {
        paddle = PaddleFrame(
          timestampMs: tMs, bbox: nil, handleEnd: nil, throat: nil,
          center: CGPoint(x: CGFloat.nan, y: paddle.center!.y), tip: nil, confidence: 0.9
        )
      }
      if let event = nanCentre.ingest(pose: fullBodyPose(at: tMs), paddle: paddle) {
        assertFinite(event, "NaN paddle centre")
      }
    }
  }

  // MARK: - S09 — duplicate landmark names in the non-trapping consumers

  /// Every consumer other than `PoseReadinessEvaluator` tolerates a frame
  /// with two visible landmarks of the same name (see the trap test file for
  /// the one that does not).
  func testS09DuplicateLandmarkNamesDoNotTrapTheOtherConsumers() {
    let duplicated: [PoseLandmark] = CaptureEvidenceAccumulator.canonicalJoints.map {
      PoseLandmark(name: $0, x: 0.5, y: 0.5, visibility: 0.9)
    } + [
      PoseLandmark(name: "left_wrist", x: 0.2, y: 0.2, visibility: 0.95),
      PoseLandmark(name: "left_wrist", x: 0.8, y: 0.8, visibility: 0.6),
      PoseLandmark(name: "right_wrist", x: 0.7, y: 0.7, visibility: 0.9),
    ]
    let frame = PoseFrame(timestampMs: 1_000, landmarks: duplicated, confidence: 0.95)

    // CaptureEvidenceAccumulator keeps the most visible duplicate.
    let accumulator = CaptureEvidenceAccumulator()
    accumulator.ingest(pose: frame)
    let summary = accumulator.summary(
      startMs: 1_000, endMs: 1_000, poseSource: "t", poseModelVersion: "t", triggerAlgorithmVersion: "t"
    )
    XCTAssertEqual(summary?.meanJointCoverage ?? 0, 1, accuracy: 1e-12)
    XCTAssertEqual(summary?.meanCanonicalJointVisibility ?? 0, (10 * 0.9 + 0.95 + 0.9) / 12, accuracy: 1e-12)

    // PoseMotionTrailBuffer: last duplicate wins, one sample per joint.
    var trails = PoseMotionTrailBuffer(config: .init(trackedJoints: ["left_wrist", "right_wrist"]))
    trails.ingest(landmarks: duplicated, timestampMs: 1_000)
    XCTAssertEqual(trails.storedSampleCount, 2)
    trails.ingest(landmarks: duplicated, timestampMs: 1_040)
    XCTAssertEqual(trails.segments(at: 1_040).count, 2)
    XCTAssertEqual(trails.segments(at: 1_040).first { $0.joint == "left_wrist" }?.startX ?? -1, 0.8, accuracy: 1e-12)

    // TemporalStrokeDetector / SessionMotionStream: duplicates overwrite
    // `lastPoints`; a still frame pair yields no event and a finite sample.
    let detector = TemporalStrokeDetector()
    XCTAssertNil(detector.ingest(pose: frame, paddle: nil))
    XCTAssertNil(detector.ingest(pose: PoseFrame(timestampMs: 1_040, landmarks: duplicated, confidence: 0.95), paddle: nil))
    let stream = SessionMotionStream()
    XCTAssertNil(stream.ingest(pose: frame))
    let sample = stream.ingest(pose: PoseFrame(timestampMs: 1_040, landmarks: duplicated, confidence: 0.95))
    XCTAssertNotNil(sample)
    XCTAssertTrue(sample?.value.isFinite ?? false)

    // PoseReadinessEvaluator survives duplicates when at most one of them is
    // visible (the filter runs before the unique-keys dictionary) …
    let evaluator = PoseReadinessEvaluator()
    let oneVisible = PoseFrame(
      timestampMs: 1_000,
      landmarks: CaptureEvidenceAccumulator.canonicalJoints.map { PoseLandmark(name: $0, x: 0.5, y: 0.5, visibility: 0.9) }
        + [PoseLandmark(name: "left_wrist", x: 0.1, y: 0.1, visibility: 0.34)],
      confidence: 0.95
    )
    XCTAssertEqual(evaluator.ingest(pose: oneVisible).jointCoverage, 1, accuracy: 1e-12)
    // … and when the pose confidence gate rejects the frame first.
    let lowConfidence = PoseFrame(timestampMs: 1_040, landmarks: duplicated, confidence: 0.49)
    XCTAssertEqual(evaluator.ingest(pose: lowConfidence).state, .noPerson)
  }

  // MARK: - S10 — garbage names, unicode, huge frames

  func testS10UnknownUnicodeAndEmptyLandmarkNamesAreIgnoredEverywhere() {
    let garbage: [PoseLandmark] = [
      PoseLandmark(name: "", x: 0.5, y: 0.5, visibility: 0.99),
      PoseLandmark(name: "left_wrist\u{0}", x: 0.5, y: 0.5, visibility: 0.99),
      PoseLandmark(name: "LEFT_WRIST", x: 0.5, y: 0.5, visibility: 0.99),
      PoseLandmark(name: "left_wrist ", x: 0.5, y: 0.5, visibility: 0.99),
      PoseLandmark(name: "🥒🎾", x: 0.5, y: 0.5, visibility: 0.99),
      PoseLandmark(name: "lef\u{200B}t_wrist", x: 0.5, y: 0.5, visibility: 0.99),
      PoseLandmark(name: "left_wrıst", x: 0.5, y: 0.5, visibility: 0.99), // dotless ı
      PoseLandmark(name: "\u{FEFF}left_wrist", x: 0.5, y: 0.5, visibility: 0.99), // BOM
      PoseLandmark(name: String(repeating: "a", count: 100_000), x: 0.5, y: 0.5, visibility: 0.99),
    ]
    let frame = PoseFrame(timestampMs: 0, landmarks: garbage, confidence: 0.95)

    let evaluator = PoseReadinessEvaluator()
    let snapshot = evaluator.ingest(pose: frame)
    XCTAssertEqual(snapshot.state, .fullBodyRequired)
    XCTAssertEqual(snapshot.jointCoverage, 0)
    XCTAssertEqual(snapshot.missingJoints.count, 12)

    let accumulator = CaptureEvidenceAccumulator()
    accumulator.ingest(pose: frame)
    let summary = accumulator.summary(startMs: 0, endMs: 0, poseSource: "t", poseModelVersion: "t", triggerAlgorithmVersion: "t")
    XCTAssertEqual(summary?.meanJointCoverage, 0)

    var trails = PoseMotionTrailBuffer()
    trails.ingest(landmarks: garbage, timestampMs: 0)
    trails.ingest(landmarks: garbage, timestampMs: 40)
    XCTAssertEqual(trails.storedSampleCount, 0)

    XCTAssertNil(TemporalStrokeDetector().ingest(pose: frame, paddle: nil))
    XCTAssertNil(SessionMotionStream().ingest(pose: frame))
  }

  /// 50 000 landmarks in one frame (noise plus a full body) over 13 frames:
  /// every consumer finishes, stays bounded, and reads the real body.
  func testS10HugeFrameIsBoundedAndStillReadsTheBody() {
    var landmarks: [PoseLandmark] = []
    landmarks.reserveCapacity(50_012)
    for index in 0 ..< 50_000 {
      landmarks.append(PoseLandmark(name: "noise_\(index)", x: 0.5, y: 0.5, visibility: 0.99))
    }
    landmarks += fullBodyPose(at: 0).landmarks
    // 0 … 1 050 ms in 150 ms steps: the readiness window needs a sample at
    // exactly `now − 450` (see AdversarialStateIntegrityGapTests G6), which
    // this grid provides from 450 on.
    let frames = (0 ..< 8).map { index in
      PoseFrame(timestampMs: index * 150, landmarks: landmarks, confidence: 0.95)
    }

    let evaluator = PoseReadinessEvaluator()
    var last: PoseReadinessEvaluator.Snapshot?
    for frame in frames { last = evaluator.ingest(pose: frame) }
    XCTAssertEqual(last?.state, .ready)
    XCTAssertEqual(last?.jointCoverage, 1)

    let accumulator = CaptureEvidenceAccumulator()
    frames.forEach { accumulator.ingest(pose: $0) }
    let summary = accumulator.summary(startMs: 0, endMs: 1_050, poseSource: "t", poseModelVersion: "t", triggerAlgorithmVersion: "t")
    XCTAssertEqual(summary?.fullBodyVisibleFrameCount, 8)

    var trails = PoseMotionTrailBuffer()
    frames.forEach { trails.ingest(landmarks: $0.landmarks, timestampMs: $0.timestampMs) }
    XCTAssertLessThanOrEqual(trails.storedSampleCount, 8 * 8)

    let detector = TemporalStrokeDetector()
    frames.forEach { XCTAssertNil(detector.ingest(pose: $0, paddle: nil)) }
    XCTAssertEqual(detector.lastBodyScale ?? 0, bodySpan, accuracy: 1e-9)
  }

  /// Rapid repeats: the same frame ingested 300 times (identical timestamp)
  /// yields no speed, no event, no growth in any bounded buffer. (The
  /// readiness stability window is not bounded by count — it keeps every
  /// same-timestamp sample and its pairwise-travel scan is O(n²) — so this
  /// stays at 300 to keep the suite fast; 1 000 repeats took ~20 s.)
  func testS10RepeatedIdenticalFrameIsInert() {
    let frame = fullBodyPose(at: 1_000)
    let detector = TemporalStrokeDetector()
    let stream = SessionMotionStream()
    var trails = PoseMotionTrailBuffer()
    let evaluator = PoseReadinessEvaluator()
    let accumulator = CaptureEvidenceAccumulator()
    for _ in 0 ..< 300 {
      XCTAssertNil(detector.ingest(pose: frame, paddle: nil))
      XCTAssertNil(stream.ingest(pose: frame))
      trails.ingest(landmarks: frame.landmarks, timestampMs: frame.timestampMs)
      XCTAssertEqual(evaluator.ingest(pose: frame).stableForMs, 0)
      accumulator.ingest(pose: frame)
    }
    XCTAssertEqual(trails.storedSampleCount, 8)
    XCTAssertTrue(trails.segments(at: 1_000).isEmpty)
    let summary = accumulator.summary(startMs: 1_000, endMs: 1_000, poseSource: "t", poseModelVersion: "t", triggerAlgorithmVersion: "t")
    XCTAssertEqual(summary?.poseFrameCount, 300)
    XCTAssertEqual(summary?.trackedDurationMs, 0)
    XCTAssertTrue(summary?.jointMotion.isEmpty ?? false)
  }

  // MARK: - S11 — interleaving reset() mid-candidate

  /// `reset()` between the trigger and the settle window drops the candidate
  /// (no event) and the very next ready position + drive fires normally —
  /// the reset leaves no refractory or stale quiet run behind.
  func testS11ResetMidCandidateDropsItAndTheDetectorReArmsImmediately() {
    let detector = TemporalStrokeDetector()
    var path = stillPath(readyFrames)
    path = move(path, by: Array(driveDeltas.prefix(4)))
    for (index, offset) in path.enumerated() {
      XCTAssertNil(detector.ingest(pose: fullBodyPose(at: index * cadenceMs, wristOffset: offset), paddle: nil))
    }
    detector.reset()
    XCTAssertNil(detector.lastBodyScale)
    // Continue the same clock: a new ready position then the drive.
    let resumeMs = path.count * cadenceMs
    var resume = stillPath(readyFrames, at: path.last ?? 0)
    resume = move(resume, by: driveDeltas)
    resume = hold(resume, for: 5)
    var events: [StrokeEvent] = []
    for (index, offset) in resume.enumerated() {
      if let event = detector.ingest(pose: fullBodyPose(at: resumeMs + index * cadenceMs, wristOffset: offset), paddle: nil) {
        events.append(event)
      }
    }
    XCTAssertEqual(events.count, 1)
    events.forEach { assertFinite($0) }
    XCTAssertEqual(events.first?.startMs, resumeMs + (readyFrames - 1) * cadenceMs)
  }

  // MARK: - Helpers

  private func assertFinite(_ event: StrokeEvent, _ context: String = "", file: StaticString = #filePath, line: UInt = #line) {
    XCTAssertTrue(event.confidence.isFinite, "confidence=\(event.confidence) \(context)", file: file, line: line)
    XCTAssertTrue((0 ... 1).contains(event.confidence), "confidence=\(event.confidence) \(context)", file: file, line: line)
    XCTAssertLessThanOrEqual(event.startMs, event.endMs, context, file: file, line: line)
    if let peak = event.peakMotionMs {
      XCTAssertGreaterThanOrEqual(peak, event.startMs, context, file: file, line: line)
      XCTAssertLessThanOrEqual(peak, event.endMs, context, file: file, line: line)
    }
  }

  private func stillPath(_ count: Int, at offset: Double = 0) -> [Double] {
    Array(repeating: offset, count: count)
  }

  private func move(_ path: [Double], by deltas: [Double]) -> [Double] {
    var offset = path.last ?? 0
    return path + deltas.map { delta in
      offset += delta
      return offset
    }
  }

  private func hold(_ path: [Double], for count: Int) -> [Double] {
    path + stillPath(count, at: path.last ?? 0)
  }

  private func run(_ detector: TemporalStrokeDetector, _ frames: [PoseFrame]) -> [(tMs: Int, event: StrokeEvent)] {
    var events: [(tMs: Int, event: StrokeEvent)] = []
    for frame in frames {
      if let event = detector.ingest(pose: frame, paddle: nil) {
        events.append((frame.timestampMs, event))
      }
    }
    return events
  }

  /// `TemporalStrokeDetectorTests.fullBodyPose` with `bodySpan` fixed at 0.4
  /// plus an optional raw override of the right wrist's x (for NaN / ±∞).
  private func fullBodyPose(
    at timestampMs: Int,
    wristOffset: Double = 0,
    rightWristX: Double? = nil,
    removing names: Set<String> = [],
    confidence: Double = 0.95
  ) -> PoseFrame {
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
      landmarks: template.compactMap { name, x, y in
        guard !names.contains(name) else { return nil }
        let imageX = 0.5 + x * bodySpan
        return PoseLandmark(
          name: name,
          x: name == "right_wrist" ? (rightWristX ?? imageX) : imageX,
          y: shoulderY + y * bodySpan,
          visibility: 0.95
        )
      },
      confidence: confidence
    )
  }

  /// `TemporalStrokeDetectorTests.paddleFrame` (body still) with a chosen
  /// confidence.
  private func paddleFrame(at timestampMs: Int, offset: Double, confidence: Double) -> PaddleFrame {
    let shoulderY = 0.5 - bodySpan / 2
    return PaddleFrame(
      timestampMs: timestampMs,
      bbox: nil,
      handleEnd: nil,
      throat: nil,
      center: CGPoint(x: 0.5 + (0.3 - offset) * bodySpan, y: shoulderY + 0.5 * bodySpan),
      tip: nil,
      confidence: confidence
    )
  }

  private func wrist(_ name: String, _ x: Double, visibility: Double = 0.95) -> PoseLandmark {
    PoseLandmark(name: name, x: x, y: 0.4, visibility: visibility)
  }
}
