import XCTest
@testable import PickleVisionCore

/// Reproduction tests for the native-vision-core audit adjudication at
/// 4d812e1a. Every test asserts the DESIRED behaviour, so a red test is a
/// reproduced defect and a green test is a rejected (non-reproducible) claim.
/// Run through tools/adjudicate/native-vision-core/run.sh (Linux proxy for the
/// pure-Swift logic; not Apple evidence).
final class AdjudicationReproTests: XCTestCase {
  // MARK: - G6 readiness: exact sample at now-450ms required

  /// Camera PTS at 60 fps rounded to integer ms, as CameraEngine produces
  /// (`Int((CMTimeGetSeconds(pts) * 1000).rounded())`), with an arbitrary
  /// host-clock origin.
  private func cameraGridMs(frame k: Int, originS: Double = 123_456.789_123) -> Int {
    Int(((originS + Double(k) / 60.0) * 1000).rounded())
  }

  private func firstReadyMs(cadence: [Int], untilMs: Int = 3_000) -> (readyMs: Int?, maxStableForMs: Int) {
    let evaluator = PoseReadinessEvaluator()
    var t = 0
    var i = 0
    var maxStable = 0
    while t <= untilMs {
      let snapshot = evaluator.ingest(pose: pose(timestampMs: t))
      maxStable = max(maxStable, snapshot.stableForMs)
      if snapshot.state == .ready { return (t, maxStable) }
      t += cadence[i % cadence.count]
      i += 1
    }
    return (nil, maxStable)
  }

  func testG6_control_exact450Multiple_reachesReady() {
    // 25 fps: 450 = 40 * 11.25 -> no; 30 ms steps: 450 = 15 * 30 -> yes.
    let (ready, _) = firstReadyMs(cadence: [30])
    XCTAssertEqual(ready, 450)
  }

  func testG6_stillAthleteAt25fpsBecomesReadyWithin3s() {
    // 40 ms cadence: no sample ever sits exactly at now-450 (450/40 is not
    // integral). A still athlete must still be reported ready within a few
    // hundred ms of the 450 ms window (we allow up to 3 s here).
    let (ready, maxStable) = firstReadyMs(cadence: [40])
    XCTAssertNotNil(ready, "never ready at 40 ms cadence; max stableForMs=\(maxStable)")
  }

  func testG6_stillAthleteAt30fpsGrid_33_33_34_BecomesReadyWithin3s() {
    // 30 fps camera grid rounded to ms: 33,33,34 repeating.
    let (ready, maxStable) = firstReadyMs(cadence: [33, 33, 34])
    XCTAssertNotNil(ready, "never ready at 30 fps ms grid; max stableForMs=\(maxStable)")
  }

  func testG6_60fpsCameraGridEveryFrame_readyAt27Frames() {
    // Vision keeps up with every camera frame: a sample exists exactly 27
    // frames (= 450.0 ms) behind, so ready is reached. Control case.
    let evaluator = PoseReadinessEvaluator()
    var readyAtFrame: Int?
    for k in 0..<180 {
      if evaluator.ingest(pose: pose(timestampMs: cameraGridMs(frame: k))).state == .ready {
        readyAtFrame = k
        break
      }
    }
    XCTAssertEqual(readyAtFrame, 27)
  }

  func testG6_60fpsCameraGridEveryOtherFrame_becomesReadyWithin3s() {
    // Vision takes 17..33 ms per frame, so `visionInFlight` back-pressure in
    // GuidedCaptureViewController.handleFrame drops every other camera frame.
    // Retained samples are then 2 frames apart; 27 frames is odd, so no
    // sample ever sits exactly 450 ms behind -> never ready.
    let evaluator = PoseReadinessEvaluator()
    var readyAtFrame: Int?
    var maxStable = 0
    for k in stride(from: 0, to: 180, by: 2) {
      let snapshot = evaluator.ingest(pose: pose(timestampMs: cameraGridMs(frame: k)))
      maxStable = max(maxStable, snapshot.stableForMs)
      if snapshot.state == .ready {
        readyAtFrame = k
        break
      }
    }
    XCTAssertNotNil(readyAtFrame, "never ready on 60 fps grid at stride 2 within 3 s; max stableForMs=\(maxStable)")
  }

  func testG6_60fpsCameraGridStride3_becomesReadyAt27Frames() {
    // Stride 3 (Vision ~34-50 ms/frame): 27 is a multiple of 3, so ready IS
    // reached — showing readiness depends on Vision latency parity, not on
    // the athlete's stillness.
    let evaluator = PoseReadinessEvaluator()
    var readyAtFrame: Int?
    for k in stride(from: 0, to: 180, by: 3) {
      if evaluator.ingest(pose: pose(timestampMs: cameraGridMs(frame: k))).state == .ready {
        readyAtFrame = k
        break
      }
    }
    XCTAssertEqual(readyAtFrame, 27)
  }

