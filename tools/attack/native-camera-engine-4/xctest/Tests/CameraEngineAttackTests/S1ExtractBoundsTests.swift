import AVFoundation
import Foundation
import XCTest

@testable import CameraEngineUnderTest

/// Scenario 1 — `SessionCaptureCoordinator.extract` bounds validation.
///
/// Assignment: `extract(startMs:500,endMs:500)` and `extract(startMs:-1,endMs:10)`
/// must both fail with `CoordinatorError.invalidBounds` WITHOUT touching the
/// extraction queue.
///
/// Production guard (SessionCaptureCoordinator.swift:204-207) is
/// `eventEndMs > eventStartMs` only. Static reading predicts:
///   (500, 500) → invalidBounds, synchronous, queue untouched  (HELD)
///   (-1, 10)   → guard passes; a StrokeEvent with absoluteStart = base - 1 is
///                dispatched to `extractionQueue` (line 216)     (BROKEN)
/// The device tests below encode the ASSIGNMENT's expectation, so the (-1,10)
/// case is expected to fail on a camera-backed run — that failure is the
/// finding's artifact.
///
/// Guard ORDER is also observable without a camera: recording state is checked
/// (line 200) before bounds (line 204), so on an unstarted coordinator a
/// malformed window reports `recordingNotStarted`, never `invalidBounds`.
final class S1ExtractBoundsTests: XCTestCase {
  private func callExtract(
    _ coordinator: SessionCaptureCoordinator,
    start: Int,
    end: Int,
    peak: Int? = nil
  ) -> ExtractCompletionRecorder {
    let recorder = ExtractCompletionRecorder()
    coordinator.extract(
      eventStartMs: start,
      eventEndMs: end,
      peakMs: peak,
      confidence: 0.9,
      detectionModelVersion: "attack-4",
      completion: recorder.completion
    )
    recorder.markCallReturned()
    return recorder
  }

  /// Enqueues a probe on the private extraction queue and reports how long it
  /// took to run. `awaitCoverageAndExport` runs on that serial queue and polls
  /// with `Thread.sleep` (250 ms steps, up to 10 s) while coverage is missing,
  /// so any work enqueued by `extract` delays the probe. A probe that runs
  /// within 100 ms is strong evidence the queue was untouched; the PRIMARY
  /// signal is `ExtractCompletionRecorder.arrivedSynchronously` — every guard
  /// rejection completes before `extract` returns, every accepted request
  /// completes from the queue.
  private func probeExtractionQueue(_ coordinator: SessionCaptureCoordinator) throws -> TimeInterval {
    let queue = try AttackSupport.extractionQueue(of: coordinator)
    let lock = NSLock()
    var ran = false
    let started = Date()
    queue.async {
      lock.lock()
      ran = true
      lock.unlock()
    }
    let held = AttackSupport.waitUntil(12) {
      lock.lock()
      defer { lock.unlock() }
      return ran
    }
    XCTAssertTrue(held, "extraction queue probe never ran (queue wedged)")
    return Date().timeIntervalSince(started)
  }

  // MARK: [sim] guard order

  func test_sim_unstartedCoordinator_emptyWindow_reportsRecordingNotStarted_notInvalidBounds() throws {
    let coordinator = SessionCaptureCoordinator()
    let recorder = callExtract(coordinator, start: 500, end: 500)
    let error = try XCTUnwrap(recorder.coordinatorError, "completion must be a CoordinatorError")
    XCTAssertTrue(
      error.isRecordingNotStarted,
      "recording state is validated BEFORE bounds (line 200 vs 204): got \(error)"
    )
    XCTAssertFalse(error.isInvalidBounds, "an empty window on an unstarted session never reports invalidBounds")
    XCTAssertTrue(recorder.arrivedSynchronously, "up-front rejections complete before extract returns")
    XCTAssertLessThan(try probeExtractionQueue(coordinator), 0.1, "extraction queue must be untouched")
  }

