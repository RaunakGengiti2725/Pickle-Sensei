import XCTest
@testable import PickleVisionCore

/// Adversarial pass 3 (S18) against `CaptureEvidenceAccumulator.summary`.
///
/// The contract at CaptureEvidenceAccumulator.swift:117-119: evidence is
/// returned ONLY when the inclusive window contains at least one usable pose.
/// Attacks: reversed window, a zero-width window on a single attempt, a window
/// holding only `ingestMissing` attempts, windows adjacent to but not touching
/// the only pose, huge / extreme bounds, a pose and a miss sharing one
/// timestamp, and a "pose" whose landmarks are all unusable.
final class AdversarialPass3CaptureEvidenceAccumulatorTests: XCTestCase {
  private let source = "apple_vision_body_pose"
  private let poseModel = "vision-body-pose-test"
  private let trigger = "temporal-stroke-heuristic-4"

  // MARK: - S18 exactly per the doc

  func testS18ReversedWindowReturnsNilEvenWhenItContainsPoses() {
    let accumulator = CaptureEvidenceAccumulator()
    accumulator.ingest(pose: pose(at: 1_000))
    accumulator.ingest(pose: pose(at: 1_040))
    XCTAssertNil(summary(accumulator, start: 1_040, end: 1_000))
    XCTAssertNil(summary(accumulator, start: 1_001, end: 1_000))
    XCTAssertNil(summary(accumulator, start: Int.max, end: Int.min))
  }

  func testS18ZeroWidthWindowOnASingleUsablePoseReturnsEvidence() {
    let accumulator = CaptureEvidenceAccumulator()
    accumulator.ingest(pose: pose(at: 1_000))
    let evidence = summary(accumulator, start: 1_000, end: 1_000)
    XCTAssertNotNil(evidence)
    XCTAssertEqual(evidence?.analysisInputFrameCount, 1)
    XCTAssertEqual(evidence?.poseFrameCount, 1)
    XCTAssertEqual(evidence?.poseMissingFrameCount, 0)
    XCTAssertEqual(evidence?.trackedDurationMs, 0)
    XCTAssertEqual(evidence?.jointMotion, [], "one pose has no motion samples")
    XCTAssertEqual(evidence?.fullBodyVisibleFrameCount, 1)
    XCTAssertEqual(evidence?.meanJointCoverage ?? 0, 1, accuracy: 1e-12)
  }

  func testS18ZeroWidthWindowOnASingleMissingAttemptReturnsNil() {
    let accumulator = CaptureEvidenceAccumulator()
    accumulator.ingestMissing(timestampMs: 1_000)
    XCTAssertNil(summary(accumulator, start: 1_000, end: 1_000))
  }

  func testS18WindowOfOnlyMissingAttemptsReturnsNil() {
    let accumulator = CaptureEvidenceAccumulator()
    // Usable poses exist on BOTH sides of the window, so the nil must come
    // from the window's own content, not from an empty accumulator.
    accumulator.ingest(pose: pose(at: 900))
    for t in stride(from: 1_000, through: 1_400, by: 40) {
      accumulator.ingestMissing(timestampMs: t)
    }
    accumulator.ingest(pose: pose(at: 1_500))
    XCTAssertNil(summary(accumulator, start: 1_000, end: 1_400))
    // Inclusive edges: touching the pose on either side flips it to evidence.
    XCTAssertNotNil(summary(accumulator, start: 900, end: 1_400))
    XCTAssertNotNil(summary(accumulator, start: 1_000, end: 1_500))
    XCTAssertNil(summary(accumulator, start: 901, end: 1_499))
  }

  // MARK: - Extra attacks on the same contract

  func testS18EmptyAccumulatorReturnsNilForEveryWindowShape() {
    let accumulator = CaptureEvidenceAccumulator()
    XCTAssertNil(summary(accumulator, start: 0, end: 0))
    XCTAssertNil(summary(accumulator, start: Int.min, end: Int.max))
    XCTAssertNil(summary(accumulator, start: -1, end: 1))
  }

  func testS18HugeWindowBoundsDoNotOverflowAndCountEveryAttempt() {
    let accumulator = CaptureEvidenceAccumulator()
    accumulator.ingest(pose: pose(at: 0))
    accumulator.ingest(pose: pose(at: 40))
    let evidence = summary(accumulator, start: Int.min, end: Int.max)
    XCTAssertEqual(evidence?.analysisInputFrameCount, 2)
    XCTAssertEqual(evidence?.trackedDurationMs, 40)
  }

  func testS18NegativeTimestampsAreOrdinaryTimestamps() {
    let accumulator = CaptureEvidenceAccumulator()
    accumulator.ingest(pose: pose(at: -80))
    accumulator.ingest(pose: pose(at: -40, xOffset: 0.01))
    let evidence = summary(accumulator, start: -80, end: -40)
    XCTAssertEqual(evidence?.poseFrameCount, 2)
    XCTAssertEqual(evidence?.trackedDurationMs, 40)
    XCTAssertEqual(evidence?.jointMotion.count, CaptureEvidenceAccumulator.canonicalJoints.count)
  }