  func testG6_stillAthleteFor10sAt25fpsIsReported_ready_atLeastOnce() {
    // 10 s of perfect stillness at a 40 ms cadence: the snapshot must report
    // `.ready` at least once (the emitted stableForMs is 0 unless ready, so
    // the telemetry sees a permanent hold_still / stableForMs=0).
    let (ready, maxStable) = firstReadyMs(cadence: [40], untilMs: 10_000)
    XCTAssertNotNil(ready, "never ready in 10 s; max reported stableForMs=\(maxStable)")
  }

  func testG6_realAppleVisionTimestampGrid_becomesReady() {
    // Real Apple Vision frame timestamps from the exact-SHA M4 run
    // (Mac Full Verify 33841813597, swing-lab-extract/pose.json, first 240
    // frames: a 24 fps grid rounded to ms, 41/42 ms steps). A still athlete
    // on this grid never has a sample exactly 450 ms behind.
    let realTimestamps = [1083, 1167, 1208, 1250, 1292, 1333, 1375, 1417, 1458, 1500, 1542, 1583, 1625, 1667, 1708, 1750, 1792, 1833, 1875, 1917, 1958, 2000, 2042, 2083, 2125, 2167, 2208, 2250, 2292, 2333, 2375, 2417, 2458, 2500, 2542, 2583, 2625, 2667, 2708, 2750, 2792, 2833, 2875, 2917, 2958, 3000, 3042, 3083, 3125, 3167, 3208, 3250, 3292, 3333, 3375, 3417, 3458, 3500, 3542, 3583, 3625, 3667, 3708, 3750, 3792, 3833, 3875, 3917, 3958, 4000, 4042, 4083, 4125, 4167, 4208, 4250, 4292, 4333, 4375, 4417, 4458, 4500, 4542, 4583, 4625, 4667, 4708, 4750, 4792, 4833, 4875, 4917, 4958, 5000, 5042, 5083, 5125, 5167, 5208, 5250, 5292, 5333, 5375, 5417, 5458, 5500, 5542, 5583, 5625, 5667, 5708, 5750, 5792, 5833, 5875, 5917, 5958, 6000, 6042, 6083, 6125, 6167, 6208, 6250, 6292, 6333, 6375, 6417, 6458, 6500, 6542, 6583, 6625, 6667, 6708, 6750, 6792, 6833, 6875, 6917, 6958, 7000, 7042, 7083, 7125, 7167, 7208, 7250, 7292, 7333, 7375, 7417, 7458, 7500, 7542, 7583, 7625, 7667, 7708, 7750, 7792, 7833, 7875, 7917, 7958, 8000, 8042, 8083, 8125, 8167, 8208, 8250, 8292, 8333, 8375, 8417, 8458, 8500, 8542, 8583, 8625, 8667, 8708, 8750, 8792, 8833, 8875, 8917, 8958, 9000, 9042, 9083, 9125, 9167, 9208, 9250, 9292, 9333, 9375, 9417, 9458, 9500, 9542, 9583, 9625, 9667, 9708, 9750, 9792, 9833, 9875, 9917, 9958, 10000, 10042, 10083, 10125, 10167, 10208, 10250, 10292, 10333, 10375, 10417, 10458, 10500, 10542, 10583, 10625, 10667, 10708, 10750, 10792, 10833, 10875, 10917, 10958, 11000, 11042, 11083]
    let evaluator = PoseReadinessEvaluator()
    var readyAt: Int?
    for t in realTimestamps where evaluator.ingest(pose: pose(timestampMs: t)).state == .ready {
      readyAt = t
      break
    }
    XCTAssertNotNil(readyAt, "never ready across \(realTimestamps.count) real Vision frames (10 s)")
  }

  // MARK: - G1 non-finite ankle poisons TemporalStrokeDetector.lastBodyScale

  func testG1_infiniteAnkleFrameDoesNotPoisonBodyScaleForLaterSwing() {
    let detector = TemporalStrokeDetector()
    // 400 ms still (ready position) with one corrupt frame in the middle whose
    // ankle y is +inf. Then a moderate drive that MUST still be detected.
    let cadence = 40
    var frames: [PoseFrame] = []
    for k in 0..<11 {
      frames.append(fullBodyPose(at: k * cadence, bodySpan: 0.5, wristOffset: 0, ankleY: k == 5 ? .infinity : nil))
    }
    let deltas: [Double] = [0.06, 0.08, 0.07, 0.06, 0.05, 0.04, 0.03, 0.016, 0.008, 0.004, 0.004]
    var offset = 0.0
    for (i, d) in deltas.enumerated() {
      offset += d
      frames.append(fullBodyPose(at: (11 + i) * cadence, bodySpan: 0.5, wristOffset: offset))
    }
    var events = 0
    for f in frames where detector.ingest(pose: f, paddle: nil) != nil { events += 1 }
    XCTAssertTrue(detector.lastBodyScale?.isFinite ?? false, "lastBodyScale=\(String(describing: detector.lastBodyScale))")
    XCTAssertEqual(events, 1, "drive after a single non-finite ankle frame was not detected")
  }