  func test_sim_unstartedCoordinator_negativeStart_reportsRecordingNotStarted() throws {
    let coordinator = SessionCaptureCoordinator()
    let recorder = callExtract(coordinator, start: -1, end: 10)
    let error = try XCTUnwrap(recorder.coordinatorError)
    XCTAssertTrue(error.isRecordingNotStarted, "got \(error)")
    XCTAssertTrue(recorder.arrivedSynchronously)
    XCTAssertLessThan(try probeExtractionQueue(coordinator), 0.1)
  }

  func test_sim_stoppedCoordinator_reportsAlreadyStopped_forAnyBounds() throws {
    let coordinator = SessionCaptureCoordinator()
    coordinator.stop()
    for (start, end) in [(0, 10), (500, 500), (-1, 10), (Int.max, Int.min)] {
      let recorder = callExtract(coordinator, start: start, end: end)
      let error = try XCTUnwrap(recorder.coordinatorError, "(\(start),\(end))")
      XCTAssertTrue(error.isAlreadyStopped, "(\(start),\(end)) → \(error)")
      XCTAssertTrue(recorder.arrivedSynchronously)
    }
    XCTAssertLessThan(try probeExtractionQueue(coordinator), 0.1)
  }

  /// Rapid repeats: 500 malformed requests on an unstarted coordinator must
  /// each complete synchronously and leave the queue idle (seeded RNG, seed
  /// printed for replay).
  func test_sim_rapidMalformedRequests_neverReachExtractionQueue() throws {
    let seed: UInt64 = 0x4D81_2E1A_0000_0004
    var rng = AttackSupport.SeededGenerator(seed: seed)
    print("S1 rapid-repeat seed: 0x\(String(seed, radix: 16))")
    let coordinator = SessionCaptureCoordinator()
    var synchronous = 0
    for _ in 0..<500 {
      let start = Int.random(in: -10_000...10_000, using: &rng)
      let end = Bool.random(using: &rng) ? start : start - Int.random(in: 0...5_000, using: &rng)
      let recorder = callExtract(coordinator, start: start, end: end)
      if recorder.arrivedSynchronously { synchronous += 1 }
      XCTAssertNotNil(recorder.coordinatorError)
    }
    XCTAssertEqual(synchronous, 500)
    XCTAssertLessThan(try probeExtractionQueue(coordinator), 0.1)
  }

  // MARK: [device] the real bounds guard (needs frames → needs a camera)

  /// Starts the coordinator's rolling recording and waits for the first
  /// frame, which is what populates `sessionBaseMs` and makes the bounds guard
  /// reachable. Skips honestly on camera-less destinations.
  private func startedCoordinator() async throws -> SessionCaptureCoordinator {
    guard AttackSupport.hasAnyVideoDevice() else {
      throw XCTSkip("[device] no video capture device on this destination (iOS Simulator) — run on an attached iPhone")
    }
    try AttackSupport.guardCameraPermissionPrompt()
    let coordinator = SessionCaptureCoordinator()
    let engine = try AttackSupport.engine(of: coordinator)
    do {
      try await coordinator.start()
    } catch let error as CameraEngine.EngineError {
      switch error {
      case .configurationFailed(let message):
        throw XCTSkip("[device] no usable camera (\(message))")
      case .permissionDenied:
        throw XCTSkip("[device] camera permission denied")
      default:
        throw error
      }
    }
    addTeardownBlock { coordinator.stop() }
    let framed = await AttackSupport.waitUntilAsync(8) {
      engine.currentRecordingFirstFrameTimestampMs != nil
    }
    guard framed else { throw XCTSkip("[device] camera produced no frames within 8 s") }
    return coordinator
  }

