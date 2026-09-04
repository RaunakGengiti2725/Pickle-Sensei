import XCTest

@testable import PickleVisionCore

/// Structural-audit probes (pass 1, native-vision-core). New file only; the
/// shipped suite is untouched.
///
/// Suspected defect (PoseReadinessEvaluator.swift:173-180): the stability
/// window prunes every sample with `timestampMs < now - stableDurationMs` and
/// then measures `stableForMs = now - first.timestampMs`. The first survivor
/// is always ≥ the cutoff, so `stableForMs ≤ stableDurationMs`, and the
/// `>=` test can only succeed when a sample sits EXACTLY at
/// `now - stableDurationMs`. `ready` therefore depends on the frame cadence
/// dividing 450 ms, not on 450 ms of stillness having been observed.
///
/// CameraEngine stamps frames with `Int((CMTimeGetSeconds(pts) * 1000).rounded())`
/// and GuidedCaptureViewController drops frames while Vision is in flight, so
/// the pose cadence on device is 60 fps only when inference keeps up.
final class AuditReadinessCadenceProbeTests: XCTestCase {
  /// Minimal repro: a perfectly still, well-framed body sampled every 200 ms
  /// for five seconds is never `ready`.
  func testStillBodySampledEvery200MsBecomesReadyWithinFiveSeconds() {
    let evaluator = PoseReadinessEvaluator()
    var states: [PoseReadinessEvaluator.State] = []
    for t in stride(from: 0, through: 5_000, by: 200) {
      states.append(evaluator.ingest(pose: pose(timestampMs: t)).state)
    }
    XCTAssertTrue(
      states.contains(.ready),
      "still body for 5 s never reached ready; states=\(Set(states.map(\.rawValue)))"
    )
  }

  /// 30 fps camera cadence with CMTime→ms rounding (33/34 ms alternating).
  func testStillBodyAt30FpsCadenceBecomesReadyWithinFiveSeconds() {
    assertReachesReady(fps: 30, seconds: 5)
  }

  /// 25 fps (40 ms) — the cadence the shipped detector tests use.
  func testStillBodyAt25FpsCadenceBecomesReadyWithinFiveSeconds() {
    assertReachesReady(fps: 25, seconds: 5)
  }

  /// 60 fps camera with every other frame dropped by the `visionInFlight`
  /// gate (inference slower than 16.7 ms): effective 30 fps pose cadence.
  func testStillBodyAt60FpsWithEveryOtherFrameDroppedBecomesReady() {
    let evaluator = PoseReadinessEvaluator()
    var states: [PoseReadinessEvaluator.State] = []
    for k in stride(from: 0, through: 300, by: 2) {
      let t = Int((Double(k) * 1_000.0 / 60.0).rounded())
      states.append(evaluator.ingest(pose: pose(timestampMs: t)).state)
    }
    XCTAssertTrue(states.contains(.ready), "states=\(Set(states.map(\.rawValue)))")
  }

  /// Control: exact 60 fps (27 frames = 450.0 ms) does reach `ready`, which is
  /// why the shipped fixtures (0/225/450, 150 ms steps) never saw the issue.
  func testStillBodyAtExact60FpsCadenceBecomesReady() {
    assertReachesReady(fps: 60, seconds: 2)
  }

  /// 60 fps with ±1 ms presentation-timestamp jitter (deterministic pattern):
  /// stillness for 3 s must still reach `ready`.
  func testStillBodyAt60FpsWithOneMsJitterBecomesReadyWithinThreeSeconds() {
    let evaluator = PoseReadinessEvaluator()
    var states: [PoseReadinessEvaluator.State] = []
    let jitter = [0, 1, 0, -1, 1, 0, 0, -1, 0, 1, -1]
    for k in 0...180 {
      let t = ms(frame: k, fps: 60) + jitter[k % jitter.count]
      states.append(evaluator.ingest(pose: pose(timestampMs: t)).state)
    }
    XCTAssertTrue(states.contains(.ready), "states=\(Set(states.map(\.rawValue)))")
  }

  /// Once ready at 60 fps, a single dropped frame must not flip a still body
  /// back to `holdStill`. (Frame k is ready only if frame k−27 was ingested.)
  func testSingleDroppedFrameDoesNotUnreadyAStillBodyAt60Fps() {
    let evaluator = PoseReadinessEvaluator()
    var lastState: PoseReadinessEvaluator.State = .noPerson
    for k in 0...60 {
      lastState = evaluator.ingest(pose: pose(timestampMs: ms(frame: k, fps: 60))).state
    }
    XCTAssertEqual(lastState, .ready, "precondition: ready after 1 s at 60 fps")

    // Frame 61 dropped (Vision in flight); frames 62… continue.
    var statesAfterDrop: [PoseReadinessEvaluator.State] = []
    for k in 62...120 {
      statesAfterDrop.append(evaluator.ingest(pose: pose(timestampMs: ms(frame: k, fps: 60))).state)
    }
    XCTAssertFalse(
      statesAfterDrop.contains(.holdStill),
      "a still body lost `ready` after one dropped frame: \(statesAfterDrop.map(\.rawValue))"
    )
  }

  /// Direct statement of the invariant the code enforces today: `stableForMs`
  /// reported on the ready snapshot can never exceed the configured window,
  /// so readiness is an equality test on timestamps, not a threshold.
  func testStableForMsOnReadySnapshotNeverExceedsWindow() {
    let evaluator = PoseReadinessEvaluator()
    var readyStableFor: [Int] = []
    for k in 0...180 {
      let snapshot = evaluator.ingest(pose: pose(timestampMs: ms(frame: k, fps: 60)))
      if snapshot.isReady { readyStableFor.append(snapshot.stableForMs) }
    }
    XCTAssertFalse(readyStableFor.isEmpty)
    // Documents the mechanism; both assertions hold on 4d812e1a.
    XCTAssertEqual(readyStableFor.max(), 450)
    XCTAssertEqual(readyStableFor.min(), 450)
  }

  // MARK: - Helpers

  private func assertReachesReady(fps: Int, seconds: Int, file: StaticString = #filePath, line: UInt = #line) {
    let evaluator = PoseReadinessEvaluator()
    var states: [PoseReadinessEvaluator.State] = []
    for k in 0...(fps * seconds) {
      states.append(evaluator.ingest(pose: pose(timestampMs: ms(frame: k, fps: fps))).state)
    }
    XCTAssertTrue(
      states.contains(.ready),
      "still body at \(fps) fps for \(seconds) s never reached ready; states=\(Set(states.map(\.rawValue)))",
      file: file,
      line: line
    )
  }

  /// CameraEngine's stamp: presentation seconds × 1000, rounded to Int.
  private func ms(frame k: Int, fps: Int) -> Int {
    Int((Double(k) * 1_000.0 / Double(fps)).rounded())
  }

  /// Same well-framed, complete, still body the shipped readiness tests use.
  private func pose(timestampMs: Int) -> PoseFrame {
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
      landmarks: points.map { PoseLandmark(name: $0.0, x: $0.1, y: $0.2, visibility: 0.95) },
      confidence: 0.95
    )
  }
}