  func testG1_nanAnkleFrameDoesNotPoisonBodyScaleForLaterSwing() {
    let detector = TemporalStrokeDetector()
    let cadence = 40
    var frames: [PoseFrame] = []
    for k in 0..<11 {
      frames.append(fullBodyPose(at: k * cadence, bodySpan: 0.5, wristOffset: 0, ankleY: k == 5 ? .nan : nil))
    }
    let deltas: [Double] = [0.06, 0.08, 0.07, 0.06, 0.05, 0.04, 0.03, 0.016, 0.008, 0.004, 0.004]
    var offset = 0.0
    for (i, d) in deltas.enumerated() {
      offset += d
      frames.append(fullBodyPose(at: (11 + i) * cadence, bodySpan: 0.5, wristOffset: offset))
    }
    var events = 0
    for f in frames where detector.ingest(pose: f, paddle: nil) != nil { events += 1 }
    XCTAssertTrue(detector.lastBodyScale?.isFinite ?? false, "lastBodyScale=\(String(describing: detector.lastBodyScale))")
    XCTAssertEqual(events, 1, "drive after a single NaN ankle frame was not detected")
  }

  func testG1_control_cleanReadyThenDriveEmitsOneEvent() {
    let detector = TemporalStrokeDetector()
    let cadence = 40
    var frames: [PoseFrame] = []
    for k in 0..<11 { frames.append(fullBodyPose(at: k * cadence, bodySpan: 0.5, wristOffset: 0)) }
    let deltas: [Double] = [0.06, 0.08, 0.07, 0.06, 0.05, 0.04, 0.03, 0.016, 0.008, 0.004, 0.004]
    var offset = 0.0
    for (i, d) in deltas.enumerated() {
      offset += d
      frames.append(fullBodyPose(at: (11 + i) * cadence, bodySpan: 0.5, wristOffset: offset))
    }
    var events = 0
    for f in frames where detector.ingest(pose: f, paddle: nil) != nil { events += 1 }
    XCTAssertEqual(events, 1)
  }

  // MARK: - G2 non-finite wrist -> SessionMotionStream emits non-finite speed

  func testG2_sessionMotionStreamNeverEmitsNonFiniteSpeed() {
    let stream = SessionMotionStream()
    _ = stream.ingest(pose: pose(timestampMs: 0))
    let corrupt = pose(timestampMs: 40, wristX: .infinity)
    let sample = stream.ingest(pose: corrupt)
    if let sample {
      XCTAssertTrue(sample.value.isFinite, "emitted value=\(sample.value)")
    }
    let nanCorrupt = pose(timestampMs: 80, wristX: .nan)
    if let sample = stream.ingest(pose: nanCorrupt) {
      XCTAssertTrue(sample.value.isFinite, "emitted value=\(sample.value)")
    }
    // And the next clean frame after the corrupt one must not inherit it.
    if let sample = stream.ingest(pose: pose(timestampMs: 120)) {
      XCTAssertTrue(sample.value.isFinite, "post-corrupt value=\(sample.value)")
    }
  }

  func testG2_temporalDetectorNeverTriggersOnNonFiniteWrist() {
    // A single ±inf wrist frame after a quiet run must not open (or emit) a
    // stroke candidate; the following clean still frames must not emit.
    let detector = TemporalStrokeDetector()
    let cadence = 40
    for k in 0..<11 { _ = detector.ingest(pose: fullBodyPose(at: k * cadence, bodySpan: 0.5, wristOffset: 0), paddle: nil) }
    var emitted: [StrokeEvent] = []
    if let e = detector.ingest(pose: fullBodyPose(at: 11 * cadence, bodySpan: 0.5, wristOffset: 0, wristX: .infinity), paddle: nil) { emitted.append(e) }
    for k in 12..<40 {
      if let e = detector.ingest(pose: fullBodyPose(at: k * cadence, bodySpan: 0.5, wristOffset: 0), paddle: nil) { emitted.append(e) }
    }
    XCTAssertTrue(emitted.isEmpty, "non-finite wrist produced \(emitted.count) event(s): \(emitted)")
  }

