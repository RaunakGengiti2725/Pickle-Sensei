import XCTest
@testable import PickleVisionCore

/// Round-10 reviewer probes (disposable, never merged). Each test pins one
/// property the review needed evidence for; the doc comment says which claim.
final class Review10ProbeTests: XCTestCase {
  // Claim 2 — the anchor is the NEWEST sample at or before t-450, not the
  // oldest retained one. 0/100/200/700: cutoff 250 → anchor 200 → 500 ms.
  // A `firstIndex(where:)` implementation would report 700.
  func testProbeAnchorIsNewestNotOldestSample() {
    let evaluator = PoseReadinessEvaluator()
    for t in [0, 100, 200] { _ = evaluator.ingest(pose: pose(timestampMs: t)) }
    let snapshot = evaluator.ingest(pose: pose(timestampMs: 700))
    XCTAssertEqual(snapshot.state, .ready)
    XCTAssertEqual(snapshot.stableForMs, 500)
  }

  // Claim 2 — semantic change vs ca5c5b25: two observations ≥450 ms apart
  // with NO frames between them (Vision stall; frames skipped while
  // `visionInFlight`) now read as ready on the second observation. The old
  // pruning dropped every sample older than 450 ms and restarted the window
  // (holdStill, stableForMs 0). The evaluator has no maximum sample gap.
  func testProbeObservationGapLongerThanWindowIsReadyOnSecondSample() {
    let evaluator = PoseReadinessEvaluator()
    _ = evaluator.ingest(pose: pose(timestampMs: 0))
    let snapshot = evaluator.ingest(pose: pose(timestampMs: 1_100))
    XCTAssertEqual(snapshot.state, .ready)
    XCTAssertEqual(snapshot.stableForMs, 1_100)
  }

  // Claim 2 — movement INSIDE the window still resets: still 0..600, step at
  // 620, still afterwards → not ready at 1_000 (380 ms after the step), ready
  // once a post-step sample is ≥450 ms old.
  func testProbeMovementInsideWindowStillResets() {
    let evaluator = PoseReadinessEvaluator()
    var t = 0
    while t <= 600 { _ = evaluator.ingest(pose: pose(timestampMs: t)); t += 33 }
    XCTAssertEqual(evaluator.ingest(pose: pose(timestampMs: 620, xOffset: 0.2)).state, .holdStill)
    t = 653
    var lastState: PoseReadinessEvaluator.State = .holdStill
    while t <= 1_000 {
      lastState = evaluator.ingest(pose: pose(timestampMs: t, xOffset: 0.2)).state
      t += 33
    }
    XCTAssertEqual(lastState, .holdStill)
    XCTAssertEqual(evaluator.ingest(pose: pose(timestampMs: 1_075, xOffset: 0.2)).state, .ready)
  }

  // Claim 2 — the window is bounded: anchor + samples within 450 ms. At 60 fps
  // that is ≤ 29 samples. Pinned through `maximumPairwiseTravel` cost being
  // irrelevant: 10 000 frames finish instantly; and readiness never flips.
  func testProbeLongStillSessionStaysReadyAndCheap() {
    let evaluator = PoseReadinessEvaluator()
    var notReady = 0
    for index in 0 ..< 10_000 {
      let t = Int((Double(index) / 60.0 * 1_000).rounded())
      let snapshot = evaluator.ingest(pose: pose(timestampMs: t))
      if t >= 450, !snapshot.isReady { notReady += 1 }
    }
    XCTAssertEqual(notReady, 0)
  }

  // Claim 2 — first ready frame at 30 fps reports 467, not exactly 450.
  func testProbeFirstReadyFrameAt30FpsReportsSpanAboveWindow() {
    let evaluator = PoseReadinessEvaluator()
    var first: PoseReadinessEvaluator.Snapshot?
    for index in 0 ..< 30 {
      let t = Int((Double(index) / 30.0 * 1_000).rounded())
      let snapshot = evaluator.ingest(pose: pose(timestampMs: t))
      if snapshot.isReady, first == nil { first = snapshot }
    }
    XCTAssertEqual(first?.timestampMs, 467)
    XCTAssertEqual(first?.stableForMs, 467)
  }

  // Claim 5(b) — a frame whose wrists were both dropped (non-finite) is
  // "wrist not visible" for the detector/stream and `missingJoints` for
  // readiness; nothing traps or divides by zero.
  func testProbeDroppedWristsReadAsMissingEverywhere() {
    let frame = PoseFrame(
      timestampMs: 33,
      landmarks: pose(timestampMs: 33).landmarks.map {
        PoseLandmark(name: $0.name, x: $0.name.hasSuffix("wrist") ? .nan : $0.x, y: $0.y, visibility: $0.visibility)
      },
      confidence: 0.95
    )
    XCTAssertEqual(frame.landmarks.count, 10)
    let readiness = PoseReadinessEvaluator().ingest(pose: frame)
    // Wrists are not mandatory joints (coverage 10/12 ≥ 0.83) → holdStill,
    // reported via `missingJoints`; the frame is not rejected.
    XCTAssertEqual(readiness.state, .holdStill)
    XCTAssertEqual(readiness.missingJoints, ["left_wrist", "right_wrist"])
    XCTAssertEqual(readiness.jointCoverage, 10.0 / 12.0, accuracy: 0.001)
    XCTAssertNil(SessionMotionStream().ingest(pose: frame))
    XCTAssertNil(TemporalStrokeDetector().ingest(pose: frame, paddle: nil))
  }

  // Claim 6 — the shipped assertion `sample?.value.isFinite ?? true` is
  // vacuous when the stream emits nothing; the stricter form (left wrist
  // still finite and unmoved → speed exactly 0) also holds.
  func testProbeStricterMotionStreamAssertionHolds() {
    let stream = SessionMotionStream()
    _ = stream.ingest(pose: pose(timestampMs: 0))
    let corrupt = PoseFrame(
      timestampMs: 33,
      landmarks: pose(timestampMs: 33).landmarks.map {
        PoseLandmark(name: $0.name, x: $0.name == "right_wrist" ? .infinity : $0.x, y: $0.y, visibility: $0.visibility)
      },
      confidence: 0.95
    )
    let sample = stream.ingest(pose: corrupt)
    XCTAssertNotNil(sample)
    XCTAssertEqual(sample?.value, 0)
  }

  private func pose(timestampMs: Int, xOffset: Double = 0) -> PoseFrame {
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
      landmarks: points.map { PoseLandmark(name: $0.0, x: $0.1 + xOffset, y: $0.2, visibility: 0.95) },
      confidence: 0.95
    )
  }
}