  func test_device_emptyWindow_isInvalidBounds_withoutTouchingQueue() async throws {
    let coordinator = try await startedCoordinator()
    let recorder = callExtract(coordinator, start: 500, end: 500)
    let error = try XCTUnwrap(recorder.coordinatorError)
    XCTAssertTrue(error.isInvalidBounds, "got \(error)")
    XCTAssertTrue(recorder.arrivedSynchronously)
    XCTAssertLessThan(try probeExtractionQueue(coordinator), 0.1, "extraction queue must be untouched")
  }

  func test_device_reversedWindow_isInvalidBounds_withoutTouchingQueue() async throws {
    let coordinator = try await startedCoordinator()
    let recorder = callExtract(coordinator, start: 600, end: 500)
    let error = try XCTUnwrap(recorder.coordinatorError)
    XCTAssertTrue(error.isInvalidBounds, "got \(error)")
    XCTAssertTrue(recorder.arrivedSynchronously)
    XCTAssertLessThan(try probeExtractionQueue(coordinator), 0.1)
  }

  /// ASSIGNMENT EXPECTATION: (-1, 10) → invalidBounds, queue untouched.
  /// STATIC PREDICTION (SessionCaptureCoordinator.swift:204): the guard is
  /// `eventEndMs > eventStartMs`, 10 > -1 passes, the request is dispatched.
  /// Expected to FAIL on a camera-backed run; that failure is the finding.
  func test_device_negativeStart_isInvalidBounds_withoutTouchingQueue() async throws {
    let coordinator = try await startedCoordinator()
    let recorder = callExtract(coordinator, start: -1, end: 10)
    XCTAssertTrue(
      recorder.arrivedSynchronously,
      "a negative event start must be rejected up front; instead the request was accepted"
    )
    let probe = try probeExtractionQueue(coordinator)
    XCTAssertLessThan(probe, 0.1, "extraction queue was touched (probe delayed \(probe)s)")
    let settled = AttackSupport.waitUntil(15) { recorder.received != nil }
    XCTAssertTrue(settled, "no completion within 15 s")
    let error = try XCTUnwrap(recorder.coordinatorError, "completion: \(String(describing: recorder.received))")
    XCTAssertTrue(error.isInvalidBounds, "expected invalidBounds, got \(error)")
  }

  /// Peak outside the window and a pre-session negative peak: neither is
  /// validated (only start/end are). Recorded as an observation — the test
  /// documents current behaviour rather than asserting a contract the code
  /// never claimed.
  func test_device_peakOutsideWindow_observation() async throws {
    let coordinator = try await startedCoordinator()
    let recorder = callExtract(coordinator, start: 100, end: 200, peak: -5_000)
    let settled = AttackSupport.waitUntil(15) { recorder.received != nil }
    XCTAssertTrue(settled)
    print("S1 peak-outside-window completion: \(String(describing: recorder.received))")
  }

  /// HUGE INPUT. `absoluteStartMs = base + eventStartMs` (line 208) uses the
  /// trapping `+`. The RN bridge feeds `(request["startMs"] as? NSNumber)?
  /// .intValue` (PickleVideoCapture.swift:534) straight in; whether a JS
  /// double can reach Int.max through NSNumber is not established here, so
  /// this probe drives the Swift API directly. With a live base this traps
  /// and kills the process. Gated behind PICKLE_ATTACK_ALLOW_TRAP=1 because a
  /// confirmed trap takes the whole xctest runner down with it.
  func test_device_intMaxBounds_trapProbe() async throws {
    guard ProcessInfo.processInfo.environment["PICKLE_ATTACK_ALLOW_TRAP"] == "1" else {
      throw XCTSkip("set PICKLE_ATTACK_ALLOW_TRAP=1 to run the Int.max overflow probe (expected to crash the runner)")
    }
    let coordinator = try await startedCoordinator()
    let recorder = callExtract(coordinator, start: Int.max - 1, end: Int.max)
    let settled = AttackSupport.waitUntil(15) { recorder.received != nil }
    XCTAssertTrue(settled, "no completion — if the runner died here, the overflow trap is confirmed")
  }
}