  // MARK: - G4 far-future frame strands readiness / evidence

  func testG4_singleFarFutureFrameDoesNotStrandReadiness() {
    let evaluator = PoseReadinessEvaluator()
    for t in stride(from: 0, through: 450, by: 30) { _ = evaluator.ingest(pose: pose(timestampMs: t)) }
    XCTAssertEqual(evaluator.ingest(pose: pose(timestampMs: 480)).state, .ready)
    // One frame with a far-future timestamp (e.g. a clock glitch), then the
    // real clock resumes.
    _ = evaluator.ingest(pose: pose(timestampMs: 10_000_000))
    var readyAgain: Int?
    for t in stride(from: 510, through: 3_000, by: 30) {
      if evaluator.ingest(pose: pose(timestampMs: t)).state == .ready { readyAgain = t; break }
    }
    XCTAssertNotNil(readyAgain, "readiness never recovered after one far-future frame")
  }

  func testG4_singleFarFutureFrameDoesNotEmptyEvidenceWindow() {
    let acc = CaptureEvidenceAccumulator()
    for t in stride(from: 0, through: 1_000, by: 40) { acc.ingest(pose: pose(timestampMs: t)) }
    acc.ingestMissing(timestampMs: 10_000_000)
    for t in stride(from: 1_040, through: 2_000, by: 40) { acc.ingest(pose: pose(timestampMs: t)) }
    let summary = acc.summary(startMs: 0, endMs: 2_000, poseSource: "t", poseModelVersion: "t", triggerAlgorithmVersion: "t")
    XCTAssertNotNil(summary, "evidence for the real window was purged by one far-future attempt")
  }

  // MARK: - S11 same-timestamp ingestMissing growth (stuck clock)

  func testS11_sameTimestampAttemptsAreBounded() {
    let acc = CaptureEvidenceAccumulator()
    for _ in 0..<20_000 { acc.ingestMissing(timestampMs: 1_000) }
    let count = Mirror(reflecting: acc).children.first { $0.label == "attempts" }.map { ($0.value as? [Any])?.count ?? -1 } ?? -1
    XCTAssertLessThanOrEqual(count, 4_000, "retained attempts=\(count) for a stuck clock")
  }

  // MARK: - S12 readiness pairwise travel cost under a realistic frame rate

  func testS12_readinessAt240fpsBurstStaysCheap() {
    // 240 fps is the highest capture rate on any supported iPhone; the 450 ms
    // window then holds ≤ 109 samples -> ≤ ~12k pair distances per frame.
    let evaluator = PoseReadinessEvaluator()
    let start = Date()
    var t = 0
    for _ in 0..<2_400 { _ = evaluator.ingest(pose: pose(timestampMs: t)); t += 4 }
    let elapsed = Date().timeIntervalSince(start)
    XCTAssertLessThan(elapsed, 2.0, "10 s of 240 fps took \(elapsed)s")
  }

  // MARK: - Fixtures

  private func pose(timestampMs: Int, wristX: Double? = nil) -> PoseFrame {
    let points: [(String, Double, Double)] = [
      ("left_shoulder", 0.43, 0.25), ("right_shoulder", 0.57, 0.25),
      ("left_elbow", 0.39, 0.38), ("right_elbow", 0.61, 0.38),
      ("left_wrist", 0.36, 0.50), ("right_wrist", wristX ?? 0.64, 0.50),
      ("left_hip", 0.45, 0.52), ("right_hip", 0.55, 0.52),
      ("left_knee", 0.45, 0.70), ("right_knee", 0.55, 0.70),
      ("left_ankle", 0.44, 0.90), ("right_ankle", 0.56, 0.90),
    ]
    return PoseFrame(
      timestampMs: timestampMs,
      landmarks: points.map { PoseLandmark(name: $0.0, x: $0.1, y: $0.2, visibility: 0.95) },
      confidence: 0.95
    )
  }

  /// Same template as TemporalStrokeDetectorTests.fullBodyPose (body-heights,
  /// shoulder line = 0, ankles = 1, scaled by `bodySpan`).
  private func fullBodyPose(
    at timestampMs: Int,
    bodySpan: Double,
    wristOffset: Double,
    ankleY: Double? = nil,
    wristX: Double? = nil
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
      landmarks: template.map { name, x, y in
        var px = 0.5 + x * bodySpan
        var py = shoulderY + y * bodySpan
        if let ankleY, name == "left_ankle" || name == "right_ankle" { py = ankleY }
        if let wristX, name == "right_wrist" { px = wristX }
        return PoseLandmark(name: name, x: px, y: py, visibility: 0.95)
      },
      confidence: 0.95
    )
  }
}
