import XCTest

@testable import PickleVisionCore

/// Structural-audit probes (pass 1, native-vision-core) for the temporal
/// detector's input-validation, ordering and cadence invariants. New file
/// only; the shipped suite is untouched. Each test states the invariant it
/// probes; a failure on 4d812e1a is a finding, a pass is `verified_ok`.
final class AuditTemporalStrokeDetectorProbeTests: XCTestCase {
  private let bodySpan = 0.45

  // MARK: - Input validation (TemporalStrokeDetector.swift:254-275 has none)

  /// A single frame whose wrist coordinate is NaN must neither crash nor
  /// produce a stroke; the still frames around it carry no swing.
  func testNaNWristCoordinateNeverCrashesOrEmits() {
    let detector = TemporalStrokeDetector()
    var events: [StrokeEvent] = []
    for k in 0...60 {
      let t = k * 40
      let frame = k == 15
        ? pose(at: t, rightWristX: .nan)
        : pose(at: t)
      if let event = detector.ingest(pose: frame, paddle: nil) { events.append(event) }
    }
    XCTAssertTrue(events.isEmpty, "NaN frame produced \(events)")
  }

  /// A single frame whose wrist coordinate is ±∞ must not produce a stroke:
  /// the athlete never moved. PoseMotionTrail (:88) and
  /// CaptureEvidenceAccumulator (:92-93) reject non-finite coordinates; the
  /// detector does not, so one corrupt sample can open AND close a candidate
  /// (infinite speed crosses the trigger, infinite path passes the path gate).
  func testInfiniteWristCoordinateOnOneStillFrameDoesNotEmitAStroke() {
    let detector = TemporalStrokeDetector()
    var events: [(tMs: Int, event: StrokeEvent)] = []
    for k in 0...60 {
      let t = k * 40
      let frame = k == 11
        ? pose(at: t, rightWristX: .infinity)
        : pose(at: t)
      if let event = detector.ingest(pose: frame, paddle: nil) { events.append((t, event)) }
    }
    XCTAssertTrue(
      events.isEmpty,
      "a still athlete with one ∞ sample emitted \(events.map { "t=\($0.tMs) start=\($0.event.startMs) end=\($0.event.endMs) conf=\($0.event.confidence)" })"
    )
  }

  /// Duplicate landmark names (two `right_wrist` entries) must not crash the
  /// detector (PoseReadinessEvaluator traps on the same input — see the
  /// audit probe script).
  func testDuplicateLandmarkNamesDoNotCrashDetector() {
    let detector = TemporalStrokeDetector()
    for k in 0...30 {
      var frame = pose(at: k * 40)
      let dup = PoseLandmark(name: "right_wrist", x: 0.3, y: 0.5, visibility: 0.9)
      frame = PoseFrame(timestampMs: frame.timestampMs, landmarks: frame.landmarks + [dup], confidence: frame.confidence)
      _ = detector.ingest(pose: frame, paddle: nil)
    }
    XCTAssertNotNil(detector.lastBodyScale)
  }

  // MARK: - Timestamp ordering (TemporalStrokeDetector.swift:256,274)

  /// A regressed / repeated timestamp mid-sequence must not crash and must not
  /// hide the following stroke (the detector should behave as if the frame
  /// were skipped).
  func testRegressedTimestampBeforeADriveNeitherCrashesNorHidesTheStroke() {
    var frames = driveFrames(fps: 25)
    // Duplicate the last still frame with a timestamp 5 ms in the past.
    let stillIndex = frames.lastIndex { $0.timestampMs < 600 }!
    let still = frames[stillIndex]
    let regressed = PoseFrame(timestampMs: still.timestampMs - 5, landmarks: still.landmarks, confidence: still.confidence)
    frames.insert(regressed, at: stillIndex + 1)
    let events = run(TemporalStrokeDetector(), frames)
    XCTAssertEqual(events.count, 1, "events=\(events)")
  }

  // MARK: - Paddle gate boundary (TemporalStrokeDetector.swift:237)

