import XCTest
@testable import PickleVisionCore

/// Adversarial pass 3 (S19) against `PoseMotionTrailBuffer`.
///
/// A "miss" for the trail buffer is an ingest in which the tracked joint is
/// absent, below `minimumVisibility`, non-finite or outside [0,1]. The buffer
/// must sever that joint's path immediately — even when the miss carries the
/// SAME timestamp as the last good sample, which the monotonic-timestamp guard
/// would otherwise ignore — so that a frame 1 ms later starts a fresh trail
/// instead of resurrecting the pre-miss segment.
final class AdversarialPass3PoseMotionTrailTests: XCTestCase {
  private let joint = "right_wrist"

  func testS19EqualTimestampMissSeversTheTrailAndTheNextFrameStartsFresh() {
    var trails = PoseMotionTrailBuffer(config: .init(trackedJoints: [joint]))
    trails.ingest(landmarks: [landmark(x: 0.20)], timestampMs: 1_000)
    trails.ingest(landmarks: [landmark(x: 0.30)], timestampMs: 1_100)
    XCTAssertEqual(trails.segments(at: 1_100).count, 1, "precondition: one live segment")

    // Miss at the SAME timestamp as the last good sample.
    trails.ingest(landmarks: [], timestampMs: 1_100)
    XCTAssertEqual(trails.storedSampleCount, 0, "equal-timestamp miss must drop the joint's samples")
    XCTAssertTrue(trails.segments(at: 1_100).isEmpty)

    // 1 ms later: a lone sample, no segment, and nothing bridging to 0.30.
    trails.ingest(landmarks: [landmark(x: 0.90)], timestampMs: 1_101)
    XCTAssertEqual(trails.storedSampleCount, 1)
    XCTAssertTrue(trails.segments(at: 1_101).isEmpty, "the pre-miss segment was resurrected")

    // The next real sample forms a segment ONLY from the post-miss sample.
    trails.ingest(landmarks: [landmark(x: 0.91)], timestampMs: 1_141)
    let segments = trails.segments(at: 1_141)
    XCTAssertEqual(segments.count, 1)
    XCTAssertEqual(segments.first?.startX ?? -1, 0.90, accuracy: 1e-12)
    XCTAssertEqual(segments.first?.endX ?? -1, 0.91, accuracy: 1e-12)
  }

  /// Same attack, but the miss is a REGRESSED timestamp (earlier than the last
  /// good sample): still a miss, still severs.
  func testS19RegressedTimestampMissAlsoSeversTheTrail() {
    var trails = PoseMotionTrailBuffer(config: .init(trackedJoints: [joint]))
    trails.ingest(landmarks: [landmark(x: 0.20)], timestampMs: 1_000)
    trails.ingest(landmarks: [landmark(x: 0.30)], timestampMs: 1_100)
    trails.ingest(landmarks: [], timestampMs: 900)
    XCTAssertEqual(trails.storedSampleCount, 0)
    trails.ingest(landmarks: [landmark(x: 0.90)], timestampMs: 1_101)
    XCTAssertTrue(trails.segments(at: 1_101).isEmpty)
  }

