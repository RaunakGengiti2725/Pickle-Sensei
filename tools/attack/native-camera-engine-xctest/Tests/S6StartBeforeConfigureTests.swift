// Scenario 6 — start() before requestPermissionAndConfigure().
//
// CameraEngine.swift:309-318: the session-queue block checks `isConfigured`
// first and emits exactly `.failed("The camera session is not configured.")`,
// returning before `.starting` and before `session.startRunning()`. Runs on
// any destination (the whole point is never reaching AVFoundation). The
// "exactly one / no .starting" assertions use the session-queue barrier
// from AttackSupport instead of sleeping.
import AVFoundation
import Foundation
import XCTest

@testable import PickleCameraEngineUnderTest

final class S6StartBeforeConfigureTests: XCTestCase {
  private let notConfigured = "failed(The camera session is not configured.)"

  func testStartBeforeConfigureEmitsExactlyOneNotConfiguredFailureAndNoStarting() {
    let engine = CameraEngine()
    let recorder = EngineCallbackRecorder()
    recorder.attach(to: engine)

    let first = expectation(description: "first session event")
    first.assertForOverFulfill = false
    recorder.onAnySessionEvent = { first.fulfill() }
    let t0 = attackNowMs()
    engine.start()
    wait(for: [first], timeout: 5)
    let elapsedMs = attackNowMs() - t0
    engine.attackDrainSessionQueue()

    XCTAssertEqual(recorder.eventLabels, [notConfigured], "exactly one .failed(not configured), nothing else")
    XCTAssertFalse(recorder.eventLabels.contains("starting"), "no .starting may precede the refusal")
    XCTAssertFalse(recorder.eventLabels.contains("running"))
    XCTAssertLessThan(elapsedMs, 1_000, "the refusal is immediate")
    XCTAssertEqual(recorder.zoomStateCount, 0, "an unconfigured start must not publish zoom state")
    XCTAssertTrue(recorder.results.isEmpty, "no recording result may be fabricated")
  }

  /// Rapid repeats: N unconfigured start() calls → N identical failures,
  /// still zero .starting — the guard has no hidden latch that turns the
  /// second call into a real start.
  func testRapidRepeatedUnconfiguredStartsFailOncePerCall() {
    let engine = CameraEngine()
    let recorder = EngineCallbackRecorder()
    recorder.attach(to: engine)
    let n = 250
    let all = expectation(description: "\(n) failures")
    all.expectedFulfillmentCount = n
    recorder.onAnySessionEvent = { all.fulfill() }

    for _ in 0..<n { engine.start() }
    wait(for: [all], timeout: 10)
    engine.attackDrainSessionQueue()

    XCTAssertEqual(recorder.eventLabels.count, n)
    XCTAssertEqual(Set(recorder.eventLabels), [notConfigured])
  }

  /// Interleaving every idle-safe public entry point with the unconfigured
  /// start(): stop(), zoom, camera switch, flip-with-spool-restart, discard,
  /// recording start / stop. Only start() may emit a session event, and only
  /// the not-configured failure; each recording request (direct or via the
  /// idle flip's restart) answers sessionNotRunning; nothing else emits.
  func testUnconfiguredControlSurfaceIsSilentExceptForRefusals() {
    let engine = CameraEngine()
    let recorder = EngineCallbackRecorder()
    recorder.attach(to: engine)
    let url = AttackFiles.temporaryURL("unconfigured-controls")
    defer { AttackFiles.removeParent(of: url) }
    var rng = SeededGenerator()
    var expectedStarts = 0
    var expectedRecordRefusals = 0
    let ops: [() -> Void] = [
      { engine.start(); expectedStarts += 1 },
      { engine.stop() },
      { engine.setDisplayZoom(CGFloat(Double.random(in: 0.5...12, using: &rng)), animated: Bool.random(using: &rng)) },
      { engine.switchCamera(to: Bool.random(using: &rng) ? .front : .back) },
      { engine.discardActiveRecording() },
      { engine.stopContinuousRecording() },
      { engine.startContinuousRecording(to: url); expectedRecordRefusals += 1 },
      { engine.flipCameraRestartingSpool(to: .front, nextRecordingURL: url); expectedRecordRefusals += 1 },
    ]
    for _ in 0..<300 { ops.randomElement(using: &rng)!() }
    engine.attackDrainSessionQueue()

    XCTAssertEqual(recorder.eventLabels.count, expectedStarts, "one session event per start(), none for other controls")
    XCTAssertEqual(Set(recorder.eventLabels), expectedStarts > 0 ? [notConfigured] : [])
    XCTAssertEqual(recorder.results.count, expectedRecordRefusals, "one refusal per recording request, none for discard/stop")
    for result in recorder.results {
      guard case .failure(let error) = result, case .sessionNotRunning = error as? CameraEngine.EngineError else {
        return XCTFail("unexpected recording result \(result)")
      }
    }
    XCTAssertFalse(FileManager.default.fileExists(atPath: url.path))
    XCTAssertTrue(recorder.startedURLs.isEmpty)
  }

  /// Permission denial is decided BEFORE configuration: with camera access
  /// denied/restricted (or authorized but without a camera, as on the
  /// Simulator, where configuration fails instead)
  /// `requestPermissionAndConfigure()` throws and a subsequent start() must
  /// still be the not-configured refusal — never a half-configured session.
  /// Skips when the host is authorized on a real camera (configuration would
  /// succeed) or when authorization is undetermined (a prompt would block).
  func testFailedConfigurationLeavesEngineUnconfigured() async throws {
    if CameraPlane.hasRearCamera && CameraPlane.isAuthorized {
      throw XCTSkip("host has an authorized camera; the denial path cannot be exercised here")
    }
    if AVCaptureDevice.authorizationStatus(for: .video) == .notDetermined {
      // requestAccess would raise the TCC prompt (and the xctest runner has no
      // NSCameraUsageDescription): pre-deny camera access for the test host.
      throw XCTSkip("camera authorization is .notDetermined; pre-deny camera access for the test host to execute")
    }
    let engine = CameraEngine()
    let recorder = EngineCallbackRecorder()
    recorder.attach(to: engine)

    do {
      try await engine.requestPermissionAndConfigure()
      XCTFail("configuration must not succeed without an authorized camera")
    } catch let error as CameraEngine.EngineError {
      switch error {
      case .permissionDenied, .configurationFailed: break
      default: XCTFail("unexpected engine error \(error)")
      }
    }
    engine.attackDrainSessionQueue()
    XCTAssertFalse(recorder.eventLabels.contains("configured"), "a failed configuration must not announce .configured")

    let first = expectation(description: "refusal")
    first.assertForOverFulfill = false
    recorder.onAnySessionEvent = { first.fulfill() }
    engine.start()
    wait(for: [first], timeout: 5)
    engine.attackDrainSessionQueue()
    XCTAssertEqual(recorder.eventLabels.last, notConfigured)
    XCTAssertFalse(recorder.eventLabels.contains("starting"))
  }
}