  /// A miss recorded at the SAME timestamp as a pose (two inference paths
  /// racing for one frame) must not erase the pose from the window, and the
  /// miss must still break motion continuity across it.
  func testS18PoseAndMissAtTheSameTimestampKeepThePoseAndBreakContinuity() {
    let accumulator = CaptureEvidenceAccumulator()
    accumulator.ingest(pose: pose(at: 1_000))
    accumulator.ingest(pose: pose(at: 1_040, xOffset: 0.01))
    accumulator.ingestMissing(timestampMs: 1_040)
    accumulator.ingest(pose: pose(at: 1_080, xOffset: 0.02))
    let evidence = summary(accumulator, start: 1_000, end: 1_080)
    XCTAssertNotNil(evidence)
    XCTAssertEqual(evidence?.analysisInputFrameCount, 4)
    XCTAssertEqual(evidence?.poseFrameCount, 3)
    XCTAssertEqual(evidence?.poseMissingFrameCount, 1)
    // 1000→1040 is a valid motion sample; the miss at 1040 sits after the pose
    // at 1040 in a stable sort, so 1040→1080 is severed: exactly one sample.
    for motion in evidence?.jointMotion ?? [] {
      XCTAssertEqual(motion.sampleCount, 1, "\(motion.joint) bridged the same-timestamp miss")
    }
  }

  /// A PoseFrame whose landmarks are ALL unusable (outside [0,1], non-finite,
  /// non-canonical names, or empty) is still recorded as a "pose": the summary
  /// is non-nil with zero joint coverage. `GuidedCaptureViewController`
  /// routes `.noPerson` readiness to `ingestMissing`, so the shipping path is
  /// guarded outside the package; the package boundary itself is not.
  func testS18PoseWithNoUsableLandmarksStillCountsAsAUsablePose() {
    let accumulator = CaptureEvidenceAccumulator()
    accumulator.ingest(pose: PoseFrame(timestampMs: 1_000, landmarks: [], confidence: 0.9))
    accumulator.ingest(pose: PoseFrame(
      timestampMs: 1_040,
      landmarks: [
        PoseLandmark(name: "left_wrist", x: 1.5, y: -0.3, visibility: 0.95),
        PoseLandmark(name: "right_wrist", x: .nan, y: 0.5, visibility: 0.95),
        PoseLandmark(name: "left_hip", x: 0.5, y: .infinity, visibility: 0.95),
        PoseLandmark(name: "nose", x: 0.5, y: 0.5, visibility: 0.95),
      ],
      confidence: 0.9
    ))
    let evidence = summary(accumulator, start: 1_000, end: 1_040)
    XCTAssertNotNil(evidence, "documented as 'at least one usable pose' — observed: any PoseFrame counts")
    XCTAssertEqual(evidence?.poseFrameCount, 2)
    XCTAssertEqual(evidence?.meanJointCoverage ?? -1, 0, accuracy: 1e-12)
    XCTAssertEqual(evidence?.minimumJointCoverage ?? -1, 0, accuracy: 1e-12)
    XCTAssertEqual(evidence?.fullBodyVisibleFrameCount, 0)
    XCTAssertEqual(evidence?.meanCanonicalJointVisibility ?? -1, 0, accuracy: 1e-12)
    XCTAssertEqual(evidence?.jointMotion, [])
  }

  /// Retention (4 s by default) is applied on ingest: attempts older than the
  /// newest timestamp minus retention vanish, so a window over them is nil
  /// even though they were ingested.
  func testS18WindowOverEvictedAttemptsReturnsNil() {
    let accumulator = CaptureEvidenceAccumulator()
    accumulator.ingest(pose: pose(at: 0))
    accumulator.ingest(pose: pose(at: 4_001))
    XCTAssertNil(summary(accumulator, start: 0, end: 0))
    XCTAssertNotNil(summary(accumulator, start: 4_001, end: 4_001))
  }

  /// Clock skew: an attempt far in the future evicts everything before it,
  /// then a later "correct" attempt is itself evicted relative to the skewed
  /// maximum. Documented behaviour, pinned so a change is visible.
  func testS18ClockSkewForwardEvictsThePresent() {
    let accumulator = CaptureEvidenceAccumulator()
    accumulator.ingest(pose: pose(at: 1_000))
    accumulator.ingest(pose: pose(at: 1_000_000))
    accumulator.ingest(pose: pose(at: 1_040))
    XCTAssertNil(summary(accumulator, start: 1_000, end: 1_040))
    XCTAssertNotNil(summary(accumulator, start: 1_000_000, end: 1_000_000))
  }

  // MARK: - Fixtures

  private func summary(_ accumulator: CaptureEvidenceAccumulator, start: Int, end: Int) -> CaptureEvidenceAccumulator.Summary? {
    accumulator.summary(
      startMs: start,
      endMs: end,
      poseSource: source,
      poseModelVersion: poseModel,
      triggerAlgorithmVersion: trigger
    )
  }

  private func pose(at timestampMs: Int, xOffset: Double = 0) -> PoseFrame {
    PoseFrame(
      timestampMs: timestampMs,
      landmarks: CaptureEvidenceAccumulator.canonicalJoints.enumerated().map { index, name in
        PoseLandmark(name: name, x: 0.3 + Double(index) * 0.03 + xOffset, y: 0.2 + Double(index) * 0.05, visibility: 0.9)
      },
      confidence: 0.9
    )
  }
}