  /// Paddle confidence exactly 0.5 must NOT replace the wrists (strict `>`).
  /// A fast-moving paddle with still wrists yields no stroke at 0.5 and a
  /// stroke at 0.51.
  func testPaddleConfidenceExactlyHalfFallsBackToWrists() {
    for (confidence, expectEvent) in [(0.5, false), (0.51, true)] {
      let detector = TemporalStrokeDetector()
      var events: [StrokeEvent] = []
      let offsets = wristOffsets(fps: 25)
      for (k, offset) in offsets.enumerated() {
        let t = k * 40
        let paddle = PaddleFrame(
          timestampMs: t,
          bbox: nil,
          handleEnd: nil,
          throat: nil,
          center: CGPoint(x: 0.5 + (0.3 - offset) * bodySpan, y: 0.5),
          tip: nil,
          confidence: confidence
        )
        if let event = detector.ingest(pose: pose(at: t), paddle: paddle) { events.append(event) }
      }
      XCTAssertEqual(!events.isEmpty, expectEvent, "confidence=\(confidence) events=\(events)")
    }
  }

  // MARK: - Cadence invariance

  /// The same physical drive sampled at 60, 30 and 25 fps (CMTime→ms rounding
  /// applied) must be detected at every cadence; start/end may differ by at
  /// most one frame period.
  func testSameDriveIsDetectedAt60And30And25Fps() {
    var results: [Int: [(tMs: Int, event: StrokeEvent)]] = [:]
    for fps in [60, 30, 25] {
      results[fps] = run(TemporalStrokeDetector(), driveFrames(fps: fps))
    }
    for fps in [60, 30, 25] {
      XCTAssertEqual(results[fps]?.count, 1, "fps=\(fps) events=\(results[fps] ?? [])")
    }
    guard let a = results[60]?.first?.event, let b = results[30]?.first?.event, let c = results[25]?.first?.event else { return }
    XCTAssertLessThanOrEqual(abs(a.startMs - b.startMs), 34)
    XCTAssertLessThanOrEqual(abs(a.startMs - c.startMs), 40)
    XCTAssertLessThanOrEqual(abs(a.endMs - b.endMs), 34)
    XCTAssertLessThanOrEqual(abs(a.endMs - c.endMs), 40)
  }

  /// The offline pass is pure: running it over a history must leave a live
  /// detector's state (body scale, refractory, candidate) untouched.
  func testStrongestEventLeavesALiveDetectorUntouched() {
    let live = TemporalStrokeDetector()
    let frames = driveFrames(fps: 25)
    _ = live.ingest(pose: frames[0], paddle: nil)
    let scaleBefore = live.lastBodyScale
    XCTAssertNotNil(TemporalStrokeDetector.strongestEvent(in: frames))
    XCTAssertEqual(live.lastBodyScale, scaleBefore)
    // The live detector still sees the drive as its first stroke.
    XCTAssertEqual(run(live, Array(frames.dropFirst())).count, 1)
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

  /// Right-wrist offset (body-heights, along x) as a continuous function of
  /// time: still until 600 ms, a smoothstep of 0.45 bh over 600…1000 ms (peak
  /// ≈ 1.69 bh/s), then still. Sampled with CameraEngine's ms rounding.
  private func wristOffset(atMs t: Int) -> Double {
    let amplitude = 0.45
    let start = 600.0, duration = 400.0
    let u = min(1, max(0, (Double(t) - start) / duration))
    return amplitude * (3 * u * u - 2 * u * u * u)
  }

  private func wristOffsets(fps: Int) -> [Double] {
    (0...(fps * 2)).map { wristOffset(atMs: Int((Double($0) * 1_000.0 / Double(fps)).rounded())) }
  }

  private func driveFrames(fps: Int) -> [PoseFrame] {
    (0...(fps * 2)).map { k in
      let t = Int((Double(k) * 1_000.0 / Double(fps)).rounded())
      return pose(at: t, wristOffset: wristOffset(atMs: t))
    }
  }

  /// Full body centred in frame (same template as the shipped detector
  /// tests); `wristOffset` moves the right wrist along x in body-heights.
  private func pose(at timestampMs: Int, wristOffset: Double = 0, rightWristX: Double? = nil) -> PoseFrame {
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
        let px = (name == "right_wrist" ? rightWristX : nil) ?? (0.5 + x * bodySpan)
        return PoseLandmark(name: name, x: px, y: shoulderY + y * bodySpan, visibility: 0.95)
      },
      confidence: 0.95
    )
  }
}
