import Dispatch
import Foundation
import XCTest
@testable import PickleNativeStressCore
@testable import PickleNativeStressKit

/// `SessionMotionStream` + `StrokeCompletionMonitor` under seeded streams and
/// from four threads at once (vision queue ingest / frame queue observe+decide
/// / arm+telemetry / payload), mirroring GuidedCaptureViewController's usage.
final class CompletionMonitorStressTests: XCTestCase {
  func testDecisionsStayInsideTheAnchorWindowAndTelemetryIsCapped() {
    let outcomes = StressCampaign.assertHeld(.motionStreamAndMonitor)
    XCTAssertEqual(outcomes.count, StressCampaign.iterations)
  }

  func testConcurrentIngestObserveArmAndTelemetryNeverDeadlockOrCorrupt() {
    let outcomes = StressCampaign.assertHeld(.monitorConcurrent)
    XCTAssertEqual(outcomes.count, StressScenario.monitorConcurrent.campaignIterations())
  }

  func testTeardownWhileVisionWorkIsInFlightDeliversNothingAfterStop() {
    // Cancellation mid-extraction as SessionCaptureCoordinator experiences it:
    // the pose provider is blocked inside extractPose on the vision queue,
    // the owner stops, THEN the extraction returns. MODEL: `TeardownOwner`
    // below gates delivery on `stopped` under its lock. The production
    // coordinator (native/camera-engine/Sources/SessionCaptureCoordinator.swift
    // handleFrame) does NOT re-check `stopped` before `onPoseFrame?`/
    // `onMotionSample?`, so ONE in-flight result can still reach the bridge
    // after `stop()`; apps/mobile/src/flow/sessionNative.ts drops it by
    // captureId. Apple-runtime behaviour of that path is UNVERIFIED-on-Linux.
    for round in 0 ..< StressCampaign.iterations {
      var rng = StressRNG(seed: UInt64(1_000 + round))
      let athlete = PoseSynth.Athlete.readyFraming(&rng)
      let frame = PoseSynth.frame(athlete, arm: .still, timestampMs: 16, rng: &rng)
      let provider = ScriptedPoseProvider(steps: [.pose(frame), .failure(.cancelled)])
      let gate = DispatchSemaphore(value: 0)
      provider.gate = gate
      let owner = TeardownOwner(provider: provider)
      let delivered = ThreadSafeCounter()
      owner.onPoseFrame = { _ in delivered.increment() }
      let inFlight = owner.handleFrame(timestampMs: 16)
      owner.stop()
      gate.signal()
      gate.signal()
      XCTAssertEqual(inFlight.wait(timeout: .now() + 10), .success, "vision work never finished")
      XCTAssertEqual(delivered.value, 0, "round \(round): pose delivered after stop()")
      XCTAssertEqual(provider.calls, 1)
      // Frames after stop are dropped without touching the provider.
      _ = owner.handleFrame(timestampMs: 32)
      XCTAssertEqual(provider.calls, 1)
    }
  }
}

/// Minimal stand-in for `SessionCaptureCoordinator`'s stop/deliver contract
/// (`stopped` + callbacks behind `stateLock`, single in-flight pose), built on
/// the real `PoseProviding` witness so the ordering is exercised, not assumed.
private final class TeardownOwner: @unchecked Sendable {
  private let provider: PoseProviding
  private let lock = NSLock()
  private var stopped = false
  private var poseInFlight = false
  private let visionQueue = DispatchQueue(label: "stress.teardown.vision")
  var onPoseFrame: ((PoseFrame?) -> Void)?

  init(provider: PoseProviding) { self.provider = provider }

  func handleFrame(timestampMs: Int) -> DispatchGroup {
    let group = DispatchGroup()
    lock.lock()
    let skip = stopped || poseInFlight
    if !skip { poseInFlight = true }
    lock.unlock()
    guard !skip else { return group }
    visionQueue.async(group: group) { [self] in
      defer {
        lock.lock()
        poseInFlight = false
        lock.unlock()
      }
      let pose = try? provider.extractPose(pixelBuffer: StressPixelBuffer.blank(), timestampMs: timestampMs)
      lock.lock()
      let callback = stopped ? nil : onPoseFrame
      lock.unlock()
      callback?(pose)
    }
    return group
  }

  func stop() {
    lock.lock()
    stopped = true
    onPoseFrame = nil
    lock.unlock()
  }
}