  /// Every flavour of "unusable observation" at an equal timestamp is a miss:
  /// low visibility, NaN, infinity, outside [0,1] on either axis.
  func testS19EveryUnusableObservationAtAnEqualTimestampIsAMiss() {
    let unusable: [(String, PoseLandmark)] = [
      ("low visibility", PoseLandmark(name: joint, x: 0.5, y: 0.5, visibility: 0.1)),
      ("nan x", PoseLandmark(name: joint, x: .nan, y: 0.5, visibility: 0.9)),
      ("infinite y", PoseLandmark(name: joint, x: 0.5, y: .infinity, visibility: 0.9)),
      ("x > 1", PoseLandmark(name: joint, x: 1.5, y: 0.5, visibility: 0.9)),
      ("y < 0", PoseLandmark(name: joint, x: 0.5, y: -0.3, visibility: 0.9)),
      ("negative zero-ish x", PoseLandmark(name: joint, x: -1e-12, y: 0.5, visibility: 0.9)),
    ]
    for (label, observation) in unusable {
      var trails = PoseMotionTrailBuffer(config: .init(trackedJoints: [joint]))
      trails.ingest(landmarks: [landmark(x: 0.20)], timestampMs: 1_000)
      trails.ingest(landmarks: [landmark(x: 0.30)], timestampMs: 1_100)
      trails.ingest(landmarks: [observation], timestampMs: 1_100)
      XCTAssertEqual(trails.storedSampleCount, 0, "\(label): equal-timestamp miss did not sever")
      trails.ingest(landmarks: [landmark(x: 0.90)], timestampMs: 1_101)
      XCTAssertTrue(trails.segments(at: 1_101).isEmpty, "\(label): pre-miss segment resurrected")
    }
  }

  /// A miss for ONE joint must not touch another joint's trail.
  func testS19MissIsPerJoint() {
    var trails = PoseMotionTrailBuffer(config: .init(trackedJoints: ["left_wrist", "right_wrist"]))
    trails.ingest(landmarks: [landmark(x: 0.20), landmark(name: "left_wrist", x: 0.70)], timestampMs: 1_000)
    trails.ingest(landmarks: [landmark(x: 0.30), landmark(name: "left_wrist", x: 0.60)], timestampMs: 1_100)
    trails.ingest(landmarks: [landmark(name: "left_wrist", x: 0.60)], timestampMs: 1_100)
    let segments = trails.segments(at: 1_100)
    XCTAssertEqual(segments.map(\.joint), ["left_wrist"])
    XCTAssertEqual(trails.storedSampleCount, 2)
  }

  /// A duplicate GOOD sample at an equal timestamp is ignored (no zero-interval
  /// segment) and does not sever: the trail continues from the original.
  func testS19DuplicateGoodSampleAtEqualTimestampNeitherSeversNorFabricatesSpeed() {
    var trails = PoseMotionTrailBuffer(config: .init(trackedJoints: [joint]))
    trails.ingest(landmarks: [landmark(x: 0.20)], timestampMs: 1_000)
    trails.ingest(landmarks: [landmark(x: 0.30)], timestampMs: 1_100)
    trails.ingest(landmarks: [landmark(x: 0.95)], timestampMs: 1_100)
    XCTAssertEqual(trails.storedSampleCount, 2)
    let segments = trails.segments(at: 1_100)
    XCTAssertEqual(segments.count, 1)
    XCTAssertEqual(segments.first?.endX ?? -1, 0.30, accuracy: 1e-12, "the duplicate must not replace the sample")
    XCTAssertTrue(segments.allSatisfy { $0.normalizedSpeedPerSecond.isFinite })
  }

  /// Rapid repeats: 10 000 alternating good/miss ingests at the same timestamp
  /// never accumulate storage and never produce a segment.
  func testS19RapidAlternatingGoodAndMissAtOneTimestampStaysEmpty() {
    var trails = PoseMotionTrailBuffer(config: .init(trackedJoints: [joint]))
    for index in 0 ..< 10_000 {
      if index % 2 == 0 {
        trails.ingest(landmarks: [landmark(x: 0.5)], timestampMs: 5_000)
      } else {
        trails.ingest(landmarks: [], timestampMs: 5_000)
      }
    }
    XCTAssertEqual(trails.storedSampleCount, 0)
    XCTAssertTrue(trails.segments(at: 5_000).isEmpty)
    XCTAssertTrue(trails.segments(at: 5_001).isEmpty)
  }

  private func landmark(name: String? = nil, x: Double, y: Double = 0.4, visibility: Double = 0.9) -> PoseLandmark {
    PoseLandmark(name: name ?? joint, x: x, y: y, visibility: visibility)
  }
}
